// =====================================================
//  NEAR — модерация файлов и ИИ-проверка (Supabase Edge Function "moderate")
//
//  1) {table, id} от базы (секрет) или от автора — ИИ-проверка фото или текста
//     (бесплатный OpenAI Moderation API). Если сервис недоступен, материал
//     НЕ публикуется: остается "на проверке" и попадает в очередь модератора.
//  2) {kind: "quarantine", post_id, status} от базы (секрет x-near-secret) —
//     скрытая публикация: файлы переносятся в приватный бакет post-quarantine;
//     возвращенная — обратно; удаленная — файлы стираются.
//  3) {kind: "cleanup"} от базы — удаление черновиков старше суток и переписок удаленных
//     аккаунтов старше 30 дней вместе с файлами.
//  4) {kind: "media_check", id} от базы — проверка нового файла: тип по сигнатуре, размер,
//     удаление метаданных (GPS) из видео; неподходящий файл удаляется, автор получает уведомление.
//
//  Секреты: OPENAI_API_KEY (для ИИ). SUPABASE_URL, SUPABASE_ANON_KEY и
//  SUPABASE_SERVICE_ROLE_KEY Supabase добавляет сам.
//  Развертывание: Verify JWT — ВЫКЛЮЧЕН (проверка внутри: токен пользователя или секрет базы).
// =====================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// Категории, при которых контент скрывается
const BLOCK = [
  "sexual", "sexual/minors", "violence/graphic", "self-harm", "self-harm/intent", "self-harm/instructions",
  "harassment/threatening", "hate/threatening", "illicit/violent",
];
const TEXT_BLOCK = [...BLOCK, "harassment", "hate"];

let secret: string | null = null;
async function dbSecret() {
  if (!secret) { const { data } = await admin.from("push_config").select("secret").eq("id", 1).single(); secret = data?.secret ?? null; }
  return secret;
}

// ---------- карантин файлов скрытой публикации ----------
async function quarantine(postId: string, status: string) {
  const { data: media } = await admin.from("post_media").select("id,path,bucket,url,thumb_url,poster_url").eq("post_id", postId);
  let moved = 0, failed = 0;
  for (const m of media ?? []) {
    if (!m.path) continue;
    const base = m.path.replace(/\.[a-z0-9]+$/i, "");
    const files = [m.path, base + "-t.jpg", base + "-p.jpg"];
    if (status === "deleted") {
      // v14: ошибка хранилища учитывается — строку публикации тогда не удаляем (повтор при следующей уборке)
      for (const b of ["post-media", "post-quarantine"]) { const { error } = await admin.storage.from(b).remove(files); if (error && !/not.?found/i.test(error.message)) failed++; }
      continue;
    }
    const to = status === "hidden" ? "post-quarantine" : "post-media";
    const from = to === "post-media" ? "post-quarantine" : "post-media";
    if (m.bucket === to) continue;
    for (const f of files) {
      const { error } = await admin.storage.from(from).move(f, f, { destinationBucket: to });
      if (error && !/not.?found/i.test(error.message)) { failed++; console.warn("move", error.message); } else if (!error) moved++;
    }
    const pub = (p: string) => admin.storage.from("post-media").getPublicUrl(p).data.publicUrl;
    const patch = to === "post-quarantine"
      ? { bucket: to, url: "private:" + m.path, thumb_url: m.thumb_url ? "private:" + base + (m.poster_url ? "-p.jpg" : "-t.jpg") : null, poster_url: m.poster_url ? "private:" + base + "-p.jpg" : null }
      : { bucket: to, url: pub(m.path), thumb_url: m.thumb_url ? pub(base + (m.poster_url ? "-p.jpg" : "-t.jpg")) : null, poster_url: m.poster_url ? pub(base + "-p.jpg") : null };
    await admin.from("post_media").update(patch).eq("id", m.id);
  }
  return { moved, failed };
}

// ---------- уборка черновиков старше суток ----------
// v14: строка удаляется, только если файлы убраны; иначе остается до следующей уборки (повтор), ссылки не теряются
async function cleanup() {
  const { data: drafts } = await admin.from("posts").select("id").eq("status", "draft").lt("created_at", new Date(Date.now() - 86400e3).toISOString()).limit(200);
  let removed = 0, retry = 0;
  for (const d of drafts ?? []) {
    const r = await quarantine(d.id, "deleted").catch(() => ({ failed: 1 }));
    if (r && r.failed) { retry++; continue; }
    const { error } = await admin.from("posts").delete().eq("id", d.id);
    if (!error) removed++; else retry++;
  }
  return { removed, retry };
}

