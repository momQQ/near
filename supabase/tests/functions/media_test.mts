// MEDIA: фото в приватном staging → проверка → публикация (подмена Supabase и OpenAI, настоящие файлы)
import { readFileSync } from "node:fs";
const F: Record<string, Record<string, Uint8Array>> = { "post-staging": {}, "post-media": {} };
const ROWS: any[] = []; const DONE: any[] = [];
const D = process.env.MEDIA_DIR!;
const jpg = new Uint8Array(readFileSync(D + "/ok.jpg"));
// JPEG с EXIF: APP1 c координатами сразу после SOI
const exif = new TextEncoder().encode("Exif\0\0GPS +43.238900+076.889700 iPhone");
const app1 = new Uint8Array([0xff, 0xe1, 0, exif.length + 2, ...exif]);
const withExif = new Uint8Array([...jpg.slice(0, 2), ...app1, ...jpg.slice(2)]);
const add = (id: string, key: string, file: Uint8Array) => { ROWS.push({ id, post_id: "P", user_id: "U", object_key: key, type: "image", state: "processing", job_id: "J" + id }); F["post-staging"][key] = file; };
add("m1", "U/p/1.jpg", withExif); add("m2", "U/p/2.jpg", new TextEncoder().encode("GIF89a not a jpeg")); add("m3", "U/p/3.jpg", jpg); add("m4", "U/p/4.jpg", jpg);
function q(t: string) { const f: any[] = []; const b: any = {
  select() { return b; }, eq(k: string, v: any) { f.push((r: any) => r[k] === v); return b; },
  maybeSingle() { return Promise.resolve({ data: (t === "push_config" ? [{ id: 1, secret: "S" }] : ROWS).find((r) => f.every((g) => g(r))) ?? null }); },
  single() { return b.maybeSingle(); },
  update(p: any) { return { eq(k: string, v: any) { ROWS.filter((r) => r[k] === v).forEach((r) => Object.assign(r, p)); return Promise.resolve({}); } }; },
  insert() { return Promise.resolve({}); } }; return b; }
const storage = { from: (bk: string) => ({
  download: async (p: string) => (F[bk][p] ? { data: new Blob([F[bk][p]], { type: "image/jpeg" }), error: null } : { data: null, error: { message: "nf" } }),
  upload: async (p: string, b: Uint8Array) => { F[bk][p] = new Uint8Array(b); return { error: null }; },
  remove: async (ps: string[]) => { ps.forEach((p) => delete F[bk][p]); return { error: null }; },
  createSignedUrl: async (p: string) => ({ data: { signedUrl: "https://signed/" + p } }),
  getPublicUrl: (p: string) => ({ data: { publicUrl: "https://cdn/" + p } }) }) };
const rpc = async (fn: string, a: any) => { DONE.push({ fn, ...a }); const r = ROWS.find((x) => x.job_id === a.p_job); if (r && a.p_state !== "retry") r.state = a.p_state; return { error: null }; };
(globalThis as any).__fake = () => ({ from: q, storage, rpc });
let ai = "ok";
(globalThis as any).fetch = async (u: string) => {
  if (ai === "down") throw new Error("network");
  return new Response(JSON.stringify({ results: [{ categories: ai === "nsfw" ? { sexual: true } : {} }] }), { status: 200 });
};
let handler: any; (globalThis as any).Deno = { env: { get: () => "x" }, serve: (h: any) => (handler = h) };
console.log = ((o) => (...a: any[]) => { if (!String(a[0]).startsWith("{")) o(...a); })(console.log);
await import("./.mod.ts");
const call = async (kind: string, id: string, sec = "S") => { const r = await handler(new Request("http://f", { method: "POST", headers: { "x-near-secret": sec }, body: JSON.stringify({ kind, id }) })); return r.status + " " + await r.text(); };
console.log("без секрета:", await call("media_check", "m1", "BAD"));
console.log("m1 JPEG с GPS:", await call("media_check", "m1"));
const pub = F["post-media"]["U/p/1.jpg"];
console.log("  EXIF/GPS удален:", pub ? !/43\.2389/.test(new TextDecoder("latin1").decode(pub)) : "нет файла", "| в staging не осталось:", !F["post-staging"]["U/p/1.jpg"]);
console.log("m2 поддельный файл:", await call("media_check", "m2"), "| в публичном бакете:", !!F["post-media"]["U/p/2.jpg"]);
ai = "down"; console.log("m3 ИИ недоступен:", await call("media_check", "m3"), "| в публичном бакете:", !!F["post-media"]["U/p/3.jpg"]);
ai = "nsfw"; console.log("m4 интим:", await call("media_check", "m4"), "| в публичном бакете:", !!F["post-media"]["U/p/4.jpg"]);
console.log("m3 модератор одобрил:", await call("media_publish", "m3"), "| в публичном бакете:", !!F["post-media"]["U/p/3.jpg"]);
console.log("повтор проверки m1:", await call("media_check", "m1"));
console.log("итог:", ROWS.map((r) => r.id + "=" + r.state).join(" "));
