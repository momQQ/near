// MEDIA-01: проверка файлов функцией moderate (подмена Supabase, настоящие файлы MOV/MP4/HEVC из ffmpeg)
import { readFileSync } from "node:fs";
const F: Record<string, Uint8Array> = {};
const ROWS: any[] = []; const NOTIF: any[] = [];
const add = (id: string, path: string, type: string, file: string) => { ROWS.push({ id, post_id: "P", user_id: "U", path, type, bucket: "post-media", checked_at: null }); F[path] = new Uint8Array(readFileSync(file)); };
const D = process.env.MEDIA_DIR!;
add("m1", "U/p/1.mov", "video", D + "/gps_h264.mov"); add("m2", "U/p/2.mp4", "video", D + "/gps_hevc.mp4"); add("m3", "U/p/3.jpg", "image", D + "/fake.jpg");
add("m4", "U/p/4.jpg", "image", D + "/ok.jpg"); add("m5", "U/p/5.mp4", "video", D + "/ok.jpg");
function q(t: string) { const f: any[] = []; const b: any = {
  select() { return b; }, eq(k: string, v: any) { f.push((r: any) => r[k] === v); return b; },
  maybeSingle() { return Promise.resolve({ data: (t === "push_config" ? [{ id: 1, secret: "S" }] : ROWS).find((r) => f.every((g) => g(r))) ?? null }); },
  single() { return b.maybeSingle(); },
  update(p: any) { const u: any = { eq(k: string, v: any) { ROWS.filter((r) => r[k] === v).forEach((r) => Object.assign(r, p)); return Promise.resolve({}); } }; return u; },
  delete() { return { eq(k: string, v: any) { const i = ROWS.findIndex((r) => r[k] === v); if (i >= 0) ROWS.splice(i, 1); return Promise.resolve({}); } }; },
  insert(x: any) { NOTIF.push(x); return Promise.resolve({}); } }; return b; }
const storage = { from: () => ({
  download: async (p: string) => (F[p] ? { data: new Blob([F[p]]), error: null } : { data: null, error: { message: "nf" } }),
  upload: async (p: string, b: Uint8Array) => { F[p] = new Uint8Array(b); return { error: null }; },
  remove: async (ps: string[]) => { ps.forEach((p) => delete F[p]); return { error: null }; } }) };
(globalThis as any).__fake = () => ({ from: q, storage });
let handler: any; (globalThis as any).Deno = { env: { get: () => "x" }, serve: (h: any) => (handler = h) };
console.log = ((o) => (...a: any[]) => { if (!String(a[0]).startsWith("{")) o(...a); })(console.log);
await import("./.mod.ts");
const call = async (id: string, sec = "S") => { const r = await handler(new Request("http://f", { method: "POST", headers: { "x-near-secret": sec }, body: JSON.stringify({ kind: "media_check", id }) })); return r.status + " " + await r.text(); };
console.log("без секрета:", await call("m1", "BAD"));
for (const id of ["m1", "m2", "m3", "m4", "m5"]) console.log(id, await call(id));
const gps = (p: string) => (F[p] ? /[+-]43\.\d+[+-]076\.\d+/.test(new TextDecoder("latin1").decode(F[p])) : "файл удален");
console.log("GPS после проверки: MOV H.264 —", gps("U/p/1.mov"), "| MP4 HEVC —", gps("U/p/2.mp4"));
console.log("осталось строк:", ROWS.map((r) => r.id + (r.checked_at ? "✓" : "")).join(" "), "| уведомлений:", NOTIF.length);
