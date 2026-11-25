#!/usr/bin/env node
// =====================================================================
//  NEAR — изолированный FFmpeg worker для видео (ТЗ плеера v14.9, раздел 9)
//
//  Берет задания из очереди media_jobs (SKIP LOCKED, повтор до 3 раз), скачивает исходник
//  из приватного staging, проверяет реальный тип, размер, длительность и декодирование,
//  применяет параметры редактора (обрезка, поворот, пропорции, без звука, обложка),
//  перекодирует в MP4 H.264/AAC faststart до 720p без апскейла (цель 3–8 МБ),
//  удаляет GPS и все метаданные, делает обложку и кадры для проверки.
//  Проверка: кадры и обложка (ИИ), текст на кадрах и QR (OCR), речь (расшифровка) —
//  на мат, угрозы, интимный контент и скам. Любой сбой проверки → "на проверке" (закрытая очередь),
//  не публикация. Опубликованный файл копируется в публичный бакет только после одобрения.
//
//  Запуск: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... [OPENAI_API_KEY=...] node worker.mjs
//  Лимиты процесса FFmpeg: WORKER_CPU_SEC (120), WORKER_MEM_MB (1024), WORKER_TIMEOUT_SEC (180).
//  Ключ service_role хранится только на сервере worker, никогда в приложении и на GitHub.
// =====================================================================
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = (k, d) => process.env[k] ?? d;
export const LIMITS = {
  maxSourceBytes: 20 * 1048576, maxSourceSec: 600, maxFinalSec: 30, targetMaxBytes: 8 * 1048576,
  cpuSec: +env("WORKER_CPU_SEC", 120), memMb: +env("WORKER_MEM_MB", 1024), timeoutSec: +env("WORKER_TIMEOUT_SEC", 180),
};
const ALLOWED_VIDEO = ["h264", "hevc", "vp8", "vp9", "av1", "mpeg4"];
const ALLOWED_FORMATS = /mov|mp4|m4a|3gp|3g2|mj2|matroska|webm/;

