// NEAR: отправка push-уведомлений. Вызывается базой (pg_net) при новом уведомлении,
// личном сообщении или происшествии рядом. Секреты функции: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// При развертывании выключите "Verify JWT": вызов подписан секретом из таблицы push_config.
import { createClient } from "npm:@supabase/supabase-js@2";

// ---------- Web Push (RFC 8291, aes128gcm) + VAPID (RFC 8292) на чистом WebCrypto — без npm-зависимостей.
const enc = new TextEncoder();
const b64u = {
  enc(buf: ArrayBuffer | Uint8Array): string {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str: string): Uint8Array {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out;
  }
};
const cat = (...a: Uint8Array[]) => { const n = a.reduce((x, y) => x + y.length, 0), o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}
// шифрование полезной нагрузки для конкретной подписки браузера
async function encryptPayload(p256dh: string, auth: string, payload: Uint8Array, test?: { as: CryptoKeyPair; salt: Uint8Array }) {
  const uaPub = b64u.dec(p256dh), authSecret = b64u.dec(auth);
  const as = test ? test.as : await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = test ? test.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
// подпись VAPID: JWT ES256
async function vapidAuth(endpoint: string, publicKey: string, privateKey: string, subject: string) {
  const pub = b64u.dec(publicKey);
  const jwk = { kty: "EC", crv: "P-256", x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), d: privateKey, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.enc(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body)));
  return `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${publicKey}`;
}
type Sub = { endpoint: string; p256dh: string; auth: string };
// SEC-04: отправляем только настоящим push-сервисам, без перенаправлений, с ограничением размера
const PUSH_HOST = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
export const endpointOk = (e: string) => typeof e === "string" && e.length <= 1024 && PUSH_HOST.test(e);
const MAX_PAYLOAD = 3000;
async function sendPush(sub: Sub, data: unknown, opt: { publicKey: string; privateKey: string; subject: string; ttl?: number; urgency?: string; topic?: string }) {
  if (!endpointOk(sub.endpoint)) return { status: 410, text: "endpoint not allowed" };
  let raw = enc.encode(JSON.stringify(data));
  if (raw.length > MAX_PAYLOAD) raw = enc.encode(JSON.stringify({ ...(data as Record<string, unknown>), body: "" }));
  const body = await encryptPayload(sub.p256dh, sub.auth, raw);
  const headers: Record<string, string> = {
    Authorization: await vapidAuth(sub.endpoint, opt.publicKey, opt.privateKey, opt.subject),
    "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
    TTL: String(opt.ttl ?? 86400), Urgency: opt.urgency ?? "normal"
  };
  if (opt.topic) headers.Topic = opt.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const r = await fetch(sub.endpoint, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(8000) });
  if (r.status >= 300 && r.status < 400) return { status: 410, text: "redirect refused" };
  return { status: r.status, text: r.ok ? "" : await r.text().catch(() => "") };
}

