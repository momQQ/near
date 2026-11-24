// NEAR service worker (v14): оболочка приложения — сначала сеть, без интернета — сохраненная копия;
// фото публикаций, шрифты и библиотеки — из кэша; push-уведомления.
// Все кэши NEAR называются "near-*": при обновлении удаляются только старые кэши NEAR, чужие кэши сайта не трогаем.
const V = "v15";
// v14: кэш фото — новое имя: при обновлении старый кэш (v12) удаляется целиком
const CACHE = "near-shell-" + V, IMG = "near-img-v3", LIB = "near-lib-v1";
const IMG_MAX = 300, IMG_BYTES = 60 * 1048576, IMG_TTL = 7 * 86400e3; // фото: до 300 файлов, 60 МБ и 7 дней
const SHELL = ["./app.html", "./css/app.min.css", "./css/near.min.css", "./js/config.min.js", "./js/i18n.min.js", "./js/data.min.js", "./js/app.min.js",
  "./manifest.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png",
  "./fonts/inter-Regular.woff2", "./fonts/inter-SemiBold.woff2", "./fonts/inter-Bold.woff2", "./fonts/inter-ExtraBold.woff2"];
const OURS = [CACHE, IMG, LIB];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x.startsWith("near-") && !OURS.includes(x)).map((x) => caches.delete(x)))));
  self.clients.claim();
});

// ответ с отметкой времени и размера — для срока хранения и лимита по объему
async function stamp(r) {
  const b = await r.blob(), h = new Headers(r.headers);
  h.set("x-near-at", String(Date.now())); h.set("x-near-size", String(b.size));
  return new Response(b, { status: r.status, statusText: r.statusText, headers: h });
}
let trimT = null;
// уборка: сначала просроченные (старше 7 дней), затем самые старые — пока не уложимся в лимит файлов и байтов
async function trim(name, max, bytes) {
  const c = await caches.open(name), keys = await c.keys(), items = [];
  for (const k of keys) { const r = await c.match(k); items.push({ k, sz: +(r && r.headers.get("x-near-size")) || 0, at: +(r && r.headers.get("x-near-at")) || 0 }); }
  items.sort((a, b) => a.at - b.at);
  let n = items.length, total = items.reduce((t, x) => t + x.sz, 0); const now = Date.now();
  for (const it of items) {
    const stale = it.at && now - it.at > IMG_TTL;
    if (!(stale || n > max || total > bytes)) break;
    await c.delete(it.k); n--; total -= it.sz;
  }
}
// сначала из кэша (у фото уникальные имена); устаревшее — заново из сети
async function cacheFirst(req, name, opt = {}) {
  const c = await caches.open(name), hit = await c.match(req);
  if (hit) {
    const at = +hit.headers.get("x-near-at") || 0;
    if (!opt.ttl || !at || Date.now() - at < opt.ttl) return hit;
  }
  let r;
  try { r = await fetch(req); } catch (e) { if (hit) return hit; throw e; }
  if (r.ok) { // непрозрачные ответы не храним: они занимают много места
    const keep = opt.ttl ? await stamp(r.clone()) : r.clone();
    c.put(req, keep).then(() => { if (opt.max) { clearTimeout(trimT); trimT = setTimeout(() => trim(name, opt.max, opt.bytes || Infinity).catch(() => {}), 2000); } }).catch(() => {});
  }
  return r;
}
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // фото и обложки публикаций из публичного бакета Supabase (подписанные ссылки и чаты не кэшируются)
  // приватные файлы (подписанные ссылки, карантин, чаты) никогда не кэшируются
  if (/\/storage\/v1\/object\/(sign|authenticated)\//.test(u.pathname) || /post-quarantine|chat-media/.test(u.pathname)) return;
  if (/\/storage\/v1\/object\/public\/post-media\//.test(u.pathname) && !u.search && !e.request.headers.has("range") && !/\.(mp4|mov|webm|m4v)$/i.test(u.pathname)) {
    e.respondWith(cacheFirst(e.request, IMG, { max: IMG_MAX, bytes: IMG_BYTES, ttl: IMG_TTL })); return;
  }
  if (u.origin === location.origin && u.pathname.includes("/fonts/")) { e.respondWith(cacheFirst(e.request, CACHE)); return; }
  if (/^https:\/\/(unpkg\.com|cdn\.jsdelivr\.net|challenges\.cloudflare\.com)$/.test(u.origin) && /@\d/.test(u.pathname)) { e.respondWith(cacheFirst(e.request, LIB, { max: 40 })); return; }
  if (u.origin !== location.origin) return; // Supabase API, карты — напрямую
  if (u.pathname.includes("/media/") || e.request.headers.has("range")) return; // видео — напрямую, без кэша
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// сообщения от приложения: выход из аккаунта стирает кэш фото; скрытая публикация — ее фото
self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "near-wipe") e.waitUntil(caches.delete(IMG));
  if (d.type === "near-purge" && Array.isArray(d.urls)) e.waitUntil(caches.open(IMG).then((c) => Promise.all(d.urls.slice(0, 50).map((u) => c.delete(u)))));
});

/* ---------- push ---------- */
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (er) { d = { title: "NEAR", body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    // приложение открыто и на экране — оно само покажет и озвучит событие, без дубля
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === "visible" && w.focused)) return;
    await self.registration.showNotification(String(d.title || "NEAR").slice(0, 80), {
      body: String(d.body || "").slice(0, 200), tag: d.tag || undefined, renotify: false,
      icon: "icon-192.png", badge: "icon-192.png", data: { url: /^#[\w=-]+$/.test(d.url || "") ? d.url : "" }, lang: "ru"
    });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const hash = (e.notification.data && e.notification.data.url) || "";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find((x) => x.url.includes("app.html")) || wins[0];
    if (w) { await w.focus(); w.postMessage({ type: "near-open", hash, from: "push" }); return; }
    await self.clients.openWindow("./app.html" + hash + (hash ? "&src=push" : "#src=push"));
  })());
});
self.addEventListener("pushsubscriptionchange", (e) => {
  // браузер сменил подписку: приложение переподпишется при следующем открытии
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((ws) => ws.forEach((w) => w.postMessage({ type: "near-resubscribe" }))));
});