// FFmpeg/ffprobe под лимитами CPU, памяти и времени, с пониженным приоритетом
export function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("timeout", ["-k", "5", String(LIMITS.timeoutSec), "prlimit", `--cpu=${LIMITS.cpuSec}`, `--as=${LIMITS.memMb * 1048576}`,
      "nice", "-n", "10", cmd, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out = [], err = [];
    p.stdout.on("data", (d) => out.push(d)); p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} ${code}: ${Buffer.concat(err).toString().slice(-300)}`))));
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

export async function probe(file) {
  const j = JSON.parse((await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file])).toString());
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  const rot = +(v?.tags?.rotate ?? (v?.side_data_list || []).find((x) => x.rotation != null)?.rotation ?? 0);
  return { format: j.format?.format_name || "", duration: +(j.format?.duration || v?.duration || 0), size: +(j.format?.size || 0),
           video: v ? { codec: v.codec_name, w: v.width, h: v.height, rotation: rot } : null, audio: a ? { codec: a.codec_name } : null, tags: j.format?.tags || {} };
}

export class Reject extends Error {}

// сборка фильтров по параметрам редактора; оригинал не меняется
export function buildArgs(src, out, info, edit = {}, crf = 26) {
  const start = Math.max(0, +edit.start || 0);
  const end = Math.min(info.duration, +edit.end || info.duration);
  const len = end - start;
  if (!(len > 0.3)) throw new Reject("Слишком короткий фрагмент");
  if (len > LIMITS.maxFinalSec + 0.05) throw new Reject("Видео длиннее 30 секунд: обрежьте его в редакторе");
  const vf = [];
  const rot = ((+edit.rotate || 0) % 360 + 360) % 360;
  if (rot === 90) vf.push("transpose=1"); else if (rot === 180) vf.push("transpose=1,transpose=1"); else if (rot === 270) vf.push("transpose=2");
  const ratios = { "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5, "16:9": 16 / 9 };
  if (ratios[edit.aspect]) {
    const r = ratios[edit.aspect];
    vf.push(`crop='if(gt(iw/ih,${r}),ih*${r},iw)':'if(gt(iw/ih,${r}),ih,iw/${r})'`);
  }
  // до 720p по короткой стороне, без апскейла; четные размеры
  vf.push("scale='if(lt(iw,ih),min(720,iw),-2)':'if(lt(iw,ih),-2,min(720,ih))'", "setsar=1", "format=yuv420p");
  const a = ["-y", "-v", "error", "-ss", String(start), "-t", String(len), "-i", src,
    "-map", "0:v:0", ...(edit.mute || !info.audio ? ["-an"] : ["-map", "0:a:0", "-c:a", "aac", "-b:a", "96k", "-ac", "2"]),
    "-vf", vf.join(","), "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-maxrate", "2500k", "-bufsize", "5000k",
    "-profile:v", "high", "-r", "30", "-movflags", "+faststart", "-map_metadata", "-1", "-map_chapters", "-1",
    "-metadata", "creation_time=", "-fflags", "+bitexact", out];
  return { args: a, len };
}

// полная обработка файла на диске: проверки → перекодирование → обложка → кадры для модерации
export async function processFile(src, dir, edit = {}) {
  const st = await stat(src);
  if (st.size > LIMITS.maxSourceBytes) throw new Reject("Файл больше 20 МБ");
  let info;
  try { info = await probe(src); } catch { throw new Reject("Файл не распознан как видео"); }
  if (!info.video || !ALLOWED_FORMATS.test(info.format) || !ALLOWED_VIDEO.includes(info.video.codec)) throw new Reject("Неподдерживаемый формат видео");
  if (!(info.duration > 0) || info.duration > LIMITS.maxSourceSec) throw new Reject("Слишком длинное видео");
  // проверка декодирования: файл читается до конца без ошибок
  try { await run("ffmpeg", ["-v", "error", "-xerror", "-i", src, "-map", "0:v:0", "-f", "null", "-"]); } catch { throw new Reject("Видео повреждено или не декодируется"); }
  const out = join(dir, "out.mp4");
  let { args, len } = buildArgs(src, out, info, edit);
  await run("ffmpeg", args);
  let size = (await stat(out)).size;
  if (size > LIMITS.targetMaxBytes) { ({ args } = buildArgs(src, out, info, edit, 31)); await run("ffmpeg", args); size = (await stat(out)).size; }
  const fin = await probe(out);
  if (!fin.video || fin.video.codec !== "h264" || Math.abs(fin.duration - len) > 1) throw new Error("проверка результата не пройдена");
  const cover = join(dir, "cover.jpg");
  const at = Math.min(Math.max(0, +edit.cover || 0), Math.max(0, fin.duration - 0.1));
  await run("ffmpeg", ["-y", "-v", "error", "-ss", String(at), "-i", out, "-frames:v", "1", "-q:v", "3", "-map_metadata", "-1", cover]);
  const frames = [];
  const n = Math.min(6, Math.max(2, Math.ceil(fin.duration / 5)));
  for (let i = 0; i < n; i++) {
    const f = join(dir, `f${i}.jpg`);
    await run("ffmpeg", ["-y", "-v", "error", "-ss", String((fin.duration * (i + 0.5)) / n), "-i", out, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", f]);
    frames.push(f);
  }
  let audio = null;
  if (fin.audio) { audio = join(dir, "a.mp3"); await run("ffmpeg", ["-y", "-v", "error", "-i", out, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio]); }
  return { out, cover, frames, audio, duration: Math.round(fin.duration * 10) / 10, w: fin.video.w, h: fin.video.h, size };
}

// ---------- проверка содержимого ----------
async function openai(path, body, key, isForm = false) {
  const r = await fetch("https://api.openai.com/v1/" + path, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, ...(isForm ? {} : { "Content-Type": "application/json" }) },
    body: isForm ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error("openai " + r.status);
  return r.json();
}
const dataUrl = async (f) => "data:image/jpeg;base64," + (await readFile(f)).toString("base64");

// возвращает {verdict: approved|pending_review, reason}
export async function moderate(res, db, key = env("OPENAI_API_KEY")) {
  if (!key) return { verdict: "pending_review", reason: "ai_unavailable" };
  try {
    const imgs = [res.cover, ...res.frames];
    const m = await openai("moderations", { model: "omni-moderation-latest", input: await Promise.all(imgs.map(async (f) => ({ type: "image_url", image_url: { url: await dataUrl(f) } }))) }, key);
    const hits = new Set();
    for (const r of m.results || []) for (const [k, v] of Object.entries(r.categories || {})) if (v) hits.add(k);
    if ([...hits].some((h) => h.startsWith("sexual"))) return { verdict: "pending_review", reason: [...hits].includes("sexual/minors") ? "minors" : "intimate" };
    if (hits.size) return { verdict: "pending_review", reason: "ai_flag", detail: [...hits].join(",") };
    // OCR и QR на кадрах — текст проверяем тем же NEAR Clean, что и публикации
    const ocr = await openai("chat/completions", { model: env("OPENAI_OCR_MODEL", "gpt-4o-mini"), max_tokens: 400, messages: [{ role: "user", content: [
      { type: "text", text: "Перепиши весь читаемый текст на кадрах и содержимое QR-кодов (если они есть), без комментариев. Если текста нет — ответь пустой строкой." },
      ...(await Promise.all(imgs.slice(0, 4).map(async (f) => ({ type: "image_url", image_url: { url: await dataUrl(f), detail: "low" } })))) ] }] }, key);
    let text = (ocr.choices?.[0]?.message?.content || "").trim();
    if (res.audio) {
      const fd = new FormData();
      fd.append("model", "whisper-1"); fd.append("file", new Blob([await readFile(res.audio)], { type: "audio/mpeg" }), "a.mp3");
      const tr = await openai("audio/transcriptions", fd, key, true);
      text += "\n" + (tr.text || "");
    }
    if (text.trim()) {
      const c = await db.rpc("clean_text", { p: text.slice(0, 4000), p_ctx: "video" });
      const v = c?.verdict;
      if (v === "block" || v === "hold" || c?.masked) return { verdict: "pending_review", reason: v === "hold" ? "threat" : "text_flag", detail: (c.reasons || []).join(",") };
      const tm = await openai("moderations", { model: "omni-moderation-latest", input: text.slice(0, 4000) }, key);
      if (tm.results?.[0]?.flagged) return { verdict: "pending_review", reason: "ai_flag" };
    }
    return { verdict: "approved" };
  } catch (e) {
    return { verdict: "pending_review", reason: "ai_unavailable", detail: String(e.message).slice(0, 100) };
  }
}

// ---------- Supabase (REST, только service_role на сервере worker) ----------
export function supabase(url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY"), f = fetch) {
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  return {
    async rpc(fn, args) {
      const r = await f(`${url}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(args) });
      if (!r.ok) throw new Error(`rpc ${fn} ${r.status}`);
      const t = await r.text(); return t ? JSON.parse(t) : null;
    },
    async download(bucket, key) {
      const r = await f(`${url}/storage/v1/object/${bucket}/${key}`, { headers: h });
      if (!r.ok) throw new Error("download " + r.status);
      return Buffer.from(await r.arrayBuffer());
    },
    async upload(bucket, key, buf, type) {
      const r = await f(`${url}/storage/v1/object/${bucket}/${key}`, { method: "POST", headers: { ...h, "Content-Type": type, "x-upsert": "true", "cache-control": "31536000" }, body: buf });
      if (!r.ok) throw new Error("upload " + r.status);
    },
    async remove(bucket, keys) {
      await f(`${url}/storage/v1/object/${bucket}`, { method: "DELETE", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: keys }) });
    },
    publicUrl: (bucket, key) => `${url}/storage/v1/object/public/${bucket}/${key}`,
  };
}