// ---------- отправка ----------
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const V = { publicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "", privateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "", subject: Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@near.app" };
const DEF = { msg: true, comment: true, like: true, friend: true, near: true, radius: 3, quiet: true, hide_text: true, sos_quiet: false }; // v14.8: текст и адрес скрыты на экране блокировки по умолчанию
type Row = Sub & { id: string; user_id: string; prefs: Record<string, unknown>; lat: number | null; lng: number | null };

let secret: string | null = null;
async function getSecret() {
  if (!secret) { const { data } = await sb.from("push_config").select("secret").eq("id", 1).single(); secret = data?.secret ?? null; }
  return secret;
}
const pref = (s: Row, k: keyof typeof DEF) => (s.prefs && k in s.prefs ? s.prefs[k] : DEF[k]);
const quietNow = () => { const h = (new Date().getUTCHours() + 5) % 24; return h >= 23 || h < 8; }; // Алматы, UTC+5
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, dLa = (b.lat - a.lat) * Math.PI / 180, dLo = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const hex = (id: string) => String(id).replace(/-/g, "").slice(0, 32);
const short = (t: string, n = 120) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
async function nameOf(id: string | null) { if (!id) return "NEAR"; const { data } = await sb.from("profiles").select("nickname,name").eq("id", id).maybeSingle(); return data?.nickname ?? data?.name ?? "NEAR"; }
async function blocked(by: string, who: string) { const { data } = await sb.from("blocks").select("blocker_id").eq("blocker_id", by).eq("blocked_id", who).maybeSingle(); return !!data; }

const stat = { sent: 0, failed: 0, removed: 0 };
async function deliver(subs: Row[], payload: Record<string, unknown>, o: { urgent?: boolean; topic?: string; sos?: boolean; secret?: Record<string, unknown> }) {
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    // тихие часы: SOS пробивает их только по явному согласию (sos_quiet)
    if (pref(s, "quiet") && quietNow() && !(o.sos && pref(s, "sos_quiet"))) return;
    // скрытие текста на экране блокировки
    const p = pref(s, "hide_text") && o.secret ? { ...payload, ...o.secret } : payload;
    try {
      const r = await sendPush(s, p, { ...V, urgency: o.urgent ? "high" : "normal", topic: o.topic, ttl: o.urgent ? 3600 : 86400 });
      if (r.status === 404 || r.status === 410) { await sb.from("push_subs").delete().eq("id", s.id); stat.removed++; } // подписка устарела
      else if (r.status < 300) { sent++; stat.sent++; }
      else { stat.failed++; console.warn("push", r.status); }
    } catch (e) { stat.failed++; console.warn("push error", (e as Error).name); }
  }));
  return sent;
}
async function subsOf(userId: string) { const { data } = await sb.from("push_subs").select("*").eq("user_id", userId); return (data ?? []) as Row[]; }