// ---------- MEDIA-01: проверка каждого файла на сервере ----------
const MAX_BYTES = 20 * 1048576;
// тип файла по первым байтам (не по имени и не по заявленному MIME)
function sniff(b: Uint8Array): string | null {
  const s = (o: number, n: number) => String.fromCharCode(...b.slice(o, o + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && s(1, 3) === "PNG") return "image/png";
  if (s(0, 4) === "RIFF" && s(8, 4) === "WEBP") return "image/webp";
  if (s(4, 4) === "ftyp") return "video/mp4"; // MP4 и MOV (в т.ч. HEVC) — контейнер ISO BMFF
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}
// убрать метаданные (udta/meta, где лежат GPS и модель телефона): блок переименовывается в free и обнуляется
export function stripMeta(buf: Uint8Array): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const typ = (o: number) => String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
  const CONT = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);
  let hits = 0;
  const walk = (start: number, end: number) => {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o), hdr = 8; const t = typ(o);
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      if (t === "udta" || t === "meta") { buf.set([102, 114, 101, 101], o + 4); buf.fill(0, o + hdr, o + size); hits++; }
      else if (CONT.has(t)) walk(o + hdr, o + size);
      o += size;
    }
  };
  walk(0, buf.length);
  return hits;
}
const hasGps = (buf: Uint8Array) => { const t = new TextDecoder("latin1").decode(buf); return /\u00a9xyz|[+-]\d{2}\.\d{3,}[+-]\d{3}\.\d{3,}/.test(t); };
async function mediaCheck(id: string) {
  const { data: m } = await admin.from("post_media").select("id,post_id,user_id,path,type,bucket,checked_at").eq("id", id).maybeSingle();
  if (!m || !m.path || m.checked_at) return { status: "skip" };
  const bucket = m.bucket || "post-media";
  const { data: blob, error } = await admin.storage.from(bucket).download(m.path);
  if (error || !blob) return { status: "missing" };
  const buf = new Uint8Array(await blob.arrayBuffer());
  const kind = sniff(buf), want = m.type === "video" ? "video" : "image";
  const reject = async (why: string) => {
    const base = m.path.replace(/\.[a-z0-9]+$/i, "");
    await admin.storage.from(bucket).remove([m.path, base + "-t.jpg", base + "-p.jpg"]);
    await admin.from("post_media").delete().eq("id", m.id);
    await admin.from("notifications").insert({ user_id: m.user_id, type: "post_hidden", post_id: m.post_id, text: "Файл в публикации отклонен: " + why });
    return { status: "rejected", why };
  };
  if (buf.length > MAX_BYTES) return reject("больше 20 МБ");
  if (!kind || !kind.startsWith(want)) return reject("неподдерживаемый формат");
  let stripped = 0;
  if (kind === "video/mp4") {
    stripped = stripMeta(buf);
    if (stripped) {
      const { error: ue } = await admin.storage.from(bucket).upload(m.path, buf, { contentType: "video/mp4", upsert: true });
      if (ue) return { status: "error", why: "reupload" };
    }
    if (hasGps(buf)) return reject("в видео остались данные о месте съемки");
  }
  await admin.from("post_media").update({ checked_at: new Date().toISOString() }).eq("id", m.id);
  return { status: "ok", kind, stripped };
}

