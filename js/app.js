/* =====================================================
   NEAR — интерфейс приложения
   ===================================================== */
(function () {
  "use strict";
  const CFG = window.NEAR_CONFIG || {};
  const N = window.NEAR;
  const CATS = N.CATS, CITY = N.CITY;
  let api = null, user = null;

  /* ---------- helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let toastT = null;
  function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 2600); }
  function timeAgo(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "только что";
    if (s < 3600) return Math.floor(s / 60) + " мин назад";
    if (s < 86400) return Math.floor(s / 3600) + " ч назад";
    if (s < 86400 * 7) return Math.floor(s / 86400) + " д назад";
    return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  }
  const fmtDist = (m) => (m < 1000 ? Math.round(m / 10) * 10 + " м" : (m / 1000).toFixed(1).replace(".", ",") + " км");
  const fmtWhen = (iso) => new Date(iso).toLocaleString("ru-RU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const initial = (n) => (String(n || "?").trim()[0] || "?").toUpperCase();
  function ava(a, color = "#ff2e88") {
    a = a || {};
    return a.avatar_url
      ? `<span class="ava"><img src="${esc(a.avatar_url)}" alt=""></span>`
      : `<span class="ava" style="background:${color}22;color:${color}">${esc(initial(a.name))}</span>`;
  }
  function loadScript(src, timeout = 12000) {
    return new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src; s.async = true;
      const t = setTimeout(() => rej(new Error("timeout " + src)), timeout);
      s.onload = () => { clearTimeout(t); res(); }; s.onerror = () => { clearTimeout(t); rej(new Error("load " + src)); };
      document.head.appendChild(s);
    });
  }

  /* ---------- state ---------- */
  let pos = { lat: CITY.lat, lng: CITY.lng, real: false };
  let R = 3000, feedCat = "all", feedPosts = [], shown = 20;
  const cache = new Map();
  const remember = (list) => { list.forEach((p) => cache.set(p.id, p)); return list; };
  const D = (p) => N.dist(pos, p);
  const CHIPS = [["all", "🔥 Все"], ["incident", "🚨 Происшествия"], ["event", "🎉 События"], ["deal", "🏷️ Акции"], ["lostfound", "🔎 Потери и находки"], ["meetup", "⚽ Встречи"], ["ad", "📢 Обьявления"], ["talk", "💬 Обсуждения"]];
  const catFilter = (c) => (c === "all" ? null : c === "lostfound" ? ["lost", "found"] : c);
  const DISTRICTS = [
    ["Алмалинский", 43.2530, 76.9100], ["Бостандыкский", 43.2150, 76.9050], ["Медеуский", 43.2400, 76.9700], ["Ауэзовский", 43.2300, 76.8400],
    ["Алатауский", 43.2750, 76.8100], ["Наурызбайский", 43.1950, 76.7900], ["Жетысуский", 43.2950, 76.9400], ["Турксибский", 43.3350, 76.9700]
  ];

  /* ---------- navigation ---------- */
  let hist = [];
  const TABS = ["v-feed", "v-map", "v-disc", "v-create", "v-com", "v-prof"];
  const cur = () => { const v = document.querySelector(".view.on:not(#v-auth)"); return v ? v.id : "v-feed"; };
  function go(id, push = true) {
    const c = cur();
    if (c === id) return;
    if (push) hist.push(c);
    qa(".view").forEach((v) => { if (v.id !== "v-auth") v.classList.remove("on"); });
    $(id).classList.add("on");
    $(id).scrollTop = 0;
    document.body.classList.toggle("picking", id === "sv-pick");
    const tab = TABS.includes(id) ? id : null;
    if (tab) qa(".tb,.tb-plus").forEach((x) => x.classList.toggle("on", x.dataset.v === tab));
    onEnter(id);
  }
  function back() { go(hist.pop() || "v-feed", false); }
  function onEnter(id) {
    if (id === "v-map") initMap();
    if (id === "v-prof") renderProfile();
    if (id === "v-disc") loadWide().then(updateDiscCounts).catch(() => {});
    if (id === "sv-radar") renderRadar();
    if (id === "sv-events") renderEvents();
    if (id === "sv-deals") renderDeals();
    if (id === "sv-lost") renderLost();
    if (id === "sv-notif") renderNotifs();
    if (id === "v-feed" && feedDirty) loadFeed();
  }
  qa("[data-v]").forEach((b) => (b.onclick = () => {
    if (b.dataset.v === "v-create") { if (!requireAuth("Войдите, чтобы публиковать")) return; openCreate({}); return; }
    hist = []; go(b.dataset.v, false);
  }));
  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-open]"); if (o) { go(o.dataset.open); return; }
    const b = e.target.closest("[data-back]"); if (b) { back(); return; }
    const c = e.target.closest("[data-create]"); if (c) { if (requireAuth("Войдите, чтобы публиковать")) openCreate({ type: c.dataset.create }); }
  });

  /* ---------- bottom sheet ---------- */
  function openSheet(title, html) { $("bsTitle").textContent = title; $("bsList").innerHTML = html; $("sheetBg").classList.add("on"); $("bsheet").classList.add("on"); }
  function closeSheet() { $("sheetBg").classList.remove("on"); $("bsheet").classList.remove("on"); }
  $("sheetBg").onclick = closeSheet;
  function confirmSheet(title, text, okLabel, danger) {
    return new Promise((res) => {
      openSheet(title, `<p class="muted" style="font-size:13px;margin-bottom:14px">${esc(text)}</p><div class="sheet-btns"><button class="btn btn-ghost" id="cfNo">Отмена</button><button class="btn btn-main" id="cfYes" ${danger ? 'style="background:#e5243b"' : ""}>${esc(okLabel)}</button></div>`);
      $("cfNo").onclick = () => { closeSheet(); res(false); };
      $("cfYes").onclick = () => { closeSheet(); res(true); };
    });
  }

  /* =====================================================
     AUTH
     ===================================================== */
  let resetEmail = null;
  function showAuth(panel = "login", err) {
    document.body.classList.add("authing");
    $("v-auth").classList.add("on");
    qa(".auth-p").forEach((f) => f.classList.add("hidden"));
    $("f-" + panel).classList.remove("hidden");
    qa("[data-err]").forEach((x) => x.classList.remove("on"));
    if (err) { const e = $("f-" + panel).querySelector("[data-err]"); if (e) { e.textContent = err; e.classList.add("on"); } }
    $("guestBtn").classList.toggle("hidden", panel === "reset");
    $("v-auth").scrollTop = 0;
  }
  function hideAuth() { document.body.classList.remove("authing"); $("v-auth").classList.remove("on"); if (!document.querySelector(".view.on")) go("v-feed", false); }
  function requireAuth(reason) { if (user) return true; showAuth("login", reason); return false; }
  function formErr(form, msg) { const e = form.querySelector("[data-err]"); e.textContent = msg; e.classList.add("on"); }
  async function busy(btn, fn) {
    const t = btn.textContent; btn.disabled = true; btn.textContent = "Подождите...";
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = t; }
  }
  qa("[data-auth]").forEach((b) => (b.onclick = () => showAuth(b.dataset.auth)));
  qa("[data-eye]").forEach((b) => (b.onclick = () => { const i = b.previousElementSibling; i.type = i.type === "password" ? "text" : "password"; b.textContent = i.type === "password" ? "👁" : "🙈"; }));
  $("guestBtn").onclick = () => { try { localStorage.setItem("near_guest", "1"); } catch (e) {} hideAuth(); toast("Вы смотрите как гость. Чтобы публиковать, войдите в Профиле"); };

  $("f-login").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target, fd = new FormData(f);
    if (!fd.get("email") || !fd.get("password")) return formErr(f, "Заполните email и пароль");
    try { await busy(f.querySelector("[type=submit]"), () => api.signIn({ email: fd.get("email"), password: fd.get("password") })); user = api.user(); afterLogin(); }
    catch (err) { formErr(f, err.message); }
  };
  $("f-signup").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target, fd = new FormData(f);
    const data = { first: (fd.get("first") || "").trim(), last: (fd.get("last") || "").trim(), email: (fd.get("email") || "").trim(), password: fd.get("password") || "" };
    if (!data.first) return formErr(f, "Укажите имя");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return formErr(f, "Проверьте правильность email");
    if (data.password.length < 6) return formErr(f, "Пароль должен быть не короче 6 символов");
    try {
      const r = await busy(f.querySelector("[type=submit]"), () => api.signUp(data));
      if (r.needsConfirm) { $("sentText").innerHTML = `Мы отправили письмо на <b>${esc(data.email)}</b>. Откройте его и нажмите ссылку, чтобы подтвердить почту. После этого вы войдете автоматически.`; showAuth("sent"); }
      else { user = api.user(); afterLogin(true); }
    } catch (err) { formErr(f, err.message); }
  };
  $("f-forgot").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target, email = (new FormData(f).get("email") || "").trim();
    if (!email) return formErr(f, "Укажите email");
    try {
      const r = await busy(f.querySelector("[type=submit]"), () => api.resetPassword(email));
      if (r.localEmail) { resetEmail = r.localEmail; showAuth("reset"); toast("Демо-режим: задайте новый пароль сразу"); }
      else { $("sentText").innerHTML = `Ссылка для нового пароля отправлена на <b>${esc(email)}</b>.`; showAuth("sent"); }
    } catch (err) { formErr(f, err.message); }
  };
  $("f-reset").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target, pw = new FormData(f).get("password") || "";
    try { await busy(f.querySelector("[type=submit]"), () => api.updatePassword(pw, resetEmail)); resetEmail = null; history.replaceState(null, "", location.pathname); user = api.user(); afterLogin(); toast("✓ Пароль изменен"); }
    catch (err) { formErr(f, err.message); }
  };
  function afterLogin(isNew) {
    hideAuth(); qa(".auth-p").forEach((f) => f.reset && f.reset());
    toast(isNew ? "🎉 Добро пожаловать в NEAR, " + (user && user.name) + "!" : "👋 Привет, " + (user && user.name) + "!");
    onUserChange();
  }
  function onUserChange() {
    feedDirty = true; wide = null; loadFeed(); refreshBadge(); if (cur() === "v-prof") renderProfile();
    if (mapReady) loadMapPosts();
  }

  /* =====================================================
     LOCATION
     ===================================================== */
  function getGeo(highAcc = false) {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error("Геолокация не поддерживается"));
      navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => rej(new Error(e.code === 1 ? "Доступ к геопозиции запрещен. Разрешите его в настройках браузера." : "Не удалось определить местоположение")),
        { enableHighAccuracy: highAcc, timeout: 10000, maximumAge: 120000 }
      );
    });
  }
  async function useMyLocation(silent) {
    try {
      const g = await getGeo();
      // если пользователь далеко от города — показываем Алматы (приложение пока для Алматы)
      if (N.dist(g, CITY) > 60000) { if (!silent) toast("Вы далеко от Алматы, показываем центр города"); return false; }
      pos = { lat: g.lat, lng: g.lng, real: true }; $("locName").textContent = "Рядом со мной";
      return true;
    } catch (e) { if (!silent) toast(e.message); return false; }
  }
  $("locBtn").onclick = () => {
    openSheet("Где смотреть?", `<button class="opt-row${pos.real ? " on" : ""}" data-loc="me">📍 Мое местоположение<span>${pos.real ? "✓" : ""}</span></button>` +
      DISTRICTS.map((d) => `<button class="opt-row${$("locName").textContent === d[0] ? " on" : ""}" data-loc="${d[0]}">${d[0]} район<span>${$("locName").textContent === d[0] ? "✓" : ""}</span></button>`).join(""));
    qa("[data-loc]", $("bsList")).forEach((b) => (b.onclick = async () => {
      closeSheet();
      if (b.dataset.loc === "me") { if (!(await useMyLocation())) return; }
      else { const d = DISTRICTS.find((x) => x[0] === b.dataset.loc); pos = { lat: d[1], lng: d[2], real: false }; $("locName").textContent = d[0]; }
      wide = null; loadFeed(); if (mapReady) { drawMe(); map.setView([pos.lat, pos.lng], zoomFor(R)); }
      toast("📍 " + $("locName").textContent);
    }));
  };

  /* =====================================================
     FEED
     ===================================================== */
  let feedDirty = false;
  function chipsHtml(active) { return CHIPS.map(([k, n]) => `<button class="chip${k === active ? " on" : ""}" data-c="${k}">${n}</button>`).join(""); }
  $("cats").innerHTML = chipsHtml("all");
  $("cats").onclick = (e) => { const b = e.target.closest("[data-c]"); if (!b) return; feedCat = b.dataset.c; $("cats").innerHTML = chipsHtml(feedCat); loadFeed(); };
  $("radius").onclick = (e) => { const b = e.target.closest("[data-r]"); if (!b) return; setRadius(+b.dataset.r); loadFeed(); };
  function setRadius(r) {
    R = r;
    qa("#radius [data-r], #mapRad [data-r]").forEach((x) => x.classList.toggle("on", +x.dataset.r === r));
    if (mapReady) { drawMe(); }
  }
  $("refreshBtn").onclick = () => { $("refreshBtn").style.background = ""; wide = null; loadFeed(); };

  function mediaBox(p, cls = "post-img") {
    const c = CATS[p.category] || CATS.talk, m = p.media[0];
    const multi = p.media.length > 1 ? `<span class="multi">1/${p.media.length}</span>` : "";
    if (m && m.type === "image") return `<div class="${cls}" style="background-image:url('${esc(m.url)}')">${multi}</div>`;
    if (m && m.type === "video") return `<div class="${cls}" style="background:#000"><video src="${esc(m.url)}#t=0.5" muted playsinline preload="metadata"></video><span class="play">▶</span>${multi}</div>`;
    return `<div class="${cls}" style="background:linear-gradient(135deg,${c.c}66,#1f1f2e 75%)">${c.e}</div>`;
  }
  function card(p) {
    const c = CATS[p.category] || CATS.talk, closed = p.status === "closed";
    let act;
    if (p.event) act = `<button class="act${p.event.joined ? " joined" : ""}" data-join="${p.id}">${p.event.joined ? "✓ Иду" : "Иду"} · ${p.event.members}${p.event.capacity ? "/" + p.event.capacity : ""}</button>`;
    else act = `<button class="act" data-onmap="${p.id}">🗺 На карте</button>`;
    return `<div class="post${closed ? " closed" : ""}" data-post="${p.id}">
      <div class="post-h">${ava(p.author, c.c)}<div class="who"><b>${esc(p.author.name)}</b><span>${timeAgo(p.created_at)} · ${fmtDist(D(p))}</span></div>
        <span class="st ${closed ? "done" : ""}" style="${closed ? "" : `background:${c.c}22;color:${c.c}`}">${closed ? "Закрыто" : c.e + " " + c.n}</span></div>
      ${mediaBox(p)}
      <div class="post-d">${esc(p.text)}</div>
      ${p.event ? `<div class="post-meta">🗓 ${fmtWhen(p.event.starts_at)}</div>` : ""}
      <div class="post-f"><button class="lk${p.liked ? " on" : ""}" data-like="${p.id}">${p.liked ? "♥" : "♡"} ${p.likes}</button><button data-cmt="${p.id}">💬 ${p.comments}</button><button class="sv${p.saved ? " on" : ""}" data-save="${p.id}">${p.saved ? "★" : "☆"}</button>${closed ? "" : act}</div>
    </div>`;
  }
  async function loadFeed() {
    feedDirty = false;
    if (!api) return;
    $("posts").innerHTML = '<div class="spin"></div>';
    try {
      feedPosts = remember(await api.listPosts({ lat: pos.lat, lng: pos.lng, radius: R, category: catFilter(feedCat), limit: 300 }));
      shown = 20; renderFeed(); updateChanges();
    } catch (e) {
      $("posts").innerHTML = `<div class="empty"><b>Не удалось загрузить ленту</b>${esc(e.message)}<br><button class="btn btn-main mt12" id="retryFeed">Повторить</button></div>`;
      $("retryFeed").onclick = loadFeed;
    }
  }
  function renderFeed() {
    if (!feedPosts.length) {
      $("posts").innerHTML = `<div class="empty"><b>Здесь пока тихо</b>В радиусе ${fmtDist(R)} нет публикаций${feedCat !== "all" ? " в этой категории" : ""}.<br>Увеличьте радиус или опубликуйте первым!<br><button class="btn btn-main mt12" data-create="talk">+ Опубликовать</button></div>`;
      return;
    }
    $("posts").innerHTML = feedPosts.slice(0, shown).map(card).join("") + (feedPosts.length > shown ? `<button class="more" id="moreBtn">Показать еще (${feedPosts.length - shown})</button>` : "");
    if ($("moreBtn")) $("moreBtn").onclick = () => { shown += 20; renderFeed(); };
  }
  function updateChanges() {
    const hr = feedPosts.filter((p) => Date.now() - new Date(p.created_at) < 3600e3);
    if (!hr.length) { $("changesText").textContent = `За последний час новых публикаций нет · всего рядом: ${feedPosts.length}`; return; }
    const by = {}; hr.forEach((p) => (by[p.category] = (by[p.category] || 0) + 1));
    $("changesText").textContent = Object.entries(by).map(([k, v]) => `${CATS[k].e} ${CATS[k].n.toLowerCase()}: ${v}`).join(" · ");
  }
  function refreshCardEverywhere(p) {
    qa(`[data-post="${p.id}"]`).forEach((el) => { if (el.classList.contains("post")) el.outerHTML = card(p); });
    if (cur() === "sv-post" && openPostId === p.id) renderDetail(p);
  }

  /* post actions (shared) */
  async function doLike(id) {
    if (!requireAuth("Войдите, чтобы ставить лайки")) return;
    const p = cache.get(id); if (!p) return;
    p.liked = !p.liked; p.likes += p.liked ? 1 : -1; refreshCardEverywhere(p);
    try { const r = await api.toggleLike(id); p.liked = r.liked; p.likes = r.likes; refreshCardEverywhere(p); }
    catch (e) { p.liked = !p.liked; p.likes += p.liked ? 1 : -1; refreshCardEverywhere(p); toast(e.message); }
  }
  async function doSave(id) {
    if (!requireAuth("Войдите, чтобы сохранять публикации")) return;
    const p = cache.get(id); if (!p) return;
    try { p.saved = await api.toggleSave(id); refreshCardEverywhere(p); toast(p.saved ? "★ Сохранено в профиль" : "Убрано из сохраненного"); }
    catch (e) { toast(e.message); }
  }
  async function doJoin(id) {
    if (!requireAuth("Войдите, чтобы участвовать")) return;
    const p = cache.get(id); if (!p || !p.event) return;
    try { const r = await api.toggleJoin(id); p.event.joined = r.joined; p.event.members = r.members; refreshCardEverywhere(p); if (cur() === "sv-events") renderEvents(); toast(r.joined ? "🎉 Вы участвуете! Напомним в календаре" : "Участие отменено"); }
    catch (e) { toast(e.message); }
  }
  function showOnMap(id) { const p = cache.get(id); if (!p) return; pendingFocus = p; hist = []; go("v-map", false); if (mapReady) focusPost(p); }
  function postClick(e) {
    const t = e.target;
    let b;
    if ((b = t.closest("[data-like]"))) return doLike(b.dataset.like);
    if ((b = t.closest("[data-save]"))) return doSave(b.dataset.save);
    if ((b = t.closest("[data-join]"))) return doJoin(b.dataset.join);
    if ((b = t.closest("[data-onmap]"))) return showOnMap(b.dataset.onmap);
    if ((b = t.closest("[data-cmt]"))) return openPost(b.dataset.cmt, true);
    if ((b = t.closest("[data-post]"))) return openPost(b.dataset.post);
  }
  $("posts").onclick = postClick;

  /* =====================================================
     POST DETAIL
     ===================================================== */
  let openPostId = null, openComments = [];
  async function openPost(id, focusComment) {
    openPostId = id; go("sv-post");
    const p0 = cache.get(id);
    if (p0) renderDetail(p0); else $("pdBody").innerHTML = '<div class="spin"></div>';
    try {
      const [p, cm] = await Promise.all([api.getPost(id), api.listComments(id)]);
      if (openPostId !== id) return;
      cache.set(id, p); openComments = cm; renderDetail(p);
      if (focusComment && $("cmIn")) setTimeout(() => $("cmIn").focus(), 200);
    } catch (e) { $("pdBody").innerHTML = `<div class="empty"><b>Не открылось</b>${esc(e.message)}</div>`; }
  }
  function renderDetail(p) {
    const c = CATS[p.category] || CATS.talk, mine = user && user.id === p.user_id, closed = p.status === "closed";
    $("pdSub").textContent = c.e + " " + c.n + " · " + fmtDist(D(p)) + " от вас";
    const media = p.media.length
      ? `<div class="pd-media">${p.media.map((m) => m.type === "video" ? `<video src="${esc(m.url)}" controls playsinline preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="" loading="lazy">`).join("")}</div>`
      : `<div class="pd-media"><div class="pd-ph" style="background:linear-gradient(135deg,${c.c}55,#1f1f2e 80%)">${c.e}</div></div>`;
    const ev = p.event ? `<div class="ev-box"><b>🗓 ${fmtWhen(p.event.starts_at)}</b><div class="muted" style="font-size:12px;margin-top:3px">Участников: ${p.event.members}${p.event.capacity ? " из " + p.event.capacity : ""}</div>
      <div class="row">${closed ? "" : `<button class="btn ${p.event.joined ? "btn-ghost" : "btn-main"}" data-join="${p.id}">${p.event.joined ? "✓ Я иду · отменить" : "Иду"}</button>`}<button class="btn btn-ghost" id="pdCal">📅 В календарь</button></div></div>` : "";
    const closeLabel = closed ? "↩ Вернуть" : (p.category === "lost" || p.category === "found") ? "✅ Вернули хозяину" : "✅ Неактуально";
    const own = mine ? `<div class="own"><button id="pdEdit">✏️ Изменить</button><button id="pdClose">${closeLabel}</button><button class="del" id="pdDel">🗑 Удалить</button></div>` : "";
    const cms = openPostId === p.id ? openComments : [];
    $("pdBody").innerHTML = `
      <div class="pd-author">${ava(p.author, c.c)}<div><b>${esc(p.author.name)}</b><span>${timeAgo(p.created_at)}${p.updated_at && p.updated_at !== p.created_at && new Date(p.updated_at) - new Date(p.created_at) > 60000 ? " · изменено" : ""}</span></div></div>
      ${closed ? `<div class="closed-note">✅ Автор отметил публикацию как неактуальную</div>` : ""}
      ${media}
      <div class="pd-text">${esc(p.text)}</div>
      ${ev}
      <div class="pd-acts"><button class="lk${p.liked ? " on" : ""}" data-like="${p.id}">${p.liked ? "♥" : "♡"} ${p.likes}</button><button class="sv${p.saved ? " on" : ""}" data-save="${p.id}">${p.saved ? "★ Сохр." : "☆ Сохранить"}</button><button data-onmap="${p.id}">🗺 Карта</button><button id="pdShare">↗ Поделиться</button></div>
      ${own}
      <div class="lbl">Комментарии · ${cms.length}</div>
      <div class="cmts">${cms.map((x) => `<div class="cmt">${ava(x.author)}<div><b>${esc(x.author.name)} <span class="dim" style="font-weight:400">· ${timeAgo(x.created_at)}</span></b><span>${esc(x.text)}</span></div>${user && user.id === x.user_id ? `<button class="x" data-delcm="${x.id}">✕</button>` : ""}</div>`).join("") || '<div class="dim" style="font-size:12px;margin-bottom:10px">Пока нет комментариев. Будьте первым!</div>'}</div>
      ${user ? `<form class="inrow cmt-form" id="cmForm"><input id="cmIn" placeholder="Написать комментарий..." maxlength="500" autocomplete="off"><button type="submit">➤</button></form>` : `<button class="btn btn-ghost full" id="cmLogin">Войдите, чтобы комментировать</button>`}`;
    bindDetail(p);
  }
  function bindDetail(p) {
    const body = $("pdBody");
    body.onclick = (e) => {
      let b;
      if ((b = e.target.closest("[data-like]"))) return doLike(p.id);
      if ((b = e.target.closest("[data-save]"))) return doSave(p.id);
      if ((b = e.target.closest("[data-join]"))) return doJoin(p.id);
      if ((b = e.target.closest("[data-onmap]"))) return showOnMap(p.id);
      if ((b = e.target.closest("[data-delcm]"))) return delComment(b.dataset.delcm);
    };
    if ($("pdShare")) $("pdShare").onclick = () => sharePost(p);
    if ($("pdCal")) $("pdCal").onclick = () => addToCalendar(p);
    if ($("cmLogin")) $("cmLogin").onclick = () => requireAuth("Войдите, чтобы комментировать");
    if ($("cmForm")) $("cmForm").onsubmit = async (e) => {
      e.preventDefault(); const v = $("cmIn").value.trim(); if (!v) return;
      $("cmIn").disabled = true;
      try { await api.addComment(p.id, v); openComments = await api.listComments(p.id); p.comments = openComments.length; renderDetail(p); refreshCardEverywhere(p); }
      catch (err) { toast(err.message); $("cmIn").disabled = false; }
    };
    if ($("pdEdit")) $("pdEdit").onclick = () => openCreate({ edit: p });
    if ($("pdClose")) $("pdClose").onclick = async () => {
      try { const np = await api.updatePost(p.id, { status: p.status === "closed" ? "active" : "closed" }); cache.set(p.id, np); renderDetail(np); feedDirty = true; wide = null; if (mapReady) loadMapPosts(); toast(np.status === "closed" ? "✅ Отмечено как неактуальное" : "Публикация снова активна"); }
      catch (e) { toast(e.message); }
    };
    if ($("pdDel")) $("pdDel").onclick = async () => {
      if (!(await confirmSheet("Удалить публикацию?", "Публикация, фото и комментарии будут удалены без возможности восстановления.", "Удалить", true))) return;
      try { await api.deletePost(p.id); cache.delete(p.id); feedPosts = feedPosts.filter((x) => x.id !== p.id); wide = null; feedDirty = true; if (mapReady) loadMapPosts(); toast("🗑 Публикация удалена"); back(); }
      catch (e) { toast(e.message); }
    };
  }
  async function delComment(cid) {
    try { await api.deleteComment(cid); openComments = await api.listComments(openPostId); const p = cache.get(openPostId); p.comments = openComments.length; renderDetail(p); refreshCardEverywhere(p); }
    catch (e) { toast(e.message); }
  }
  function postLink(p) { return location.origin + location.pathname + "#post=" + p.id; }
  async function sharePost(p) {
    const data = { title: "NEAR", text: p.text.slice(0, 120), url: postLink(p) };
    try { if (navigator.share) { await navigator.share(data); return; } } catch (e) { if (e.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(data.url); toast("🔗 Ссылка скопирована"); } catch (e) { toast(data.url); }
  }
  function addToCalendar(p) {
    const s = new Date(p.event.starts_at), e = new Date(s.getTime() + 2 * 3600e3);
    const f = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NEAR//RU", "BEGIN:VEVENT", "UID:" + p.id + "@near", "DTSTAMP:" + f(new Date()), "DTSTART:" + f(s), "DTEND:" + f(e),
      "SUMMARY:" + p.text.slice(0, 60).replace(/[\n,;]/g, " "), "DESCRIPTION:" + postLink(p), "GEO:" + p.lat + ";" + p.lng, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    try { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" })); a.download = "near-event.ics"; document.body.appendChild(a); a.click(); a.remove(); toast("📅 Файл события скачан, откройте его, чтобы добавить в календарь"); }
    catch (e) { toast("Не удалось создать событие календаря"); }
  }

  /* =====================================================
     CREATE / EDIT
     ===================================================== */
  const ORDER = ["incident", "event", "deal", "meetup", "lost", "found", "ad", "talk"];
  const cr = { type: null, files: [], loc: null, edit: null };
  $("typeGrid").innerHTML = ORDER.map((k) => `<button type="button" data-type="${k}"><span>${CATS[k].e}</span>${CATS[k].n}</button>`).join("");
  $("typeGrid").onclick = (e) => { const b = e.target.closest("[data-type]"); if (b) setType(b.dataset.type); };
  function setType(t) {
    cr.type = t; qa("#typeGrid [data-type]").forEach((x) => x.classList.toggle("on", x.dataset.type === t));
    $("crEvent").classList.toggle("hidden", !(t === "event" || t === "meetup"));
    const ph = { incident: "Что случилось? Например: ДТП, перекрыта дорога, отключили воду", event: "Что за событие, где и для кого?", deal: "Какая акция, где и до какого времени?", meetup: "Кого ищете и чем займетесь?", lost: "Что потеряли, где и когда? Особые приметы", found: "Что нашли и где? Как с вами связаться", ad: "Продам, отдам, ищу мастера...", talk: "О чем хотите спросить соседей?" };
    $("crText").placeholder = ph[t] || "Опишите, что происходит";
  }
  function openCreate({ type, edit } = {}) {
    cr.files.forEach((f) => f._url && URL.revokeObjectURL(f._url));
    cr.files = []; cr.edit = edit || null; $("crErr").classList.remove("on"); $("crProg").textContent = "";
    $("crTitle").textContent = edit ? "Редактирование" : "Новая публикация";
    $("crSub").textContent = edit ? "фото и место не меняются" : "что происходит рядом?";
    $("crMediaBlock").classList.toggle("hidden", !!edit);
    $("crLocBlock").classList.toggle("hidden", !!edit);
    $("pubBtn").textContent = edit ? "Сохранить изменения" : "Опубликовать";
    $("crBack").classList.toggle("hidden", !edit);
    $("crText").value = edit ? edit.text : ""; $("crCount").textContent = $("crText").value.length;
    $("crWhen").value = ""; $("crCap").value = "";
    if (edit && edit.event) {
      const d = new Date(edit.event.starts_at); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      $("crWhen").value = d.toISOString().slice(0, 16); $("crCap").value = edit.event.capacity || "";
    }
    setType(edit ? edit.category : type || null);
    if (!edit) { cr.loc = pos.real ? { lat: pos.lat, lng: pos.lng, how: "here" } : null; renderLoc(); }
    renderMedia();
    if (edit) go("v-create"); else { hist = []; go("v-create", false); }
  }
  $("crBack").onclick = back;
  $("crText").oninput = () => { $("crCount").textContent = $("crText").value.length; };
  $("addGallery").onclick = () => $("fileGallery").click();
  $("addCamera").onclick = () => $("fileCamera").click();
  function addFiles(list) {
    const max = CFG.MAX_FILES || 5;
    for (const f of list) {
      if (cr.files.length >= max) { toast(`Можно добавить не больше ${max} файлов`); break; }
      try { N.validateFile(f); f._url = URL.createObjectURL(f); cr.files.push(f); }
      catch (e) { toast(e.message); }
    }
    renderMedia();
  }
  $("fileGallery").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  $("fileCamera").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  function renderMedia() {
    qa("#mediaRow .m-prev").forEach((x) => x.remove());
    const row = $("mediaRow");
    cr.files.forEach((f, i) => {
      const d = document.createElement("div"); d.className = "m-prev";
      if (/^video\//.test(f.type)) d.innerHTML = `<video src="${f._url}" muted playsinline preload="metadata"></video><i>🎬</i>`;
      else d.style.backgroundImage = `url('${f._url}')`;
      d.insertAdjacentHTML("beforeend", `<button type="button" data-rm="${i}">✕</button>`);
      row.insertBefore(d, $("addCamera"));
    });
  }
  $("mediaRow").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]"); if (!b) return;
    const f = cr.files.splice(+b.dataset.rm, 1)[0]; if (f && f._url) URL.revokeObjectURL(f._url); renderMedia();
  });
  function renderLoc() {
    if (!cr.loc) { $("crLocT").textContent = "Место не выбрано"; $("crLocS").textContent = "нажмите кнопку ниже"; return; }
    $("crLocT").textContent = cr.loc.how === "here" ? "Где я сейчас" : "Выбрано на карте";
    $("crLocS").textContent = `${cr.loc.lat.toFixed(5)}, ${cr.loc.lng.toFixed(5)}${cr.loc.acc ? " · точность ~" + Math.round(cr.loc.acc) + " м" : ""}`;
  }
  $("crHere").onclick = async () => {
    $("crLocS").textContent = "определяем...";
    try { const g = await getGeo(true); cr.loc = { ...g, how: "here" }; renderLoc(); }
    catch (e) { toast(e.message); renderLoc(); }
  };
  $("crPick").onclick = () => openPicker(cr.loc || pos);
  $("crFuzzy").onclick = () => $("crFuzzy").classList.toggle("on");
  function crError(m) { $("crErr").textContent = m; $("crErr").classList.add("on"); $("crErr").scrollIntoView({ block: "center", behavior: "smooth" }); }
  $("pubBtn").onclick = async () => {
    if (!requireAuth("Войдите, чтобы публиковать")) return;
    $("crErr").classList.remove("on");
    const text = $("crText").value.trim();
    if (!cr.type) return crError("Выберите тип публикации");
    if (!text) return crError("Добавьте описание");
    let event = null;
    if (cr.type === "event" || cr.type === "meetup") {
      if (!$("crWhen").value) { if (cr.type === "event") return crError("Укажите дату и время события"); }
      else {
        const d = new Date($("crWhen").value);
        if (isNaN(d)) return crError("Проверьте дату");
        if (!cr.edit && d < Date.now() - 3600e3) return crError("Дата события уже прошла");
        const cap = parseInt($("crCap").value, 10);
        event = { starts_at: d.toISOString(), capacity: cap > 0 ? cap : null };
      }
    }
    const btn = $("pubBtn"); btn.disabled = true;
    try {
      if (cr.edit) {
        const np = await api.updatePost(cr.edit.id, { text, category: cr.type, event });
        cache.set(np.id, np); toast("✓ Изменения сохранены"); feedDirty = true; wide = null; if (mapReady) loadMapPosts();
        hist.pop(); openPostId = np.id; go("sv-post", false); openPost(np.id);
        return;
      }
      if (!cr.loc) return crError("Укажите место: \"Где я сейчас\" или \"На карте\"");
      let { lat, lng } = cr.loc;
      if ($("crFuzzy").classList.contains("on")) {
        const a = Math.random() * 2 * Math.PI, r = 60 + Math.random() * 140;
        lat += (r * Math.cos(a)) / 111320; lng += (r * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180));
      }
      const p = await api.createPost({ category: cr.type, text, lat, lng, files: cr.files, event }, (m) => ($("crProg").textContent = m));
      cache.set(p.id, p);
      cr.files.forEach((f) => f._url && URL.revokeObjectURL(f._url)); cr.files = [];
      $("crProg").textContent = ""; $("crText").value = "";
      toast("✓ Опубликовано! Публикация уже в ленте и на карте");
      feedCat = "all"; $("cats").innerHTML = chipsHtml("all"); wide = null;
      if (N.dist(pos, p) > R) setRadius(Math.min(10000, Math.max(R, Math.ceil(N.dist(pos, p) / 1000) * 1000)));
      hist = []; go("v-feed", false); await loadFeed(); if (mapReady) loadMapPosts();
    } catch (e) { crError(e.message); $("crProg").textContent = ""; }
    finally { btn.disabled = false; }
  };

  /* =====================================================
     MAP (Leaflet + OpenStreetMap)
     ===================================================== */
  let leafletP = null, map = null, cluster = null, meLayer = null, circleLayer = null, mapReady = false, mapPosts = [], mapCat = "all", mapT = null, pendingFocus = null, markers = new Map();
  function loadLeaflet() {
    if (!leafletP) leafletP = (async () => {
      if (!window.L) await loadScript("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js");
      if (!L.markerClusterGroup) { try { await loadScript("https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"); } catch (e) { console.warn("cluster plugin", e); } }
      return window.L;
    })().catch((e) => { leafletP = null; throw e; });
    return leafletP;
  }
  const zoomFor = (r) => (r <= 500 ? 16 : r <= 1000 ? 15 : r <= 3000 ? 14 : r <= 5000 ? 13 : 12);
  const TILE = ["https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19, subdomains: "abcd", attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>' }];
  $("mapCats").innerHTML = chipsHtml("all");
  $("mapCats").onclick = (e) => { const b = e.target.closest("[data-c]"); if (!b) return; mapCat = b.dataset.c; $("mapCats").innerHTML = chipsHtml(mapCat); loadMapPosts(); };
  $("mapRad").onclick = (e) => { const b = e.target.closest("[data-r]"); if (!b) return; setRadius(+b.dataset.r); feedDirty = true; if (mapReady) map.fitBounds(circleLayer.getBounds(), { padding: [10, 10] }); };
  async function initMap() {
    if (mapReady) { setTimeout(() => { map.invalidateSize(); if (pendingFocus) focusPost(pendingFocus); }, 60); return; }
    $("mapMsg").classList.remove("hidden"); $("mapMsg").innerHTML = '<div><div class="spin"></div>Загружаем карту...</div>';
    try { await loadLeaflet(); }
    catch (e) { $("mapMsg").innerHTML = `<div>🗺️<br>Карта не загрузилась. Проверьте интернет.<br><button class="btn btn-main mt12" id="mapRetry">Повторить</button></div>`; $("mapRetry").onclick = initMap; return; }
    $("mapMsg").classList.add("hidden");
    map = L.map("map", { zoomControl: false, attributionControl: true, preferCanvas: false }).setView([pos.lat, pos.lng], zoomFor(R));
    L.tileLayer(TILE[0], TILE[1]).addTo(map);
    cluster = L.markerClusterGroup
      ? L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 55, showCoverageOnHover: false, spiderfyOnMaxZoom: true, disableClusteringAtZoom: 18,
          iconCreateFunction: (c) => L.divIcon({ html: `<div class="cl">${c.getChildCount()}</div>`, className: "cl-wrap", iconSize: [44, 44] }) })
      : L.layerGroup();
    map.addLayer(cluster);
    map.on("moveend", () => { clearTimeout(mapT); mapT = setTimeout(loadMapPosts, 350); });
    map.on("click", hideMapCard);
    mapReady = true; drawMe();
    setTimeout(() => map.invalidateSize(), 80);
    await loadMapPosts();
    if (pendingFocus) focusPost(pendingFocus);
  }
  function drawMe() {
    if (!mapReady) return;
    if (meLayer) map.removeLayer(meLayer); if (circleLayer) map.removeLayer(circleLayer);
    circleLayer = L.circle([pos.lat, pos.lng], { radius: R, color: "#ff2e88", weight: 1.5, opacity: 0.7, fillColor: "#ff2e88", fillOpacity: 0.05, interactive: false }).addTo(map);
    meLayer = L.marker([pos.lat, pos.lng], { icon: L.divIcon({ className: "pin-wrap", html: pos.real ? '<div class="me-dot"></div>' : '<div class="me-dot" style="background:#9b9bb4"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
  }
  async function loadMapPosts() {
    if (!mapReady) return;
    const b = map.getBounds();
    try {
      const list = remember(await api.listPosts({ bounds: { s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() }, category: catFilter(mapCat), limit: 500 }));
      mapPosts = list.filter((p) => p.status !== "closed");
      cluster.clearLayers(); markers.clear();
      const ms = mapPosts.map((p) => {
        const c = CATS[p.category] || CATS.talk;
        const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "pin-wrap", html: `<div class="pin" style="--c:${c.c}">${c.e}</div>`, iconSize: [36, 36], iconAnchor: [18, 18] }) });
        m.on("click", (ev) => { if (ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent); showMapCard(p); });
        markers.set(p.id, m); return m;
      });
      if (cluster.addLayers) cluster.addLayers(ms); else ms.forEach((m) => cluster.addLayer(m));
      $("mapCount").textContent = mapPosts.length ? `${mapPosts.length} публикаций в этой области` : "В этой области пока пусто";
      if (!$("mapList").classList.contains("hidden")) renderMapList();
    } catch (e) { $("mapCount").textContent = "Ошибка загрузки: " + e.message; }
  }
  function showMapCard(p) {
    const c = CATS[p.category] || CATS.talk, m = p.media[0];
    $("mapCard").innerHTML = `<div class="th" style="${m && m.type === "image" ? `background-image:url('${esc(m.url)}')` : `background:${c.c}33`}">${m && m.type === "image" ? "" : c.e}</div>
      <div class="tx"><b>${esc(p.text)}</b><span>${c.e} ${c.n} · ${fmtDist(D(p))} · ${timeAgo(p.created_at)}</span></div>
      <button class="sh-open" data-post="${p.id}">Открыть</button><button class="x" id="mcX">✕</button>`;
    $("mapCard").classList.remove("hidden"); $("v-map").classList.add("carded");
    $("mcX").onclick = (e) => { e.stopPropagation(); hideMapCard(); };
  }
  function hideMapCard() { $("mapCard").classList.add("hidden"); $("v-map").classList.remove("carded"); }
  $("mapCard").onclick = (e) => { if (e.target.id === "mcX") return; const p = $("mapCard").querySelector("[data-post]"); if (p) openPost(p.dataset.post); };
  function focusPost(p) {
    pendingFocus = null; $("mapList").classList.add("hidden"); $("mapListBtn").textContent = "☰";
    map.setView([p.lat, p.lng], 17, { animate: true });
    showMapCard(p);
  }
  $("mapLocate").onclick = async () => { if (await useMyLocation()) { drawMe(); map.setView([pos.lat, pos.lng], zoomFor(R)); feedDirty = true; } };
  $("mapListBtn").onclick = () => { const l = $("mapList"); l.classList.toggle("hidden"); $("mapListBtn").textContent = l.classList.contains("hidden") ? "☰" : "🗺"; if (!l.classList.contains("hidden")) renderMapList(); };
  function rowPost(p) {
    const c = CATS[p.category] || CATS.talk, m = p.media[0];
    return `<button class="row-post" data-post="${p.id}"><span class="th" style="${m && m.type === "image" ? `background-image:url('${esc(m.url)}')` : `background:${c.c}33`}">${m && m.type === "image" ? "" : c.e}</span><div><b>${esc(p.text)}</b><span>${c.e} ${c.n} · ${fmtDist(D(p))} · ${timeAgo(p.created_at)}${p.status === "closed" ? " · закрыто" : ""}</span></div></button>`;
  }
  function renderMapList() {
    const list = [...mapPosts].sort((a, b) => D(a) - D(b));
    $("mapList").innerHTML = list.length ? list.map(rowPost).join("") : '<div class="empty"><b>Пусто</b>В видимой области нет публикаций</div>';
  }
  $("mapList").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };

  /* picker */
  let pick = null;
  async function openPicker(center) {
    go("sv-pick");
    try { await loadLeaflet(); } catch (e) { toast("Карта не загрузилась. Проверьте интернет."); back(); return; }
    if (!pick) {
      pick = L.map("pickMap", { zoomControl: false }).setView([center.lat, center.lng], 16);
      L.tileLayer(TILE[0], TILE[1]).addTo(pick);
      pick.on("move", () => { const c = pick.getCenter(); $("pickHint").textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`; });
    } else pick.setView([center.lat, center.lng], 16);
    setTimeout(() => pick.invalidateSize(), 80);
  }
  $("pickBack").onclick = back;
  $("pickOk").onclick = () => { if (pick) { const c = pick.getCenter(); cr.loc = { lat: c.lat, lng: c.lng, how: "map" }; renderLoc(); } back(); };

  /* =====================================================
     DISCOVER (реальные данные)
     ===================================================== */
  let wide = null, wideAt = 0;
  async function loadWide() {
    if (wide && Date.now() - wideAt < 60000) return wide;
    wide = remember(await api.listPosts({ lat: pos.lat, lng: pos.lng, radius: 10000, limit: 500 })); wideAt = Date.now(); return wide;
  }
  function setCnt(id, n) { const e = $(id); e.textContent = n; e.classList.toggle("hidden", !n); }
  function upcoming(list) { return list.filter((p) => p.event && p.status !== "closed" && new Date(p.event.starts_at) > Date.now() - 3 * 3600e3).sort((a, b) => a.event.starts_at.localeCompare(b.event.starts_at)); }
  function updateDiscCounts() {
    if (!wide) return; const act = wide.filter((p) => p.status !== "closed");
    setCnt("cntRadar", act.filter((p) => D(p) <= 5000 && Date.now() - new Date(p.created_at) < 86400e3).length);
    setCnt("cntEvents", upcoming(wide).length);
    setCnt("cntDeals", act.filter((p) => p.category === "deal").length);
    setCnt("cntLost", act.filter((p) => p.category === "lost" || p.category === "found").length);
  }
  async function withWide(boxId, fn) {
    $(boxId).innerHTML = '<div class="spin"></div>';
    try { fn(await loadWide()); } catch (e) { $(boxId).innerHTML = `<div class="empty"><b>Ошибка</b>${esc(e.message)}</div>`; }
  }
  function renderRadar() {
    withWide("radarRows", (list) => {
      const act = list.filter((p) => p.status !== "closed" && D(p) <= 5000);
      const box = $("radarBox"); qa(".bl", box).forEach((x) => x.remove());
      act.slice(0, 40).forEach((p) => {
        const dy = (p.lat - pos.lat) * 111320, dx = (p.lng - pos.lng) * 111320 * Math.cos((pos.lat * Math.PI) / 180);
        const c = CATS[p.category];
        box.insertAdjacentHTML("beforeend", `<span class="bl" data-post="${p.id}" style="left:${50 + (dx / 5000) * 50}%;top:${50 - (dy / 5000) * 50}%;background:${c.c};cursor:pointer">${c.e}</span>`);
      });
      const rings = [[0, 500, "500 м"], [500, 1000, "1 км"], [1000, 3000, "3 км"], [3000, 5000, "5 км"]];
      $("radarSub").textContent = `${act.length} публикаций в радиусе 5 км`;
      $("radarRows").innerHTML = rings.map(([a, b, n]) => {
        const ps = act.filter((p) => D(p) > a && D(p) <= b); const by = {};
        ps.forEach((p) => (by[p.category] = (by[p.category] || 0) + 1));
        const txt = ps.length ? Object.entries(by).map(([k, v]) => `${CATS[k].e} ${v}`).join("  ") : "тихо";
        return `<button class="rrow" data-rr="${b}"><span class="rd2">${n}</span><span>${ps.length ? ps.length + " · " : ""}${txt}</span></button>`;
      }).join("");
    });
  }
  $("radarRows").onclick = (e) => { const b = e.target.closest("[data-rr]"); if (!b) return; setRadius(+b.dataset.rr); hist = []; go("v-feed", false); loadFeed(); };
  $("radarBox").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };

  function renderEvents() {
    withWide("eventsList", (list) => {
      const ev = upcoming(list);
      $("eventsList").innerHTML = ev.length ? ev.map((p) => {
        const d = new Date(p.event.starts_at), c = CATS[p.category], m = p.media[0];
        return `<div class="ev" data-post="${p.id}"><div class="eh" style="${m && m.type === "image" ? `background:url('${esc(m.url)}') center/cover` : `background:linear-gradient(135deg,${c.c}aa,#1f1f2e)`}"><span class="date"><b>${d.getDate()}</b>${d.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "").toUpperCase()}</span>${m ? "" : c.e}</div>
          <div class="eb"><b>${esc(p.text.slice(0, 80))}</b><span>🕒 ${fmtWhen(p.event.starts_at)} · 📍 ${fmtDist(D(p))}</span>
          <div class="avs"><small style="margin:0">👥 ${p.event.members}${p.event.capacity ? " из " + p.event.capacity : ""} участников</small></div>
          <div class="ev-act"><button class="go${p.event.joined ? " in" : ""}" data-join="${p.id}">${p.event.joined ? "✓ Иду" : "Иду"}</button><button data-cal="${p.id}">📅 Календарь</button><button data-post="${p.id}">Подробнее</button></div></div></div>`;
      }).join("") : '<div class="empty"><b>Ближайших событий нет</b>Создайте первое: футбол, прогулку или встречу соседей</div>';
    });
  }
  $("eventsList").onclick = (e) => {
    let b;
    if ((b = e.target.closest("[data-join]"))) return doJoin(b.dataset.join);
    if ((b = e.target.closest("[data-cal]"))) return addToCalendar(cache.get(b.dataset.cal));
    if ((b = e.target.closest("[data-post]"))) return openPost(b.dataset.post);
  };

  let cTimer = null;
  function renderDeals() {
    withWide("dealsList", (list) => {
      const ds = list.filter((p) => p.category === "deal" && p.status !== "closed").sort((a, b) => D(a) - D(b));
      $("dealsList").innerHTML = ds.length ? ds.map((p) => {
        const m = p.media[0];
        return `<div class="deal" data-post="${p.id}"><span class="di" style="${m && m.type === "image" ? `background:url('${esc(m.url)}') center/cover` : "background:rgba(255,176,32,.15)"}">${m && m.type === "image" ? "" : "🏷️"}</span><div style="flex:1;min-width:0"><b style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(p.text)}</b><span>${esc(p.author.name)} · ${fmtDist(D(p))}</span></div><button class="ac" data-coupon="${p.id}">Купон</button></div>`;
      }).join("") : '<div class="empty"><b>Акций рядом пока нет</b>Есть кафе или магазин? Добавьте свою акцию</div>';
    });
  }
  $("dealsList").onclick = (e) => {
    const b = e.target.closest("[data-coupon]");
    if (b) {
      const p = cache.get(b.dataset.coupon); let h = 0; for (const ch of p.id + (user ? user.id : "guest")) h = (h * 31 + ch.charCodeAt(0)) % 9000;
      $("cpName").textContent = p.author.name + " · " + p.text.slice(0, 50); $("cpCode").textContent = "NEAR-" + (1000 + h);
      $("coupon").classList.add("on"); $("sv-deals").scrollTop = 0;
      let t = 899; clearInterval(cTimer); $("ctm").textContent = "14:59";
      cTimer = setInterval(() => { t--; $("ctm").textContent = Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); if (t <= 0) { clearInterval(cTimer); $("coupon").classList.remove("on"); } }, 1000);
      toast("🏷️ Купон готов, покажите его на кассе"); return;
    }
    const c = e.target.closest("[data-post]"); if (c) openPost(c.dataset.post);
  };

  let lfMode = "lost";
  function renderLost() {
    withWide("lfGrid", (list) => {
      const ls = list.filter((p) => p.category === lfMode && p.status !== "closed").sort((a, b) => b.created_at.localeCompare(a.created_at));
      $("lfGrid").innerHTML = ls.length ? ls.map((p) => {
        const c = CATS[p.category], m = p.media[0];
        return `<button class="lf" data-post="${p.id}"><div class="im" style="${m && m.type === "image" ? `background:url('${esc(m.url)}') center/cover` : `background:linear-gradient(135deg,${c.c}88,#1f1f2e)`}">${m && m.type === "image" ? "" : c.e}</div><div class="t"><b style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(p.text)}</b><span>${fmtDist(D(p))} · ${timeAgo(p.created_at)}</span></div></button>`;
      }).join("") : `<div class="empty" style="grid-column:span 2"><b>Пока пусто</b>${lfMode === "lost" ? "Никто ничего не потерял рядом 🙂" : "Находок рядом пока нет"}</div>`;
    });
  }
  qa("#lfSeg [data-lf]").forEach((b) => (b.onclick = () => { qa("#lfSeg button").forEach((x) => x.classList.toggle("on", x === b)); lfMode = b.dataset.lf; renderLost(); }));
  $("lfGrid").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };
  $("lfAdd").onclick = () => { if (requireAuth("Войдите, чтобы публиковать")) openCreate({ type: lfMode }); };
  $("parkBtn").onclick = () => toast("🅿️ Парковки появятся на следующих этапах");

  /* =====================================================
     SEARCH
     ===================================================== */
  let qT = null;
  qa("[data-search]").forEach((b) => (b.onclick = async () => { $("q").value = ""; go("sv-search"); setTimeout(() => $("q").focus(), 150); runSearch(); }));
  async function runSearch() {
    const q = $("q").value.trim().toLowerCase();
    $("qRes").innerHTML = '<div class="spin"></div>';
    try {
      const list = await loadWide();
      const words = q.split(/\s+/).filter(Boolean);
      const r = !q ? [...list].sort((a, b) => D(a) - D(b)).slice(0, 10)
        : list.filter((p) => { const hay = (p.text + " " + CATS[p.category].n + " " + p.author.name).toLowerCase(); return words.every((w) => hay.includes(w)); });
      $("qRes").innerHTML = (q ? "" : '<div class="lbl">Ближайшие публикации</div>') + (r.length ? r.map(rowPost).join("") : '<div class="empty"><b>Ничего не нашли</b>Попробуйте другое слово или увеличьте радиус</div>');
    } catch (e) { $("qRes").innerHTML = `<div class="empty"><b>Ошибка поиска</b>${esc(e.message)}</div>`; }
  }
  $("q").oninput = () => { clearTimeout(qT); qT = setTimeout(runSearch, 250); };
  $("qTags").onclick = (e) => { const b = e.target.closest("button"); if (b) { $("q").value = b.textContent; runSearch(); } };
  $("qRes").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };

  /* =====================================================
     NOTIFICATIONS
     ===================================================== */
  async function refreshBadge() {
    if (!api || !user) { $("bellBadge").classList.add("hidden"); return; }
    try { const n = await api.unreadCount(); $("bellBadge").textContent = n > 9 ? "9+" : n; $("bellBadge").classList.toggle("hidden", !n); } catch (e) {}
  }
  $("bellBtn").onclick = () => { if (!requireAuth("Войдите, чтобы видеть уведомления")) return; go("sv-notif"); };
  async function renderNotifs() {
    $("nfList").innerHTML = '<div class="spin"></div>';
    try {
      const list = await api.notifications();
      const unread = list.filter((n) => !n.read).length;
      $("nfSub").textContent = unread ? unread + " новых" : "все прочитано";
      const ic = { like: "♥", likes: "♥", comment: "💬", comments: "💬", join: "🎉", event_members: "🎉" };
      $("nfList").innerHTML = list.length ? list.map((n) => `<button class="res${n.read ? "" : " unread"}" data-post="${n.post_id || ""}"><span class="e">${ic[n.type] || "🔔"}</span><div><b>${esc(n.actor.name)}</b><span>${esc(n.text || "")} · ${timeAgo(n.created_at)}</span></div></button>`).join("")
        : '<div class="empty"><b>Уведомлений пока нет</b>Здесь появятся лайки, комментарии и участники ваших событий</div>';
      if (unread) { await api.markNotificationsRead(); refreshBadge(); }
    } catch (e) { $("nfList").innerHTML = `<div class="empty"><b>Ошибка</b>${esc(e.message)}</div>`; }
  }
  $("nfList").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b && b.dataset.post) openPost(b.dataset.post); };

  /* =====================================================
     PROFILE
     ===================================================== */
  const PREFS_KEY = "near_prefs";
  const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; } })();
  const PREF_LIST = [["incident", "🚨 Происшествия рядом", true], ["event", "🎉 События и встречи", true], ["deal", "🏷️ Акции", false], ["quiet", "🌙 Тихие часы 23:00–08:00", true]];
  let profTab = "mine";
  async function renderProfile() {
    const b = $("profBody");
    if (!user) {
      b.innerHTML = `<div class="pf"><div class="big"><div>?</div></div><b>Вы не вошли</b><div class="since">Войдите, чтобы публиковать, комментировать и сохранять</div></div>
        <div class="prof-btns"><button id="pLogin">Войти</button><button id="pSignup">Регистрация</button></div>${api.mode === "local" ? '<button class="logout" style="color:var(--muted);border-color:var(--line)" id="pReset">Сбросить демо-данные</button>' : ""}`;
      $("pLogin").onclick = () => showAuth("login"); $("pSignup").onclick = () => showAuth("signup");
      if ($("pReset")) $("pReset").onclick = resetDemo;
      return;
    }
    b.innerHTML = `<div class="pf"><div class="big"><div>${user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : esc(initial(user.name))}</div></div><b>${esc(user.name)}</b><div class="email">${esc(user.email || "")}</div><div class="since">${user.district ? "📍 " + esc(user.district) + " район" : "Район не указан"}</div></div>
      <div class="pstats" id="pStats"><div><b>…</b><span>Публикации</span></div><div><b>…</b><span>Сохранено</span></div><div><b>…</b><span>События</span></div></div>
      <div class="prof-btns"><button id="pEdit">✏️ Редактировать</button><button id="pPass">🔑 Сменить пароль</button></div>
      <div class="seg" id="pSeg"><button data-t="mine" class="${profTab === "mine" ? "on" : ""}">Мои публикации</button><button data-t="saved" class="${profTab === "saved" ? "on" : ""}">Сохраненное</button></div>
      <div id="pList"><div class="spin"></div></div>
      <div class="lbl" style="margin-top:14px">Уведомления</div>
      ${PREF_LIST.map(([k, n, d]) => `<div class="set"><span>${n}</span><button class="tg${(prefs[k] ?? d) ? " on" : ""}" data-pref="${k}"></button></div>`).join("")}
      ${api.mode === "local" ? '<div class="demo-strip mt12">🧪 Демо-режим: аккаунт и публикации хранятся только на этом устройстве</div>' : ""}
      <button class="logout" id="pOut">Выйти из аккаунта</button>`;
    $("pEdit").onclick = editProfile; $("pPass").onclick = changePassword; $("pOut").onclick = logout;
    qa("#pSeg [data-t]").forEach((x) => (x.onclick = () => { profTab = x.dataset.t; qa("#pSeg button").forEach((y) => y.classList.toggle("on", y === x)); loadProfList(); }));
    qa("[data-pref]").forEach((t) => (t.onclick = () => { t.classList.toggle("on"); prefs[t.dataset.pref] = t.classList.contains("on"); try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} toast((prefs[t.dataset.pref] ? "Включено: " : "Выключено: ") + t.previousElementSibling.textContent.replace(/^\S+\s/, "")); }));
    $("pList").onclick = (e) => { const r = e.target.closest("[data-post]"); if (r) openPost(r.dataset.post); };
    api.stats().then((s) => { if ($("pStats")) $("pStats").innerHTML = `<div><b>${s.posts}</b><span>Публикации</span></div><div><b>${s.saved}</b><span>Сохранено</span></div><div><b>${s.events}</b><span>События</span></div>`; }).catch(() => {});
    loadProfList();
  }
  async function loadProfList() {
    const box = $("pList"); if (!box) return; box.innerHTML = '<div class="spin"></div>';
    try {
      const list = remember(profTab === "mine" ? await api.myPosts() : await api.savedPosts());
      box.innerHTML = list.length ? list.map(rowPost).join("") : `<div class="empty">${profTab === "mine" ? "<b>Вы еще ничего не публиковали</b>Нажмите + внизу экрана" : "<b>Пусто</b>Нажмите ☆ на публикации, чтобы сохранить"}</div>`;
    } catch (e) { box.innerHTML = `<div class="empty"><b>Ошибка</b>${esc(e.message)}</div>`; }
  }
  function editProfile() {
    let avatarFile = null;
    openSheet("Редактировать профиль", `<div class="av-edit"><span class="ava" id="avPrev" style="background:#ff2e8822;color:#ff6aa8">${user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : esc(initial(user.name))}</span><button class="btn btn-ghost" id="avBtn" type="button">📷 Сменить фото</button><input type="file" id="avFile" accept="image/*" hidden></div>
      <div class="fld"><label>Имя и фамилия</label><input id="peName" value="${esc(user.name)}" maxlength="60"></div>
      <div class="fld"><label>Район</label><select id="peDist"><option value="">Не указан</option>${DISTRICTS.map((d) => `<option ${user.district === d[0] ? "selected" : ""}>${d[0]}</option>`).join("")}</select></div>
      <div class="err" id="peErr"></div>
      <div class="sheet-btns"><button class="btn btn-ghost" id="peCancel">Отмена</button><button class="btn btn-main" id="peSave">Сохранить</button></div>`);
    $("avBtn").onclick = () => $("avFile").click();
    $("avFile").onchange = (e) => { const f = e.target.files[0]; if (!f) return; try { N.validateFile(f); avatarFile = f; $("avPrev").innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`; } catch (err) { toast(err.message); } };
    $("peCancel").onclick = closeSheet;
    $("peSave").onclick = async () => {
      try { user = await busy($("peSave"), () => api.updateProfile({ name: $("peName").value, district: $("peDist").value, avatarFile })); closeSheet(); toast("✓ Профиль обновлен"); renderProfile(); }
      catch (e) { $("peErr").textContent = e.message; $("peErr").classList.add("on"); }
    };
  }
  function changePassword() {
    openSheet("Сменить пароль", `<div class="fld"><label>Новый пароль</label><div class="pw"><input id="npw" type="password" minlength="6" placeholder="Не короче 6 символов" autocomplete="new-password"><button type="button" data-eye2>👁</button></div></div><div class="err" id="npErr"></div>
      <div class="sheet-btns"><button class="btn btn-ghost" id="npCancel">Отмена</button><button class="btn btn-main" id="npSave">Сохранить</button></div>`);
    document.querySelector("[data-eye2]").onclick = () => { const i = $("npw"); i.type = i.type === "password" ? "text" : "password"; };
    $("npCancel").onclick = closeSheet;
    $("npSave").onclick = async () => {
      try { await busy($("npSave"), () => api.updatePassword($("npw").value)); closeSheet(); toast("✓ Пароль изменен"); }
      catch (e) { $("npErr").textContent = e.message; $("npErr").classList.add("on"); }
    };
  }
  async function logout() {
    if (!(await confirmSheet("Выйти из аккаунта?", "Вы сможете войти снова с тем же email и паролем.", "Выйти", true))) return;
    await api.signOut(); user = null; try { localStorage.removeItem("near_guest"); } catch (e) {}
    onUserChange(); hist = []; go("v-feed", false); showAuth("login");
  }
  async function resetDemo() {
    if (!(await confirmSheet("Сбросить демо-данные?", "Удалятся все аккаунты и публикации, созданные на этом устройстве, и вернутся примеры.", "Сбросить", true))) return;
    api.resetDemo(); user = null; wide = null; cache.clear(); onUserChange(); toast("Демо-данные сброшены");
  }

  /* =====================================================
     DEMO-РАЗДЕЛЫ (SOS, услуги, опросы, помощь, сообщества)
     ===================================================== */
  const REPLIES = ["Здравствуйте! Да, актуально 👍", "Отлично, договорились!", "Спасибо, что написали 🙏", "Сейчас посмотрю и отвечу", "Могу подьехать сегодня"];
  function openChat(name, first) { $("chatName").textContent = name; $("chatMsgs").innerHTML = `<div class="msg a">${esc(first || "Здравствуйте! Чем могу помочь?")}</div>`; go("sv-chat"); }
  if ($("chatForm")) $("chatForm").onsubmit = (e) => {
    e.preventDefault(); const v = $("chatIn").value.trim(); if (!v) return; const m = $("chatMsgs");
    m.insertAdjacentHTML("beforeend", `<div class="msg u">${esc(v)}</div>`); $("chatIn").value = ""; m.scrollTop = 1e5;
    setTimeout(() => { m.insertAdjacentHTML("beforeend", `<div class="msg a"><span class="typing"><i></i><i></i><i></i></span></div>`); m.scrollTop = 1e5; setTimeout(() => { m.lastElementChild.textContent = REPLIES[Math.floor(Math.random() * REPLIES.length)]; m.scrollTop = 1e5; }, 900); }, 300);
  };
  if ($("urg")) $("urg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; qa("#urg button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); };
  if ($("sosBtn")) $("sosBtn").onclick = async function () {
    if (this.classList.contains("sent")) { this.classList.remove("sent"); this.textContent = "SOS"; toast("SOS отменен"); return; }
    if (!requireAuth("Войдите, чтобы отправить SOS")) return;
    const u = document.querySelector("#urg .on").textContent.replace(/^\S+\s/, "");
    if (!(await confirmSheet("Отправить SOS?", `"${u}" — сообщение увидят люди рядом в ленте и на карте. При угрозе жизни сначала звоните 112.`, "Отправить SOS", true))) return;
    try {
      const g = pos.real ? pos : await getGeo().catch(() => pos);
      const p = await api.createPost({ category: "incident", text: "🆘 SOS: " + u + ". Нужна помощь рядом!", lat: g.lat, lng: g.lng, files: [] });
      cache.set(p.id, p); this.classList.add("sent"); this.innerHTML = "✓ Отправлено<br><small style='font-size:10px;font-weight:600'>нажмите, чтобы отменить</small>";
      wide = null; feedDirty = true; if (mapReady) loadMapPosts(); toast("🆘 SOS опубликован рядом с вами");
    } catch (e) { toast(e.message); }
  };
  const PRO = { "Сантехник": ["Нурлан", "Сергей", "\"Сервис 24\""], "Электрик": ["Бауыржан", "Олег", "\"Свет+\""], "Автомеханик": ["Арман", "СТО \"Мотор\"", "Денис"], "Ремонт": ["Бригада Кайрата", "\"Ремонт-Про\"", "Максат"], "Репетитор": ["Айгерим (математика)", "Анна (англ.)", "Ержан (физика)"], "Уборка": ["\"Чистый дом\"", "Гульнара", "\"Clean KZ\""], "ПК-мастер": ["Даурен", "\"IT-помощь\"", "Артем"] };
  const PA = ["👨‍🔧", "🧰", "🔧", "🛠️", "👩‍🏫", "🧹", "💻"];
  function renderPro(cat) {
    if (!$("proList") || !PRO[cat]) return; const ix = Object.keys(PRO).indexOf(cat);
    $("proList").innerHTML = '<div class="demo-strip">🧪 Пример раздела: мастера и отзывы появятся после запуска каталога услуг</div>' + PRO[cat].map((n, i) => `<div class="pro"><span class="pa" style="background:${["rgba(61,165,255,.15)", "rgba(43,212,125,.15)", "rgba(255,176,32,.15)"][i]}">${PA[ix]}</span><div><b>${esc(n)} · ${cat.toLowerCase()}</b><span>⭐ ${(4.9 - i * 0.1).toFixed(1)} · ${[128, 64, 41][i]} отзывов · ${["800 м", "1,5 км", "2,3 км"][i]}</span><span class="pr">от ${[5, 4, 6][i]} 000 ₸ · ${["сегодня", "сегодня", "завтра"][i]}</span></div><button class="wr" data-pro="${esc(n)}">Написать</button></div>`).join("");
  }
  qa("#svcCats span").forEach((sp) => { sp.dataset.cat = sp.lastChild.textContent.trim(); sp.onclick = () => { qa("#svcCats span").forEach((x) => x.classList.remove("on")); sp.classList.add("on"); renderPro(sp.dataset.cat); }; });
  if ($("proList")) { $("proList").onclick = (e) => { const b = e.target.closest("[data-pro]"); if (b) openChat(b.dataset.pro, "Здравствуйте! Опишите задачу, подскажу по цене и времени 🙂"); }; renderPro("Сантехник"); }
  qa("[data-poll]").forEach((pl) => (pl.onclick = (e) => { const o = e.target.closest(".opt"); if (!o || pl.classList.contains("voted")) return; o.classList.add("mine"); pl.classList.add("voted"); qa(".opt", pl).forEach((x) => (x.querySelector("i").style.width = x.dataset.p + "%")); toast("🗳️ Голос учтен"); }));
  qa("#sv-help .help button").forEach((b) => (b.onclick = () => { const on = b.classList.toggle("done"); b.textContent = on ? "✓ Вы откликнулись" : "Помогу"; if (on) toast("🤝 Автор получит ваш отклик"); }));
  if ($("helpAdd")) $("helpAdd").onclick = () => { if (requireAuth("Войдите, чтобы попросить о помощи")) { openCreate({ type: "talk" }); $("crText").value = "Нужна помощь: "; } };
  qa("#v-com .jn").forEach((b) => (b.onclick = () => {
    const on = b.classList.toggle("in"), nm = b.parentElement.querySelector("b").textContent;
    if (b.textContent === "Войти" || b.dataset.w) { b.dataset.w = 1; b.textContent = on ? "✓ Внутри" : "Войти"; } else b.textContent = on ? "✓" : "+";
    b.style.background = on ? "rgba(43,212,125,.15)" : ""; b.style.color = on ? "var(--ok)" : "";
    toast(on ? "Вы вступили: " + nm : "Вы вышли: " + nm);
  }));

  /* =====================================================
     BOOT
     ===================================================== */
  function fatal(msg) {
    hideAuth(); $("posts").innerHTML = `<div class="empty"><b>Не удалось запустить NEAR</b>${esc(msg)}<br><button class="btn btn-main mt12" onclick="location.reload()">Перезагрузить</button></div>`;
  }
  async function boot() {
    try {
      if (CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && !window.supabase) await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js");
      user = await N.start(); api = N.api;
    } catch (e) { fatal(/^(load|timeout) /.test(e.message) ? "Не удалось подключиться к серверу. Проверьте интернет и попробуйте снова." : N.ruError(e)); return; }
    if (api.mode === "local") $("demoStrip").classList.remove("hidden");
    api.onAuth((u, ev) => {
      if (ev === "recovery") { showAuth("reset"); return; }
      const was = user && user.id; user = u;
      if (u && !was) { hideAuth(); onUserChange(); } else if (!u && was) onUserChange(); else if (u && ev === "USER_UPDATED") renderProfile();
    });
    const isRecovery = /type=recovery/.test(location.hash);
    let guest = false; try { guest = localStorage.getItem("near_guest") === "1"; } catch (e) {}
    if (isRecovery) showAuth("reset");
    else if (user || guest) hideAuth();
    else showAuth("login");
    if (!document.querySelector(".view.on:not(#v-auth)")) $("v-feed").classList.add("on");
    useMyLocation(true).then((ok) => { if (ok) { loadFeed(); if (mapReady) drawMe(); } else if (!pos.real) $("locName").textContent = "Центр Алматы"; });
    await loadFeed();
    refreshBadge();
    try { api.subscribe((type, row) => {
      if (type === "post") { wide = null; if (mapReady) { clearTimeout(mapT); mapT = setTimeout(loadMapPosts, 800); } if (row && N.dist(pos, row) <= R && (!user || row.user_id !== user.id)) { $("refreshBtn").style.background = "var(--grad)"; toast("🆕 Новая публикация рядом. Нажмите ↻"); } }
      if (type === "notif") refreshBadge();
    }); } catch (e) { console.warn(e); }
    setInterval(() => { if (!document.hidden) refreshBadge(); }, 60000);
    loadLeaflet().catch(() => {});
    const m = location.hash.match(/post=([\w-]+)/); if (m) openPost(m[1]);
  }
  boot();
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