// одно задание целиком; повтор того же задания безопасен (ключи объектов детерминированы)
export async function runJob(job, db, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), "near-v-"));
  try {
    const src = join(dir, "src");
    await writeFile(src, await db.download("post-staging", job.object_key));
    let res;
    try { res = await processFile(src, dir, job.edit || {}); }
    catch (e) {
      if (e instanceof Reject) { await db.rpc("media_job_done", { p_job: job.job_id, p_state: "rejected", p_result: { error: e.message } }); return "rejected"; }
      throw e;
    }
    const base = job.object_key.replace(/\.[^./]+$/, "");
    const vKey = `${base}-720.mp4`, cKey = `${base}-cover.jpg`;
    await db.upload("post-staging", vKey, await readFile(res.out), "video/mp4");
    await db.upload("post-staging", cKey, await readFile(res.cover), "image/jpeg");
    const mod = await (opts.moderate || moderate)(res, db);
    const meta = { duration: res.duration, w: res.w, h: res.h, size: res.size, object_key: vKey, cover_key: cKey, reason: mod.reason, error: mod.detail };
    if (mod.verdict === "approved") {
      await db.upload("post-media", vKey, await readFile(res.out), "video/mp4");
      await db.upload("post-media", cKey, await readFile(res.cover), "image/jpeg");
      await db.rpc("media_job_done", { p_job: job.job_id, p_state: "approved", p_result: { ...meta, bucket: "post-media",
        url: db.publicUrl("post-media", vKey), poster_url: db.publicUrl("post-media", cKey), thumb_url: db.publicUrl("post-media", cKey) } });
      await db.remove("post-staging", [job.object_key, vKey, cKey]);   // сиротские файлы не остаются
    } else {
      await db.rpc("media_job_done", { p_job: job.job_id, p_state: "pending_review", p_result: meta });
      await db.remove("post-staging", [job.object_key]);                // исходник с метаданными больше не нужен
    }
    return mod.verdict;
  } catch (e) {
    await db.rpc("media_job_done", { p_job: job.job_id, p_state: "retry", p_result: { error: String(e.message).slice(0, 300) } }).catch(() => {});
    return "retry";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const db = supabase();
  const id = env("WORKER_ID", "worker-" + process.pid);
  console.log(JSON.stringify({ worker: id, start: new Date().toISOString(), limits: LIMITS }));
  for (;;) {
    let job = null;
    try { job = await db.rpc("media_job_claim", { p_worker: id, p_kind: "video" }); } catch (e) { console.error(JSON.stringify({ worker: id, error: e.message })); }
    if (!job) { await new Promise((r) => setTimeout(r, 5000)); continue; }
    const t0 = Date.now();
    const r = await runJob(job, db);
    console.log(JSON.stringify({ worker: id, job: job.job_id, attempt: job.attempt, result: r, ms: Date.now() - t0 }));
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