// ---------- PRIV-01: переписки удаленных аккаунтов старше 30 дней ----------
// v14: файлы читаются постранично; при любой ошибке хранилища переписка НЕ удаляется (ссылки на файлы остаются),
// задача повторяется при следующей уборке
async function listAll(bucket: string, dir: string): Promise<string[] | null> {
  const out: string[] = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const { data, error } = await admin.storage.from(bucket).list(dir, { limit: 1000, offset });
    if (error) return null;
    out.push(...(data ?? []).map((f: { name: string }) => `${dir}/${f.name}`));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function cleanupOrphans() {
  const { data: convs } = await admin.from("conversations").select("id,user_a,user_b").lt("orphaned_at", new Date(Date.now() - 30 * 86400e3).toISOString()).limit(200);
  let removed = 0, retry = 0;
  for (const c of convs ?? []) {
    let ok = true;
    for (const u of [c.user_a, c.user_b].filter(Boolean)) {
      const paths = await listAll("chat-media", `${u}/${c.id}`);
      if (paths === null) { ok = false; break; }
      for (let i = 0; i < paths.length && ok; i += 100) {
        const { error } = await admin.storage.from("chat-media").remove(paths.slice(i, i + 100));
        if (error) ok = false;
      }
      if (!ok) break;
    }
    if (!ok) { retry++; console.warn("orphan cleanup retry", c.id); continue; }
    const { error } = await admin.from("conversations").delete().eq("id", c.id);
    if (!error) removed++; else retry++;
  }
  return { removed, retry };
}

// для автотеста уборки (supabase/tests/functions/cleanup_test.mts)
(globalThis as Record<string, unknown>).__near_cleanupOrphans = cleanupOrphans;

// ---------- очередь модератора ----------
async function queue(targetType: string, targetId: string, owner: string | null, reason: string, details: string) {
  await admin.from("reports").insert({ reporter_id: null, source: "ai", target_type: targetType, target_id: targetId, target_user: owner, reason, details });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const corr = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
  const body = await req.json().catch(() => ({}));
  try {
    // ---- вызовы от базы ----
    if (body.kind === "quarantine" || body.kind === "cleanup" || body.kind === "media_check") {
      if (req.headers.get("x-near-secret") !== (await dbSecret())) return json({ error: "forbidden" }, 403);
      if (body.kind === "cleanup") return json({ ...(await cleanup()), ...(await cleanupOrphans()) });
      if (body.kind === "media_check") {
        if (typeof body.id !== "string") return json({ error: "bad request" }, 400);
        const r = await mediaCheck(body.id);
        console.log(JSON.stringify({ fn: "moderate", corr, kind: "media_check", ...r }));
        return json(r);
      }
      if (typeof body.post_id !== "string" || !["hidden", "active", "deleted", "closed"].includes(body.status)) return json({ error: "bad request" }, 400);
      const r = await quarantine(body.post_id, body.status === "closed" ? "active" : body.status);
      console.log(JSON.stringify({ fn: "moderate", corr, kind: "quarantine", status: body.status, ...r }));
      return json(r);
    }

    // ---- ИИ-проверка: вызывает база (секрет) сразу после записи; автор может только повторить проверку своего ----
    const { table, id } = body;
    if (!["post_media", "messages"].includes(table) || typeof id !== "string") return json({ error: "bad request" }, 400);
    const fromDb = req.headers.get("x-near-secret") === (await dbSecret());
    let caller: string | null = null;
    if (!fromDb) {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: u } = await admin.auth.getUser(token);
      if (!u?.user) return json({ error: "unauthorized" }, 401);
      caller = u.user.id;
    }

    const { data: row } = await admin.from(table).select("*").eq("id", id).maybeSingle();
    if (!row) return json({ error: "not found" }, 404);
    const owner = table === "post_media" ? row.user_id : row.sender_id;
    if (!fromDb && owner !== caller) return json({ error: "forbidden" }, 403);
    if (row.mod_status !== "pending") return json({ status: row.mod_status });

    const input: unknown[] = [];
    const isImage = table === "post_media" ? row.type === "image" : row.kind === "image";
    if (isImage) {
      let imgUrl: string | null = row.url ?? row.media_url;
      if (table === "messages" && row.media_path) {
        const { data: sig } = await admin.storage.from("chat-media").createSignedUrl(row.media_path, 600);
        imgUrl = sig?.signedUrl ?? null;
      }
      if (imgUrl && !imgUrl.startsWith("private:")) input.push({ type: "image_url", image_url: { url: imgUrl } });
    }
    if (row.text) input.push({ type: "text", text: row.text });
    if (!input.length) { await admin.from(table).update({ mod_status: "ok" }).eq("id", id); return json({ status: "ok" }); }

    const key = Deno.env.get("OPENAI_API_KEY");
    let out: { results?: { categories?: Record<string, boolean> }[] } | null = null;
    if (key) {
      const r = await fetch("https://api.openai.com/v1/moderations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "omni-moderation-latest", input }),
        signal: AbortSignal.timeout(15000),
      }).catch(() => null);
      if (r && r.ok) out = await r.json();
      else console.warn(JSON.stringify({ fn: "moderate", corr, ai: "unavailable", status: r?.status ?? 0 }));
    }
    if (!out) {
      // SEC-08: ИИ недоступен — материал остается на проверке и уходит в очередь модератора
      await queue(table === "post_media" ? "post" : "message", table === "post_media" ? row.post_id : row.id, owner, "ai_unavailable", "ИИ-проверка недоступна: нужна ручная проверка");
      return json({ status: "pending", note: "queued for manual review" });
    }
    const cats = out.results?.[0]?.categories ?? {};
    const hit = (isImage ? BLOCK : TEXT_BLOCK).filter((k) => cats[k]);
    const status = hit.length ? "flagged" : "ok";
    await admin.from(table).update({ mod_status: status }).eq("id", id);
    if (status === "flagged") {
      await queue(table === "post_media" ? "post" : "message", table === "post_media" ? row.post_id : row.id, owner, "nsfw", "Автопроверка ИИ: " + hit.join(", "));
      if (table === "post_media") {
        await admin.from("notifications").insert({ user_id: owner, type: "post_hidden", post_id: row.post_id,
          text: "Фото в вашей публикации скрыто автоматической проверкой. Модератор посмотрит его, можно подать апелляцию." });
      }
    }
    return json({ status, categories: hit });
  } catch (e) {
    console.error(JSON.stringify({ fn: "moderate", corr, error: (e as Error).name }));
    return json({ error: "internal" }, 500);
  }
});