const NOTIF_PREF: Record<string, keyof typeof DEF> = { likes: "like", comments: "comment", reply: "comment", sos_closed: "comment", event_members: "comment", friend_request: "friend", friend_accept: "friend" };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("x-near-secret") !== (await getSecret())) return new Response("forbidden", { status: 403 });
  if (!V.publicKey || !V.privateKey) return new Response("VAPID keys missing", { status: 500 });
  const { kind, id } = await req.json().catch(() => ({}));
  if (!["notif", "msg", "near"].includes(kind) || typeof id !== "string") return new Response("bad request", { status: 400 });
  const corr = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
  stat.sent = 0; stat.failed = 0; stat.removed = 0;
  let sent = 0;

  if (kind === "notif") {
    const { data: n } = await sb.from("notifications").select("*").eq("id", id).maybeSingle();
    if (!n) return new Response("no row");
    const pk = NOTIF_PREF[n.type];
    const subs = (await subsOf(n.user_id)).filter((s) => !pk || pref(s, pk));
    if (subs.length) {
      const who = n.actor_id ? await nameOf(n.actor_id) : "NEAR";
      // v14.8: ссылка из уведомления (комната/встреча); приложение при открытии проверяет доступ
      const url = typeof n.link === "string" && /^#(room|meet|post|user)=[0-9a-f-]{36}$/.test(n.link) ? n.link : n.post_id ? "#post=" + n.post_id : n.actor_id ? "#user=" + n.actor_id : "#notif";
      const { data: pr } = await sb.from("profiles").select("notify_level").eq("id", n.user_id).maybeSingle();
      if (pr?.notify_level === "off") return new Response("off");
      sent = await deliver(subs, { title: who, body: short(n.text ?? ""), url, silent: pr?.notify_level === "silent", tag: "n" + hex(n.room_id ?? n.post_id ?? n.id).slice(0, 20) + n.type.slice(0, 8) },
        { topic: "n" + hex(n.post_id ?? n.id).slice(0, 23) + n.type.slice(0, 8), secret: { title: "NEAR", body: "Новое уведомление" } });
    }
  }

  if (kind === "msg") {
    const { data: m } = await sb.from("messages").select("id,conversation_id,sender_id,kind,text,mod_status").eq("id", id).maybeSingle();
    if (!m || !m.sender_id || m.mod_status !== "ok") return new Response("skip");
    const { data: c } = await sb.from("conversations").select("user_a,user_b,status,initiator").eq("id", m.conversation_id).single();
    const to = c.user_a === m.sender_id ? c.user_b : c.user_a;
    if (!to || (await blocked(to, m.sender_id)) || c.status === "declined") return new Response("skip");
    const isRequest = c.status === "request" && c.initiator === m.sender_id;
    const subs = (await subsOf(to)).filter((s) => pref(s, "msg"));
    if (subs.length) {
      const body = m.kind === "text" ? short(m.text ?? "") : ({ image: "📷 Фото", video: "🎬 Видео", audio: "🎤 Голосовое сообщение" } as Record<string, string>)[m.kind] ?? "Новое сообщение";
      const title = (isRequest ? "Запрос на общение · " : "") + await nameOf(m.sender_id);
      sent = await deliver(subs, { title, body: isRequest ? "Хочет написать вам" : body, url: "#conv=" + m.conversation_id, tag: "c" + hex(m.conversation_id) },
        { urgent: !isRequest, topic: "c" + hex(m.conversation_id).slice(0, 31), secret: { title: "NEAR", body: "Новое сообщение" } });
    }
  }

  if (kind === "near") {
    const { data: p } = await sb.from("posts").select("id,user_id,category,text,lat,lng,status,is_sos,expires_at").eq("id", id).maybeSingle();
    if (!p || p.status !== "active" || (p.expires_at && new Date(p.expires_at) < new Date())) return new Response("skip");
    const sos = p.is_sos === true; // SOS-01: только явный признак, не текст
    const { data } = await sb.from("push_subs").select("*").neq("user_id", p.user_id).not("lat", "is", null);
    const subs = ((data ?? []) as Row[]).filter((s) => pref(s, "near") && km(p, { lat: s.lat!, lng: s.lng! }) <= Math.min(10, Number(pref(s, "radius")) || 3));
    const { data: bl } = await sb.from("blocks").select("blocker_id").eq("blocked_id", p.user_id);
    const blockedBy = new Set((bl ?? []).map((x) => x.blocker_id));
    const ok = subs.filter((s) => !blockedBy.has(s.user_id));
    const dist = (d: number) => (d < 1 ? Math.max(100, Math.round(d * 10) * 100) + " м" : d.toFixed(1).replace(".", ",") + " км");
    const done = new Set<string>();
    // каждому подписчику — с его расстоянием
    for (const s of ok) {
      const d = km(p, { lat: s.lat!, lng: s.lng! }); done.add(s.user_id);
      sent += await deliver([s], { title: sos ? "🆘 SOS рядом" : "🚨 Происшествие рядом", body: `${dist(d)} · ${short(p.text ?? "", 100)}`, url: "#post=" + p.id, tag: "p" + hex(p.id) },
        { urgent: sos, topic: "p" + hex(p.id).slice(0, 31), sos, secret: { title: sos ? "🆘 SOS рядом" : "NEAR", body: "Откройте приложение, чтобы посмотреть" } });
    }
    // избранные места: только места с включенными уведомлениями (согласие пользователя)
    const { data: places } = await sb.from("saved_places").select("user_id,name,lat,lng,radius,notify").eq("notify", true).neq("user_id", p.user_id);
    for (const pl of (places ?? []) as { user_id: string; name: string; lat: number; lng: number; radius: number }[]) {
      if (done.has(pl.user_id) || blockedBy.has(pl.user_id)) continue;
      const d = km(p, pl); if (d * 1000 > pl.radius) continue;
      done.add(pl.user_id);
      const ps = (await subsOf(pl.user_id)).filter((x) => pref(x, "near"));
      if (ps.length) sent += await deliver(ps, { title: (sos ? "🆘 SOS" : "🚨 Происшествие") + " · " + short(pl.name, 30), body: `${dist(d)} от места · ${short(p.text ?? "", 90)}`, url: "#post=" + p.id, tag: "p" + hex(p.id) },
        { urgent: sos, topic: "p" + hex(p.id).slice(0, 31), sos, secret: { title: sos ? "🆘 SOS" : "NEAR", body: "Откройте приложение, чтобы посмотреть" } });
    }
  }
  // журнал без содержимого: только счетчики
  await sb.from("push_log").insert({ kind, sent: stat.sent, failed: stat.failed, removed: stat.removed }).then(() => {}, () => {});
  console.log(JSON.stringify({ fn: "push", corr, kind, sent: stat.sent, failed: stat.failed, removed: stat.removed }));
  return new Response(JSON.stringify({ sent }), { headers: { "Content-Type": "application/json" } });
});
