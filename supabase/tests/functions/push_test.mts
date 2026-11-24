const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (b) => Buffer.from(b).toString("base64url"), ub = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const vk = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const ENV = { SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "y", VAPID_PUBLIC_KEY: b64(await crypto.subtle.exportKey("raw", vk.publicKey)), VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", vk.privateKey)).d };
// браузеры-подписчики
async function mkSub(id, user, prefs, lat, lng) { const k = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]); const a = crypto.getRandomValues(new Uint8Array(16));
  return { row: { id, user_id: user, endpoint: (id === "evil" ? "https://169.254.169.254/" : "https://fcm.googleapis.com/fcm/send/") + id, p256dh: b64(await crypto.subtle.exportKey("raw", k.publicKey)), auth: b64(a), prefs, lat, lng }, key: k, auth: a }; }
const S = [await mkSub("s1", "uB", {}, 43.24, 76.91), await mkSub("s2", "uB", { msg: false }, null, null), await mkSub("s3", "uC", { near: true, radius: 1 }, 43.30, 76.95), await mkSub("s4", "uD", { quiet: false }, 43.24, 76.92), await mkSub("gone", "uB", {}, null, null), await mkSub("hid", "uB", { hide_text: true }, null, null), await mkSub("evil", "uB", {}, null, null), await mkSub("place", "uE", {}, null, null), await mkSub("noplace", "uF", {}, null, null)];
const DB = {
  push_config: [{ id: 1, secret: "SEC" }],
  push_subs: S.map((s) => s.row),
  profiles: [{ id: "uA", name: "Айгерим" }, { id: "uB", name: "Бауыржан" }],
  notifications: [{ id: "n1", user_id: "uB", actor_id: "uA", type: "likes", post_id: "11111111-2222-3333-4444-555555555555", text: "оценил(а) вашу публикацию" }],
  messages: [{ id: "m1", conversation_id: "c1c1c1c1-0000-0000-0000-000000000000", sender_id: "uA", kind: "text", text: "Привет! Ты дома?", mod_status: "ok" }],
  conversations: [{ id: "c1c1c1c1-0000-0000-0000-000000000000", user_a: "uA", user_b: "uB", status: "accepted", initiator: "uA" }], push_log: [], saved_places: [{ user_id: "uE", name: "Дом", lat: 43.241, lng: 76.913, radius: 1000, notify: true }, { user_id: "uF", name: "Работа", lat: 43.241, lng: 76.913, radius: 1000, notify: false }],
  blocks: [{ blocker_id: "uD", blocked_id: "uA" }],
  posts: [{ id: "p1p1p1p1-0000-0000-0000-000000000000", user_id: "uA", category: "incident", text: "Пожар. Нужна помощь рядом!", lat: 43.2405, lng: 76.9120, status: "active", is_sos: true },
    { id: "p2p2p2p2-0000-0000-0000-000000000000", user_id: "uA", category: "incident", text: "Текст со словом SOS, но не экстренный", lat: 43.2405, lng: 76.9120, status: "active", is_sos: false }]
};
function q(t) { let rows = DB[t].slice(); const b = {
  select() { return b; }, eq(k, v) { rows = rows.filter((r) => r[k] === v); return b; }, neq(k, v) { rows = rows.filter((r) => r[k] !== v); return b; },
  not(k, op, v) { rows = rows.filter((r) => r[k] !== null && r[k] !== undefined); return b; },
  maybeSingle() { return Promise.resolve({ data: rows[0] ?? null }); }, single() { return Promise.resolve({ data: rows[0] ?? null }); },
  delete() { const del = { eq(k, v) { DB[t] = DB[t].filter((r) => r[k] !== v); return Promise.resolve({}); } }; return del; },
  insert(x) { DB[t].push(x); return Promise.resolve({}); }, then(res) { return Promise.resolve({ data: rows }).then(res); } }; return b; }
globalThis.__fakeCreate = () => ({ from: q });
let handler; globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => (handler = h) };
const sent = [];
globalThis.fetch = async (url, o) => { const id = url.split("/").pop(); sent.push({ id, o }); return new Response("", { status: id === "gone" ? 410 : 201 }); };
await import("./.push.ts");
async function decrypt(s, body) { const salt = body.slice(0, 16), il = body[20], asPub = body.slice(21, 21 + il), ct = body.slice(21 + il);
  const H = async (salt, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const uaPub = ub(s.row.p256dh); const sh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []) }, s.key.privateKey, 256));
  const ikm = await H(s.auth, sh, Buffer.concat([enc.encode("WebPush: info\0"), uaPub, asPub]), 32);
  const k = await crypto.subtle.importKey("raw", await H(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: await H(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12) }, k, ct)); return JSON.parse(dec.decode(pt.slice(0, -1))); }
async function run(kind, id, secret = "SEC") {
  sent.length = 0; const r = await handler(new Request("http://f", { method: "POST", headers: { "x-near-secret": secret }, body: JSON.stringify({ kind, id }) }));
  const out = []; for (const x of sent) { const s = S.find((z) => z.row.id === x.id); out.push(x.id + " " + JSON.stringify(s && x.id !== "gone" ? await decrypt(s, x.o.body) : "-") + " topic=" + x.o.headers.Topic + " urg=" + x.o.headers.Urgency); }
  console.log(`[${kind}] status ${r.status} ${await r.text()}\n  ` + out.join("\n  "));
}
await run("notif", "n1", "WRONG");
await run("notif", "n1");
console.log("  'gone' removed:", !DB.push_subs.some((r) => r.id === "gone"));
await run("msg", "m1");
await run("near", "p1p1p1p1-0000-0000-0000-000000000000");
await run("near", "p2p2p2p2-0000-0000-0000-000000000000");
console.log("  evil endpoint fetched:", sent.some((x) => x.id === "evil"), "| evil removed:", !DB.push_subs.some((r) => r.id === "evil"));
console.log("  push_log rows:", DB.push_log.length, JSON.stringify(DB.push_log.at(-1)));
DB.conversations[0].status = "request";
await run("msg", "m1");
await run("bogus", "x");
