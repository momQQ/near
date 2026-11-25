// Проверка FFmpeg worker на настоящих файлах (без Supabase): обрезка, 720p, faststart, GPS, обложка, отказы
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob, probe } from "./worker.mjs";
const T = mkdtempSync(join(tmpdir(), "nwt-"));
const ff = (...a) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...a]);
ff("-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=40", "-f", "lavfi", "-i", "sine=f=440:d=40", "-c:v", "libx264", "-preset", "veryfast", "-crf", "34", "-c:a", "aac",
   "-metadata", "location=+43.2389+076.8897/", "-movflags", "use_metadata_tags", "-shortest", join(T, "long.mov"));
ff("-f", "lavfi", "-i", "testsrc2=s=640x480:d=1", "-frames:v", "1", join(T, "pic.jpg"));
const FILES = { "post-staging": { "U/P/a.mov": readFileSync(join(T, "long.mov")), "U/P/b.mov": readFileSync(join(T, "long.mov")), "U/P/c.mp4": readFileSync(join(T, "pic.jpg")) }, "post-media": {} };
const CALLS = [];
const db = {
  rpc: async (fn, a) => { CALLS.push({ fn, ...a }); return null; },
  download: async (b, k) => { if (!FILES[b][k]) throw new Error("nf"); return FILES[b][k]; },
  upload: async (b, k, buf) => { FILES[b][k] = buf; },
  remove: async (b, ks) => ks.forEach((k) => delete FILES[b][k]),
  publicUrl: (b, k) => `https://cdn/${b}/${k}`,
};
const last = () => CALLS[CALLS.length - 1];
let r = await runJob({ job_id: "J1", object_key: "U/P/a.mov", edit: { start: 5, end: 20, cover: 3 } }, db, { moderate: async () => ({ verdict: "approved" }) });
const out = FILES["post-media"]["U/P/a-720.mp4"];
const fs2 = join(T, "o.mp4"); (await import("node:fs")).writeFileSync(fs2, out);
const p = await probe(fs2);
const txt = out.toString("latin1");
console.log("обрезка 5–20 с →", r, "| длительность:", p.duration.toFixed(1), "| размер:", p.video.w + "x" + p.video.h, "| кодеки:", p.video.codec + "/" + p.audio?.codec);
console.log("  faststart (moov до mdat):", txt.indexOf("moov") < txt.indexOf("mdat"), "| GPS удален:", !/43\.2389/.test(txt), "| МБ:", (out.length / 1048576).toFixed(2));
console.log("  обложка:", !!FILES["post-media"]["U/P/a-cover.jpg"], "| исходник удален из staging:", !FILES["post-staging"]["U/P/a.mov"], "| статус:", last().p_state, last().p_result.url);
r = await runJob({ job_id: "J2", object_key: "U/P/b.mov", edit: {} }, db, { moderate: async () => ({ verdict: "approved" }) });
console.log("40 с без обрезки →", r, "|", last().p_result.error);
r = await runJob({ job_id: "J3", object_key: "U/P/c.mp4", edit: {} }, db);
console.log("картинка вместо видео →", r, "|", last().p_result.error);
FILES["post-staging"]["U/P/d.mov"] = readFileSync(join(T, "long.mov"));
r = await runJob({ job_id: "J4", object_key: "U/P/d.mov", edit: { start: 0, end: 10, mute: true, rotate: 90, aspect: "1:1" } }, db, { moderate: async () => ({ verdict: "pending_review", reason: "ai_unavailable" }) });
const sk = FILES["post-staging"]["U/P/d-720.mp4"]; const f4 = join(T, "d.mp4"); (await import("node:fs")).writeFileSync(f4, sk);
const p4 = await probe(f4);
console.log("сбой проверки →", r, "| в публичном бакете нет:", !FILES["post-media"]["U/P/d-720.mp4"], "| без звука:", !p4.audio, "| 1:1 после поворота:", p4.video.w + "x" + p4.video.h);
r = await runJob({ job_id: "J5", object_key: "U/P/missing.mov", edit: {} }, db);
console.log("файла нет (обрыв) →", r, "| повтор поставлен:", last().p_state === "retry");
