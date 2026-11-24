/* NEAR — интерфейс. ФАЙЛ СОБРАН АВТОМАТИЧЕСКИ из src/app/*.js (node tools/build.mjs), правьте модули. */
(function () {
  "use strict";
/* ===== 00-core.js ===== */
  const CFG = window.NEAR_CONFIG || {};
  const APP_VERSION = "14.0";
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
    return dfmt(iso, { day: "numeric", month: "short" });
  }
  const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const fmtDist = (m) => (m < 1000 ? Math.round(m / 10) * 10 + " м" : (m / 1000).toFixed(1).replace(/\.0$/, "").replace(".", ",") + " км");
  const fmtWhen = (iso) => dfmt(iso, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const initial = (n) => (String(n || "?").trim()[0] || "?").toUpperCase();
  function ava(a, color = "#ff2e88") {
    a = a || {};
    return a.avatar_url
      ? `<span class="ava"><img src="${esc(a.avatar_url)}" alt=""></span>`
      : `<span class="ava" style="background:${color}22;color:${color}">${esc(initial(a.name))}</span>`;
  }
  /* ---------- язык и тема ---------- */
  const I18N = window.NEAR_I18N || { lang: "ru", locale: () => LOC(), t: (x) => x, start() {}, setLang() {} };
  const LOC = () => I18N.locale();
  // даты: в части браузеров нет казахских названий месяцев (выходит "М11 24"), поэтому собираем сами
  const KZ_M = ["қаңтар", "ақпан", "наурыз", "сәуір", "мамыр", "маусым", "шілде", "тамыз", "қыркүйек", "қазан", "қараша", "желтоқсан"];
  const KZ_MS = ["қаң.", "ақп.", "нау.", "сәу.", "мам.", "мау.", "шіл.", "там.", "қыр.", "қаз.", "қар.", "жел."];
  const KZ_W = ["жс", "дс", "сс", "ср", "бс", "жм", "сб"];
  function dfmt(d, o) {
    d = d instanceof Date ? d : new Date(d);
    if (LOC() !== "kk-KZ") return o.hour ? d.toLocaleString(LOC(), o) : d.toLocaleDateString(LOC(), o);
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: o.timeZone, year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday], mo = +p.month - 1, out = [];
    if (o.weekday) out.push(KZ_W[wd] + (o.day ? "," : ""));
    if (o.day) out.push(+p.day);
    if (o.month) out.push(o.month === "long" ? KZ_M[mo] : KZ_MS[mo]);
    if (o.year) out.push(p.year + " ж.");
    if (o.hour) out.push(p.hour + ":" + p.minute);
    return out.join(" ");
  }
  const THEME_KEY = "near_theme";
  // смена темы — плавно 150 мс, без перезагрузки
  function themeAnim() { const h = document.documentElement; h.classList.add("theme-anim"); setTimeout(() => h.classList.remove("theme-anim"), 220); }
  document.addEventListener("visibilitychange", () => document.documentElement.classList.toggle("bg-hidden", document.hidden));
  function applyTheme() {
    let t = "system"; try { t = localStorage.getItem(THEME_KEY) || "system"; } catch (e) {}
    const dark = t === "dark" || (t === "system" && !(window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches));
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = dark ? "#10101b" : "#f6f6fa";
    return t;
  }
  applyTheme();
  const themeChoice = () => { try { return localStorage.getItem(THEME_KEY) || "system"; } catch (e) { return "system"; } };
  if (window.matchMedia) { try { matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { applyTheme(); syncMapTheme(); }); } catch (e) {} }

  /* ---------- наблюдаемость: ошибки и псевдонимизированная аналитика ---------- */
  const Obs = {
    install() { let id = null; try { id = localStorage.getItem("near_install"); if (!id) { id = N.rid() + N.rid(); localStorage.setItem("near_install", id); } } catch (e) {} return id; },
    on() { if (CFG.ANALYTICS === false) return false; try { return localStorage.getItem("near_stats") !== "0"; } catch (e) { return true; } },
    track(name, props) { if (!api || !this.on()) return; try { api.track(name, props || {}, this.install()); } catch (e) {} },
    _n: 0,
    error(kind, err) {
      if (!api || this._n > 20) return; this._n++;
      const e = err || {}; this.track("error", { error: String(kind).slice(0, 20) }); api.logError && api.logError({ kind, message: e.message || String(e), stack: e.stack || "", corr: e.requestId || "", version: APP_VERSION });
    }
  };
  window.addEventListener("error", (e) => Obs.error("js", e.error || { message: e.message }));
  window.addEventListener("unhandledrejection", (e) => Obs.error("promise", e.reason || {}));

  /* ---------- SEC-06: локальный кэш привязан к аккаунту и стирается при выходе ---------- */
  const Cache = {
    // uid — чей кэш стереть (по умолчанию все ленты и черновики)
    wipe(uid) {
      try {
        const pre = uid ? uid.slice(0, 12) : "";
        Object.keys(localStorage).forEach((k) => {
          if (/^near_feed_/.test(k) && (!pre || k.includes("_" + pre + "_"))) localStorage.removeItem(k);
          if (/^near_draft_/.test(k) && (!pre || k.endsWith(pre))) localStorage.removeItem(k);
        });
      } catch (e) {}
      // кэш фото в Service Worker: убираем все, чтобы на общем телефоне ничего не осталось
      try { if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: "near-wipe" }); } catch (e) {}
    },
    // скрытая или удаленная публикация: ее фото удаляются из кэша телефона
    purge(urls) { try { if (urls.length && navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: "near-purge", urls }); } catch (e) {} }
  };

  function loadScript(src, timeout = 12000) {
    return new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src; s.async = true;
      const t = setTimeout(() => rej(new Error("timeout " + src)), timeout);
      s.onload = () => { clearTimeout(t); res(); }; s.onerror = () => { clearTimeout(t); rej(new Error("load " + src)); };
      document.head.appendChild(s);
    });
  }

  /* ---------- state ---------- */
  // src: gps — точная геопозиция, district — выбран район, city — запасной вариант (центр Алматы)
  let pos = { lat: CITY.lat, lng: CITY.lng, real: false, src: "city", acc: null };
  let R = 3000, feedCat = "all", feedPosts = [];
  const cache = new Map();
  const remember = (list) => { list.forEach((p) => cache.set(p.id, p)); return list; };
  const D = (p) => N.dist(pos, p);
  const CHIPS = [["all", "🔥 Все"], ["incident", "🚨 Происшествия"], ["event", "🎉 События"], ["deal", "🏷️ Акции"], ["lostfound", "🔎 Потери и находки"], ["meetup", "⚽ Встречи"], ["ad", "📢 Объявления"], ["talk", "💬 Обсуждения"]];
  const catFilter = (c) => (c === "all" ? null : c === "lostfound" ? ["lost", "found"] : c);
  const DISTRICTS = [
    ["Алмалинский", 43.2530, 76.9100], ["Бостандыкский", 43.2150, 76.9050], ["Медеуский", 43.2400, 76.9700], ["Ауэзовский", 43.2300, 76.8400],
    ["Алатауский", 43.2750, 76.8100], ["Наурызбайский", 43.1950, 76.7900], ["Жетысуский", 43.2950, 76.9400], ["Турксибский", 43.3350, 76.9700]
  ];

  /* ---------- navigation ---------- */
  let hist = [];
  // v14: 5 вкладок (лента, карта, +, чаты, профиль); "Все разделы" (v-disc) — из быстрых входов ленты
  const TABS = ["v-feed", "v-map", "v-create", "v-chats", "v-prof"];
  const cur = () => { const v = document.querySelector(".view.on:not(#v-auth)"); return v ? v.id : "v-feed"; };
  function go(id, push = true) {
    const c = cur();
    if (c === id) return;
    if (push) hist.push(c);
    qa(".view").forEach((v) => { if (v.id !== "v-auth") v.classList.remove("on", "nav-fwd", "nav-back", "nav-tab"); });
    // анимация перехода: вперед — справа, назад — слева, вкладки — плавно
    const anim = push ? "nav-fwd" : TABS.includes(id) && TABS.includes(c) ? (TABS.indexOf(id) > TABS.indexOf(c) ? "nav-tab r" : "nav-tab l") : "nav-back";
    $(id).classList.remove("r", "l"); $(id).classList.add("on", ...anim.split(" "));
    $(id).scrollTop = 0;
    document.body.classList.toggle("picking", id === "sv-pick"); document.body.classList.toggle("in-conv", id === "sv-conv");
    if (id !== "sv-conv") { convId = null; Conv.unsub(); stopRec(true); }
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
    if (id === "sv-sos") renderSOS();
    if (id === "sv-settings") renderSettings();
    if (id === "sv-events") renderEvents();
    if (id === "sv-deals") renderDeals();
    if (id === "sv-lost") renderLost();
    if (id === "sv-notif") renderNotifs();
    if (id === "v-chats") renderChats();
    if (id === "sv-find") { $("fq").value = ""; $("fRes").innerHTML = '<div class="dim center" style="font-size:12px;padding:20px">Введите минимум 2 буквы</div>'; setTimeout(() => $("fq").focus(), 150); }
    if (id === "sv-mod") renderMod();
    if (id === "v-feed" && feedDirty) loadFeed();
  }
  qa("[data-v]").forEach((b) => (b.onclick = () => {
    if (b.dataset.v === "v-create") { openCreateMenu(); return; }
    hist = []; go(b.dataset.v, false);
  }));
  document.addEventListener("click", (e) => {
    const ao = e.target.closest("[data-auth-open]"); if (ao) { showAuth(ao.dataset.authOpen); return; }
    const o = e.target.closest("[data-open]"); if (o) { go(o.dataset.open); return; }
    const b = e.target.closest("[data-back]"); if (b) { back(); return; }
    const c = e.target.closest("[data-create]"); if (c) { if (requireAuth("Войдите, чтобы публиковать", { t: "create", a: c.dataset.create })) openCreate({ type: c.dataset.create }); return; }
    const r = e.target.closest("[data-rules]"); if (r) { e.preventDefault(); showRules(); }
  });

  /* ---------- bottom sheet ---------- */
  let sheetBack = null;
  function openSheet(title, html, cls) {
    $("bsTitle").textContent = title; $("bsList").innerHTML = html; $("bsheet").className = "bsheet on" + (cls ? " " + cls : "");
    $("bsheet").setAttribute("role", "dialog"); $("bsheet").setAttribute("aria-modal", "true"); $("bsheet").setAttribute("aria-label", title);
    $("sheetBg").classList.add("on"); sheetBack = document.activeElement;
    // фокус внутрь панели: клавиатура и экранный диктор
    setTimeout(() => { const f = $("bsList").querySelector("button,input,select,textarea,[tabindex]"); if (f && !/^(INPUT|TEXTAREA)$/.test(f.tagName)) f.focus({ preventScroll: true }); }, 60);
  }
  function closeSheet() {
    $("sheetBg").classList.remove("on"); $("bsheet").classList.remove("on"); $("bsheet").classList.remove("cr-sheet");
    const pb = $("plusBtn"); if (pb) { pb.classList.remove("open"); pb.setAttribute("aria-expanded", "false"); }
    if (sheetBack && sheetBack.focus && document.contains(sheetBack)) { try { sheetBack.focus({ preventScroll: true }); } catch (e) {} } sheetBack = null;
  }
  // Escape закрывает панель; Tab не уходит за ее пределы
  document.addEventListener("keydown", (e) => {
    if (!$("bsheet").classList.contains("on")) return;
    if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
    if (e.key === "Tab") {
      const f = qa("button:not([disabled]),input,select,textarea,a[href]", $("bsheet")).filter((x) => x.offsetParent !== null); if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  $("sheetBg").onclick = closeSheet;
  function confirmSheet(title, text, okLabel, danger) {
    return new Promise((res) => {
      openSheet(title, `<p class="muted" style="font-size:13px;margin-bottom:14px">${esc(text)}</p><div class="sheet-btns"><button class="btn btn-ghost" id="cfNo">Отмена</button><button class="btn btn-main" id="cfYes" ${danger ? 'style="background:#e5243b"' : ""}>${esc(okLabel)}</button></div>`);
      $("cfNo").onclick = () => { closeSheet(); res(false); };
      $("cfYes").onclick = () => { closeSheet(); res(true); };
    });
  }

  /* ---------- "в сети" ---------- */
  let seenT = null;
  function startSeen() {
    if (seenT) return; const tick = () => { if (user && !document.hidden) api.touchSeen().catch(() => {}); };
    tick(); seenT = setInterval(tick, 60000); document.addEventListener("visibilitychange", tick);
  }
  function seenText(p) {
    if (!p || !p.last_seen_at || (user && user.show_seen === false)) return "";
    // нейтральные формулировки, без указания пола
    const m = (Date.now() - new Date(p.last_seen_at)) / 60000;
    if (m < 3) return "в сети";
    if (m < 60) return `в сети ${Math.max(3, Math.round(m))} мин назад`;
    if (m < 24 * 60) return `в сети ${Math.round(m / 60)} ч назад`;
    if (m < 48 * 60) return "в сети вчера";
    if (m < 7 * 24 * 60) return `в сети ${Math.round(m / 1440)} дн назад`;
    return "давно не в сети";
  }
  const isOnline = (p) => !!(p && !(user && user.show_seen === false) && p.last_seen_at && Date.now() - new Date(p.last_seen_at) < 180000);
  const vBadge = (p) => (p && p.verified ? '<span class="vbadge" title="Email подтвержден" aria-label="Email подтвержден">✓</span>' : "");
  function applyPendingInsta() {
    let v = null; try { v = localStorage.getItem("near_pending_insta"); } catch (e) {}
    if (v && user && !user.instagram) api.updateProfile({ instagram: v }).then((u) => { user = u; }).catch(() => {});
    try { localStorage.removeItem("near_pending_insta"); } catch (e) {}
  }

  /* ---------- знакомство с NEAR: видео 12 секунд (RU/KZ субтитры), лента не блокируется ---------- */
  const ONB_DONE = "near_onboarded";
  const onbDone = () => { try { return localStorage.getItem(ONB_DONE) === "1"; } catch (e) { return false; } };
  const onbMark = () => { try { localStorage.setItem(ONB_DONE, "1"); } catch (e) {} };
  const onbLang = () => (I18N.lang === "kz" ? "kz" : "ru");
  // без анимации: системная настройка "уменьшить движение" или режим экономии трафика
  const onbStatic = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches || !!(navigator.connection && navigator.connection.saveData); } catch (e) { return false; } };
  // при первом запуске — небольшая карточка в ленте; видео грузится только по нажатию
  function maybeOnboard(force) {
    if (force) return playOnboarding();
    if (onbDone() || $("onbCard")) return;
    const L = onbLang(), c = document.createElement("div"); c.className = "onb-card"; c.id = "onbCard";
    c.innerHTML = `<button type="button" class="onb-th" id="onbPlay" aria-label="Смотреть 12 секунд"><img src="media/onb-${L}-2.jpg" alt="" loading="lazy" decoding="async"><span>▶</span></button>
      <div class="onb-tx"><b>Как работает NEAR</b><span>Что происходит рядом — за 12 секунд</span><button type="button" class="btn btn-main" id="onbPlay2">Смотреть 12 секунд</button></div>
      <button type="button" class="x" id="onbClose" aria-label="Закрыть">✕</button>`;
    $("posts").before(c);
    $("onbPlay").onclick = $("onbPlay2").onclick = () => playOnboarding();
    $("onbClose").onclick = () => { onbMark(); Obs.track("onboarding_skip", { source: "card" }); c.remove(); };
  }
  function playOnboarding() {
    if ($("onb")) return;
    const card = $("onbCard"); if (card) card.remove();
    const L = onbLang(), still = onbStatic();
    const o = document.createElement("div"); o.className = "onb" + (still ? " still" : ""); o.id = "onb"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "Как работает NEAR");
    o.innerHTML = still
      ? `<img id="onbI" src="media/onb-${L}-2.jpg" alt=""><div class="onb-prog"><i id="onbP"></i></div><button class="onb-skip" id="onbX">Пропустить</button>
         <div class="onb-bar"><button class="btn btn-ghost" id="onbR">Далее ›</button><button class="btn btn-main" id="onbGo">Открыть NEAR</button></div>`
      : `<video id="onbV" src="media/onb-${L}.mp4" poster="media/onb-${L}-1.jpg" playsinline muted autoplay preload="auto" disablepictureinpicture></video>
         <div class="onb-prog"><i id="onbP"></i></div><button class="onb-skip" id="onbX">Пропустить</button>
         <div class="onb-bar"><button class="btn btn-ghost" id="onbR">↻ Еще раз</button><button class="btn btn-main" id="onbGo">Открыть NEAR</button></div>`;
    document.body.appendChild(o);
    const v = $("onbV");
    const close = () => { onbMark(); if (v) v.pause(); o.style.transition = "opacity .2s"; o.style.opacity = "0"; setTimeout(() => o.remove(), 200); document.removeEventListener("keydown", k); };
    const k = (e) => { if (e.key === "Escape") { Obs.track("onboarding_skip", { source: "esc" }); close(); } };
    document.addEventListener("keydown", k);
    $("onbX").onclick = () => { Obs.track("onboarding_skip", { source: still ? "static" : "video" }); close(); };
    $("onbGo").onclick = () => { Obs.track("onboarding_complete", { source: still ? "static" : "video" }); close(); };
    if (still) {
      // статичный вариант: 4 кадра листаются кнопкой, без движения
      const n = [2, 3, 4, 5]; let i = 0;
      const show = () => { $("onbI").src = `media/onb-${L}-${n[i]}.jpg`; $("onbP").style.width = ((i + 1) / n.length) * 100 + "%"; $("onbR").classList.toggle("hidden", i === n.length - 1); };
      $("onbR").onclick = () => { if (i < n.length - 1) { i++; show(); } };
      show(); return;
    }
    v.ontimeupdate = () => { if (v.duration) $("onbP").style.width = (v.currentTime / v.duration) * 100 + "%"; };
    v.onerror = close; // нет файла или нет сети — просто пропускаем
    v.play().catch(() => {});
    $("onbR").onclick = () => { v.currentTime = 0; v.play().catch(() => {}); };
  }

  /* ---------- защита от ботов: Cloudflare Turnstile ---------- */
  const Cap = {
    on: !!CFG.TURNSTILE_SITE_KEY, p: null, w: new Map(),
    load() { if (!this.p) this.p = loadScript("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", 15000).catch((e) => { this.p = null; throw e; }); return this.p; },
    // показать виджет в контейнере; вернет объект с token и reset()
    async mount(el) {
      if (!this.on || !el) return null;
      if (this.w.has(el)) return this.w.get(el);
      const st = { token: null, id: null, reset() { this.token = null; try { if (this.id != null) window.turnstile.reset(this.id); } catch (e) {} } };
      this.w.set(el, st);
      try {
        await this.load();
        st.id = window.turnstile.render(el, { sitekey: CFG.TURNSTILE_SITE_KEY, theme: "dark", language: "ru", size: "flexible", appearance: "interaction-only",
          callback: (t) => (st.token = t), "expired-callback": () => (st.token = null), "error-callback": () => { st.token = null; } });
      } catch (e) { el.innerHTML = '<div class="hint">Не удалось загрузить проверку "я не робот". Проверьте интернет</div>'; }
      return st;
    },
    // токен для формы; если проверка еще идет — подождать до 8 секунд
    async token(el) {
      if (!this.on) return undefined;
      const st = await this.mount(el); if (!st) return undefined;
      for (let i = 0; i < 40 && !st.token; i++) await new Promise((r) => setTimeout(r, 200));
      if (!st.token) throw new Error('Подтвердите, что вы не робот (галочка над кнопкой)');
      return st.token;
    },
    reset(el) { const st = this.w.get(el); if (st) st.reset(); }
  };
  const capOf = (form) => form && form.querySelector("[data-cap]");

  /* ---------- push-уведомления ---------- */
  const PUSH_DEF = { msg: true, comment: true, like: true, friend: true, near: true, radius: 3, quiet: true, sos_quiet: false, hide_text: false };
  const Push = {
    supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
    ios: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    standalone: (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true,
    key() { return "near_push_" + (user ? user.id : ""); },
    prefs() { try { return { ...PUSH_DEF, ...(JSON.parse(localStorage.getItem(this.key() + "_p") || "{}")) }; } catch (e) { return { ...PUSH_DEF }; } },
    setPrefs(p) { try { localStorage.setItem(this.key() + "_p", JSON.stringify(p)); } catch (e) {} },
    wanted() { try { return localStorage.getItem(this.key()) === "1"; } catch (e) { return false; } },
    setWanted(v) { try { localStorage.setItem(this.key(), v ? "1" : "0"); } catch (e) {} },
    async sub() { if (!this.supported) return null; const r = await navigator.serviceWorker.getRegistration(); return r ? r.pushManager.getSubscription() : null; },
    keyBytes() { const s = CFG.VAPID_PUBLIC_KEY.replace(/-/g, "+").replace(/_/g, "/"), b = atob(s + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); },
    where() { return pos.src === "gps" || pos.src === "district" ? { lat: pos.lat, lng: pos.lng } : { lat: null, lng: null }; },
    async save(s) {
      const j = s.toJSON(), w = this.where();
      await api.pushSave({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, prefs: this.prefs(), lat: w.lat, lng: w.lng });
      this.lastLoc = w;
    },
    async enable() {
      if (!api.pushAvailable) throw new Error("Push-уведомления работают, когда приложение подключено к серверу");
      if (!this.supported) throw new Error(this.ios && !this.standalone ? "На iPhone сначала добавьте NEAR на экран \"Домой\" и откройте с иконки" : "Этот браузер не поддерживает push-уведомления");
      if (!CFG.VAPID_PUBLIC_KEY) throw new Error("Push еще не настроены на сервере");
      const perm = await Notification.requestPermission();
      Obs.track("push_opt_in", { ok: perm === "granted", state: perm });
      if (perm !== "granted") throw new Error(perm === "denied" ? "Уведомления запрещены. Разрешите их для сайта в настройках браузера или телефона" : "Вы не разрешили уведомления");
      const reg = await navigator.serviceWorker.ready;
      let s = await reg.pushManager.getSubscription();
      try { if (!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this.keyBytes() }); }
      catch (e) { throw new Error("Браузер не смог подключить уведомления. Проверьте интернет и разрешение уведомлений для сайта, затем попробуйте снова"); }
      await this.save(s); this.setWanted(true);
    },
    async disable() { const s = await this.sub(); if (s) { await api.pushRemove(s.endpoint).catch(() => {}); } this.setWanted(false); },
    // при входе и при смене места: обновить подписку на сервере (только если пользователь сам включал)
    async sync(force) {
      if (!user || !api.pushAvailable || !this.supported || !this.wanted() || Notification.permission !== "granted") return;
      try {
        let s = await this.sub();
        if (!s) { const reg = await navigator.serviceWorker.ready; s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this.keyBytes() }); }
        const w = this.where(), l = this.lastLoc;
        if (!force && l && (w.lat == null || (Math.abs(w.lat - l.lat) < 0.01 && Math.abs(w.lng - l.lng) < 0.01))) return;
        await this.save(s);
      } catch (e) { console.warn("push sync", e); }
    },
    async test() {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification("NEAR", { body: "Так будут выглядеть уведомления: сообщения, ответы и SOS рядом", icon: "icon-192.png", badge: "icon-192.png", tag: "near-test" });
    }
  };
  // переход по нажатию на уведомление и по ссылкам вида #post= / #user= / #conv=
  function openHash(h) {
    if (!h) return; let m;
    if ((m = h.match(/post=([\w-]+)/))) openPost(m[1]);
    else if ((m = h.match(/user=([\w-]+)/))) openUser(m[1]);
    else if ((m = h.match(/conv=([\w-]+)/))) { if (user) openConv(m[1]); }
    else if (/notif/.test(h)) go("sv-notif");
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => {
    if (!e.data) return;
    if (e.data.type === "near-open") { openHash(e.data.hash); if (e.data.from === "push") Obs.track("push_opened"); }
    if (e.data.type === "near-resubscribe") Push.sync(true);
  });
  // карточка-предложение включить уведомления (один раз)
  // первое полезное действие (публикация, комментарий, сообщение, участие): считаем активацию и только тогда предлагаем push
  const usefulKey = () => "near_useful_" + (user ? user.id.slice(0, 12) : "guest");
  const hadUseful = () => { try { return localStorage.getItem(usefulKey()) === "1"; } catch (e) { return false; } };
  function usefulAction(source) {
    if (!user) return;
    if (!hadUseful()) { try { localStorage.setItem(usefulKey(), "1"); } catch (e) {} Obs.track("activation", { source }); }
    pushInvite();
  }
  function pushInvite() {
    const box = $("pushInvite"); if (!box) return;
    let dismissed = false; try { dismissed = localStorage.getItem("near_push_invite") === "x"; } catch (e) {}
    const can = user && hadUseful() && api.pushAvailable && CFG.VAPID_PUBLIC_KEY && !dismissed && ((Push.supported && Notification.permission === "default") || (Push.ios && !Push.standalone));
    box.classList.toggle("hidden", !can);
    if (!can) return;
    box.innerHTML = Push.supported
      ? `<span>🔔</span><div><b>Не пропускайте важное</b>Сообщения, ответы и SOS рядом — даже когда NEAR закрыт</div><button class="btn btn-main" id="piOn">Включить</button><button class="x" id="piX" aria-label="Закрыть">✕</button>`
      : `<span>📲</span><div><b>Уведомления на iPhone</b>Нажмите "Поделиться" ⬆️ → "На экран Домой", откройте NEAR с иконки и включите уведомления</div><button class="x" id="piX" aria-label="Закрыть">✕</button>`;
    $("piX").onclick = () => { try { localStorage.setItem("near_push_invite", "x"); } catch (e) {} box.classList.add("hidden"); };
    if ($("piOn")) $("piOn").onclick = async () => { try { await Push.enable(); toast("🔔 Уведомления включены"); box.classList.add("hidden"); } catch (er) { toast(er.message); } };
  }
  function pushSection() {
    const p = Push.prefs();
    if (!api.pushAvailable) return `<div class="sgrp"><div class="sg-t">Push-уведомления на телефон</div><div class="s-note">Работают, когда приложение подключено к серверу.</div></div>`;
    let state = "";
    if (!Push.supported) state = Push.ios && !Push.standalone
      ? '<div class="s-note s-ios">📲 На iPhone: откройте NEAR в Safari → "Поделиться" ⬆️ → "На экран Домой". Затем запустите NEAR с иконки и включите уведомления здесь (нужен iOS 16.4 или новее).</div>'
      : '<div class="s-note">Этот браузер не поддерживает push-уведомления. Попробуйте Chrome или Safari.</div>';
    else if (Notification.permission === "denied") state = '<div class="s-note warn-t">Уведомления запрещены для NEAR в настройках браузера или телефона. Разрешите их там и вернитесь сюда.</div>';
    const on = Push.supported && Notification.permission === "granted" && Push.wanted();
    const tg = (k, v) => `<span class="tg${v ? " on" : ""}" data-ptg="${k}"></span>`;
    const r = (k, ico, t, sub) => `<div class="srow"><span class="si">${ico}</span><span class="st2"><b>${t}</b>${sub ? `<small>${sub}</small>` : ""}</span>${tg(k, p[k])}</div>`;
    return `<div class="sgrp" id="pushGrp"><div class="sg-t">Push-уведомления на телефон</div>${state}
      ${Push.supported ? `<div class="srow"><span class="si">🔔</span><span class="st2"><b>Присылать уведомления</b><small>${on ? "включены на этом устройстве" : "даже когда NEAR закрыт"}</small></span><span class="tg${on ? " on" : ""}" id="pushMain"></span></div>` : ""}
      ${on ? r("msg", "✉️", "Личные сообщения") + r("comment", "💬", "Комментарии и ответы") + r("like", "❤️", "Лайки") + r("friend", "🤝", "Заявки в друзья")
        + r("near", "🚨", "Происшествия и SOS рядом", "по вашему местоположению")
        + (p.near ? `<div class="srow"><span class="si"></span><span class="st2"><b>Радиус</b></span><span class="rad-ch">${[1, 3, 5, 10].map((k) => `<button data-prad="${k}" class="${+p.radius === k ? "on" : ""}">${k} км</button>`).join("")}</span></div>` : "")
        + r("quiet", "🌙", "Тихие часы 23:00–08:00", "по времени Алматы, без уведомлений ночью")
        + (p.quiet ? r("sos_quiet", "🆘", "SOS рядом — даже в тихие часы", "только если вы согласны получать их ночью") : "")
        + r("hide_text", "🔒", "Скрывать текст на экране блокировки", "вместо текста — \"Новое сообщение\"")
        + `<button class="srow" id="pushTest"><span class="si">🧪</span><span class="st2"><b>Проверить уведомление</b></span><span class="sr">›</span></button>` : ""}</div>`;
  }
  function bindPushSection() {
    const g = $("pushGrp"); if (!g) return;
    if ($("pushMain")) $("pushMain").onclick = async () => {
      const t = $("pushMain"), turnOn = !t.classList.contains("on"); t.classList.toggle("on", turnOn);
      try { if (turnOn) { await Push.enable(); toast("🔔 Уведомления включены"); } else { await Push.disable(); toast("Уведомления выключены"); } }
      catch (e) { t.classList.toggle("on", !turnOn); toast(e.message); }
      renderSettings();
    };
    qa("[data-ptg]", g).forEach((t) => (t.onclick = async () => {
      const p = Push.prefs(); p[t.dataset.ptg] = !p[t.dataset.ptg]; Push.setPrefs(p); t.classList.toggle("on", p[t.dataset.ptg]);
      if (t.dataset.ptg === "near" || t.dataset.ptg === "quiet") renderSettings();
      Push.sync(true);
    }));
    qa("[data-prad]", g).forEach((b) => (b.onclick = () => { const p = Push.prefs(); p.radius = +b.dataset.prad; Push.setPrefs(p); qa("[data-prad]", g).forEach((x) => x.classList.toggle("on", x === b)); Push.sync(true); }));
    if ($("pushTest")) $("pushTest").onclick = () => Push.test().then(() => toast("Сверните приложение, если уведомление не появилось сверху")).catch((e) => toast(e.message));
  }

  /* ---------- удаление аккаунта ---------- */
  function deleteAccountFlow() {
    openSheet("Удалить аккаунт", `<div class="del-warn"><b>Это нельзя отменить.</b> Будут удалены навсегда:<ul><li>профиль, фото и описание</li><li>все ваши публикации, фото и видео</li><li>комментарии, лайки и сохраненное</li><li>переписки и файлы в них, друзья</li></ul>Жалобы, которые вы отправили, тоже удалятся.</div>
      <div class="fld"><label>Чтобы подтвердить, введите слово УДАЛИТЬ</label><input id="delWord" autocomplete="off" autocapitalize="characters" placeholder="УДАЛИТЬ"></div>
      <div class="err" id="delErr"></div>
      <div class="sheet-btns"><button class="btn btn-ghost" id="delNo">Отмена</button><button class="btn btn-danger" id="delYes" disabled>Удалить навсегда</button></div>`);
    $("delWord").oninput = () => { $("delYes").disabled = $("delWord").value.trim().toUpperCase() !== "УДАЛИТЬ"; };
    $("delNo").onclick = closeSheet;
    $("delYes").onclick = async () => {
      try {
        await Push.disable().catch(() => {});
        try { await busy($("delYes"), () => api.deleteAccount()); }
        catch (e) {
          if (e.code !== "REAUTH") throw e;
          // SEC-05: свежая аутентификация перед удалением
          if (user.provider === "google") { toast("Войдите через Google еще раз и повторите удаление"); await api.reauth(); return; }
          const pw = $("delPw");
          if (!pw) { $("delErr").innerHTML = ""; $("delErr").insertAdjacentHTML("beforebegin", `<div class="fld"><label for="delPw">Для удаления введите пароль еще раз</label><input id="delPw" type="password" autocomplete="current-password"></div>`); $("delPw").focus(); return; }
          await busy($("delYes"), async () => { await api.reauth(pw.value); await api.deleteAccount(); });
        }
        const was = user && user.id; Conv.unsub(); closeSheet(); user = null; cache.clear(); Cache.wipe(was);
        onUserChange(); hist = []; go("v-feed", false); toast("Аккаунт удален. Спасибо, что были с NEAR");
      } catch (e) { $("delErr").textContent = e.message; $("delErr").classList.add("on"); }
    };
  }

/* ===== 10-auth.js ===== */
  /* =====================================================
     AUTH
     ===================================================== */
  let resetEmail = null;
  function showAuth(panel = "login", err) {
    document.body.classList.add("authing");
    $("v-auth").classList.add("on");
    qa(".auth-p").forEach((f) => f.classList.add("hidden"));
    $("f-" + panel).classList.remove("hidden");
    if (Cap.on) { const c = capOf($("f-" + panel)); if (c) Cap.mount(c); }
    qa("[data-err]").forEach((x) => x.classList.remove("on"));
    if (err) { const e = $("f-" + panel).querySelector("[data-err]"); if (e) { e.textContent = err; e.classList.add("on"); } }
    $("guestBtn").classList.toggle("hidden", panel === "reset");
    $("v-auth").scrollTop = 0;
  }
  function hideAuth() { document.body.classList.remove("authing"); $("v-auth").classList.remove("on"); if (!document.querySelector(".view.on")) go("v-feed", false); }
  // после входа (в том числе через Google с перезагрузкой) выполняется то, ради чего человек входил
  function requireAuth(reason, intent) {
    if (user) return true;
    try { if (intent) sessionStorage.setItem("near_intent", JSON.stringify({ ...intent, at: Date.now() })); else sessionStorage.removeItem("near_intent"); } catch (e) {}
    showAuth("login", reason); return false;
  }
  // сервер не пустил: email не подтвержден или профиль не заполнен — объясняем и даем действие
  function gateError(e) {
    const m = (e && e.message) || "";
    if (/Подтвердите email/.test(m)) {
      openSheet("Подтвердите email", `<p class="muted" style="font-size:13.5px;margin-bottom:12px">Публиковать, комментировать и писать сообщения можно после подтверждения почты. Мы отправили письмо на <b>${esc((user && user.email) || "")}</b>.</p>
        <div class="sheet-btns"><button class="btn btn-ghost" id="gwNo">Позже</button><button class="btn btn-main" id="gwSend">Отправить письмо еще раз</button></div>`);
      $("gwNo").onclick = closeSheet;
      $("gwSend").onclick = async () => { try { await busy($("gwSend"), () => api.resendConfirm(user.email)); closeSheet(); toast("📬 Письмо отправлено. Следующее — через минуту"); } catch (er) { toast(er.message); } };
      return true;
    }
    if (/Заполните профиль/.test(m)) { showComplete(); return true; }
    // v14: личные сообщения незнакомым — после проверки возраста; до этого — через друзей
    if (e && e.hint === "age_gate") {
      openSheet("Пока только через друзей", `<p class="muted" style="font-size:13.5px;margin-bottom:12px">Личные сообщения незнакомым людям пока недоступны: это защита от спама и мошенников. Добавьте человека в друзья — после принятия заявки можно писать. Обсудить публикацию можно в комментариях.</p>
        <div class="sheet-btns"><button class="btn btn-main" id="agOk">Понятно</button></div>`);
      $("agOk").onclick = closeSheet; return true;
    }
    return false;
  }
  function runIntent() {
    let it = null; try { it = JSON.parse(sessionStorage.getItem("near_intent") || "null"); sessionStorage.removeItem("near_intent"); } catch (e) {}
    if (!it || !user || Date.now() - it.at > 15 * 60e3) return;
    setTimeout(() => {
      if (it.t === "like") doLike(it.a); else if (it.t === "save") doSave(it.a); else if (it.t === "join") doJoin(it.a);
      else if (it.t === "create") openCreate({ type: it.a || undefined }); else if (it.t === "comments") openPost(it.a, true);
      else if (it.t === "chat") startChat(it.a); else if (it.t === "sos") go("sv-sos"); else if (it.t === "notif") go("sv-notif");
    }, 400);
  }
  function formErr(form, msg) { const e = form.querySelector("[data-err]"); e.textContent = msg; e.classList.add("on"); }
  async function busy(btn, fn) {
    const t = btn.textContent; btn.disabled = true; btn.textContent = "Подождите...";
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = t; }
  }
  qa("[data-auth]").forEach((b) => (b.onclick = () => showAuth(b.dataset.auth)));
  qa("[data-eye]").forEach((b) => (b.onclick = () => { const i = b.previousElementSibling; i.type = i.type === "password" ? "text" : "password"; b.textContent = i.type === "password" ? "👁" : "🙈"; }));
  $("guestBtn").onclick = () => { hideAuth(); guestBar(); };

  $("f-login").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target, fd = new FormData(f);
    if (!fd.get("email") || !fd.get("password")) return formErr(f, "Заполните email и пароль");
    try { await busy(f.querySelector("[type=submit]"), async () => api.signIn({ email: fd.get("email"), password: fd.get("password"), captchaToken: await Cap.token(capOf(f)) })); user = api.user(); afterLogin(); }
    catch (err) { if (/не подтверждена/.test(err.message)) { showSent(String(fd.get("email")).trim(), false); return; } formErr(f, err.message); }
    finally { Cap.reset(capOf(f)); }
  };
  /* ---------- регистрация в 3 шага ---------- */
  const SU = $("f-signup"); let suStep = 1, suAvatar = null, pendingEmail = "";
  const distOpts = (sel) => `<option value="">Не указывать</option>` + DISTRICTS.map(([n]) => `<option${n === sel ? " selected" : ""}>${n}</option>`).join("");
  $("suDistrict").innerHTML = distOpts(""); $("cpDistrict").innerHTML = distOpts("");
  // v14: живая проверка никнейма (формат — сразу, занятость — запросом через 400 мс)
  function nickLive(input, hint) {
    let t = null, seq = 0; const base = hint.textContent;
    input.addEventListener("input", () => {
      clearTimeout(t); const v = input.value.trim(), my = ++seq;
      hint.className = "hint"; if (!v) { hint.textContent = base; return; }
      const p = N.nickProblem(v); if (p) { hint.textContent = p; hint.classList.add("bad"); return; }
      hint.textContent = "Проверяем...";
      t = setTimeout(async () => { try { const r = await api.nicknameCheck(v); if (my !== seq) return; hint.textContent = r.ok ? "✓ Никнейм свободен" : r.error; hint.classList.add(r.ok ? "ok" : "bad"); } catch (e) { hint.textContent = base; } }, 400);
    });
  }
  nickLive($("suNick"), $("suNickHint")); nickLive($("cpNick"), $("cpNickHint"));
  function pwScore(pw) { let n = 0; if (pw.length >= 8) n++; if (/\d/.test(pw) && /[a-zа-я]/i.test(pw)) n++; if (/[A-ZА-Я]/.test(pw) && /[a-zа-я]/.test(pw)) n++; if (/[^\w\s]/.test(pw) || pw.length >= 12) n++; return pw.length < 8 ? Math.min(n, 1) : Math.max(n, 1); }
  SU.password.oninput = () => {
    const sc = pwScore(SU.password.value), L = ["", "слабый", "средний", "хороший", "надежный"];
    qa(".pw-meter i", SU).forEach((x, i) => (x.className = i < sc ? "s" + sc : ""));
    $("pwHint").textContent = SU.password.value ? "Пароль: " + L[sc] + (SU.password.value.length < 8 ? " · нужно минимум 8 символов" : "") : "Минимум 8 символов, буквы и цифры";
  };
  function suGo(n) {
    suStep = n; qa(".st", SU).forEach((x) => x.classList.toggle("hidden", +x.dataset.st !== n));
    qa(".steps i", SU).forEach((x, i) => x.classList.toggle("on", i < n));
    SU.querySelector("[data-err]").classList.remove("on"); $("v-auth").scrollTop = 0;
    const st = SU.querySelector(`[data-st="${n}"]`); st.classList.remove("st-in"); void st.offsetWidth; st.classList.add("st-in");
  }
  function suCheck(n) {
    const email = SU.email.value.trim(), pw = SU.password.value;
    if (n === 1) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Проверьте правильность email";
      if (pw.length < 8) return "Пароль должен быть не короче 8 символов";
      if (!/\d/.test(pw) || !/[a-zа-я]/i.test(pw)) return "В пароле нужны и буквы, и цифры";
      if (pw !== SU.password2.value) return "Пароли не совпадают";
    }
    if (n === 2) {
      const np = N.nickProblem(SU.nickname.value); if (np) return np;
      if ($("suNickHint").classList.contains("bad")) return $("suNickHint").textContent;
      if (!SU.rules.checked) return "Чтобы продолжить, примите правила сообщества";
    }
    return "";
  }
  SU.addEventListener("click", (e) => {
    if (e.target.closest("[data-next]")) { const er = suCheck(suStep); if (er) return formErr(SU, er); suGo(suStep + 1); }
    else if (e.target.closest("[data-prev]")) suGo(suStep - 1);
    else if (e.target.closest("[data-skip]")) { SU.dataset.skip = "1"; SU.requestSubmit ? SU.requestSubmit() : SU.onsubmit(new Event("submit")); }
  });
  SU.addEventListener("input", () => SU.querySelector("[data-err]").classList.remove("on"));
  SU.addEventListener("keydown", (e) => { if (e.key === "Enter" && suStep < 3) { e.preventDefault(); const b = SU.querySelector(`[data-st="${suStep}"] [data-next]`); b && b.click(); } });
  $("suAva").onchange = (e) => { const f = e.target.files[0]; if (!f) return; try { N.validateFile(f); } catch (er) { return toast(er.message); } suAvatar = f; $("suAvaPrev").style.backgroundImage = `url(${URL.createObjectURL(f)})`; $("suAvaPrev").textContent = ""; $("suAvaBox").querySelector("b").textContent = "Фото выбрано ✓"; };
  SU.onsubmit = async (e) => {
    e.preventDefault();
    for (const n of [1, 2]) { const er = suCheck(n); if (er) { suGo(n); return formErr(SU, er); } }
    // шаг 3 необязательный: "Пропустить" — без района, фото и Instagram
    const skip = SU.dataset.skip === "1"; delete SU.dataset.skip;
    const data = { nickname: SU.nickname.value.trim(), email: SU.email.value.trim(), password: SU.password.value, district: skip ? "" : SU.district.value };
    const insta = skip ? "" : SU.instagram.value.trim();
    if (skip) suAvatar = null;
    try {
      const r = await busy(SU.querySelector("[type=submit]"), async () => api.signUp({ ...data, captchaToken: await Cap.token(capOf(SU)) }));
      if (r.needsConfirm) {
        try { if (insta) localStorage.setItem("near_pending_insta", insta); } catch (er) {}
        showSent(data.email, true);
      } else {
        user = api.user();
        if (suAvatar || insta) { try { user = await api.updateProfile({ avatarFile: suAvatar || undefined, instagram: insta || undefined }); } catch (er) { toast(er.message); } }
        afterLogin(true);
      }
      resetSignup();
    } catch (err) { formErr(SU, err.message); if (/email/i.test(err.message)) suGo(1); else if (/[Нн]икнейм/.test(err.message)) suGo(2); } finally { Cap.reset(capOf(SU)); }
  };
  function resetSignup() { SU.reset(); suAvatar = null; $("suAvaPrev").style.backgroundImage = ""; $("suAvaPrev").textContent = "📷"; $("suAvaBox").querySelector("b").textContent = "Добавить фото"; $("suNickHint").className = "hint"; suGo(1); SU.password.oninput(); }
  /* ---------- подтверждение почты ---------- */
  let resendT = 0;
  function showSent(email, fresh) {
    pendingEmail = email;
    $("sentText").innerHTML = (fresh ? "Аккаунт создан! " : "Почта еще не подтверждена. ") + `Мы отправили письмо на <b>${esc(email)}</b>. Откройте его и нажмите "Подтвердить", вы войдете автоматически.`;
    showAuth("sent"); if (fresh) startResendTimer();
  }
  function startResendTimer() {
    resendT = 60; const b = $("resendBtn"); b.disabled = true;
    const t = setInterval(() => { resendT--; b.textContent = resendT > 0 ? `Отправить еще раз через ${resendT} с` : "Отправить письмо еще раз"; if (resendT <= 0) { clearInterval(t); b.disabled = false; } }, 1000);
    b.textContent = `Отправить еще раз через ${resendT} с`;
  }
  $("resendBtn").onclick = async () => {
    if (!pendingEmail) return showAuth("login");
    try { await api.resendConfirm(pendingEmail, await Cap.token(capOf($("f-sent")))); toast("📬 Письмо отправлено еще раз"); startResendTimer(); } catch (er) { toast(er.message); } finally { Cap.reset(capOf($("f-sent"))); }
  };
  /* ---------- Google ---------- */
  qa("[data-google]").forEach((b) => (b.onclick = async () => {
    try { b.disabled = true; await api.signInWithGoogle(); } catch (er) { formErr(b.closest("form"), er.message); } finally { setTimeout(() => (b.disabled = false), 1500); }
  }));
  // после Google или для аккаунта v12: выбрать никнейм (имя, фамилия и пол больше не нужны), район, правила
  function needsCompletion(u) { return u && (!u.nickname || !u.accepted_rules); }
  function showComplete() {
    const f = $("f-complete"); f.nickname.value = (user && user.nickname) || ""; $("cpNickHint").className = "hint"; $("cpDistrict").innerHTML = distOpts((user && user.district) || "");
    f.querySelector("h1").textContent = user && user.nickname ? "Почти готово" : "Выберите никнейм";
    f.querySelector(".sub").textContent = user && user.provider === "google" ? "Вы вошли через Google. Имя из Google мы не показываем — соседи увидят только никнейм"
      : "Мы обновили профиль: вместо имени и пола теперь никнейм. Старые имя и пол удаляются";
    showAuth("complete"); $("guestBtn").classList.add("hidden");
  }
  $("f-complete").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target, nick = f.nickname.value.trim();
    const np = N.nickProblem(nick); if (np) return formErr(f, np);
    if (!f.rules.checked) return formErr(f, "Чтобы продолжить, примите правила сообщества");
    try {
      user = await busy(f.querySelector("[type=submit]"), async () => {
        await api.updateProfile({ district: f.district.value || null, acceptRules: true });
        return user && user.nickname === nick ? api.user() : api.setNickname(nick);
      });
      afterLogin(true);
    } catch (er) { formErr(f, er.message); }
  };
  $("f-forgot").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target, email = (new FormData(f).get("email") || "").trim();
    if (!email) return formErr(f, "Укажите email");
    try {
      const r = await busy(f.querySelector("[type=submit]"), async () => api.resetPassword(email, await Cap.token(capOf(f))));
      if (r.localEmail) { resetEmail = r.localEmail; showAuth("reset"); toast("Демо-режим: задайте новый пароль сразу"); }
      else { $("sentText").innerHTML = `Если аккаунт с адресом <b>${esc(email)}</b> существует, мы отправили на него ссылку для нового пароля. Ссылка действует 1 час.`; showAuth("sent"); }
    } catch (err) { formErr(f, err.message); } finally { Cap.reset(capOf(f)); }
  };
  $("f-reset").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target, pw = new FormData(f).get("password") || "";
    try { await busy(f.querySelector("[type=submit]"), () => api.updatePassword(pw, resetEmail)); resetEmail = null; history.replaceState(null, "", location.pathname); user = api.user(); afterLogin(); toast("✓ Пароль изменен"); }
    catch (err) { formErr(f, err.message); }
  };
  function afterLogin(isNew) {
    if (needsCompletion(user)) return showComplete();
    hideAuth(); qa(".auth-p").forEach((f) => f.reset && f.reset());
    applyPendingInsta(); startSeen(); Push.sync(true);
    toast(isNew ? "🎉 Добро пожаловать в NEAR, " + (user && user.name) + "!" : "👋 Привет, " + (user && user.name) + "!");
    if (isNew) Obs.track("signup");
    onUserChange(); runIntent();
  }
  function onUserChange() {
    loadHidden(); loadPrefs(); profCounts = null; Push.lastLoc = null; Push.sync(true); pushInvite(); guestBar(); chatSeen = -1;
    if (api) Live.start();
    feedDirty = true; wide = null; loadFeed(); refreshBadge(); refreshChatBadge(); if (cur() === "v-prof") renderProfile(); if (cur() === "v-chats") renderChats();
    if (mapReady) loadMapPosts();
  }

/* ===== 20-location.js ===== */
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
      pos = { lat: g.lat, lng: g.lng, real: true, src: "gps", acc: g.acc || null }; $("locName").textContent = "Рядом со мной";
      if (typeof Push !== "undefined") Push.sync();
      if (typeof geoBanner === "function") geoBanner();
      return true;
    } catch (e) { if (!silent) toast(e.message); return false; }
  }
  // где смотреть: GPS, избранные места (приватные) или район
  $("locBtn").onclick = async () => {
    let places = []; try { places = user ? await api.placesList() : []; } catch (e) {}
    const cur = $("locName").textContent;
    openSheet("Где смотреть?", `<button class="opt-row${pos.src === "gps" ? " on" : ""}" data-loc="me">📍 Мое местоположение<span>${pos.src === "gps" ? "✓" : ""}</span></button>`
      + (places.length ? '<div class="lbl mt8">Избранные места</div>' + places.map((p) => `<button class="opt-row${pos.src === "place" && pos.pid === p.id ? " on" : ""}" data-place="${p.id}"><span class="pl-n">⭐ <span translate="no">${esc(p.name)}</span> · ${fmtDist(p.radius)}${p.notify ? " · 🔔" : ""}</span><span>${pos.src === "place" && pos.pid === p.id ? "✓" : ""}</span></button>`).join("") : "")
      + (user ? `<button class="opt-row" data-addplace>＋ Сохранить ${pos.src === "city" ? "центр" : "это место"} в избранное<span>›</span></button>` : "")
      + '<div class="lbl mt8">Районы</div>'
      + DISTRICTS.map((d) => `<button class="opt-row${cur === d[0] ? " on" : ""}" data-loc="${d[0]}">${d[0]} район<span>${cur === d[0] ? "✓" : ""}</span></button>`).join(""));
    const apply = (name) => { $("locName").textContent = name; wide = null; feedDirty = true; loadFeed(); drawMe(); fitRadius(); geoBanner(); toast("📍 " + name); };
    qa("[data-loc]", $("bsList")).forEach((b) => (b.onclick = async () => {
      closeSheet();
      if (b.dataset.loc === "me") { Obs.track("location_permission", { state: "asked" }); const ok = await useMyLocation(); Obs.track("location_permission", { state: ok ? "granted" : "denied" }); if (!ok) return; apply("Рядом со мной"); return; }
      const d = DISTRICTS.find((x) => x[0] === b.dataset.loc); pos = { lat: d[1], lng: d[2], real: false, src: "district", name: d[0], acc: null }; apply(d[0]);
    }));
    qa("[data-place]", $("bsList")).forEach((b) => (b.onclick = () => {
      closeSheet(); const p = places.find((x) => x.id === b.dataset.place); if (!p) return;
      pos = { lat: p.lat, lng: p.lng, real: false, src: "place", name: p.name, pid: p.id, acc: null };
      if ([500, 1000, 3000, 5000, 10000].includes(p.radius)) setRadius(p.radius);
      apply(p.name);
    }));
    const ap = $("bsList").querySelector("[data-addplace]"); if (ap) ap.onclick = () => placeSheet(null);
  };
  // избранное место: название, радиус, уведомления (по умолчанию выключены — только по согласию)
  function placeSheet(pl) {
    const p = pl || { name: "", lat: pos.lat, lng: pos.lng, radius: 1000, notify: false };
    openSheet(pl ? "Избранное место" : "Сохранить место", `<div class="fld"><label for="plName">Название</label><input id="plName" maxlength="40" value="${esc(p.name)}" placeholder="Например: Дом, Работа, Школа"></div>
      <div class="lbl">Радиус</div><div class="rad-ch wide" id="plRad">${[500, 1000, 3000, 5000].map((r) => `<button data-r="${r}" class="${p.radius === r ? "on" : ""}">${fmtDist(r)}</button>`).join("")}</div>
      <label class="rules-check mt12"><input type="checkbox" id="plNotify" ${p.notify ? "checked" : ""}> <span>Присылать push о происшествиях и SOS рядом с этим местом</span></label>
      <div class="s-note">Место видите только вы. Точка хранится с точностью около 100 м.</div>
      <div class="err" id="plErr"></div>
      <div class="sheet-btns">${pl ? '<button class="btn btn-ghost" id="plDel">Удалить</button>' : '<button class="btn btn-ghost" id="plNo">Отмена</button>'}<button class="btn btn-main" id="plOk">Сохранить</button></div>`);
    let rad = p.radius;
    qa("#plRad [data-r]").forEach((b) => (b.onclick = () => { rad = +b.dataset.r; qa("#plRad button").forEach((x) => x.classList.toggle("on", x === b)); }));
    if ($("plNo")) $("plNo").onclick = closeSheet;
    if ($("plDel")) $("plDel").onclick = async () => { try { await api.placeDelete(pl.id); closeSheet(); toast("Место удалено"); if (cur() === "sv-settings") renderSettings(); } catch (e) { toast(e.message); } };
    $("plOk").onclick = async () => {
      try {
        await busy($("plOk"), () => api.placeSave({ id: pl && pl.id, name: $("plName").value, lat: p.lat, lng: p.lng, radius: rad, notify: $("plNotify").checked }));
        closeSheet(); toast("⭐ Место сохранено"); if (cur() === "sv-settings") renderSettings();
      } catch (e) { $("plErr").textContent = e.message; $("plErr").classList.add("on"); }
    };
  }

/* ===== 30-feed.js ===== */
  /* =====================================================
     FEED
     ===================================================== */
  let feedDirty = false;
  function chipsHtml(active) { return CHIPS.map(([k, n]) => `<button class="chip${k === active ? " on" : ""}" data-c="${k}">${n}</button>`).join(""); }
  $("cats").innerHTML = chipsHtml("all");
  $("cats").onclick = (e) => { const b = e.target.closest("[data-c]"); if (!b) return; feedCat = b.dataset.c; $("cats").innerHTML = chipsHtml(feedCat); saveFeedPrefs(); Obs.track("filter_changed", { category: feedCat }); loadFeed(); };
  $("radius").onclick = (e) => { const b = e.target.closest("[data-r]"); if (!b) return; setRadius(+b.dataset.r); saveFeedPrefs(); Obs.track("filter_changed", { radius: R }); loadFeed(); };
  function setRadius(r) {
    R = r;
    qa("#radius [data-r], #mapRad [data-r]").forEach((x) => x.classList.toggle("on", +x.dataset.r === r));
    if (mapReady) { drawMe(); if (mapMode === "radius") loadMapPosts(true); }
    if (typeof geoBanner === "function") geoBanner();
  }
  // MAP-01: режим карты — "на экране" (рамка) или "в радиусе" (как лента)
  let mapMode = "screen";

  function shieldFor(m, ownerId) {
    if (!m) return null;
    if (m.mod_status === "flagged") return "⚠️ Возможно неприемлемое фото";
    if (m.mod_status === "pending" && !(user && user.id === ownerId)) return "⏳ Фото проверяется";
    return null;
  }
  /* ---------- иконки панели действий ---------- */
  const IC = {
    heart: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 20.5s-7.5-4.6-9.3-9.1C1.5 8.3 3.4 4.8 6.8 4.5c2-.2 3.6.9 5.2 2.8 1.6-1.9 3.2-3 5.2-2.8 3.4.3 5.3 3.8 4.1 6.9-1.8 4.5-9.3 9.1-9.3 9.1z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    heartOn: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 20.5s-7.5-4.6-9.3-9.1C1.5 8.3 3.4 4.8 6.8 4.5c2-.2 3.6.9 5.2 2.8 1.6-1.9 3.2-3 5.2-2.8 3.4.3 5.3 3.8 4.1 6.9-1.8 4.5-9.3 9.1-9.3 9.1z" fill="#ff3b6b" stroke="#ff3b6b" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    cmt: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M20.5 11.6a8.4 8.4 0 0 1-12.3 7.5L3.5 20.5l1.4-4.4A8.4 8.4 0 1 1 20.5 11.6z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M21 3 10.2 13.8M21 3l-6.8 18-3.9-7.2L3 9.9 21 3z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    save: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M18.5 21 12 15.8 5.5 21V4.5a1.5 1.5 0 0 1 1.5-1.5h10a1.5 1.5 0 0 1 1.5 1.5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    saveOn: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M18.5 21 12 15.8 5.5 21V4.5a1.5 1.5 0 0 1 1.5-1.5h10a1.5 1.5 0 0 1 1.5 1.5z" fill="#ffd166" stroke="#ffd166" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>'
  };
  const fmtDur = (s) => { s = Math.round(s || 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const LONG_TEXT = 240;
  let hiddenPosts = new Set();
  const hiddenKey = () => "near_hidden_" + (user ? user.id : "guest");
  function loadHidden() { try { hiddenPosts = new Set(JSON.parse(localStorage.getItem(hiddenKey()) || "[]")); } catch (e) { hiddenPosts = new Set(); } }
  function saveHidden() { try { localStorage.setItem(hiddenKey(), JSON.stringify([...hiddenPosts])); } catch (e) {} }

  // галерея: все фото и видео публикации, свайп, счетчик 1/N
  function galleryHtml(p) {
    if (!p.media.length) return "";
    const m0 = p.media[0], n = p.media.length;
    const r = m0.w && m0.h ? Math.max(0.6, Math.min(1.25, m0.h / m0.w)) : m0.type === "video" ? 1.25 : 1;
    const slides = p.media.map((m, i) => {
      const sh = shieldFor(m, p.user_id);
      if (m.type === "video") return `<div class="gs vid" data-i="${i}"><video data-src="${esc(m.url)}${m.poster ? "" : "#t=0.3"}"${m.poster ? ` data-poster="${esc(m.poster)}"` : ""} playsinline muted preload="none"></video>
        <button class="vplay" type="button" aria-label="Смотреть видео">▶</button><span class="vdur${m.duration ? "" : " hidden"}">${m.duration ? fmtDur(m.duration) : ""}</span><button class="vfs" type="button" aria-label="На весь экран">⛶</button><span class="vload hidden"><i class="mini-spin"></i></span></div>`;
      if (sh) return `<div class="gs blur-wrap" data-reveal data-i="${i}"><img data-src="${esc(m.thumb || m.url)}" alt="" decoding="async"><div class="shield">${sh}<button type="button">Показать</button></div></div>`;
      return `<div class="gs" data-img data-i="${i}"><img data-src="${esc(m.url)}"${m.thumb && m.thumb !== m.url ? ` data-thumb="${esc(m.thumb)}"` : ""} alt="" decoding="async"></div>`;
    }).join("");
    return `<div class="gal" data-gal="${p.id}" style="--r:${r.toFixed(3)}"><div class="gal-track">${slides}</div>${n > 1 ? `<span class="gal-n">1/${n}</span><div class="gal-dots">${p.media.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div>` : ""}<div class="heart-burst">${IC.heartOn}</div></div>`;
  }
  const expired = (p) => !!(p.expires_at && new Date(p.expires_at) <= Date.now());
  function statusChip(p) {
    if (p.status === "closed") return '<span class="nst done">✅ Неактуально</span>';
    if (p.status === "hidden") return '<span class="nst red">🛡 Скрыто</span>';
    if (p.status === "draft") return '<span class="nst">✎ Черновик</span>';
    if (expired(p)) return '<span class="nst done">⏱ Срок истек</span>';
    if (p.is_sos) return '<span class="nst red">🆘 SOS</span>';
    const h = (Date.now() - new Date(p.created_at)) / 3600e3;
    return h < 24 ? '<span class="nst live">● Актуально</span>' : "";
  }
  function card(p) {
    const c = CATS[p.category] || CATS.talk, closed = p.status === "closed", long = p.text.length > LONG_TEXT || (p.text.match(/\n/g) || []).length > 4;
    const join = p.event && !closed ? `<button class="act${p.event.joined ? " joined" : ""}" data-join="${p.id}">${p.event.joined ? "✓ Иду" : "Иду"} · ${p.event.members}${p.event.capacity ? "/" + p.event.capacity : ""}</button>` : "";
    return `<article class="post${closed || expired(p) ? " closed" : ""}${p.is_sos ? " sos" : ""}" data-post="${p.id}">
      <header class="post-h"><span class="who-link" data-user="${p.user_id}">${ava(p.author, c.c)}</span>
        <div class="who"><b class="who-link" data-user="${p.user_id}" translate="no">${esc(p.author.name)}${vBadge(p.author)}</b><span>${timeAgo(p.created_at)}${p.updated_at && new Date(p.updated_at) - new Date(p.created_at) > 60000 ? " · изменено" : ""}</span></div>
        <span class="cat" style="--c:${c.c}">${p.is_sos ? "🆘 SOS" : c.e + " " + c.n}</span><button class="pmenu" data-pmenu="${p.id}" aria-label="Меню публикации">${IC.more}</button></header>
      <div class="post-d${long ? " clamp" : ""}" translate="no">${esc(p.text)}</div>${long ? '<button class="more-t" data-moretext>Показать полностью</button>' : ""}
      ${galleryHtml(p)}
      <div class="post-near"><button data-onmap="${p.id}">📍 ${fmtDist(D(p))} от вас</button>${statusChip(p)}${p.event ? `<span>🗓 ${fmtWhen(p.event.starts_at)}</span>` : ""}</div>
      <div class="post-f"><button class="ab lk${p.liked ? " on" : ""}" data-like="${p.id}" aria-label="Нравится">${p.liked ? IC.heartOn : IC.heart}<b>${p.likes || ""}</b></button>
        <button class="ab" data-cmt="${p.id}" aria-label="Комментарии">${IC.cmt}<b>${p.comments || ""}</b></button>
        <button class="ab" data-share="${p.id}" aria-label="Поделиться">${IC.share}</button><span class="sp"></span>${join}
        <button class="ab sv${p.saved ? " on" : ""}" data-save="${p.id}" aria-label="Сохранить">${p.saved ? IC.saveOn : IC.save}</button></div>
    </article>`;
  }
  // обновление счетчиков без перерисовки (галерея и видео не сбрасываются)
  function patchCard(p) {
    qa(`.post[data-post="${p.id}"]`).forEach((el) => {
      const lk = el.querySelector("[data-like]"); if (lk) { lk.classList.toggle("on", p.liked); lk.innerHTML = (p.liked ? IC.heartOn : IC.heart) + `<b>${p.likes || ""}</b>`; }
      const cm = el.querySelector("[data-cmt]"); if (cm) cm.innerHTML = IC.cmt + `<b>${p.comments || ""}</b>`;
      const sv = el.querySelector("[data-save]"); if (sv) { sv.classList.toggle("on", p.saved); sv.innerHTML = p.saved ? IC.saveOn : IC.save; }
      const jn = el.querySelector("[data-join]"); if (jn && p.event) { jn.classList.toggle("joined", p.event.joined); jn.textContent = `${p.event.joined ? "✓ Иду" : "Иду"} · ${p.event.members}${p.event.capacity ? "/" + p.event.capacity : ""}`; }
    });
    const pb = document.querySelector("#pdBody > [data-cmt]");
    if (pb && openPostId === p.id) pb.textContent = "💬 " + (p.comments ? "Комментарии · " + p.comments : "Написать комментарий");
  }
  function refreshCardEverywhere(p) {
    qa(`.post[data-post="${p.id}"]`).forEach((el) => { el.outerHTML = card(p); });
    wireMedia(document);
    if (cur() === "sv-post" && openPostId === p.id) renderDetail(p);
  }

  /* ---------- ленивая загрузка фото и видео ---------- */
  // грузим только то, что близко к экрану: ~1 экран вперед. Сначала маленькое превью, потом полное фото
  function loadSlide(gs) {
    if (!gs || gs.dataset.ld) return; gs.dataset.ld = "1";
    const img = gs.querySelector("img[data-src]"), v = gs.querySelector("video[data-src]");
    if (img) {
      const full = img.dataset.src, th = img.dataset.thumb; img.crossOrigin = "anonymous";
      // если сервер не разрешил CORS — грузим обычным способом (без кэша в фоне)
      img.onerror = () => { if (img.crossOrigin) { img.onerror = null; img.removeAttribute("crossorigin"); img.classList.remove("lq"); img.src = full; } };
      if (th) { img.src = th; img.classList.add("lq"); const pre = new Image(); pre.crossOrigin = "anonymous"; pre.decoding = "async"; pre.onload = () => { img.src = full; img.classList.remove("lq"); }; pre.onerror = () => img.classList.remove("lq"); pre.src = full; }
      else img.src = full;
      img.removeAttribute("data-src");
    }
    if (v) { if (v.dataset.poster) v.poster = v.dataset.poster; else v.preload = "metadata"; v.src = v.dataset.src; v.removeAttribute("data-src"); }
  }
  function loadNear(track, i) { const ch = track.children; [i, i + 1].forEach((k) => ch[k] && loadSlide(ch[k])); }
  const lazyIOs = new Map();
  function lazyIO(root) {
    if (!("IntersectionObserver" in window)) return null;
    if (!lazyIOs.has(root)) lazyIOs.set(root, new IntersectionObserver((en, io) => en.forEach((x) => {
      if (!x.isIntersecting) return; io.unobserve(x.target);
      const tr = x.target.querySelector(".gal-track"); if (tr) loadNear(tr, 0); else loadSlide(x.target);
    }), { root, rootMargin: "900px 0px 900px 0px" }));
    return lazyIOs.get(root);
  }
  function lazyMedia(root) {
    qa(".gal:not([data-lz])", root).forEach((g) => {
      g.dataset.lz = "1"; const io = lazyIO(g.closest(".view") || null);
      if (io) io.observe(g); else loadNear(g.querySelector(".gal-track"), 0);
    });
  }

  /* ---------- видео: одно одновременно, пауза вне экрана ---------- */
  const vio = "IntersectionObserver" in window ? new IntersectionObserver((ents) => ents.forEach((en) => { if (!en.isIntersecting && !en.target.paused) en.target.pause(); }), { threshold: 0.25 }) : null;
  function wireMedia(root) {
    lazyMedia(root);
    qa(".gs.vid video:not([data-w])", root).forEach((v) => {
      v.dataset.w = "1"; if (vio) vio.observe(v);
      const box = v.closest(".gs");
      v.addEventListener("loadedmetadata", () => { const d = box.querySelector(".vdur"); if (d && d.classList.contains("hidden") && isFinite(v.duration)) { d.textContent = fmtDur(v.duration); d.classList.remove("hidden"); } });
      v.addEventListener("waiting", () => box.querySelector(".vload").classList.remove("hidden"));
      v.addEventListener("playing", () => { box.querySelector(".vload").classList.add("hidden"); box.classList.add("playing"); });
      v.addEventListener("pause", () => box.classList.remove("playing"));
      v.addEventListener("error", () => { box.classList.add("verr"); box.querySelector(".vplay").textContent = "⚠"; });
    });
  }
  document.addEventListener("play", (e) => { if (e.target.tagName !== "VIDEO") return; qa("video").forEach((v) => { if (v !== e.target && !v.paused && !v.closest(".onb")) v.pause(); }); }, true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) qa(".gs video").forEach((v) => v.pause()); });
  function playInline(box) {
    const v = box.querySelector("video"); loadSlide(box);
    if (box.classList.contains("verr")) return toast("Видео не воспроизводится на этом устройстве");
    v.controls = true; v.preload = "auto"; box.classList.add("started");
    v.play().catch(() => { v.muted = true; v.play().catch(() => toast("Не удалось запустить видео")); });
  }
  // счетчик галереи при свайпе
  document.addEventListener("scroll", (e) => {
    const t = e.target; if (!t.classList || !t.classList.contains("gal-track")) return;
    const i = Math.round(t.scrollLeft / t.clientWidth), g = t.parentElement, n = t.children.length;
    loadNear(t, i);
    const lab = g.querySelector(".gal-n"); if (lab) lab.textContent = `${i + 1}/${n}`;
    qa(".gal-dots i", g).forEach((d, k) => d.classList.toggle("on", k === i));
    qa("video", t).forEach((v, k) => { if (!v.paused && Math.abs(v.closest(".gs").offsetLeft - t.scrollLeft) > 10) v.pause(); });
  }, true);

  /* ---------- полноэкранный просмотр фото и видео ---------- */
  function openMediaViewer(items, start = 0) {
    qa(".gs video").forEach((v) => v.pause());
    const o = document.createElement("div"); o.className = "mv"; o.id = "mv";
    o.innerHTML = `<div class="mv-track">${items.map((m) => m.type === "video"
      ? `<div class="mv-s"><video src="${esc(m.url)}"${m.poster ? ` poster="${esc(m.poster)}"` : ""} controls playsinline preload="metadata"></video></div>`
      : `<div class="mv-s"><img src="${esc(m.url)}" alt="" decoding="async"></div>`).join("")}</div>
      <button class="mv-x" aria-label="Закрыть">✕</button>${items.length > 1 ? `<span class="mv-n">${start + 1}/${items.length}</span>` : ""}`;
    document.body.appendChild(o);
    const tr = o.querySelector(".mv-track");
    requestAnimationFrame(() => { tr.scrollLeft = start * tr.clientWidth; o.classList.add("on"); });
    tr.addEventListener("scroll", () => { const i = Math.round(tr.scrollLeft / tr.clientWidth); const n = o.querySelector(".mv-n"); if (n) n.textContent = `${i + 1}/${items.length}`; qa("video", tr).forEach((v, k) => { if (k !== i && !v.paused) v.pause(); }); });
    const close = () => { qa("video", o).forEach((v) => v.pause()); o.classList.remove("on"); setTimeout(() => o.remove(), 220); document.removeEventListener("keydown", esc2); };
    const esc2 = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", esc2);
    o.querySelector(".mv-x").onclick = close;
    o.addEventListener("click", (e) => { if (e.target.classList.contains("mv-s")) close(); });
    // свайп вниз закрывает
    let y0 = null; o.addEventListener("touchstart", (e) => { if (e.touches.length === 1) y0 = e.touches[0].clientY; }, { passive: true });
    o.addEventListener("touchmove", (e) => { if (y0 == null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) { tr.style.transform = `translateY(${dy}px)`; o.style.background = `rgba(0,0,0,${Math.max(0.3, 0.96 - dy / 400)})`; } }, { passive: true });
    o.addEventListener("touchend", (e) => { if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null; tr.style.transform = ""; o.style.background = ""; if (dy > 110) close(); });
    const v0 = qa("video", tr)[start]; if (v0) setTimeout(() => v0.play().catch(() => {}), 250);
  }
  function openViewer(src) { openMediaViewer([{ type: "image", url: src }], 0); }

  /* ---------- двойное нажатие на фото = лайк ---------- */
  let tapT = null, tapEl = null;
  function photoTap(box, p) {
    if (tapEl === box && tapT) {
      clearTimeout(tapT); tapT = null; tapEl = null;
      const g = box.closest(".gal"), hb = g.querySelector(".heart-burst"); hb.classList.remove("go"); void hb.offsetWidth; hb.classList.add("go");
      if (!p.liked) doLike(p.id); return;
    }
    tapEl = box; tapT = setTimeout(() => { tapT = null; tapEl = null; openMediaViewer(p.media.filter((m) => !shieldFor(m, p.user_id) || m.type === "video"), +box.dataset.i); }, 260);
  }

  /* ---------- меню публикации ⋯ ---------- */
  function postMenu(p) {
    const mine = user && user.id === p.user_id;
    const rows = [];
    if (mine) {
      rows.push(`<button class="opt-row" data-m="edit">✏️ Редактировать<span>›</span></button>`);
      rows.push(`<button class="opt-row" data-m="close">${p.status === "closed" ? "↩ Снова актуально" : "✅ Отметить неактуальным"}<span></span></button>`);
    }
    rows.push(`<button class="opt-row" data-m="link">🔗 Скопировать ссылку<span></span></button>`);
    rows.push(`<button class="opt-row" data-m="share">↗ Поделиться<span></span></button>`);
    if (!mine) {
      rows.push(`<button class="opt-row" data-m="hide">🙈 Скрыть из моей ленты<span></span></button>`);
      rows.push(`<button class="opt-row" data-m="report">⚑ Пожаловаться<span>›</span></button>`);
      rows.push(`<button class="opt-row" data-m="block" style="color:#ff8a95">🚫 Заблокировать ${esc(p.author.name)}<span></span></button>`);
    } else rows.push(`<button class="opt-row" data-m="del" style="color:#ff8a95">🗑 Удалить<span></span></button>`);
    openSheet("Публикация", rows.join(""));
    $("bsList").onclick = async (e) => {
      const b = e.target.closest("[data-m]"); if (!b) return; const m = b.dataset.m;
      if (m === "edit") { closeSheet(); openCreate({ edit: p }); }
      if (m === "close") { closeSheet(); toggleClosed(p); }
      if (m === "del") { closeSheet(); deletePostFlow(p); }
      if (m === "link") { closeSheet(); try { await navigator.clipboard.writeText(postLink(p)); toast("🔗 Ссылка скопирована"); } catch (er) { toast(postLink(p)); } }
      if (m === "share") { closeSheet(); sharePost(p); }
      if (m === "hide") { closeSheet(); hiddenPosts.add(p.id); saveHidden(); qa(`.post[data-post="${p.id}"]`).forEach((el) => { el.style.transition = "opacity .25s,transform .25s"; el.style.opacity = "0"; el.style.transform = "scale(.97)"; setTimeout(() => el.remove(), 260); }); toast("🙈 Скрыто. Вернуть можно в Настройках → Приватность"); }
      if (m === "report") reportSheet({ type: "post", id: p.id, user_id: p.user_id, label: "публикацию" });
      if (m === "block") blockUser(p.user_id, p.author.name, () => { if (cur() === "sv-post") back(); });
    };
  }
  async function toggleClosed(p) {
    try { const np = await api.updatePost(p.id, { status: p.status === "closed" ? "active" : "closed" }); cache.set(p.id, np); refreshCardEverywhere(np); feedDirty = true; wide = null; if (mapReady) loadMapPosts(true); toast(np.status === "closed" ? "✅ Отмечено как неактуальное" : "Публикация снова активна"); }
    catch (e) { toast(e.message); }
  }
  async function deletePostFlow(p) {
    if (!(await confirmSheet("Удалить публикацию?", "Публикация, фото и комментарии будут удалены без возможности восстановления.", "Удалить", true))) return;
    try { await api.deletePost(p.id); cache.delete(p.id); feedPosts = feedPosts.filter((x) => x.id !== p.id); wide = null; feedDirty = true; if (mapReady) loadMapPosts(true); qa(`.post[data-post="${p.id}"]`).forEach((el) => el.remove()); toast("🗑 Публикация удалена"); if (cur() === "sv-post") back(); }
    catch (e) { toast(e.message); }
  }

  /* ---------- комментарии в нижней панели ---------- */
  const CS = { postId: null, list: [], replyTo: null };
  function openComments(id) {
    const p = cache.get(id); if (!p) return;
    CS.postId = id; CS.replyTo = null; $("csReply").classList.add("hidden");
    $("csTitle").textContent = "Комментарии" + (p.comments ? " · " + p.comments : "");
    $("csList").innerHTML = '<div class="spin"></div>';
    $("csForm").classList.toggle("hidden", !user); $("csLogin").classList.toggle("hidden", !!user);
    if (user) $("csAva").innerHTML = ava(user);
    $("csBg").classList.add("on"); $("csheet").classList.add("on"); document.body.classList.add("cs-open");
    fitSheet();
    api.listComments(id).then((cm) => { if (CS.postId !== id) return; CS.list = cm; if (p.comments !== cm.length) { p.comments = cm.length; patchCard(p); } renderComments(); })
      .catch((e) => { $("csList").innerHTML = `<div class="empty"><b>Не удалось загрузить</b>${esc(e.message)}<br><button class="btn btn-main mt12" id="csRetry">Повторить</button></div>`; $("csRetry").onclick = () => openComments(id); });
  }
  function closeComments() { $("csBg").classList.remove("on"); $("csheet").classList.remove("on"); document.body.classList.remove("cs-open"); $("csIn").blur(); CS.postId = null; $("csheet").style.transform = ""; }
  function cmHtml(c, reply) {
    const own = user && user.id === c.user_id;
    const acts = c._state === "failed" ? `<button data-retry="${c.id}" class="red">⚠ Не отправлено · Повторить</button><button data-drop="${c.id}">Удалить</button>`
      : c._state === "sending" ? "" : `<button data-reply="${c.id}">Ответить</button>${own ? `<button data-delc="${c.id}">Удалить</button>` : `<button data-repc="${c.id}" data-uid="${c.user_id}">Пожаловаться</button>`}`;
    return `<div class="cm${reply ? " cm-r" : ""}${c._state ? " " + c._state : ""}" data-cid="${c.id}"><span class="who-link" data-user="${c.user_id}">${ava(c.author)}</span>
      <div class="cm-b"><div class="cm-h"><b class="who-link" data-user="${c.user_id}" translate="no">${esc(c.author.name)}${vBadge(c.author)}</b><span>${c._state === "sending" ? "отправка..." : timeAgo(c.created_at)}</span></div>
      <div class="cm-t" translate="no">${esc(c.text)}</div><div class="cm-a">${acts}</div></div></div>`;
  }
  function renderComments() {
    const p = cache.get(CS.postId); const top = CS.list.filter((c) => !c.parent_id || !CS.list.some((x) => x.id === c.parent_id));
    $("csTitle").textContent = "Комментарии" + (CS.list.length ? " · " + CS.list.length : "");
    $("csList").innerHTML = top.length ? top.map((c) => cmHtml(c) + CS.list.filter((r) => r.parent_id === c.id).map((r) => cmHtml(r, true)).join("")).join("")
      : `<div class="empty cs-empty"><b>Пока нет комментариев</b>${p && user && p.user_id === user.id ? "Здесь появятся ответы соседей" : "Напишите первым!"}</div>`;
  }
  async function sendComment(text, parentId, tmpId) {
    const p = cache.get(CS.postId); const id = CS.postId;
    let tmp = CS.list.find((c) => c.id === tmpId);
    if (!tmp) { tmp = { id: "tmp-" + Date.now(), text, parent_id: parentId, user_id: user.id, author: user, created_at: new Date().toISOString(), _state: "sending" }; CS.list.push(tmp); }
    else tmp._state = "sending";
    renderComments(); const el = $("csList").querySelector(`[data-cid="${tmp.id}"]`); if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    try {
      const real = await api.addComment(id, text, parentId);
      if (CS.postId !== id) return;
      Object.assign(tmp, real || {}, { _state: null }); if (real && real.id) tmp.id = real.id;
      if (p) { p.comments = CS.list.filter((c) => !c._state).length; patchCard(p); }
      renderComments(); Sound.play("send"); Obs.track("comment_created"); usefulAction("comment");
    } catch (e) { if (gateError(e)) { CS.list = CS.list.filter((x) => x !== tmp); renderComments(); return; } tmp._state = "failed"; tmp._err = e.message; renderComments(); toast(e.message); }
  }
  function fitSheet() {
    const vv = window.visualViewport, sh = $("csheet"); if (!sh) return;
    if (!vv) return;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    sh.style.bottom = kb + "px"; sh.style.maxHeight = Math.round(vv.height * (kb > 0 ? 0.92 : 0.82)) + "px";
  }
  if (window.visualViewport) { visualViewport.addEventListener("resize", () => { if (CS.postId) fitSheet(); }); visualViewport.addEventListener("scroll", () => { if (CS.postId) fitSheet(); }); }
  $("csBg").onclick = closeComments; $("csX").onclick = closeComments;
  $("csLogin").onclick = () => { closeComments(); requireAuth("Войдите, чтобы комментировать", { t: "comments", a: CS.postId }); };
  $("csReplyX").onclick = () => { CS.replyTo = null; $("csReply").classList.add("hidden"); };
  $("csForm").onsubmit = (e) => {
    e.preventDefault(); const v = $("csIn").value.trim(); if (!v || !CS.postId) return;
    if (N.hasBad(v)) toast("🤬 Грубые слова будут скрыты звездочками");
    $("csIn").value = ""; const par = CS.replyTo; CS.replyTo = null; $("csReply").classList.add("hidden");
    sendComment(v, par, null);
  };
  $("csList").onclick = async (e) => {
    let b;
    if ((b = e.target.closest("[data-reply]"))) {
      if (!requireAuth("Войдите, чтобы отвечать")) return;
      const c = CS.list.find((x) => x.id === b.dataset.reply); CS.replyTo = c.parent_id || c.id;
      $("csReply").querySelector("span").innerHTML = `Ответ для <b>${esc(c.author.name)}</b>`; $("csReply").classList.remove("hidden"); $("csIn").focus(); return;
    }
    if ((b = e.target.closest("[data-retry]"))) { const c = CS.list.find((x) => x.id === b.dataset.retry); if (c) sendComment(c.text, c.parent_id, c.id); return; }
    if ((b = e.target.closest("[data-drop]"))) { CS.list = CS.list.filter((x) => x.id !== b.dataset.drop); renderComments(); return; }
    if ((b = e.target.closest("[data-delc]"))) {
      if (!(await confirmSheet("Удалить комментарий?", "Ответы на него тоже удалятся.", "Удалить", true))) return;
      try { await api.deleteComment(b.dataset.delc); CS.list = CS.list.filter((x) => x.id !== b.dataset.delc && x.parent_id !== b.dataset.delc); const p = cache.get(CS.postId); if (p) { p.comments = CS.list.length; patchCard(p); } renderComments(); toast("Комментарий удален"); }
      catch (er) { toast(er.message); } return;
    }
    if ((b = e.target.closest("[data-repc]"))) return reportSheet({ type: "comment", id: b.dataset.repc, user_id: b.dataset.uid, label: "комментарий" });
    if ((b = e.target.closest("[data-user]"))) { closeComments(); openUser(b.dataset.user); }
  };
  // свайп вниз по заголовку закрывает панель
  (() => { let y0 = null; const h = $("csHead"), sh = $("csheet");
    h.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    h.addEventListener("touchmove", (e) => { if (y0 == null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) sh.style.transform = `translateY(${dy}px)`; }, { passive: true });
    h.addEventListener("touchend", (e) => { if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null; sh.style.transform = ""; if (dy > 90) closeComments(); });
  })();
  /* ---------- лента порциями + кэш + обновление ---------- */
  const PAGE = 12;
  const F = { ids: new Set(), next: null, done: false, loading: false, seq: 0, newest: null };
  // SEC-06: кэш ленты привязан к аккаунту (или гостю) и версии; при выходе и смене аккаунта стирается
  const feedKey = () => `near_feed_v12_${user ? user.id.slice(0, 12) : "guest"}_${R}_${feedCat}_${FS.sort}_${FS.period || "all"}_${FS.friends ? 1 : 0}_${pos.lat.toFixed(2)}_${pos.lng.toFixed(2)}`;
  let feedCachedAt = 0;
  function saveFeedCache() {
    if (api.mode === "local") return; // в демо фото хранятся внутри данных — кэш не нужен
    try { localStorage.setItem(feedKey(), JSON.stringify({ t: Date.now(), posts: feedPosts.slice(0, PAGE) })); } catch (e) {}
  }
  function readFeedCache() {
    try {
      const c = JSON.parse(localStorage.getItem(feedKey()) || "null");
      if (!c || Date.now() - c.t > 48 * 3600e3) return null;
      feedCachedAt = c.t; const nowS = new Date().toISOString();
      // устаревшие SOS и просроченные происшествия из кэша не показываем
      return c.posts.filter((p) => !p.expires_at || p.expires_at > nowS);
    } catch (e) { return null; }
  }
  const newestOf = (list) => list.reduce((m, p) => (!m || p.created_at > m.ts || (p.created_at === m.ts && p.id > m.id) ? { ts: p.created_at, id: p.id } : m), null);
  function addPosts(list, where) {
    const fresh = list.filter((p) => p && !F.ids.has(p.id)); // без дублей: по уникальному id
    fresh.forEach((p) => F.ids.add(p.id)); remember(fresh);
    if (where === "top") feedPosts = fresh.concat(feedPosts); else feedPosts = feedPosts.concat(fresh);
    if (feedPosts.length) { const n = newestOf(feedPosts); if (!F.newest || n.ts > F.newest.ts || (n.ts === F.newest.ts && n.id > F.newest.id)) F.newest = n; }
    return fresh;
  }
  // UX-02: сортировка ("Новое" по умолчанию — прозрачно), период и "только друзья"; сохраняются для каждого аккаунта
  const FS = { sort: "new", period: null, friends: false };
  const feedArgs = () => ({ lat: pos.lat, lng: pos.lng, radius: R, category: catFilter(feedCat), sort: FS.sort, period: FS.period, friends: FS.friends && !!user });
  function loadFeedPrefs() {
    const f = prefs.feed || {};
    FS.sort = ["new", "near", "top"].includes(f.sort) ? f.sort : "new"; FS.period = ["today", "week"].includes(f.period) ? f.period : null; FS.friends = !!f.friends;
    if ([500, 1000, 3000, 5000, 10000].includes(f.r)) setRadius(f.r);
    if (f.cat && CHIPS.some(([k]) => k === f.cat)) { feedCat = f.cat; $("cats").innerHTML = chipsHtml(feedCat); }
    renderSortBar();
  }
  function saveFeedPrefs() { prefs.feed = { sort: FS.sort, period: FS.period, friends: FS.friends, r: R, cat: feedCat }; savePrefs(); }
  function renderSortBar() {
    const n = (FS.period ? 1 : 0) + (FS.friends ? 1 : 0);
    $("sortBar").innerHTML = `<div class="sort-seg" role="tablist">${[["new", "Новое"], ["near", "Рядом"], ["top", "Для вас"]].map(([k, t]) => `<button role="tab" aria-selected="${FS.sort === k}" data-sort="${k}" class="${FS.sort === k ? "on" : ""}">${t}</button>`).join("")}</div>
      <button class="flt-btn${n ? " on" : ""}" id="fltBtn" aria-label="Фильтры">⚙ Фильтры${n ? ` · ${n}` : ""}</button>`;
  }
  $("sortBar").onclick = (e) => {
    const b = e.target.closest("[data-sort]");
    if (b) { if (FS.sort === b.dataset.sort) return; FS.sort = b.dataset.sort; renderSortBar(); saveFeedPrefs(); Obs.track("filter_changed", { sort: FS.sort }); loadFeed(); return; }
    if (e.target.closest("#fltBtn")) filterSheet();
  };
  function filterSheet() {
    const per = [[null, "Все время"], ["today", "Сегодня"], ["week", "Неделя"]];
    openSheet("Фильтры", `<div class="lbl">Период</div><div class="rad-ch wide" id="fPer">${per.map(([k, t]) => `<button data-per="${k || ""}" class="${FS.period === k ? "on" : ""}">${t}</button>`).join("")}</div>
      <div class="lbl mt12">Кто публикует</div><div class="rad-ch wide" id="fWho"><button data-who="0" class="${FS.friends ? "" : "on"}">Все</button><button data-who="1" class="${FS.friends ? "on" : ""}">Только друзья</button></div>
      ${user ? "" : '<div class="s-note">"Только друзья" работает после входа.</div>'}
      <div class="sheet-btns mt12"><button class="btn btn-ghost" id="fReset">Сбросить</button><button class="btn btn-main" id="fApply">Применить</button></div>`);
    let per0 = FS.period, who = FS.friends;
    qa("#fPer [data-per]").forEach((b) => (b.onclick = () => { per0 = b.dataset.per || null; qa("#fPer button").forEach((x) => x.classList.toggle("on", x === b)); }));
    qa("#fWho [data-who]").forEach((b) => (b.onclick = () => { who = b.dataset.who === "1"; qa("#fWho button").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("fReset").onclick = () => { closeSheet(); FS.period = null; FS.friends = false; renderSortBar(); saveFeedPrefs(); loadFeed(); };
    $("fApply").onclick = () => {
      closeSheet(); if (who && !user) { requireAuth("Войдите, чтобы видеть публикации друзей"); return; }
      FS.period = per0; FS.friends = who; renderSortBar(); saveFeedPrefs(); Obs.track("filter_changed", { period: FS.period || "all", filter: who ? "friends" : "all" }); loadFeed();
    };
  }
  // метка "обновлено N мин назад" для ленты из кэша
  function staleNote(on) {
    let el = $("feedStale");
    if (!on) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement("div"); el.id = "feedStale"; el.className = "feed-stale"; el.setAttribute("role", "status"); $("posts").before(el); }
    el.textContent = "Сохраненная лента · обновлено " + (feedCachedAt ? timeAgo(new Date(feedCachedAt).toISOString()) : "ранее");
  }
  async function loadFeed() {
    feedDirty = false;
    if (!api) return;
    // устаревший запрос (сменили радиус, сортировку, место) отменяется
    if (F.ctrl) try { F.ctrl.abort(); } catch (e) {}
    F.ctrl = "AbortController" in window ? new AbortController() : null;
    const seq = ++F.seq, t0 = performance.now(), prev = feedPosts.slice();
    F.loading = true;
    const cached = readFeedCache();
    // показанная лента не стирается до ответа сервера: при ошибке сети она остается на экране
    if (cached && cached.length) { F.ids = new Set(); feedPosts = []; F.newest = null; addPosts(cached); renderFeed(true); staleNote(true); }
    else if (!prev.length) $("posts").innerHTML = '<div class="post sk"></div><div class="post sk"></div>';
    else $("posts").classList.add("reloading");
    try {
      const r = await api.feedPage({ ...feedArgs(), limit: PAGE, signal: F.ctrl && F.ctrl.signal });
      if (seq !== F.seq) return;
      const shown = feedPosts.slice();
      F.ids = new Set(); feedPosts = []; F.newest = null; addPosts(r.posts); F.next = r.next; F.done = r.done;
      renderFeed(); saveFeedCache(); staleNote(false);
      invalidateGone(shown, r.posts);
      Obs.track("feed_loaded", { ms: Math.round(performance.now() - t0), count: r.posts.length, radius: R, sort: FS.sort });
    } catch (e) {
      if (seq !== F.seq || e.name === "AbortError" || /abort/i.test(e.message)) return;
      if (!feedPosts.length) { $("posts").innerHTML = `<div class="empty"><b>Не удалось загрузить ленту</b>${esc(e.message)}<br><button class="btn btn-main mt12" id="retryFeed">Повторить</button></div>`; $("retryFeed").onclick = loadFeed; }
      else { toast("Нет связи. Показываем последнюю загруженную ленту"); staleNote(true); }
    } finally { if (seq === F.seq) { F.loading = false; $("posts").classList.remove("reloading"); feedTail(); } }
    updateChanges();
  }
  // CACHE-01: публикация была в сохраненной ленте, но сервер ее больше не отдает (скрыта, удалена, истекла) —
  // убираем из памяти и ее фото из кэша телефона. Уже скачанные кем-то копии удалить невозможно.
  function invalidateGone(shown, fresh) {
    if (FS.sort !== "new" || !shown.length || !fresh.length) return;
    const ids = new Set(fresh.map((p) => p.id)), oldest = fresh[fresh.length - 1].created_at;
    const gone = shown.filter((p) => !ids.has(p.id) && p.created_at >= oldest);
    if (!gone.length) return;
    gone.forEach((p) => cache.delete(p.id));
    Cache.purge(gone.flatMap((p) => (p.media || []).flatMap((m) => [m.url, m.thumb, m.poster])).filter(Boolean));
  }
  async function loadMore() {
    if (F.loading || F.done || !feedPosts.length) return;
    const seq = F.seq; F.loading = true; feedTail();
    try {
      const r = await api.feedPage({ ...feedArgs(), limit: PAGE, before: F.next });
      if (seq !== F.seq) return;
      F.next = r.next; F.done = r.done;
      const fresh = addPosts(r.posts).filter((p) => !hiddenPosts.has(p.id));
      if (fresh.length) { $("posts").insertAdjacentHTML("beforeend", fresh.map(card).join("")); wireMedia($("posts")); }
    } catch (e) { toast("Не удалось загрузить еще: " + e.message); F.err = true; }
    finally { if (seq === F.seq) { F.loading = false; feedTail(); } }
  }
  // новые публикации с момента последнего просмотра
  async function refreshNew(silent) {
    // "Рядом" и "Для вас" пересчитываются целиком; "Новое" — догружаются новые сверху
    if (!feedPosts.length || !F.newest || FS.sort !== "new") { await loadFeed(); return 0; }
    const seq = F.seq;
    try {
      const r = await api.feedPage({ ...feedArgs(), after: F.newest });
      if (seq !== F.seq) return 0;
      const fresh = addPosts(r.posts, "top").filter((p) => !hiddenPosts.has(p.id));
      fresh.sort((a, b) => (b.created_at === a.created_at ? (b.id > a.id ? 1 : -1) : b.created_at.localeCompare(a.created_at)));
      if (fresh.length) {
        feedPosts.sort((a, b) => b.created_at.localeCompare(a.created_at));
        const empty = $("posts").querySelector(".empty"); if (empty) empty.remove();
        $("posts").insertAdjacentHTML("afterbegin", fresh.map(card).join("")); wireMedia($("posts")); saveFeedCache();
      }
      if (!silent) toast(fresh.length ? `🆕 ${fresh.length} ${plural(fresh.length, "новая публикация", "новые публикации", "новых публикаций")}` : "Новых публикаций нет");
      updateChanges(); $("refreshBtn").style.background = "";
      return fresh.length;
    } catch (e) { if (!silent) toast("Не удалось обновить: " + e.message); return 0; }
  }
  function feedTail() {
    let t = $("feedTail");
    if (!t) { t = document.createElement("div"); t.id = "feedTail"; t.className = "feed-tail"; $("posts").after(t); }
    if (!feedPosts.length) { t.innerHTML = ""; return; }
    t.innerHTML = F.loading ? '<div class="spin"></div>' : F.done ? `<span>Это все публикации в радиусе ${fmtDist(R)}</span>` : F.err ? '<button class="more" id="tailRetry">Повторить</button>' : "";
    if ($("tailRetry")) $("tailRetry").onclick = () => { F.err = false; loadMore(); };
  }
  // подгрузка следующей порции, когда до конца ленты остается ~1,5 экрана
  const tailIO = "IntersectionObserver" in window ? new IntersectionObserver((en) => { if (en.some((x) => x.isIntersecting) && !F.err) loadMore(); }, { root: $("v-feed"), rootMargin: "0px 0px 1200px 0px" }) : null;
  function renderFeed(fromCache) {
    const vis = feedPosts.filter((p) => !hiddenPosts.has(p.id));
    if (!vis.length) {
      $("posts").innerHTML = F.loading ? '<div class="post sk"></div><div class="post sk"></div>' : `<div class="empty"><b>Здесь пока тихо</b>В радиусе ${fmtDist(R)} нет публикаций${feedCat !== "all" ? " в этой категории" : ""}.<br>Увеличьте радиус или опубликуйте первым!<br><button class="btn btn-main mt12" data-create="talk">+ Опубликовать</button></div>`;
      feedTail(); return;
    }
    $("posts").innerHTML = vis.map(card).join("");
    wireMedia($("posts")); feedTail();
    if (tailIO) { tailIO.disconnect(); tailIO.observe($("feedTail")); }
  }
  async function updateChanges() {
    try {
      const by = await api.recentStats(feedArgs());
      const parts = Object.entries(by).filter(([k]) => CATS[k]);
      $("changesText").textContent = parts.length ? parts.map(([k, v]) => `${CATS[k].e} ${I18N.t(CATS[k].n).toLowerCase()}: ${v}`).join(" · ") : "За последний час новых публикаций нет";
    } catch (e) { $("changesText").textContent = "—"; }
  }
  $("refreshBtn").onclick = () => refreshNew();

  /* ---------- обновление свайпом вниз ---------- */
  (() => {
    const v = $("v-feed"), ind = document.createElement("div"); ind.className = "ptr"; ind.innerHTML = '<i class="ptr-ic">↓</i>'; v.parentElement.insertBefore(ind, v);
    let y0 = null, pull = 0, busyP = false;
    const set = (h, anim) => { ind.style.top = v.offsetTop + "px"; v.style.transition = anim ? "transform .25s" : "none"; ind.style.transition = v.style.transition; v.style.transform = h ? `translateY(${h}px)` : ""; ind.style.opacity = Math.min(1, h / 60); ind.querySelector(".ptr-ic").style.transform = `rotate(${h > 70 ? 180 : 0}deg)`; };
    v.addEventListener("touchstart", (e) => { if (busyP || v.scrollTop > 0 || e.touches.length > 1) { y0 = null; return; } y0 = e.touches[0].clientY; pull = 0; }, { passive: true });
    v.addEventListener("touchmove", (e) => {
      if (y0 == null) return; const dy = e.touches[0].clientY - y0;
      if (dy <= 0 || v.scrollTop > 0) { if (pull) set(0); y0 = dy < 0 ? null : y0; pull = 0; return; }
      if (e.cancelable) e.preventDefault();
      pull = Math.min(120, dy * 0.5); set(pull);
    }, { passive: false });
    v.addEventListener("touchend", async () => {
      if (y0 == null) return; y0 = null;
      if (pull > 70) {
        busyP = true; set(56, true); ind.classList.add("spin-on"); if (navigator.vibrate) navigator.vibrate(10);
        await refreshNew(); ind.classList.remove("spin-on"); set(0, true); busyP = false;
      } else set(0, true);
      pull = 0;
    });
  })();

  /* post actions (shared) */
  async function doLike(id) {
    if (!requireAuth("Войдите, чтобы ставить лайки", { t: "like", a: id })) return;
    const p = cache.get(id); if (!p) return;
    p.liked = !p.liked; p.likes += p.liked ? 1 : -1; patchCard(p);
    if (p.liked) qa(`.post[data-post="${id}"] [data-like]`).forEach((b) => { b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); });
    try { const r = await api.toggleLike(id); p.liked = r.liked; p.likes = r.likes; patchCard(p); }
    catch (e) { p.liked = !p.liked; p.likes += p.liked ? 1 : -1; patchCard(p); toast("Не удалось: " + e.message); }
  }
  async function doSave(id) {
    if (!requireAuth("Войдите, чтобы сохранять публикации", { t: "save", a: id })) return;
    const p = cache.get(id); if (!p) return;
    p.saved = !p.saved; patchCard(p);
    try { p.saved = await api.toggleSave(id); patchCard(p); toast(p.saved ? "🔖 Сохранено в профиль" : "Убрано из сохраненного"); if (cur() === "v-prof" && profTab === "saved") loadProfList(); }
    catch (e) { p.saved = !p.saved; patchCard(p); toast("Не удалось: " + e.message); }
  }
  async function doJoin(id) {
    if (!requireAuth("Войдите, чтобы участвовать", { t: "join", a: id })) return;
    const p = cache.get(id); if (!p || !p.event) return;
    try { const r = await api.toggleJoin(id); p.event.joined = r.joined; p.event.members = r.members; patchCard(p); if (cur() === "sv-events") renderEvents(); toast(r.joined ? "🎉 Вы участвуете! Напомним в календаре" : "Участие отменено"); if (r.joined) usefulAction("join"); }
    catch (e) { toast(e.message); }
  }
  function showOnMap(id) { const p = cache.get(id); if (!p) return; pendingFocus = p; hist = []; go("v-map", false); if (mapReady) focusPost(p); }
  function postClick(e) {
    const t = e.target, art = t.closest(".post[data-post]"), p = art && cache.get(art.dataset.post);
    let b;
    if ((b = t.closest("[data-user]"))) return openUser(b.dataset.user);
    if ((b = t.closest("[data-like]"))) return doLike(b.dataset.like);
    if ((b = t.closest("[data-save]"))) return doSave(b.dataset.save);
    if ((b = t.closest("[data-join]"))) return doJoin(b.dataset.join);
    if ((b = t.closest("[data-onmap]"))) return showOnMap(b.dataset.onmap);
    if ((b = t.closest("[data-cmt]"))) return openComments(b.dataset.cmt);
    if ((b = t.closest("[data-share]"))) { const q = cache.get(b.dataset.share); return q && sharePost(q); }
    if ((b = t.closest("[data-pmenu]"))) { const q = cache.get(b.dataset.pmenu); return q && postMenu(q); }
    if ((b = t.closest("[data-moretext]"))) { b.previousElementSibling.classList.remove("clamp"); b.remove(); return; }
    if ((b = t.closest("[data-reveal]"))) { if (t.closest(".shield button")) { b.classList.remove("blur-wrap"); b.removeAttribute("data-reveal"); b.setAttribute("data-img", ""); b.querySelector(".shield").remove(); } return; }
    if ((b = t.closest(".vfs"))) { const box = b.closest(".gs"); return p && openMediaViewer(p.media, +box.dataset.i); }
    if ((b = t.closest(".gs.vid"))) { if (!b.classList.contains("started")) playInline(b); return; }
    if ((b = t.closest("[data-img]"))) return p && photoTap(b, p);
    if (t.closest(".post-near, .post-f, .gal")) return;
    if (art) return openPost(art.dataset.post);
  }
  $("posts").onclick = postClick;

/* ===== 40-post.js ===== */
  /* =====================================================
     POST DETAIL
     ===================================================== */
  let openPostId = null;
  async function openPost(id, focusComment) {
    openPostId = id; go("sv-post");
    const p0 = cache.get(id);
    if (p0) renderDetail(p0); else $("pdBody").innerHTML = '<div class="spin"></div>';
    try {
      const p = await api.getPost(id);
      if (openPostId !== id) return;
      cache.set(id, p); renderDetail(p);
      if (focusComment) openComments(id);
    } catch (e) { $("pdBody").innerHTML = `<div class="empty"><b>Не открылось</b>${esc(e.message)}</div>`; }
  }
  function renderDetail(p) {
    const c = CATS[p.category] || CATS.talk, mine = user && user.id === p.user_id, closed = p.status === "closed";
    $("pdSub").textContent = c.e + " " + c.n + " · " + fmtDist(D(p)) + " от вас";
    const ev = p.event ? `<div class="ev-box"><b>🗓 ${fmtWhen(p.event.starts_at)}</b><div class="muted" style="font-size:12px;margin-top:3px">Участников: ${p.event.members}${p.event.capacity ? " из " + p.event.capacity : ""}</div>
      <div class="row">${closed ? "" : `<button class="btn ${p.event.joined ? "btn-ghost" : "btn-main"}" data-join="${p.id}">${p.event.joined ? "✓ Я иду · отменить" : "Иду"}</button>`}<button class="btn btn-ghost" id="pdCal">📅 В календарь</button></div></div>` : "";
    const closeLabel = closed ? "↩ Вернуть" : (p.category === "lost" || p.category === "found") ? "✅ Вернули хозяину" : "✅ Неактуально";
    const own = mine ? `<div class="own"><button id="pdEdit">✏️ Изменить</button><button id="pdClose">${closeLabel}</button><button class="del" id="pdDel">🗑 Удалить</button></div>` : "";
    const hiddenNote = p.status === "hidden" ? `<div class="warn-banner red" style="margin:0 0 10px">🛡 Публикация скрыта и ждет проверки модератора. Ее видите только вы${user && user.is_mod ? " и модераторы" : ""}.${mine ? '<div class="wb-acts"><button id="pdAppeal">Обжаловать</button></div>' : ""}</div>` : "";
    $("pdBody").innerHTML = `${hiddenNote}<div class="pd-card">${card(p)}</div>${ev}${own}<button class="btn btn-ghost full mt12" data-cmt="${p.id}">💬 ${p.comments ? "Комментарии · " + p.comments : "Написать комментарий"}</button>`;
    wireMedia($("pdBody")); bindDetail(p); return;
  }
  function bindDetail(p) {
    const body = $("pdBody");
    body.onclick = (e) => {
      let b;
      if ((b = e.target.closest("#pdCal, #pdEdit, #pdClose, #pdDel"))) return;
      if (e.target.closest(".post")) { if (e.target.closest("[data-like],[data-save],[data-join],[data-onmap],[data-cmt],[data-share],[data-pmenu],[data-moretext],[data-reveal],.gs,[data-user]")) return postClick(e); return; }
      if ((b = e.target.closest("[data-cmt]"))) return openComments(p.id);
      if ((b = e.target.closest("[data-like]"))) return doLike(p.id);
      if ((b = e.target.closest("[data-save]"))) return doSave(p.id);
      if ((b = e.target.closest("[data-join]"))) return doJoin(p.id);
      if ((b = e.target.closest("[data-onmap]"))) return showOnMap(p.id);
      if ((b = e.target.closest("[data-reveal]"))) { b.classList.remove("blur-wrap"); b.querySelector(".shield").remove(); return; }
      if ((b = e.target.closest("[data-zoom]"))) return openViewer(b.src);
      if ((b = e.target.closest("[data-user]"))) return openUser(b.dataset.user);
    };
    if ($("pdCal")) $("pdCal").onclick = () => addToCalendar(p);
    if ($("pdEdit")) $("pdEdit").onclick = () => openCreate({ edit: p });
    if ($("pdClose")) $("pdClose").onclick = () => toggleClosed(p);
    if ($("pdDel")) $("pdDel").onclick = () => deletePostFlow(p);
    if ($("pdAppeal")) $("pdAppeal").onclick = () => appealSheet("post", p.id);
  }
  // SEC-08: апелляция автора на решение модератора
  function appealSheet(type, id) {
    openSheet("Обжаловать решение", `<p class="muted" style="font-size:13px;margin-bottom:10px">Объясните, почему решение стоит пересмотреть. Модератор ответит уведомлением.</p>
      <div class="fld"><textarea id="apTx" maxlength="1000" placeholder="Например: это не реклама, а объявление соседям" style="min-height:90px"></textarea></div>
      <div class="err" id="apErr"></div><div class="sheet-btns"><button class="btn btn-ghost" id="apNo">Отмена</button><button class="btn btn-main" id="apYes">Отправить</button></div>`);
    $("apNo").onclick = closeSheet;
    $("apYes").onclick = async () => {
      const t = $("apTx").value.trim(); if (t.length < 5) { $("apErr").textContent = "Напишите хотя бы пару слов"; $("apErr").classList.add("on"); return; }
      try { await busy($("apYes"), () => api.appeal(type, id, t)); closeSheet(); toast("Апелляция отправлена модератору"); } catch (e) { $("apErr").textContent = e.message; $("apErr").classList.add("on"); }
    };
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
  // v14 / 03: семь типов создания — шесть плиток и отдельно SOS. Цвета — как метки на карте (раздел 27)
  const GROUPS = {
    post: { t: "Публикация", s: "Новость, вопрос, объявление", e: "📝", c: "#ec398e", types: ["talk", "ad"], title: "Новая публикация" },
    incident: { t: "Происшествие", s: "ДТП, отключения, перекрытия", e: "🚨", c: "#ff873b", types: ["incident"], title: "Происшествие" },
    meetup: { t: "Встреча", s: "Группа по интересам", e: "🤝", c: "#9855e9", types: ["meetup"], title: "Новая встреча" },
    event: { t: "Событие", s: "Открытое мероприятие", e: "🎉", c: "#3da5ff", types: ["event"], title: "Новое событие" },
    deal: { t: "Акция", s: "Предложение бизнеса", e: "🏷️", c: "#f5b400", types: ["deal"], title: "Новая акция" },
    help: { t: "Помощь", s: "Потеря, находка, помощь соседям", e: "🔑", c: "#2bd47d", types: ["lost", "found"], title: "Помощь рядом" }
  };
  const groupOf = (t) => Object.keys(GROUPS).find((g) => GROUPS[g].types.includes(t)) || "post";
  // "+" → "Что создать?". Гость сначала входит, затем меню открывается снова
  function openCreateMenu() {
    if (!requireAuth("Войдите, чтобы публиковать", { t: "create" })) return;
    const pb = $("plusBtn");
    if ($("bsheet").classList.contains("on") && $("bsheet").classList.contains("cr-sheet")) { closeSheet(); return; }
    openSheet("Что создать?", `<div class="cr-grid">${Object.entries(GROUPS).map(([k, g]) => `<button type="button" class="cr-tile" data-group="${k}" style="--c:${g.c}"><span class="ci">${g.e}</span><b>${g.t}</b><small>${g.s}</small></button>`).join("")}</div>
      <button type="button" class="cr-sos" id="crSos"><span class="sb">SOS</span><span><b>SOS — срочная помощь</b><small>сообщить людям рядом · не заменяет 112</small></span></button>
      <div class="cr-note">Черновик сохраняется на телефоне до публикации</div>`, "cr-sheet");
    if (pb) { pb.classList.add("open"); pb.setAttribute("aria-expanded", "true"); }
    qa("[data-group]", $("bsList")).forEach((b) => (b.onclick = () => { closeSheet(); openCreate({ group: b.dataset.group }); }));
    $("crSos").onclick = () => { closeSheet(); go("sv-sos"); };
  }
  const cr = { type: null, group: null, files: [], loc: null, edit: null, key: null, started: false };
  // POST-01: черновик текста хранится на телефоне до публикации
  const draftKey = () => "near_draft_" + (user ? user.id.slice(0, 12) : "guest");
  function saveDraft() { try { if (cr.edit) return; const t = $("crText").value; if (t.trim()) localStorage.setItem(draftKey(), JSON.stringify({ type: cr.type, text: t, t: Date.now() })); else localStorage.removeItem(draftKey()); } catch (e) {} }
  function renderTypes(types) {
    $("typeGrid").innerHTML = types.map((k) => `<button type="button" data-type="${k}"><span>${CATS[k].e}</span>${CATS[k].n}</button>`).join("");
    // один тип — выбирать нечего: плитки скрыты
    $("typeGrid").classList.toggle("hidden", types.length < 2);
  }
  renderTypes(ORDER);
  $("typeGrid").onclick = (e) => { const b = e.target.closest("[data-type]"); if (b) setType(b.dataset.type); };
  function setType(t) {
    cr.type = t; qa("#typeGrid [data-type]").forEach((x) => x.classList.toggle("on", x.dataset.type === t));
    $("crEvent").classList.toggle("hidden", !(t === "event" || t === "meetup"));
    const ph = { incident: "Что случилось? Например: ДТП, перекрыта дорога, отключили воду", event: "Что за событие, где и для кого?", deal: "Какая акция, где и до какого времени?", meetup: "Кого ищете и чем займетесь?", lost: "Что потеряли, где и когда? Особые приметы", found: "Что нашли и где? Как с вами связаться", ad: "Продам, отдам, ищу мастера...", talk: "О чем хотите спросить соседей?" };
    $("crText").placeholder = ph[t] || "Опишите, что происходит";
  }
  function openCreate({ type, edit, group } = {}) {
    // без типа и группы (например, после входа) — сначала меню "Что создать?"
    if (!edit && !type && !group) { let dr = null; try { dr = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch (e) {} if (dr && dr.type) type = dr.type; else { openCreateMenu(); return; } }
    cr.group = edit ? groupOf(edit.category) : group || groupOf(type);
    renderTypes(edit ? ORDER : GROUPS[cr.group].types);
    cr.files.forEach((f) => f._url && URL.revokeObjectURL(f._url));
    cr.files = []; cr.edit = edit || null; $("crErr").classList.remove("on"); $("crProg").textContent = "";
    $("crFuzzy").classList.toggle("on", prefs.fuzz_default ?? true);
    // незавершенная загрузка прошлой публикации отменяется: файлы и строка удаляются
    if (cr.key && cr.started && !edit) api.abandonDraft && api.abandonDraft(cr.key).catch(() => {});
    cr.key = edit ? null : N.rid() + N.rid(); cr.started = false;
    $("crTitle").textContent = edit ? "Редактирование" : GROUPS[cr.group].title;
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
    let dr = null; if (!edit) { try { dr = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch (e) {} }
    if (dr && dr.text && Date.now() - dr.t < 7 * 86400e3) { $("crText").value = dr.text; $("crCount").textContent = dr.text.length; toast("Восстановлен черновик"); }
    const gt = GROUPS[cr.group].types;
    setType(edit ? edit.category : type || (dr && gt.includes(dr.type) ? dr.type : null) || (gt.length === 1 ? gt[0] : null));
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
      try {
        const kind = N.validateFile(f); f._url = URL.createObjectURL(f); cr.files.push(f);
        if (kind === "video") {
          // проверяем видео сразу, до публикации: формат, длительность, обложка
          f._state = "check";
          N.probeVideo(f).then((m) => { f._meta = m; f._state = "ok"; renderMedia(); })
            .catch((er) => { cr.files = cr.files.filter((x) => x !== f); URL.revokeObjectURL(f._url); renderMedia(); crError(er.message); });
        }
      } catch (e) { toast(e.message); }
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
      if (/^video\//.test(f.type) || /\.(mov|mp4|m4v|webm)$/i.test(f.name)) d.innerHTML = `<video src="${f._url}#t=0.3" muted playsinline preload="metadata"></video><i>${f._state === "check" ? '<span class="mini-spin"></span>' : f._meta ? "▶ " + fmtDur(f._meta.duration) : "🎬"}</i>`;
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
    if (cr.files.some((f) => f._state === "check")) return crError("Подождите, проверяем видео...");
    if (N.isThreat(text)) return crError("Угрозы запрещены правилами NEAR. Измените текст");
    if (N.hasBad(text)) toast("Грубые слова будут скрыты: " + N.mask(text).slice(0, 60));
    const btn = $("pubBtn"); btn.disabled = true;
    try {
      if (cr.edit) {
        const np = await api.updatePost(cr.edit.id, { text, category: cr.type, event });
        cache.set(np.id, np); toast("✓ Изменения сохранены"); feedDirty = true; wide = null; if (mapReady) loadMapPosts();
        hist.pop(); openPostId = np.id; go("sv-post", false); openPost(np.id);
        return;
      }
      if (!cr.loc) return crError("Укажите место: \"Где я сейчас\" или \"На карте\"");
      const { lat, lng } = cr.loc;
      // место по умолчанию приблизительное (~200 м, округляет сервер); точное — только если переключатель выключен
      const exact = !$("crFuzzy").classList.contains("on");
      cr.started = true;
      const p = await api.createPost({ category: cr.type, text, lat, lng, files: cr.files, event, exact, clientKey: cr.key }, (m, frac) => { $("crProg").innerHTML = `<div>${esc(m)}</div>${frac != null ? `<div class="pbar"><i style="width:${Math.round(Math.min(1, frac) * 100)}%"></i></div>` : ""}`; });
      cache.set(p.id, p); cr.started = false; cr.key = N.rid() + N.rid();
      cr.files.forEach((f) => f._url && URL.revokeObjectURL(f._url)); cr.files = [];
      $("crProg").textContent = ""; $("crText").value = ""; saveDraft();
      Obs.track("post_created", { category: p.category, count: p.media.length }); usefulAction("post");
      toast("✓ Опубликовано! Публикация уже в ленте и на карте");
      feedCat = "all"; $("cats").innerHTML = chipsHtml("all"); wide = null;
      if (N.dist(pos, p) > R) setRadius(Math.min(10000, Math.max(R, Math.ceil(N.dist(pos, p) / 1000) * 1000)));
      hist = []; go("v-feed", false); await loadFeed(); if (mapReady) loadMapPosts();
    } catch (e) { if (gateError(e)) { $("crProg").textContent = ""; return; } crError(e.message + (cr.started && !/^NR\d/.test(e.code || "") ? " · Нажмите \"Опубликовать\" еще раз — загрузка продолжится без дублей" : "")); $("crProg").textContent = ""; }
    finally { btn.disabled = false; }
  };
  $("crText").addEventListener("input", () => { clearTimeout(cr.dt); cr.dt = setTimeout(saveDraft, 400); });

/* ===== 50-map.js ===== */
  /* =====================================================
     MAP (MapLibre GL + OpenFreeMap: векторная карта, без ключей)
     ===================================================== */
  const ML_VER = "5.24.1", OFM = "https://tiles.openfreemap.org/styles/";
  let mlP = null, map = null, mapReady = false, mapPosts = [], mapCat = "all", mapT = null, pendingFocus = null, meMarker = null, selId = null;
  let loadedArea = null, reqSeq = 0;
  const htmlMarkers = new Map();
  // карта по умолчанию в теме приложения; кнопка 🌓 запоминает выбор отдельно
  const appTheme = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  let mapTheme = appTheme(); try { mapTheme = localStorage.getItem("near_map_theme") || appTheme(); } catch (e) {}
  async function syncMapTheme() {
    let fixed = null; try { fixed = localStorage.getItem("near_map_theme"); } catch (e) {}
    const want = fixed || appTheme(); if (want === mapTheme) return;
    mapTheme = want; $("v-map").classList.toggle("light-map", mapTheme === "light");
    if (mapReady) { try { map.setStyle(await mapStyle(mapTheme), { diff: false }); } catch (e) {} }
  }
  function loadML() {
    if (!mlP) mlP = (async () => {
      if (!document.getElementById("mlcss")) { const l = document.createElement("link"); l.id = "mlcss"; l.rel = "stylesheet"; l.href = `https://unpkg.com/maplibre-gl@${ML_VER}/dist/maplibre-gl.css`; document.head.appendChild(l); }
      if (!window.maplibregl) await loadScript(`https://unpkg.com/maplibre-gl@${ML_VER}/dist/maplibre-gl.js`, 20000);
      return window.maplibregl;
    })().catch((e) => { mlP = null; throw e; });
    return mlP;
  }
  // подписи на русском, где есть перевод в OpenStreetMap
  function ruLabels(st) {
    st.layers.forEach((l) => {
      const lay = l.layout || {}; const tf = lay["text-field"];
      if (tf && JSON.stringify(tf).includes("name")) lay["text-field"] = ["coalesce", ["get", "name:ru"], ["get", "name"]];
    });
    return st;
  }
  // фирменная ночная палитра NEAR
  function tuneDark(st) {
    const C = { bg: "#12131c", res: "#161723", water: "#13233d", waterLine: "#1b3152", park: "#132a20", bld: "#1d1f2e", bldLine: "#272a3c",
      minor: "#272b3f", path: "#22263a", major: "#3b405e", motor: "#6a4fa0", casing: "#0c0d14", rail: "#2c2f45", label: "#9aa0bd", place: "#e2e4f3", wlabel: "#5f86bd" };
    st.layers.forEach((l) => {
      const id = l.id, p = (l.paint = l.paint || {});
      if (l.type === "background") p["background-color"] = C.bg;
      else if (id === "water") p["fill-color"] = C.water;
      else if (id === "waterway") p["line-color"] = C.waterLine;
      else if (id === "landuse_residential") { p["fill-color"] = C.res; p["fill-opacity"] = 1; }
      else if (id === "landcover_wood" || id === "landuse_park") { p["fill-color"] = C.park; p["fill-opacity"] = 0.95; }
      else if (id === "building") { p["fill-color"] = C.bld; p["fill-outline-color"] = C.bldLine; }
      else if (id.startsWith("aeroway")) { if (l.type === "fill") p["fill-color"] = C.bld; else p["line-color"] = C.minor; }
      else if (id.includes("casing")) p["line-color"] = C.casing;
      else if (id.startsWith("highway_motorway")) p["line-color"] = C.motor;
      else if (id.startsWith("highway_major")) p["line-color"] = C.major;
      else if (id === "highway_minor" || id === "road_pier") p["line-color"] = C.minor;
      else if (id === "highway_path") p["line-color"] = C.path;
      else if (id.startsWith("railway")) p["line-color"] = C.rail;
      else if (id.startsWith("boundary")) p["line-color"] = "#3a3d55";
      else if (l.type === "symbol") {
        p["text-color"] = id.startsWith("place") ? C.place : id === "water_name" ? C.wlabel : C.label;
        p["text-halo-color"] = C.bg; p["text-halo-width"] = 1.3;
      }
    });
    return st;
  }
  const styleCache = {};
  function mapStyle(theme) {
    const name = theme === "light" ? "liberty" : "dark";
    if (!styleCache[name]) styleCache[name] = fetch(OFM + name).then((r) => { if (!r.ok) throw new Error("Стиль карты недоступен"); return r.json(); })
      .then((st) => (name === "dark" ? tuneDark(ruLabels(st)) : ruLabels(st))).catch((e) => { delete styleCache[name]; throw e; });
    return styleCache[name].then((s) => JSON.parse(JSON.stringify(s)));
  }
  function circlePoly(lat, lng, r, n = 72) {
    const c = [], dLat = r / 111320, dLng = r / (111320 * Math.cos((lat * Math.PI) / 180));
    for (let i = 0; i <= n; i++) { const a = (i / n) * 2 * Math.PI; c.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]); }
    return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [c] } };
  }
  const radBounds = (r = R) => { const b = N.boundsAround(pos.lat, pos.lng, r); return [[b.w, b.s], [b.e, b.n]]; };
  const MAP_PAD = () => ({ top: 150, bottom: 130, left: 24, right: 24 });
  function fitRadius(anim = true) { if (mapReady) map.fitBounds(radBounds(), { padding: MAP_PAD(), duration: anim ? 600 : 0 }); }

  $("mapCats").innerHTML = chipsHtml("all");
  $("mapCats").onclick = (e) => { const b = e.target.closest("[data-c]"); if (!b) return; mapCat = b.dataset.c; $("mapCats").innerHTML = chipsHtml(mapCat); loadMapPosts(true); };
  $("mapRad").onclick = (e) => { const b = e.target.closest("[data-r]"); if (!b) return; setRadius(+b.dataset.r); feedDirty = true; fitRadius(); };

  function addOverlays() {
    const empty = { type: "FeatureCollection", features: [] };
    if (!map.getSource("radius")) {
      map.addSource("radius", { type: "geojson", data: empty });
      map.addLayer({ id: "radius-fill", type: "fill", source: "radius", paint: { "fill-color": "#ff2e88", "fill-opacity": 0.05 } });
      map.addLayer({ id: "radius-line", type: "line", source: "radius", paint: { "line-color": "#ff2e88", "line-width": 1.6, "line-opacity": 0.75, "line-dasharray": [3, 2] } });
    }
    if (!map.getSource("acc")) {
      map.addSource("acc", { type: "geojson", data: empty });
      map.addLayer({ id: "acc-fill", type: "fill", source: "acc", paint: { "fill-color": "#3da5ff", "fill-opacity": 0.12 } });
      map.addLayer({ id: "acc-line", type: "line", source: "acc", paint: { "line-color": "#3da5ff", "line-width": 1, "line-opacity": 0.5 } });
    }
    if (!map.getSource("posts")) map.addSource("posts", { type: "geojson", data: empty, cluster: true, clusterRadius: 46, clusterMaxZoom: 16 });
    // невидимый слой: без него MapLibre не строит кластеры для HTML-меток
    if (!map.getLayer("posts-hit")) map.addLayer({ id: "posts-hit", type: "circle", source: "posts", paint: { "circle-radius": 1, "circle-opacity": 0 } });
    drawMe(); setPostsData();
  }
  async function initMap() {
    if (mapReady) { setTimeout(() => { map.resize(); if (pendingFocus) focusPost(pendingFocus); }, 60); return; }
    $("mapMsg").classList.remove("hidden"); $("mapMsg").innerHTML = '<div><div class="spin"></div>Загружаем карту...</div>';
    let style;
    try { await loadML(); style = await mapStyle(mapTheme); }
    catch (e) { $("mapMsg").innerHTML = `<div>🗺️<br>Карта не загрузилась. Проверьте интернет.<br><button class="btn btn-main mt12" id="mapRetry">Повторить</button></div>`; $("mapRetry").onclick = initMap; return; }
    map = new maplibregl.Map({ container: "map", style, bounds: radBounds(), fitBoundsOptions: { padding: MAP_PAD() }, minZoom: 9, maxZoom: 18.5,
      attributionControl: { compact: true }, dragRotate: false, touchPitch: false, pitchWithRotate: false, fadeDuration: 150 });
    map.touchZoomRotate.disableRotation();
    map.on("style.load", addOverlays);
    map.on("load", () => { $("mapMsg").classList.add("hidden"); });
    // MAP-01: при перемещении карта не грузит данные сама — появляется кнопка "Искать здесь"
    map.on("moveend", () => { clearTimeout(mapT); mapT = setTimeout(() => { if (mapMode === "screen" && needsArea()) $("mapHere").classList.remove("hidden"); updateCount(); }, 250); });
    map.on("render", () => { if (map.getSource("posts") && map.isSourceLoaded("posts")) syncMarkers(); });
    map.on("click", (e) => { if (!e.originalEvent.target.closest(".ml-pin,.ml-cl")) hideMapCard(); });
    map.on("error", (e) => console.warn("map", e && e.error));
    const me = document.createElement("div"); me.className = "me-dot";
    meMarker = new maplibregl.Marker({ element: me }).setLngLat([pos.lng, pos.lat]).addTo(map);
    mapReady = true; geoBanner();
    await new Promise((r) => (map.loaded() ? r() : map.once("load", r)));
    await loadMapPosts(true);
    if (pendingFocus) focusPost(pendingFocus);
  }
  $("mapTheme").onclick = async () => {
    mapTheme = mapTheme === "dark" ? "light" : "dark"; try { localStorage.setItem("near_map_theme", mapTheme); } catch (e) {}
    $("v-map").classList.toggle("light-map", mapTheme === "light");
    if (!mapReady) return;
    try { map.setStyle(await mapStyle(mapTheme), { diff: false }); } catch (e) { toast("Не удалось сменить стиль карты"); }
  };
  $("v-map").classList.toggle("light-map", mapTheme === "light");

  function drawMe() {
    geoBanner();
    if (!mapReady || !map.getSource("radius")) return;
    map.getSource("radius").setData(circlePoly(pos.lat, pos.lng, R));
    map.getSource("acc").setData(pos.src === "gps" && pos.acc ? circlePoly(pos.lat, pos.lng, Math.max(pos.acc, 15)) : { type: "FeatureCollection", features: [] });
    meMarker.setLngLat([pos.lng, pos.lat]);
    meMarker.getElement().className = "me-dot" + (pos.src === "gps" ? "" : " approx");
  }
  // индикатор: откуда взято местоположение
  function geoText() {
    if (pos.src === "gps") return pos.acc > 500 ? { k: "warn", t: `📡 GPS неточный: ±${fmtDist(pos.acc)}` } : { k: "ok", t: `📍 GPS · точность ±${fmtDist(Math.max(pos.acc || 0, 5))}` };
    if (pos.src === "district") return { k: "warn", t: `📍 ${pos.name} район · примерно, по центру района` };
    if (pos.src === "place") return { k: "warn", t: `⭐ ${pos.name} · избранное место` };
    return { k: "bad", t: "⚠️ Местоположение не определено — показан центр Алматы" };
  }
  function geoBanner() {
    const g = geoText(), el = $("mapGeo");
    if (el) { el.className = "map-geo " + g.k; el.innerHTML = `<span>${g.t}</span>${pos.src === "gps" ? "" : '<button type="button" id="geoFix">Определить</button>'}`; }
    const pill = $("locBtn"); if (pill) { pill.dataset.src = pos.src; pill.title = g.t.replace(/^\S+\s/, ""); }
    // постоянная подпись: район/GPS, радиус и точность; без GPS — кнопка "Рядом со мной" (разрешение спрашиваем только по нажатию)
    const fl = $("feedLoc");
    if (fl) {
      const where = pos.src === "gps" ? "📍 Рядом с вами" : pos.src === "district" ? `📍 ${pos.name} район` : pos.src === "place" ? `⭐ ${esc(pos.name)}` : "📍 Центр Алматы";
      const acc = pos.src === "gps" ? (pos.acc ? ` · точность ±${fmtDist(Math.max(pos.acc, 5))}` : "") : " · примерно";
      fl.className = "feed-loc " + g.k;
      fl.innerHTML = `<button type="button" class="fl-t" id="feedLocPick" aria-label="Выбрать место">${where} · ${fmtDist(R)}${acc}</button>${pos.src === "gps" ? "" : '<button type="button" class="fl-b" id="feedGeoFix">Рядом со мной</button>'}`;
    }
  }
  document.addEventListener("click", (e) => { if (e.target.closest("#feedLocPick")) $("locBtn").click(); });
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("#geoFix,#feedGeoFix")) return;
    if (await useMyLocation()) { wide = null; feedDirty = true; drawMe(); fitRadius(); loadFeed(); toast("📍 " + geoText().t.replace(/^\S+\s/, "")); }
  });

  function setPostsData() {
    if (!mapReady || !map.getSource("posts")) return;
    map.getSource("posts").setData({ type: "FeatureCollection", features: mapPosts.map((p) => {
      const c = CATS[p.category] || CATS.talk;
      return { type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { id: p.id, color: c.c, emoji: c.e, sos: p.is_sos ? 1 : 0, fresh: Date.now() - new Date(p.created_at) < 3600e3 ? 1 : 0, ended: postEnded(p) ? 1 : 0 } };
    }) });
  }
  function syncMarkers() {
    const feats = map.querySourceFeatures("posts"), seen = new Set();
    for (const f of feats) {
      const pr = f.properties, cl = !!pr.cluster, key = cl ? "c" + pr.cluster_id : "p" + pr.id;
      if (seen.has(key)) continue; seen.add(key);
      let mk = htmlMarkers.get(key);
      if (!mk) {
        const el = document.createElement("button"); el.type = "button";
        if (cl) {
          el.className = "ml-cl"; el.style.setProperty("--s", Math.round(36 + Math.min(24, Math.log2(pr.point_count) * 5)) + "px"); el.textContent = pr.point_count_abbreviated;
          el.onclick = (ev) => { ev.stopPropagation(); map.getSource("posts").getClusterExpansionZoom(pr.cluster_id).then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z + 0.3, 18) })).catch(() => {}); };
        } else {
          // завершенное событие — другая форма (квадрат) и подпись, а не только цвет
          el.className = "ml-pin" + (pr.ended ? " ended" : pr.sos ? " sos" : pr.fresh ? " fresh" : ""); el.style.setProperty("--c", pr.color);
          el.innerHTML = `<span>${pr.emoji}</span>${pr.ended ? "<em>завершено</em>" : ""}`; el.setAttribute("aria-label", pr.ended ? "Завершенное событие" : pr.sos ? "SOS" : "Публикация");
          el.onclick = (ev) => { ev.stopPropagation(); const p = cache.get(pr.id); if (p) selectPost(p); };
        }
        mk = new maplibregl.Marker({ element: el, anchor: cl ? "center" : "bottom" }).setLngLat(f.geometry.coordinates).addTo(map);
        htmlMarkers.set(key, mk);
      }
      if (!cl) mk.getElement().classList.toggle("sel", pr.id === selId);
    }
    for (const [k, mk] of htmlMarkers) if (!seen.has(k)) { mk.remove(); htmlMarkers.delete(k); }
  }
  // запрос только при выходе за загруженную область (с запасом 35%) или через 90 сек
  // MAP-01: кто и за какой период (идея "Все / Друзья / Горячее" и "Сегодня / Неделя"); сохраняется для аккаунта
  const MF = { who: "all", period: null };
  const postEnded = (p) => !!(p.event && new Date(p.event.starts_at).getTime() + 3 * 3600e3 < Date.now());
  const isHot = (p) => p.is_sos || (p.category === "incident" && Date.now() - new Date(p.created_at) < 3 * 3600e3) || (p.likes || 0) + (p.comments || 0) * 2 >= 4;
  function loadMapFilters() { const m = prefs.map || {}; MF.who = ["all", "friends", "hot"].includes(m.who) ? m.who : "all"; MF.period = ["today", "week"].includes(m.period) ? m.period : null; renderMapFlt(); }
  function renderMapFlt() {
    $("mapFlt").innerHTML = [["all", "Все"], ["friends", "Друзья"], ["hot", "🔥 Горячее"]].map(([k, t]) => `<button data-who="${k}" class="${MF.who === k ? "on" : ""}">${t}</button>`).join("")
      + '<span class="sep"></span>' + [[null, "Все время"], ["today", "Сегодня"], ["week", "Неделя"]].map(([k, t]) => `<button data-per="${k || ""}" class="${MF.period === k ? "on" : ""}">${t}</button>`).join("");
  }
  $("mapFlt").onclick = (e) => {
    const w = e.target.closest("[data-who]"), pe = e.target.closest("[data-per]");
    if (w) { if (w.dataset.who === "friends" && !requireAuth("Войдите, чтобы видеть публикации друзей")) return; MF.who = w.dataset.who; }
    else if (pe) MF.period = pe.dataset.per || null; else return;
    prefs.map = { who: MF.who, period: MF.period }; savePrefs(); renderMapFlt(); Obs.track("filter_changed", { filter: "map_" + MF.who, period: MF.period || "all" }); loadMapPosts(true);
  };
  // нужна ли новая выборка для текущей области экрана
  function needsArea() {
    const A = loadedArea; if (!A || A.mode !== "screen") return true;
    const bb = map.getBounds();
    return !(bb.getSouth() >= A.b.s && bb.getNorth() <= A.b.n && bb.getWest() >= A.b.w && bb.getEast() <= A.b.e);
  }
  $("mapHere").onclick = () => { $("mapHere").classList.add("hidden"); loadMapPosts(true); };
  let mapCtrl = null;
  async function loadMapPosts(force) {
    if (!mapReady) return;
    $("mapHere").classList.add("hidden");
    const bb = map.getBounds(), v = { s: bb.getSouth(), n: bb.getNorth(), w: bb.getWest(), e: bb.getEast() };
    const A = loadedArea;
    if (mapMode === "radius") {
      if (!force && A && A.mode === "radius" && A.cat === mapCat && A.r === R && A.lat === pos.lat && Date.now() - A.at < 90000) return updateCount();
    } else if (!force && A && A.mode === "screen" && A.cat === mapCat && Date.now() - A.at < 90000 && v.s >= A.b.s && v.n <= A.b.n && v.w >= A.b.w && v.e <= A.b.e) return updateCount();
    const dy = (v.n - v.s) * 0.35, dx = (v.e - v.w) * 0.35, b = { s: v.s - dy, n: v.n + dy, w: v.w - dx, e: v.e + dx };
    // устаревший ответ (пользователь уже сдвинул карту) отбрасывается по номеру запроса
    const seq = ++reqSeq; $("mapCount").innerHTML = '<i class="mini-spin"></i> Загружаем...';
    if (mapCtrl) try { mapCtrl.abort(); } catch (e) {}
    mapCtrl = "AbortController" in window ? new AbortController() : null;
    try {
      const ext = { period: MF.period, friends: MF.who === "friends" && !!user, signal: mapCtrl && mapCtrl.signal };
      const args = mapMode === "radius" ? { lat: pos.lat, lng: pos.lng, radius: R, category: catFilter(mapCat), limit: 400, ...ext } : { bounds: b, category: catFilter(mapCat), limit: 400, ...ext };
      const list = remember(await api.listPosts(args));
      if (seq !== reqSeq) return;
      loadedArea = { b, cat: mapCat, at: Date.now(), mode: mapMode, r: R, lat: pos.lat };
      mapPosts = list.filter((p) => p.status !== "closed" && (MF.who !== "hot" || isHot(p)));
      setPostsData(); updateCount();
      if (!$("mapList").classList.contains("hidden")) renderMapList();
    } catch (e) { if (seq === reqSeq && e.name !== "AbortError" && !/abort/i.test(e.message)) $("mapCount").textContent = "Не удалось загрузить: " + e.message; }
  }
  function inView() { if (mapMode === "radius") return mapPosts.slice(); const b = map.getBounds(); return mapPosts.filter((p) => b.contains([p.lng, p.lat])); }
  $("mapMode").onclick = (e) => {
    const b = e.target.closest("[data-mm]"); if (!b) return;
    mapMode = b.dataset.mm; prefs.map_mode = mapMode; savePrefs();
    qa("#mapMode [data-mm]").forEach((x) => x.classList.toggle("on", x === b));
    if (mapReady) { if (mapMode === "radius") fitRadius(); loadMapPosts(true); }
  };
  function updateCount() {
    const n = inView().length, where = mapMode === "radius" ? `в радиусе ${fmtDist(R)}` : "на экране";
    $("mapCount").textContent = n ? `${n} ${plural(n, "публикация", "публикации", "публикаций")} ${where}` : `${where[0].toUpperCase() + where.slice(1)} пока пусто — опубликуйте первым`;
  }

  function selectPost(p) {
    selId = p.id; syncMarkers();
    const c = CATS[p.category] || CATS.talk, m = p.media && p.media[0], img = m && m.type === "image" && !shieldFor(m, p.user_id);
    $("mapCard").innerHTML = `<div class="mc-grab"></div>
      <div class="mc-top"><span class="mc-cat" style="--c:${c.c}">${c.e} ${c.n}</span><span class="mc-meta">${fmtDist(D(p))} · ${timeAgo(p.created_at)}</span><button class="x" id="mcX" aria-label="Закрыть">✕</button></div>
      <div class="mc-body"><div class="th" style="${img ? `background-image:url('${esc(m.url)}')` : `background:${c.c}2b`}">${img ? "" : c.e}</div>
        <div class="tx"><b translate="no">${esc(p.text)}</b><span><i translate="no">${esc(p.author.name)}</i>${p.media.length > 1 ? " · 📷 " + p.media.length : ""}</span></div></div>
      <div class="mc-acts"><button class="btn btn-main" data-post="${p.id}">Открыть</button><a class="btn btn-ghost" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener">Маршрут</a></div>`;
    $("mapCard").classList.remove("hidden"); $("v-map").classList.add("carded");
    $("mcX").onclick = (e) => { e.stopPropagation(); hideMapCard(); };
  }
  function hideMapCard() { $("mapCard").classList.add("hidden"); $("v-map").classList.remove("carded"); if (selId) { selId = null; if (mapReady) syncMarkers(); } }
  $("mapCard").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };
  // свайп вниз закрывает карточку
  (() => { let y0 = null; const el = $("mapCard");
    el.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    el.addEventListener("touchmove", (e) => { if (y0 == null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) el.style.transform = `translateY(${dy}px)`; }, { passive: true });
    el.addEventListener("touchend", (e) => { const dy = y0 == null ? 0 : e.changedTouches[0].clientY - y0; el.style.transform = ""; y0 = null; if (dy > 70) hideMapCard(); });
  })();
  function focusPost(p) {
    pendingFocus = null; $("mapList").classList.add("hidden"); $("mapListBtn").textContent = "☰";
    map.flyTo({ center: [p.lng, p.lat], zoom: 16.3, offset: [0, -60], duration: 700 });
    if (!mapPosts.some((x) => x.id === p.id) && p.status !== "closed") { mapPosts.push(p); setPostsData(); }
    selectPost(p);
  }
  $("mapLocate").onclick = async () => { if (await useMyLocation()) { feedDirty = true; wide = null; drawMe(); fitRadius(); } else fitRadius(); };
  $("mapListBtn").onclick = () => { const l = $("mapList"); l.classList.toggle("hidden"); $("mapListBtn").textContent = l.classList.contains("hidden") ? "☰" : "🗺"; if (!l.classList.contains("hidden")) renderMapList(); };
  function rowPost(p) {
    const c = CATS[p.category] || CATS.talk, m = p.media[0];
    return `<button class="row-post" data-post="${p.id}"><span class="th" style="${m && m.type === "image" ? `background-image:url('${esc(m.url)}')` : `background:${c.c}33`}">${m && m.type === "image" ? "" : c.e}</span><div><b>${esc(p.text)}</b><span>${c.e} ${c.n} · ${fmtDist(D(p))} · ${timeAgo(p.created_at)}${p.status === "closed" ? " · закрыто" : ""}</span></div></button>`;
  }
  function renderMapList() {
    const list = (mapReady ? inView() : mapPosts).sort((a, b) => D(a) - D(b));
    $("mapList").innerHTML = '<div class="lbl">На экране, по расстоянию</div>' + (list.length ? list.map(rowPost).join("") : '<div class="empty"><b>Пусто</b>В видимой области нет публикаций. Отдалите карту или смените категорию.</div>');
  }
  $("mapList").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };

  /* picker */
  let pick = null;
  async function openPicker(center) {
    go("sv-pick");
    let style;
    try { await loadML(); style = await mapStyle(mapTheme); } catch (e) { toast("Карта не загрузилась. Проверьте интернет."); back(); return; }
    if (!pick) {
      pick = new maplibregl.Map({ container: "pickMap", style, center: [center.lng, center.lat], zoom: 16, minZoom: 9, dragRotate: false, touchPitch: false, attributionControl: { compact: true } });
      pick.touchZoomRotate.disableRotation();
      pick.on("move", () => { const c = pick.getCenter(); $("pickHint").textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`; });
    } else pick.jumpTo({ center: [center.lng, center.lat], zoom: 16 });
    setTimeout(() => pick.resize(), 80);
  }
  $("pickBack").onclick = back;
  $("pickOk").onclick = () => { if (pick) { const c = pick.getCenter(); cr.loc = { lat: c.lat, lng: c.lng, how: "map" }; renderLoc(); } back(); };

/* ===== 60-discover.js ===== */
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
    setCnt("cntRadar", act.filter((p) => D(p) <= 10000 && Date.now() - new Date(p.created_at) < 86400e3).length);
    setCnt("cntEvents", upcoming(wide).length);
    setCnt("cntDeals", act.filter((p) => p.category === "deal").length);
    setCnt("cntLost", act.filter((p) => p.category === "lost" || p.category === "found").length);
  }
  async function withWide(boxId, fn) {
    $(boxId).innerHTML = '<div class="spin"></div>';
    try { fn(await loadWide()); } catch (e) { $(boxId).innerHTML = `<div class="empty"><b>Ошибка</b>${esc(e.message)}</div>`; }
  }
  // радар до 10 км; шкала нелинейная, чтобы ближние точки не слипались в центре
  const RINGS = [[0, 0], [500, 0.22], [1000, 0.40], [3000, 0.62], [5000, 0.80], [10000, 1]];
  function radarFrac(d) {
    for (let i = 1; i < RINGS.length; i++) if (d <= RINGS[i][0]) { const [d0, f0] = RINGS[i - 1], [d1, f1] = RINGS[i]; return f0 + ((d - d0) / (d1 - d0)) * (f1 - f0); }
    return 1;
  }
  function renderRadar() {
    withWide("radarRows", (list) => {
      const act = list.filter((p) => p.status === "active" && D(p) <= 10000);
      const box = $("radarBox"); qa(".bl", box).forEach((x) => x.remove());
      act.slice(0, 60).forEach((p) => {
        const dy = (p.lat - pos.lat) * 111320, dx = (p.lng - pos.lng) * 111320 * Math.cos((pos.lat * Math.PI) / 180);
        const d = Math.hypot(dx, dy) || 1, f = radarFrac(d) * 0.5, c = CATS[p.category] || CATS.talk;
        box.insertAdjacentHTML("beforeend", `<span class="bl" data-post="${p.id}" style="left:${50 + (dx / d) * f * 100}%;top:${50 - (dy / d) * f * 100}%;background:${c.c};cursor:pointer">${c.e}</span>`);
      });
      const rings = [[0, 500, "500 м"], [500, 1000, "1 км"], [1000, 3000, "3 км"], [3000, 5000, "5 км"], [5000, 10000, "10 км"]];
      $("radarSub").textContent = `${act.length} ${plural(act.length, "публикация", "публикации", "публикаций")} в радиусе 10 км` + (pos.src === "gps" ? "" : " · от центра " + (pos.src === "district" ? "района" : "Алматы"));
      $("radarRows").innerHTML = rings.map(([a, b, n]) => {
        const ps = act.filter((p) => D(p) > a && D(p) <= b); const by = {};
        ps.forEach((p) => (by[p.category] = (by[p.category] || 0) + 1));
        const txt = ps.length ? Object.entries(by).map(([k, v]) => `${(CATS[k] || CATS.talk).e} ${v}`).join("  ") : "тихо";
        return `<button class="rrow" data-rr="${b}"><span class="rd2">${n}</span><span>${ps.length ? ps.length + " · " : ""}${txt}</span></button>`;
      }).join("");
    });
  }
  $("radarRows").onclick = (e) => { const b = e.target.closest("[data-rr]"); if (!b) return; setRadius(+b.dataset.rr); hist = []; go("v-feed", false); loadFeed(); };
  $("radarBox").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };

  // события по дням (идея из Posse): колонка даты слева, карточки справа; "Все / Сегодня / Неделя"
  let evPeriod = "all", evKind = null;
  // v14: быстрые входы ленты — "Встречи" и "События" открывают один календарь с фильтром по типу
  qa("[data-quick]").forEach((b) => (b.onclick = () => { evKind = b.dataset.quick; go("sv-events"); }));
  document.addEventListener("click", (e) => { const o = e.target.closest('[data-open="sv-events"]'); if (o && !o.closest("#quick")) evKind = null; }, true);
  qa("#evSeg [data-ev]").forEach((b) => (b.onclick = () => { evPeriod = b.dataset.ev; qa("#evSeg button").forEach((x) => x.classList.toggle("on", x === b)); renderEvents(); }));
  const dayKey = (d) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Almaty" });
  function renderEvents() {
    withWide("eventsList", (list) => {
      const now = new Date(), today = dayKey(now), wk = Date.now() + 7 * 86400e3;
      $("evTitle").textContent = evKind === "meetup" ? "Встречи" : evKind === "event" ? "События" : "События и встречи";
      const cb = document.querySelector("#sv-events [data-create]"); if (cb) { cb.dataset.create = evKind === "meetup" ? "meetup" : "event"; cb.textContent = evKind === "meetup" ? "+ Создать встречу" : "+ Создать событие"; }
      const ev = upcoming(list).filter((p) => !evKind || p.category === evKind).filter((p) => { const t = new Date(p.event.starts_at); return evPeriod === "all" || (evPeriod === "today" ? dayKey(t) === today : t.getTime() < wk); });
      if (!ev.length) { $("eventsList").innerHTML = `<div class="empty"><b>${evKind === "meetup" ? (evPeriod === "today" ? "Сегодня встреч нет" : "Ближайших встреч нет") : evPeriod === "today" ? "Сегодня событий нет" : "Ближайших событий нет"}</b>${evKind === "meetup" ? "Расширьте радиус или создайте встречу: футбол, настолки, прогулка" : "Создайте первое: концерт, ярмарку или встречу соседей"}</div>`; return; }
      const groups = []; ev.forEach((p) => { const k = dayKey(new Date(p.event.starts_at)); const g = groups.find((x) => x.k === k); if (g) g.items.push(p); else groups.push({ k, items: [p] }); });
      const tomorrow = dayKey(new Date(Date.now() + 86400e3));
      $("eventsList").innerHTML = groups.map((g) => {
        const d = new Date(g.items[0].event.starts_at);
        const lbl = g.k === today ? "Сегодня" : g.k === tomorrow ? "Завтра" : "";
        return `<section class="ev-day${g.k === today ? " today" : ""}"><div class="ev-date"><small>${lbl}</small><b>${dfmt(d, { day: "numeric", timeZone: "Asia/Almaty" })}</b><span>${dfmt(d, { weekday: "short", timeZone: "Asia/Almaty" })}</span></div>
          <div class="ev-items">${g.items.map((p) => {
            const c = CATS[p.category], m = p.media[0], img = m && (m.thumb || (m.type === "image" ? m.url : m.poster));
            const t = new Date(p.event.starts_at).toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Almaty" });
            const full = p.event.capacity && p.event.members >= p.event.capacity;
            return `<article class="ev2" data-post="${p.id}"><div class="ev2-im" style="${img ? `background-image:url('${esc(img)}')` : `background:linear-gradient(135deg,${c.c}cc,${c.c}55)`}">${img ? "" : `<span>${c.e}</span>`}${p.event.members >= 10 ? `<i class="ev2-hot">🔥 ${p.event.members} идут</i>` : ""}</div>
              <div class="ev2-b"><b translate="no">${esc(p.text.split("\n")[0].slice(0, 70))}</b><span>📍 ${fmtDist(D(p))} · <span translate="no">${esc(p.author.name)}</span></span>
                <div class="ev2-t"><b>${t}</b> · ${p.event.members}${p.event.capacity ? " из " + p.event.capacity : ""} ${plural(p.event.members, "участник", "участника", "участников")}</div>
                <div class="ev2-a"><button class="go${p.event.joined ? " in" : ""}" data-join="${p.id}" ${full && !p.event.joined ? "disabled" : ""}>${p.event.joined ? "✓ Иду" : full ? "Мест нет" : "Иду"}</button><button data-cal="${p.id}" aria-label="В календарь">📅</button><button data-share="${p.id}" aria-label="Поделиться">↗</button></div></div></article>`;
          }).join("")}</div></section>`;
      }).join("");
    });
  }
  $("eventsList").onclick = (e) => {
    let b;
    if ((b = e.target.closest("[data-join]"))) return doJoin(b.dataset.join);
    if ((b = e.target.closest("[data-cal]"))) return addToCalendar(cache.get(b.dataset.cal));
    if ((b = e.target.closest("[data-share]"))) { const q = cache.get(b.dataset.share); return q && sharePost(q); }
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
      toast("🧪 Демо-купон: заведение пока не подключено к NEAR"); return;
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
  $("bellBtn").onclick = () => { if (!requireAuth("Войдите, чтобы видеть уведомления", { t: "notif" })) return; go("sv-notif"); };
  async function renderNotifs() {
    $("nfList").innerHTML = '<div class="spin"></div>';
    try {
      const list = await api.notifications();
      const unread = list.filter((n) => !n.read).length;
      $("nfSub").textContent = unread ? unread + " новых" : "все прочитано";
      const ic = { like: "♥", likes: "♥", comment: "💬", comments: "💬", join: "🎉", event_members: "🎉", friend_request: "👋", friend_accept: "🤝", post_hidden: "🛡", sos_closed: "✅", appeal: "⚖️", reply: "↩️" };
      // группировка: лайки и участники одной публикации — одной строкой ("Айгерим и еще 2")
      const GROUP = new Set(["like", "likes", "join", "event_members"]), groups = [];
      list.forEach((n) => { const g = GROUP.has(n.type) && n.post_id && groups.find((x) => x.type === n.type && x.post_id === n.post_id); if (g) { g.more.push(n); if (!n.read) g.read = false; } else groups.push({ ...n, more: [] }); });
      $("nfList").innerHTML = groups.length ? groups.map((n) => { const names = [...new Set([n.actor.name, ...n.more.map((x) => x.actor.name)])];
        const who = names.length > 1 ? `${esc(names[0])} и еще ${names.length - 1}` : esc(names[0]);
        return `<button class="res${n.read ? "" : " unread"}" data-post="${n.post_id || ""}" data-actor="${(n.type || "").startsWith("friend") ? (n.actor && n.actor.id) || n.actor_id || "" : ""}"><span class="e">${ic[n.type] || "🔔"}</span><div><b translate="no">${who}</b><span>${esc(n.text || "")} · ${timeAgo(n.created_at)}</span></div></button>`; }).join("")
        : '<div class="empty"><b>Уведомлений пока нет</b>Здесь появятся лайки, комментарии и участники ваших событий</div>';
      if (unread) { await api.markNotificationsRead(); refreshBadge(); }
    } catch (e) { $("nfList").innerHTML = `<div class="empty"><b>Ошибка</b>${esc(e.message)}</div>`; }
  }
  $("nfList").onclick = (e) => { const b = e.target.closest("[data-post]"); if (!b) return; if (b.dataset.actor) { if (b.dataset.actor) openUser(b.dataset.actor); return; } if (b.dataset.post) openPost(b.dataset.post); };

/* ===== 70-profile.js ===== */
  /* =====================================================
     PROFILE
     ===================================================== */
  // SEC-06: настройки хранятся отдельно для каждого аккаунта (и для гостя)
  const prefsKey = () => "near_prefs_" + (user ? user.id.slice(0, 12) : "guest");
  let PREFS_KEY = prefsKey();
  const prefs = {};
  function loadPrefs() {
    PREFS_KEY = prefsKey();
    Object.keys(prefs).forEach((k) => delete prefs[k]);
    try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || (user ? {} : JSON.parse(localStorage.getItem("near_prefs") || "{}"))); } catch (e) {}
    mapMode = prefs.map_mode === "radius" ? "radius" : "screen";
    qa("#mapMode [data-mm]").forEach((x) => x.classList.toggle("on", x.dataset.mm === mapMode));
    loadFeedPrefs(); loadMapFilters();
  }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }
  loadPrefs();
  const PREF_LIST = [["sound", "🔊 Звуки и вибрация", true], ["n_like", "❤️ Лайки", true], ["n_comment", "💬 Комментарии и ответы", true], ["n_msg", "✉️ Сообщения", true], ["incident", "🚨 Сигнал: происшествия рядом", true], ["event", "🎉 Сигнал: события и встречи", true], ["deal", "🏷️ Сигнал: акции", false], ["quiet", "🌙 Тихие часы 23:00–08:00 (без звука)", true]];
  const prefOn = (k) => { const d = PREF_LIST.find((x) => x[0] === k); return prefs[k] ?? (d ? d[2] : false); };
  /* ---------- звуки (синтез WebAudio, без файлов) ---------- */
  const Sound = (() => {
    let ctx = null;
    const SEQ = { message: [[880, 0, 0.09], [1320, 0.09, 0.14]], notif: [[660, 0, 0.1], [990, 0.1, 0.16]], send: [[520, 0, 0.06], [780, 0.05, 0.09]],
      post: [[740, 0, 0.1], [988, 0.1, 0.12]], sos: [[880, 0, 0.16], [660, 0.18, 0.16], [880, 0.36, 0.22]] };
    const quietNow = () => { const h = new Date().getHours(); return prefOn("quiet") && (h >= 23 || h < 8); };
    const getCtx = () => { const A = window.AudioContext || window.webkitAudioContext; if (!A) return null; ctx = ctx || new A(); if (ctx.state === "suspended") ctx.resume(); return ctx; };
    // iPhone разрешает звук только после первого касания
    document.addEventListener("pointerdown", () => { try { getCtx(); } catch (e) {} }, { once: true, capture: true });
    let last = 0;
    function play(kind) {
      if (!prefOn("sound") || quietNow() || document.hidden) return;
      const now = Date.now(); if (kind !== "send" && now - last < 1200) return; last = now; // без дублей подряд
      try {
        const c = getCtx(); if (!c) return; const t0 = c.currentTime + 0.01;
        (SEQ[kind] || SEQ.notif).forEach(([f, dt, d]) => {
          const o = c.createOscillator(), g = c.createGain(); o.type = "sine"; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.16, t0 + dt + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + d);
          o.connect(g); g.connect(c.destination); o.start(t0 + dt); o.stop(t0 + dt + d + 0.03);
        });
        if (navigator.vibrate && (kind === "message" || kind === "sos")) navigator.vibrate(kind === "sos" ? [90, 60, 90] : 35);
      } catch (e) {}
    }
    return { play };
  })();
  let profTab = "posts", profCounts = null;
  async function renderProfile() {
    const b = $("profBody");
    if (!user) {
      b.innerHTML = `<div class="pf"><div class="big"><div>?</div></div><b>Вы не вошли</b><div class="since">Войдите, чтобы публиковать, комментировать и сохранять</div></div>
        <div class="prof-btns"><button id="pLogin">Войти</button><button id="pSignup">Регистрация</button></div>
        <button class="srow guest-set" id="pGuestSet"><span class="si">⚙</span><span class="st2"><b>Настройки</b><small>тема, язык, правила</small></span><span class="sr">›</span></button>
        ${api.mode === "local" ? '<button class="logout" style="color:var(--muted);border-color:var(--line)" id="pReset">Сбросить демо-данные</button>' : ""}`;
      $("pLogin").onclick = () => showAuth("login"); $("pSignup").onclick = () => showAuth("signup"); $("pGuestSet").onclick = () => go("sv-settings");
      if ($("pReset")) $("pReset").onclick = resetDemo;
      return;
    }
    const cnt = (k) => (profCounts ? profCounts[k] : "…");
    b.innerHTML = `<div class="ph">
        <div class="ph-top"><div class="ph-ava">${user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : esc(initial(user.name))}</div>
          <div class="ph-stats"><div><b id="pcPosts">${cnt("posts")}</b><span id="plPosts">публикации</span></div><div><b id="pcSaved">${cnt("saved")}</b><span>сохранено</span></div><div><b id="pcEvents">${cnt("events")}</b><span id="plEvents">события</span></div></div>
          <button class="ph-gear" id="pGear" aria-label="Настройки">⚙</button></div>
        <b class="ph-name" translate="no">${esc(user.name)}${vBadge(user)}</b>${user.verified ? '<div class="vlabel">✓ Email подтвержден</div>' : ""}
        ${user.district ? `<div class="ph-d">📍 ${esc(user.district)} район</div>` : ""}
        ${user.bio ? `<div class="ph-bio">${esc(user.bio)}</div>` : ""}
        ${user.instagram ? `<a class="insta" href="https://instagram.com/${esc(user.instagram)}" target="_blank" rel="noopener">📷 @${esc(user.instagram)}</a>` : ""}
        <div class="ph-btns"><button id="pEdit">Редактировать профиль</button><button id="pShare">Поделиться</button></div>
      </div>
      ${user.banned ? '<div class="warn-banner red ban-note">⛔ Ваш аккаунт ограничен модератором: публиковать и писать сообщения нельзя.<div class="wb-acts"><button id="pAppeal">Обжаловать</button></div></div>' : ""}
      ${api.mode === "local" ? '<div class="demo-strip">🧪 Демо-режим: аккаунт и публикации хранятся только на этом устройстве</div>' : ""}
      <div class="ptabs" id="pSeg"><button data-t="posts" class="${profTab === "posts" ? "on" : ""}">Посты</button><button data-t="media" class="${profTab === "media" ? "on" : ""}">Медиа</button><button data-t="saved" class="${profTab === "saved" ? "on" : ""}">🔒 Сохраненное</button></div>
      <div id="pList"><div class="spin"></div></div>`;
    $("pEdit").onclick = editProfile; $("pGear").onclick = () => go("sv-settings");
    if ($("pAppeal")) $("pAppeal").onclick = () => appealSheet("user", user.id);
    $("pShare").onclick = async () => { const url = location.origin + location.pathname + "#user=" + user.id; try { if (navigator.share) { await navigator.share({ title: "NEAR", text: user.name + " в NEAR", url }); return; } } catch (e) { if (e.name === "AbortError") return; } try { await navigator.clipboard.writeText(url); toast("🔗 Ссылка на профиль скопирована"); } catch (e) { toast(url); } };
    qa("#pSeg [data-t]").forEach((x) => (x.onclick = () => { profTab = x.dataset.t; qa("#pSeg button").forEach((y) => y.classList.toggle("on", y === x)); loadProfList(); }));
    $("pList").onclick = (e) => { const g = e.target.closest("[data-gpost]"); if (g) return openPost(g.dataset.gpost); postClick(e); };
    const lbls = () => { if (!profCounts) return; if ($("plPosts")) $("plPosts").textContent = plural(+profCounts.posts, "публикация", "публикации", "публикаций"); if ($("plEvents")) $("plEvents").textContent = plural(+profCounts.events, "событие", "события", "событий"); };
    api.stats().then((s) => { profCounts = s; ["posts", "saved", "events"].forEach((k) => { const el = $("pc" + k[0].toUpperCase() + k.slice(1)); if (el) el.textContent = s[k]; }); lbls(); }).catch(() => {});
    loadProfList();
  }
  async function loadProfList() {
    const box = $("pList"); if (!box) return; box.innerHTML = '<div class="spin"></div>';
    const tab = profTab;
    try {
      const list = remember(tab === "saved" ? await api.savedPosts() : await api.myPosts());
      if (tab !== profTab) return;
      if (tab === "media") {
        const withM = list.filter((p) => p.media.length);
        box.innerHTML = withM.length ? `<div class="mgrid">${withM.map((p) => { const m = p.media[0]; const src = m.thumb || m.poster || (m.type === "image" ? m.url : ""); return `<button class="mg" data-gpost="${p.id}" style="${src ? `background-image:url('${esc(src)}')` : "background:#000"}">${m.type === "video" ? `<span class="mg-v">▶${m.duration ? " " + fmtDur(m.duration) : ""}</span>` : ""}${p.media.length > 1 ? '<span class="mg-n">❐</span>' : ""}</button>`; }).join("")}</div>`
          : '<div class="empty"><b>Нет фото и видео</b>Публикации с медиа появятся здесь сеткой</div>';
        return;
      }
      box.innerHTML = list.length ? list.map(card).join("") : `<div class="empty">${tab === "posts" ? '<b>Вы еще ничего не публиковали</b>Расскажите соседям, что происходит рядом<br><button class="btn btn-main mt12" data-create="talk">+ Опубликовать</button>' : "<b>Сохраненного пока нет</b>Нажмите 🔖 на публикации, чтобы сохранить. Это видите только вы"}</div>`;
      wireMedia(box);
      if (profCounts) { profCounts[tab === "saved" ? "saved" : "posts"] = list.length; const el = $(tab === "saved" ? "pcSaved" : "pcPosts"); if (el) el.textContent = list.length; }
    } catch (e) { box.innerHTML = `<div class="empty"><b>Не удалось загрузить</b>${esc(e.message)}<br><button class="btn btn-main mt12" id="plRetry">Повторить</button></div>`; $("plRetry").onclick = loadProfList; }
  }
  function editProfile() {
    let avatarFile = null;
    openSheet("Редактировать профиль", `<div class="av-edit"><span class="ava" id="avPrev" style="background:#ff2e8822;color:#ff6aa8">${user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : esc(initial(user.name))}</span><button class="btn btn-ghost" id="avBtn" type="button">📷 Сменить фото</button><input type="file" id="avFile" accept="image/*" hidden></div>
      <div class="fld"><label for="peNick">Никнейм</label><div class="nick-in"><span>@</span><input id="peNick" value="${esc(user.nickname || "")}" maxlength="20" autocapitalize="off" spellcheck="false"></div><div class="hint" id="peNickHint">${user.account && user.account.nickname_next_change ? `Следующая смена — ${esc(dfmt(user.account.nickname_next_change, { day: "numeric", month: "long" }))}` : "Менять можно раз в 30 дней"}</div></div>
      <div class="fld"><label>О себе</label><textarea id="peBio" maxlength="160" placeholder="Пара слов о себе: чем занимаетесь, что любите в районе" style="min-height:64px">${esc(user.bio || "")}</textarea><div class="hint" id="peBioN">${(user.bio || "").length}/160</div></div>
      <div class="fld"><label>Район</label><select id="peDist"><option value="">Не показывать</option>${DISTRICTS.map((d) => `<option ${user.district === d[0] ? "selected" : ""}>${d[0]}</option>`).join("")}</select></div>
      <div class="fld"><label>Instagram</label><input id="peInsta" value="${esc(user.instagram || "")}" placeholder="ваш_ник (без @)" autocapitalize="off" autocomplete="off"></div>
      <div class="err" id="peErr"></div>
      <div class="sheet-btns"><button class="btn btn-ghost" id="peCancel">Отмена</button><button class="btn btn-main" id="peSave">Сохранить</button></div>`);
    $("peBio").oninput = () => ($("peBioN").textContent = $("peBio").value.length + "/160");
    nickLive($("peNick"), $("peNickHint"));
    $("avBtn").onclick = () => $("avFile").click();
    $("avFile").onchange = (e) => { const f = e.target.files[0]; if (!f) return; try { N.validateFile(f); avatarFile = f; $("avPrev").innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`; } catch (err) { toast(err.message); } };
    $("peCancel").onclick = closeSheet;
    $("peSave").onclick = async () => {
      try {
        user = await busy($("peSave"), async () => {
          const nick = $("peNick").value.trim();
          // никнейм — отдельным запросом: проверки, занятость, раз в 30 дней
          if (nick !== (user.nickname || "")) await api.setNickname(nick);
          return api.updateProfile({ district: $("peDist").value || null, avatarFile, instagram: $("peInsta").value, bio: $("peBio").value });
        });
        closeSheet(); toast("✓ Профиль обновлен"); renderProfile(); if (cur() === "sv-settings") renderSettings();
      }
      catch (e) { $("peErr").textContent = e.message; $("peErr").classList.add("on"); }
    };
  }
  /* ---------- экран настроек ---------- */
  // тема и язык — доступны и гостю
  const appearanceGrp = () => `<div class="sgrp"><div class="sg-t">Внешний вид</div>
        <div class="srow"><span class="si">🌓</span><span class="st2"><b>Тема</b></span><span class="rad-ch" id="sTheme">${[["system", "Системная"], ["light", "Светлая"], ["dark", "Темная"]].map(([k, n]) => `<button data-theme="${k}" class="${themeChoice() === k ? "on" : ""}">${n}</button>`).join("")}</span></div>
        <div class="srow"><span class="si">🌐</span><span class="st2"><b>Язык</b><small>${I18N.lang === "kz" ? "казахский перевод — бета, проверяется" : ""}</small></span><span class="rad-ch" id="sLang"><button data-lang="ru" class="${I18N.lang === "ru" ? "on" : ""}">Русский</button><button data-lang="kz" class="${I18N.lang === "kz" ? "on" : ""}">Қазақша</button></span></div></div>`;
  function bindAppearance() {
    qa("#sTheme [data-theme]").forEach((b) => (b.onclick = () => { try { localStorage.setItem(THEME_KEY, b.dataset.theme); } catch (e) {} themeAnim(); applyTheme(); qa("#sTheme button").forEach((x) => x.classList.toggle("on", x === b)); syncMapTheme(); }));
    qa("#sLang [data-lang]").forEach((b) => (b.onclick = () => { if (b.dataset.lang !== I18N.lang) I18N.setLang(b.dataset.lang); }));
  }
  function renderSettings() {
    if (!user) {
      $("setBody").innerHTML = appearanceGrp() + `<div class="sgrp"><div class="sg-t">О приложении</div>
        <button class="srow" id="sRules"><span class="si">📜</span><span class="st2"><b>Правила сообщества</b></span><span class="sr">›</span></button>
        <button class="srow" id="sPriv"><span class="si">🔏</span><span class="st2"><b>Политика конфиденциальности</b></span><span class="sr">›</span></button>
        <button class="srow" id="sOnb"><span class="si">▶️</span><span class="st2"><b>Как пользоваться NEAR</b><small>видео на 12 секунд</small></span><span class="sr">›</span></button>
        <button class="srow" id="sBug"><span class="si">🐞</span><span class="st2"><b>Сообщить об ошибке</b></span><span class="sr">›</span></button>
        <div class="s-ver">NEAR ${APP_VERSION}${api.mode === "local" ? " · демо-режим" : ""}</div></div>`;
      bindAppearance(); $("sBug").onclick = bugSheet; $("sRules").onclick = showRules; $("sPriv").onclick = showPrivacy; $("sOnb").onclick = () => maybeOnboard(true);
      return;
    }
    const row = (id, ico, t, sub, right = "›", cls = "") => `<button class="srow ${cls}" id="${id}"><span class="si">${ico}</span><span class="st2"><b>${t}</b>${sub ? `<small>${sub}</small>` : ""}</span><span class="sr">${right}</span></button>`;
    const tg = (k, on) => `<span class="tg${on ? " on" : ""}" data-tg="${k}"></span>`;
    const notif = PREF_LIST.map(([k, n, d]) => `<div class="srow"><span class="st2"><b>${n}</b></span>${tg(k, prefs[k] ?? d)}</div>`).join("");
    $("setBody").innerHTML = `
      <div class="sgrp"><div class="sg-t">Аккаунт</div>
        ${row("sEmail", "✉️", "Email", esc(user.email || "—") + (user.verified ? ' · <span class="ok-t">подтвержден</span>' : ' · <span class="warn-t">не подтвержден</span>'), "")}
        ${user.provider === "google" ? row("sGoogle", "🔐", "Вход через Google", "пароль не нужен", "") : row("sPass", "🔑", "Сменить пароль", "")}
        ${row("sRecover", "🛟", "Восстановление доступа", "отправить ссылку для сброса пароля на почту")}
        ${row("sOut", "🚪", "Выйти из аккаунта", "", "", "danger")}
        ${row("sDel", "🗑", "Удалить аккаунт", "навсегда, вместе с публикациями и перепиской", "›", "danger")}</div>
      <div class="sgrp"><div class="sg-t">Профиль</div>
        ${row("sEdit", "👤", "Фото, имя, описание", "")}
        ${row("sDist", "📍", "Район", user.district ? esc(user.district) : "не показывается")}
        ${row("sInsta", "📷", "Instagram", user.instagram ? "@" + esc(user.instagram) : "не указан")}
        ${row("sPlaces", "⭐", "Избранные места", "Дом, работа — видите только вы")}</div>
      <div class="sgrp"><div class="sg-t">Приватность</div>
        <div class="srow"><span class="si">🟢</span><span class="st2"><b>Показывать, когда я был(а) в сети</b><small>если выключить, вы тоже не будете видеть статус других</small></span>${tg("show_seen", user.show_seen !== false)}</div>
        <div class="srow"><span class="si">🎯</span><span class="st2"><b>Скрывать точное место в новых публикациях</b><small>метка смещается примерно на 200 м</small></span>${tg("fuzz_default", prefs.fuzz_default ?? true)}</div>
        ${row("sBlocked", "🚫", "Заблокированные", "")}
        ${row("sHidden", "🙈", "Скрытые публикации", hiddenPosts.size ? hiddenPosts.size + " скрыто · нажмите, чтобы вернуть все" : "нет скрытых", "")}</div>
        <div class="srow"><span class="si">📊</span><span class="st2"><b>Анонимная статистика</b><small>помогает улучшать NEAR: без email, текстов и точного места</small></span>${tg("stats", Obs.on())}</div>
      ${pushSection()}
      <div class="sgrp"><div class="sg-t">Уведомления в приложении</div>${notif}
        <div class="s-note">Звуки и сигналы — пока NEAR открыт. Уведомления на заблокированный телефон — в разделе выше.</div></div>
      ${appearanceGrp()}
      <div class="sgrp"><div class="sg-t">Безопасность</div>
        ${row("sAll", "📵", "Выйти на всех устройствах", "если потеряли телефон или вошли с чужого")}
        ${user.is_mod ? row("sMod", "🛡", "Модерация", "жалобы, публикации, апелляции", '<span class="mini-badge hidden" id="modBadge"></span> ›') : ""}</div>
      <div class="sgrp"><div class="sg-t">О приложении</div>
        ${row("sRules", "📜", "Правила сообщества", "")}
        ${row("sPriv", "🔏", "Политика конфиденциальности", "")}
        ${row("sOnb", "▶️", "Как пользоваться NEAR", "видео на 12 секунд")}
        ${row("sBug", "🐞", "Сообщить об ошибке", "опишите, что пошло не так — ответим в приложении")}
        ${CFG.SUPPORT_EMAIL ? row("sHelp", "💬", "Поддержка по email", esc(CFG.SUPPORT_EMAIL)) : ""}
        <div class="s-ver">NEAR ${APP_VERSION}${api.mode === "local" ? " · демо-режим" : ""}</div>
        ${api.mode === "local" ? row("sReset", "🧹", "Сбросить демо-данные", "", "", "danger") : ""}</div>`;
    const on = (id, f) => { const el = $(id); if (el) el.onclick = f; };
    on("sPass", changePassword); on("sOut", logout); on("sEdit", editProfile); on("sDist", editProfile); on("sInsta", editProfile);
    on("sRecover", () => {
      openSheet("Восстановление доступа", `<div class="dim" style="font-size:13px;margin-bottom:12px">Отправим ссылку для нового пароля на <b>${esc(user.email)}</b>.</div><div class="cap" id="recCap"></div><div class="err" id="recErr"></div><div class="sheet-btns"><button class="btn btn-ghost" id="recNo">Отмена</button><button class="btn btn-main" id="recYes">Отправить</button></div>`);
      if (Cap.on) Cap.mount($("recCap"));
      $("recNo").onclick = closeSheet;
      $("recYes").onclick = async () => { try { await busy($("recYes"), async () => api.resetPassword(user.email, await Cap.token($("recCap")))); closeSheet(); toast("📬 Письмо отправлено"); } catch (e) { $("recErr").textContent = e.message; $("recErr").classList.add("on"); Cap.reset($("recCap")); } };
    });
    on("sDel", deleteAccountFlow);
    on("sBug", bugSheet);
    on("sPlaces", async () => {
      openSheet("Избранные места", '<div class="spin"></div>');
      try {
        const list = await api.placesList();
        $("bsList").innerHTML = (list.length ? list.map((p) => `<button class="opt-row" data-pl="${p.id}">⭐ <span translate="no">${esc(p.name)}</span> · ${fmtDist(p.radius)}${p.notify ? " · 🔔" : ""}<span>›</span></button>`).join("")
          : '<div class="empty"><b>Пока пусто</b>Откройте "Где смотреть?" в ленте и сохраните место</div>') + '<div class="s-note">Места видите только вы. Push о происшествиях рядом — только если вы их включили для места.</div>';
        qa("[data-pl]", $("bsList")).forEach((b) => (b.onclick = () => placeSheet(list.find((x) => x.id === b.dataset.pl))));
      } catch (e) { $("bsList").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    });
    bindPushSection();
    on("sBlocked", blockedSheet); on("sRules", showRules); on("sPriv", showPrivacy); on("sOnb", () => maybeOnboard(true)); on("sReset", resetDemo);
    on("sHidden", () => { if (!hiddenPosts.size) return; hiddenPosts.clear(); saveHidden(); renderSettings(); feedDirty = true; toast("Скрытые публикации снова в ленте"); });
    on("sHelp", () => { if (CFG.SUPPORT_EMAIL) location.href = "mailto:" + CFG.SUPPORT_EMAIL + "?subject=" + encodeURIComponent("NEAR: вопрос"); else toast("Пока поддержка через модераторов: нажмите ⚑ на любой публикации"); });
    on("sAll", async () => { if (!(await confirmSheet("Выйти на всех устройствах?", "Сеансы на всех телефонах и компьютерах завершатся. Войти можно будет снова.", "Выйти везде", true))) return; try { const was = user.id; Conv.unsub(); await api.signOutAll(); user = null; Cache.wipe(was); cache.clear(); onUserChange(); hist = []; go("v-feed", false); toast("Вы вышли на всех устройствах"); } catch (e) { toast(e.message); } });
    on("sMod", () => go("sv-mod"));
    if (user.is_mod) api.openReportsCount().then((n) => { if ($("modBadge") && n) { $("modBadge").textContent = n; $("modBadge").classList.remove("hidden"); } }).catch(() => {});
    qa("[data-tg]", $("setBody")).forEach((t) => (t.onclick = async () => {
      const k = t.dataset.tg, val = !t.classList.contains("on"); t.classList.toggle("on", val);
      if (k === "show_seen") { try { user = await api.updateProfile({ show_seen: val }); toast(val ? "Статус \"в сети\" виден соседям" : "Статус \"в сети\" скрыт"); } catch (e) { t.classList.toggle("on", !val); toast(e.message); } return; }
      if (k === "stats") { try { localStorage.setItem("near_stats", val ? "1" : "0"); } catch (e) {} return; }
      prefs[k] = val; savePrefs();
      if (k === "sound" && val) Sound.play("notif");
    }));
    bindAppearance();
  }
  // поддержка: сообщение об ошибке уходит в приложение (без email и паролей)
  function bugSheet() {
    openSheet("Сообщить об ошибке", `<p class="muted" style="font-size:13px;margin-bottom:10px">Что вы делали и что пошло не так? Не пишите пароли и коды из SMS.</p>
      <div class="fld"><textarea id="bugTx" maxlength="1000" style="min-height:110px" placeholder="Например: не открывается карта после входа"></textarea></div>
      <div class="err" id="bugErr"></div><div class="sheet-btns"><button class="btn btn-ghost" id="bugNo">Отмена</button><button class="btn btn-main" id="bugYes">Отправить</button></div>`);
    $("bugNo").onclick = closeSheet;
    $("bugYes").onclick = async () => {
      const t = $("bugTx").value.trim(); if (t.length < 3) { $("bugErr").textContent = "Опишите проблему подробнее"; $("bugErr").classList.add("on"); return; }
      try { await busy($("bugYes"), () => api.sendFeedback(t, APP_VERSION)); closeSheet(); toast("Спасибо! Сообщение отправлено"); } catch (e) { $("bugErr").textContent = e.message; $("bugErr").classList.add("on"); }
    };
  }
  function showPrivacy() {
    openSheet("Политика конфиденциальности", `<div class="rules" style="font-size:13px;line-height:1.5">
      <p><b>Что мы храним:</b> email, никнейм, район (если указан), фото профиля, ваши публикации, комментарии, сообщения и место публикаций. Имя, фамилию и пол NEAR не собирает. Email и телефон видите только вы.</p>
      <p><b>Возраст:</b> по умолчанию неизвестен. Документы NEAR не хранит. Пока возраст не проверен, недоступны личные сообщения незнакомым и офлайн-встречи.</p>
      <p><b>Местоположение:</b> используется, чтобы показать, что рядом. Точное место можно скрыть — метка сместится примерно на 200 м.</p>
      <p><b>Кто что видит:</b> публикации и профиль видят пользователи NEAR. Сохраненное, настройки и заблокированные видите только вы. Файлы из переписки доступны только ее участникам по временной ссылке.</p>
      <p><b>Модерация:</b> модераторы видят жалобы и отмеченные ИИ материалы, но не читают все переписки.</p>
      <p><b>Удаление:</b> публикации и комментарии можно удалить в любой момент. Аккаунт целиком — в Настройках → Аккаунт → "Удалить аккаунт": данные и файлы стираются безвозвратно.</p></div>
      <button class="btn btn-main full" id="privOk">Понятно</button>`);
    $("privOk").onclick = closeSheet;
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
    try { const s = await Push.sub(); if (s) await api.pushRemove(s.endpoint); } catch (e) {}
    const was = user && user.id;
    Conv.unsub(); await api.signOut(); user = null; Cache.wipe(was); cache.clear(); wide = null;
    onUserChange(); hist = []; go("v-feed", false); toast("Вы вышли из аккаунта. Можно смотреть ленту как гость");
  }
  async function resetDemo() {
    if (!(await confirmSheet("Сбросить демо-данные?", "Удалятся все аккаунты и публикации, созданные на этом устройстве, и вернутся примеры.", "Сбросить", true))) return;
    api.resetDemo(); user = null; wide = null; cache.clear(); onUserChange(); toast("Демо-данные сброшены");
  }


  /* =====================================================
     ПРАВИЛА, ЖАЛОБЫ, БЛОКИРОВКИ
     ===================================================== */
  function showRules() {
    openSheet("Правила сообщества NEAR", `<ol class="rules">
      <li>Уважайте соседей: без оскорблений, угроз, травли и дискриминации.</li>
      <li>Публикуйте правду. Ложные ДТП, SOS и фейки удаляются, автор блокируется.</li>
      <li>Без спама, мошенничества и навязчивой рекламы.</li>
      <li>Без откровенных, жестоких и шокирующих фото и видео.</li>
      <li>Не публикуйте чужие личные данные: адреса, номера, документы, лица детей.</li>
      <li>NEAR — не сервис знакомств: без романтических и интимных объявлений.</li>
      <li>Не переводите деньги незнакомым пользователям. NEAR не просит SMS-коды.</li>
      <li>При угрозе жизни сначала звоните 112.</li>
      <li>Мат скрывается автоматически: остается первая буква, остальное — звездочки. Угрозы не публикуются. Фото и сообщения проверяются автоматически.</li>
      <li>Лимиты на день: новый аккаунт — 3 публикации, 20 комментариев, 3 новых запроса в чат.</li>
      <li>Нарушения: жалоба ⚑ → проверка модератором → скрытие контента или блокировка аккаунта.</li>
    </ol><button class="btn btn-main full" id="rulesOk">Понятно</button>`);
    $("rulesOk").onclick = () => { closeSheet(); const cb = document.querySelector('#f-signup [name=rules]'); if (cb && $("v-auth").classList.contains("on")) cb.checked = true; };
  }
  function reportSheet({ type, id, user_id, label }) {
    if (!requireAuth("Войдите, чтобы отправить жалобу")) return;
    const R2 = N.REASONS; let reason = null;
    openSheet("Пожаловаться на " + label, `<div class="reason-list">${Object.entries(R2).map(([k, v]) => `<button class="opt-row" data-reason="${k}">${v}<span></span></button>`).join("")}</div>
      <div class="fld mt8"><textarea id="repDet" maxlength="500" placeholder="Подробности (необязательно)" style="min-height:70px"></textarea></div>
      ${user_id && user && user_id !== user.id ? `<label class="rules-check" style="margin:0 0 12px"><input type="checkbox" id="repBlock"> <span>Также заблокировать этого пользователя</span></label>` : ""}
      <div class="err" id="repErr"></div>
      <div class="sheet-btns"><button class="btn btn-ghost" id="repNo">Отмена</button><button class="btn btn-main" id="repYes">Отправить</button></div>`);
    qa("[data-reason]", $("bsList")).forEach((b) => (b.onclick = () => { reason = b.dataset.reason; qa("[data-reason]", $("bsList")).forEach((x) => { x.classList.toggle("on", x === b); x.querySelector("span").textContent = x === b ? "✓" : ""; }); }));
    $("repNo").onclick = closeSheet;
    $("repYes").onclick = async () => {
      if (!reason) { $("repErr").textContent = "Выберите причину"; $("repErr").classList.add("on"); return; }
      try {
        await busy($("repYes"), () => api.report({ type, id, user_id, reason, details: $("repDet").value }));
        const alsoBlock = $("repBlock") && $("repBlock").checked;
        if (alsoBlock) await api.block(user_id);
        closeSheet(); toast("🛡 Спасибо! Модератор проверит жалобу" + (alsoBlock ? ", пользователь заблокирован" : ""));
        if (alsoBlock) { wide = null; feedDirty = true; loadFeed(); }
      } catch (e) { $("repErr").textContent = e.message; $("repErr").classList.add("on"); }
    };
  }
  async function blockUser(id, name, after) {
    if (!requireAuth("Войдите, чтобы блокировать")) return;
    if (!(await confirmSheet("Заблокировать " + name + "?", "Вы не будете видеть публикации и комментарии этого человека, он не сможет писать вам. Дружба будет удалена. Разблокировать можно в профиле.", "Заблокировать", true))) return;
    try { await api.block(id); toast("🚫 " + name + " заблокирован(а)"); wide = null; feedDirty = true; loadFeed(); if (mapReady) loadMapPosts(); refreshChatBadge(); if (after) after(); }
    catch (e) { toast(e.message); }
  }
  async function blockedSheet() {
    openSheet("Заблокированные", '<div class="spin"></div>');
    try {
      const list = await api.blockedList();
      $("bsList").innerHTML = list.length ? list.map((u) => `<div class="u-row">${ava(u)}<div class="tx"><b>${esc(u.name)}</b><span>${esc(u.district || "")}</span></div><button class="pill-btn ghost" data-unblock="${u.id}">Разблокировать</button></div>`).join("") : '<div class="empty"><b>Список пуст</b>Вы никого не блокировали</div>';
      qa("[data-unblock]", $("bsList")).forEach((b) => (b.onclick = async () => { try { await api.unblock(b.dataset.unblock); b.closest(".u-row").remove(); toast("Пользователь разблокирован"); wide = null; feedDirty = true; } catch (e) { toast(e.message); } }));
    } catch (e) { $("bsList").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  /* =====================================================
     ПРОФИЛЬ ДРУГОГО ПОЛЬЗОВАТЕЛЯ
     ===================================================== */
  let openUserId = null;
  async function openUser(id) {
    if (!id) return;
    if (user && id === user.id) { hist = []; go("v-prof", false); return; }
    openUserId = id; go("sv-user"); $("uBody").innerHTML = '<div class="spin"></div>'; $("uSub").textContent = "";
    try { const u = await api.getProfile(id); if (openUserId === id) renderUser(u); }
    catch (e) { $("uBody").innerHTML = `<div class="empty"><b>Не открылось</b>${esc(e.message)}</div>`; }
  }
  function renderUser(u) {
    const fs = u.friendship;
    const fBtn = u.blocked ? "" : fs === "friends" ? `<button class="btn btn-ghost" id="uFriend">✓ В друзьях</button>`
      : fs === "requested" ? `<button class="btn btn-ghost" id="uFriend">⏳ Заявка отправлена</button>`
      : fs === "incoming" ? `<button class="btn btn-main" id="uFriend">✓ Принять заявку</button>`
      : `<button class="btn btn-main" id="uFriend">➕ Добавить в друзья</button>`;
    $("uSub").textContent = fs === "friends" ? "ваш друг" : "";
    $("uBody").innerHTML = `<div class="up"><span class="ava-w big">${ava(u)}${isOnline(u) ? '<i class="on-dot"></i>' : ""}</span><b translate="no">${esc(u.name)}${vBadge(u)}</b>${u.verified ? '<div class="vlabel">✓ Email подтвержден</div>' : ""}${seenText(u) ? `<div class="seen${isOnline(u) ? " on" : ""}">${seenText(u)}</div>` : ""}${u.bio ? `<div class="ph-bio">${esc(u.bio)}</div>` : ""}<div class="d">${u.district ? "📍 " + esc(u.district) + " район · " : ""}в NEAR с ${dfmt(u.created_at || Date.now(), { day: "numeric", month: "long", year: "numeric" })}</div>
      ${u.instagram ? `<a class="insta" href="https://instagram.com/${esc(u.instagram)}" target="_blank" rel="noopener">📷 @${esc(u.instagram)}</a>` : ""}</div>
      <div class="up-stats"><div><b>${u.posts}</b><br><span>публикаций</span></div><div><b>${u.friends}</b><br><span>друзей</span></div></div>
      ${u.blocked ? `<div class="warn-banner red" style="margin:0 0 12px">🚫 Вы заблокировали этого пользователя<div class="wb-acts"><button id="uUnblock">Разблокировать</button></div></div>` : `<div class="up-acts">${fBtn}<button class="btn btn-ghost" id="uMsg">💬 Написать</button><button class="iconbtn" id="uMore">⋯</button></div>`}
      ${fs === "incoming" && !u.blocked ? `<button class="more" id="uDecline">Отклонить заявку</button>` : ""}
      ${user && user.is_admin && user.id !== u.id ? `<button class="more" id="uBan" style="color:${u.banned ? "var(--muted)" : "#ff6b7d"}">${u.banned ? "✓ Снять бан" : "⛔ Забанить (администратор)"}</button>` : ""}
      <div class="lbl">Публикации</div><div id="uPosts"><div class="spin"></div></div>`;
    const reload = () => openUser(u.id);
    if ($("uBan")) $("uBan").onclick = async () => { if (!(await confirmSheet("Модерация", u.banned ? "Снять бан?" : "Забанить пользователя? Он не сможет публиковать и писать.", "Да", !u.banned))) return; try { await api.modAction("user", u.id, u.banned ? "unban" : "ban"); toast("✓ Готово"); reload(); } catch (er) { toast(er.message); } };
    if ($("uUnblock")) $("uUnblock").onclick = async () => { try { await api.unblock(u.id); toast("Разблокирован(а)"); wide = null; feedDirty = true; reload(); } catch (e) { toast(e.message); } };
    if ($("uFriend")) $("uFriend").onclick = async () => {
      if (!requireAuth("Войдите, чтобы добавлять друзей")) return;
      try {
        if (fs === "none") { await api.sendFriendRequest(u.id); toast("👋 Заявка отправлена"); }
        else if (fs === "incoming") { await api.acceptFriend(u.id); toast("🤝 Теперь вы друзья"); }
        else if (fs === "requested") { if (!(await confirmSheet("Отменить заявку?", "Заявка в друзья будет удалена.", "Отменить заявку"))) return; await api.removeFriend(u.id); toast("Заявка отменена"); }
        else if (fs === "friends") { if (!(await confirmSheet("Удалить из друзей?", u.name + " исчезнет из списка друзей. Переписка сохранится.", "Удалить", true))) return; await api.removeFriend(u.id); toast("Удален(а) из друзей"); }
        reload(); refreshChatBadge();
      } catch (e) { toast(e.message); }
    };
    if ($("uDecline")) $("uDecline").onclick = async () => { try { await api.removeFriend(u.id); toast("Заявка отклонена"); reload(); refreshChatBadge(); } catch (e) { toast(e.message); } };
    if ($("uMsg")) $("uMsg").onclick = () => startChat(u.id);
    if ($("uMore")) $("uMore").onclick = () => {
      openSheet(u.name, `<button class="opt-row" id="umRep">⚑ Пожаловаться на пользователя<span>›</span></button><button class="opt-row" id="umBlock" style="color:#ff8a95">🚫 Заблокировать<span></span></button>`);
      $("umRep").onclick = () => reportSheet({ type: "user", id: u.id, user_id: u.id, label: "пользователя" });
      $("umBlock").onclick = () => blockUser(u.id, u.name, reload);
    };
    api.userPosts(u.id).then((list) => { remember(list); if ($("uPosts")) $("uPosts").innerHTML = list.length ? list.map(rowPost).join("") : '<div class="empty">Публикаций пока нет</div>'; }).catch(() => {});
  }
  $("uBody").addEventListener("click", (e) => { const b = e.target.closest("[data-post]"); if (b && b.classList.contains("row-post")) openPost(b.dataset.post); });

/* ===== 80-chat.js ===== */
  /* =====================================================
     ЧАТЫ, ДРУЗЬЯ, ЗАЯВКИ
     ===================================================== */
  let chTab = "chats";
  qa("#chSeg [data-t]").forEach((b) => (b.onclick = () => { chTab = b.dataset.t; qa("#chSeg button").forEach((x) => x.classList.toggle("on", x === b)); renderChats(); }));
  function msgPreview(m) {
    if (!m) return "";
    const pre = user && m.sender_id === user.id ? "Вы: " : "";
    if (m.mod_status === "flagged") return pre + "⚠️ Скрытое сообщение";
    return pre + ({ image: "📷 Фото", video: "🎬 Видео", audio: "🎤 Голосовое" }[m.kind] || m.text || "");
  }
  const shortTime = (iso) => { const d = new Date(iso), n = new Date(); return d.toDateString() === n.toDateString() ? d.toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" }) : dfmt(d, { day: "numeric", month: "short" }); };
  const convRow = (c) => `<button class="u-row${c.unread ? " unread-row" : ""}" data-conv="${c.id}"><span class="ava-w">${ava(c.other)}${isOnline(c.other) ? '<i class="on-dot"></i>' : ""}</span><div class="tx"><b translate="no">${esc(c.other.name)}${vBadge(c.other)}</b>${c.status === "request" && !c.request ? '<span class="tag-mini">запрос отправлен</span>' : c.status === "declined" ? '<span class="tag-mini red">ограничено</span>' : c.friend ? "" : '<span class="tag-mini">не в друзьях</span>'}<span translate="no">${esc(msgPreview(c.last))}</span></div><div class="meta"><small>${shortTime(c.last.created_at)}</small>${c.unread ? `<span class="unread">${c.unread}</span>` : ""}</div></button>`;
  async function renderChats() {
    const box = $("chBody");
    if (!user) { box.innerHTML = `<div class="empty"><b>Сообщения и друзья</b>Войдите, чтобы переписываться с соседями<br><button class="btn btn-main mt12" id="chLogin">Войти</button></div>`; $("chLogin").onclick = () => showAuth("login"); return; }
    if (!box.children.length || box.querySelector(".empty")) box.innerHTML = '<div class="spin"></div>';
    try {
      const [rq, convs] = await Promise.all([api.friendRequests(), chTab === "friends" ? Promise.resolve([]) : api.conversations()]);
      const msgReq = convs.filter((c) => c.request && c.status === "request");
      const nReq = rq.incoming.length + msgReq.length;
      $("reqBadge").textContent = nReq; $("reqBadge").classList.toggle("hidden", !nReq);
      if (chTab === "chats") {
        const list = convs.filter((c) => !c.request);
        box.innerHTML = (msgReq.length ? `<button class="req-strip" data-tab="requests">✉️ ${msgReq.length} ${plural(msgReq.length, "запрос", "запроса", "запросов")} на переписку от незнакомых людей ›</button>` : "")
          + (list.length ? list.map(convRow).join("") : `<div class="empty"><b>Пока нет переписок</b>Откройте профиль соседа и нажмите "Написать"<br><button class="btn btn-main mt12" data-open="sv-find">Найти людей</button></div>`);
      } else if (chTab === "friends") {
        const list = await api.friends();
        box.innerHTML = list.length ? list.map((u) => `<div class="u-row" data-user="${u.id}"><span class="ava-w">${ava(u)}${isOnline(u) ? '<i class="on-dot"></i>' : ""}</span><div class="tx"><b translate="no">${esc(u.name)}${vBadge(u)}</b><span>${isOnline(u) ? '<em class="ok-t">в сети</em> · ' : ""}${u.district ? esc(u.district) + " район" : ""}${u.instagram ? " · @" + esc(u.instagram) : ""}</span></div><button class="pill-btn" data-chat="${u.id}" aria-label="Написать">💬</button></div>`).join("")
          : `<div class="empty"><b>Друзей пока нет</b>Найдите соседей по имени или добавьте автора публикации из его профиля</div>`;
      } else {
        // CHAT-01: запросы на переписку от незнакомых + заявки в друзья
        box.innerHTML = (msgReq.length ? '<div class="lbl">Запросы на переписку</div><div class="s-note" style="margin:0 0 8px">Пока вы не приняли запрос, собеседник не может отправить больше одного сообщения, фото и ссылки.</div>' + msgReq.map(convRow).join("") : "")
          + (rq.incoming.length ? '<div class="lbl mt12">Заявки в друзья</div>' + rq.incoming.map((u) => `<div class="u-row" data-user="${u.id}">${ava(u)}<div class="tx"><b translate="no">${esc(u.name)}</b><span>хочет добавить вас в друзья</span></div><button class="pill-btn" data-accept="${u.id}">Принять</button><button class="pill-btn ghost" data-decline="${u.id}" aria-label="Отклонить">✕</button></div>`).join("") : "")
          + (rq.outgoing.length ? '<div class="lbl mt12">Отправленные заявки</div>' + rq.outgoing.map((u) => `<div class="u-row" data-user="${u.id}">${ava(u)}<div class="tx"><b translate="no">${esc(u.name)}</b><span>ждем ответа</span></div><button class="pill-btn ghost" data-decline="${u.id}">Отменить</button></div>`).join("") : "")
          || '<div class="empty"><b>Запросов нет</b>Здесь появятся запросы на переписку и заявки в друзья</div>';
      }
    } catch (e) { box.innerHTML = `<div class="empty"><b>Ошибка</b>${esc(e.message)}<br><button class="btn btn-main mt12" id="chRetry">Повторить</button></div>`; $("chRetry").onclick = renderChats; }
  }
  $("chBody").onclick = async (e) => {
    let b;
    if ((b = e.target.closest("[data-tab]"))) { const t = document.querySelector(`#chSeg [data-t="${b.dataset.tab}"]`); if (t) t.click(); return; }
    if ((b = e.target.closest("[data-accept]"))) { try { await api.acceptFriend(b.dataset.accept); toast("🤝 Теперь вы друзья"); renderChats(); refreshChatBadge(); } catch (er) { toast(er.message); } return; }
    if ((b = e.target.closest("[data-decline]"))) { try { await api.removeFriend(b.dataset.decline); toast("Заявка удалена"); renderChats(); refreshChatBadge(); } catch (er) { toast(er.message); } return; }
    if ((b = e.target.closest("[data-chat]"))) return startChat(b.dataset.chat);
    if ((b = e.target.closest("[data-conv]"))) return openConv(b.dataset.conv);
    if ((b = e.target.closest("[data-user]"))) return openUser(b.dataset.user);
  };
  // notify — прозвучать и показать подсказку, если непрочитанных стало больше
  let chatSeen = -1;
  async function refreshChatBadge(notify) {
    if (!api || !user) { $("chatBadge").classList.add("hidden"); return; }
    try {
      const [m, rq] = await Promise.all([api.unreadMessages(), api.friendRequests()]);
      const n = m + rq.incoming.length;
      $("chatBadge").textContent = n > 9 ? "9+" : n; $("chatBadge").classList.toggle("hidden", !n);
      if (notify && chatSeen >= 0 && m > chatSeen && cur() !== "sv-conv") { if (prefOn("n_msg")) Sound.play("message"); toast("💬 Новое сообщение"); }
      chatSeen = m;
    } catch (e) {}
  }

  /* поиск людей */
  let fT = null;
  $("fq").oninput = () => { clearTimeout(fT); fT = setTimeout(async () => {
    const q = $("fq").value.trim();
    if (q.length < 2) { $("fRes").innerHTML = '<div class="dim center" style="font-size:12px;padding:20px">Введите минимум 2 буквы</div>'; return; }
    $("fRes").innerHTML = '<div class="spin"></div>';
    try { const list = await api.searchUsers(q); $("fRes").innerHTML = list.length ? list.map((u) => `<button class="u-row" data-user="${u.id}">${ava(u)}<div class="tx"><b>${esc(u.name)}</b><span>${u.district ? esc(u.district) + " район" : "Алматы"}${u.instagram ? " · @" + esc(u.instagram) : ""}</span></div><span class="pill-btn ghost">Профиль</span></button>`).join("") : '<div class="empty"><b>Никого не нашли</b>Проверьте написание имени</div>'; }
    catch (e) { $("fRes").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }, 300); };
  $("fRes").onclick = (e) => { const b = e.target.closest("[data-user]"); if (b) openUser(b.dataset.user); };

  /* =====================================================
     ПЕРЕПИСКА: текст, фото, видео, голосовые
     ===================================================== */
  let convId = null, convInfo = null;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));
  async function startChat(otherId) {
    if (!requireAuth("Войдите, чтобы писать сообщения", { t: "chat", a: otherId })) return;
    try { const cid = await api.openConversation(otherId); openConv(cid); } catch (e) { if (!gateError(e)) toast(e.message); }
  }
  /* CHAT-02: одна переписка — свой канал Realtime; сообщения хранятся по id (без дублей);
     опрос сервера — только когда канал оборвался, с растущим интервалом */
  const Conv = {
    msgs: new Map(), off: null, state: "idle", pollT: null, delay: 5000,
    reset() { this.unsub(); this.msgs = new Map(); },
    sub() {
      this.unsub(); if (!convId || !api.subscribeConversation) return;
      const cid = convId;
      try { this.off = api.subscribeConversation(cid, (t, row) => { if (cid === convId) this.onRow(t, row); }, (st) => this.onState(st)); }
      catch (e) { this.onState("CHANNEL_ERROR"); }
      if (api.mode === "local") this.state = "SUBSCRIBED";
    },
    unsub() { if (this.off) { try { this.off(); } catch (e) {} } this.off = null; clearTimeout(this.pollT); this.state = "idle"; },
    onState(st) {
      const was = this.state; this.state = st;
      if (st === "SUBSCRIBED") { clearTimeout(this.pollT); this.delay = 5000; if (was !== "idle") this.catchUp(); }
      else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(st)) this.poll();
    },
    poll() {
      clearTimeout(this.pollT);
      this.pollT = setTimeout(async () => { if (convId && !document.hidden) await this.catchUp(); this.delay = Math.min(this.delay * 2, 60000); if (convId && this.state !== "SUBSCRIBED") this.poll(); }, this.delay);
    },
    last() { let t = null; this.msgs.forEach((m) => { if (!m._state && (!t || m.created_at > t)) t = m.created_at; }); return t; },
    async catchUp() {
      const cid = convId; if (!cid) return;
      try { const list = await api.messages(cid, this.last()); if (cid !== convId) return; list.forEach((m) => this.put(m)); render(); } catch (e) {}
    },
    put(m) { const old = this.msgs.get(m.id); if (old && old._state === "pending" && !m._state) delete old._state; this.msgs.set(m.id, old ? Object.assign(old, m, { _state: m._state }) : m); },
    async onRow(t, row) {
      if (!row) return;
      if (t === "delete") { this.msgs.delete(row.id); render(); return; }
      if (row.media_path && api.signChat) { try { await api.signChat([row]); } catch (e) {} }
      const isNew = !this.msgs.has(row.id);
      this.put({ ...row, _state: undefined }); render(isNew);
      if (t === "insert" && user && row.sender_id !== user.id) {
        if (prefOn("n_msg")) Sound.play("message");
        if (!document.hidden) api.markRead(convId).then(() => refreshChatBadge()).catch(() => {});
        if (convInfo && convInfo.status === "request" && convInfo.initiator === user.id) { convInfo.status = "accepted"; convHead(); }
      }
    },
    statusChanged(row) { if (!convInfo || !row || !row.status || row.status === convInfo.status) return; convInfo.status = row.status; convHead(); }
  };
  // шапка, предупреждения и поле ввода — по состоянию переписки (запрос, принята, отклонена, блокировка)
  function convHead() {
    if (!convInfo) return;
    const o = convInfo.other, me = user && user.id, st = convInfo.status || "accepted", mine = convInfo.initiator === me;
    $("convWho").innerHTML = `<span class="ava-w">${ava(o)}${isOnline(o) ? '<i class="on-dot"></i>' : ""}</span><div style="min-width:0"><b translate="no">${esc(o.name)}${vBadge(o)}</b><span class="${isOnline(o) ? "ok-t" : ""}">${o.deleted ? "аккаунт удален" : seenText(o) || (convInfo.friend ? "друг" : "не в друзьях")}</span></div>`;
    const w = $("convWarn"); w.className = "warn-banner"; w.classList.remove("hidden");
    let canWrite = true, canFiles = true;
    if (o.deleted) {
      const left = convInfo.orphaned_at ? Math.max(0, 30 - Math.floor((Date.now() - new Date(convInfo.orphaned_at)) / 86400e3)) : 30;
      w.classList.add("red"); w.innerHTML = `Собеседник удалил аккаунт. Переписка доступна только для чтения и будет удалена через ${left} ${plural(left, "день", "дня", "дней")}.`; canWrite = false;
    }
    else if (convInfo.blocked) { w.classList.add("red"); w.innerHTML = "🚫 Переписка недоступна: пользователь заблокирован."; canWrite = false; }
    else if (st === "request" && !mine) {
      w.innerHTML = `<b>Запрос на переписку</b> ${esc(o.name)} нет у вас в друзьях. Не переходите по ссылкам и не сообщайте коды из SMS, данные карт и адрес.
        <div class="wb-acts"><button class="ok" id="cwAccept">✓ Принять</button><button id="cwDecline">Отклонить</button><button id="cwBlock">🚫 Заблокировать</button><button id="cwRep">⚑ Пожаловаться</button></div>`;
      canFiles = false;
    } else if (st === "request" && mine) {
      const sent = [...Conv.msgs.values()].some((m) => m.sender_id === me && m._state !== "failed");
      w.innerHTML = sent ? `<b>Запрос отправлен.</b> Дождитесь, пока ${esc(o.name)} примет его, — тогда можно будет продолжить переписку.`
        : `<b>Это первое сообщение незнакомому человеку.</b> До принятия запроса можно отправить одно сообщение без фото и ссылок.`;
      canWrite = !sent; canFiles = false;
    } else if (st === "declined") {
      w.classList.add("red");
      w.innerHTML = mine ? "Собеседник ограничил переписку. Отправлять сообщения нельзя." : `Вы отклонили запрос.<div class="wb-acts"><button class="ok" id="cwAccept">Все-таки принять</button></div>`;
      canWrite = false;
    } else if (!convInfo.friend) {
      w.innerHTML = `⚠️ ${esc(o.name)} нет у вас в друзьях. Не переходите по ссылкам, не сообщайте коды из SMS, данные карт и адрес.<div class="wb-acts"><button id="cwRep">⚑ Пожаловаться</button><button id="cwBlock">🚫 Заблокировать</button></div>`;
    } else w.classList.add("hidden");
    $("composer").classList.toggle("hidden", !canWrite);
    $("attachBtn").classList.toggle("hidden", !canFiles); $("micBtn").classList.toggle("hidden", !canFiles || !!$("msgIn").value.trim());
    $("composer").dataset.files = canFiles ? "1" : "";
    const on = (id, f) => { const el = $(id); if (el) el.onclick = f; };
    on("cwRep", () => reportSheet({ type: "user", id: o.id, user_id: o.id, label: "пользователя" }));
    on("cwBlock", () => blockUser(o.id, o.name, () => openConv(convId)));
    on("cwAccept", async () => { try { convInfo.status = await api.conversationRespond(convId, true); convHead(); refreshChatBadge(); toast("Запрос принят"); Obs.track("chat_request_accepted"); } catch (e) { toast(e.message); } });
    on("cwDecline", async () => {
      if (!(await confirmSheet("Отклонить запрос?", `${o.name} больше не сможет писать вам в этой переписке. Вы сможете принять запрос позже.`, "Отклонить", true))) return;
      try { convInfo.status = await api.conversationRespond(convId, false); convHead(); refreshChatBadge(); toast("Запрос отклонен"); } catch (e) { toast(e.message); }
    });
  }
  async function openConv(cid) {
    go("sv-conv"); Conv.reset(); convId = cid; convInfo = null; lastSig = "";
    $("convMsgs").innerHTML = '<div class="spin"></div>'; $("convWarn").classList.add("hidden"); $("convWho").innerHTML = ""; $("convProg").textContent = "";
    try {
      convInfo = await api.conversationInfo(cid);
      if (convId !== cid) return;
      const list = await api.messages(cid);
      if (convId !== cid) return;
      list.forEach((m) => Conv.put(m)); convHead(); render(true);
      Conv.sub();
    } catch (e) { $("convMsgs").innerHTML = `<div class="empty"><b>Не открылось</b>${esc(e.message)}</div>`; }
  }
  $("convWho").onclick = () => { if (convInfo && convInfo.other.id) openUser(convInfo.other.id); };
  $("convMenu").onclick = () => {
    if (!convInfo || !convInfo.other.id) return; const o = convInfo.other;
    openSheet(o.name, `<button class="opt-row" id="cmProf">👤 Профиль<span>›</span></button><button class="opt-row" id="cmRep">⚑ Пожаловаться<span>›</span></button><button class="opt-row" id="cmBlock" style="color:#ff8a95">🚫 Заблокировать<span></span></button>`);
    $("cmProf").onclick = () => { closeSheet(); openUser(o.id); };
    $("cmRep").onclick = () => reportSheet({ type: "user", id: o.id, user_id: o.id, label: "пользователя" });
    $("cmBlock").onclick = () => blockUser(o.id, o.name, () => openConv(convId));
  };
  let lastSig = "";
  function render(scroll) {
    const list = [...Conv.msgs.values()].sort((a, b) => (a.created_at === b.created_at ? (a.id > b.id ? 1 : -1) : a.created_at.localeCompare(b.created_at)));
    const sig = list.map((m) => m.id + (m._state || "") + m.mod_status + (m.read_at ? 1 : 0) + (m.media_url || "")).join("|");
    if (sig === lastSig && !scroll) return; lastSig = sig;
    const box = $("convMsgs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    let day = "";
    box.innerHTML = list.length ? list.map((m) => {
      const d = dfmt(m.created_at, { day: "numeric", month: "long" });
      const sep = d !== day ? `<div class="day-sep">${(day = d)}</div>` : "";
      return sep + bubble(m);
    }).join("") : `<div class="empty" style="margin-top:20px"><b>Начните разговор</b>${convInfo && convInfo.status === "request" ? "Первое сообщение — только текст, без ссылок" : "Напишите сообщение, отправьте фото или голосовое 🎤"}</div>`;
    if (scroll || atBottom) box.scrollTop = box.scrollHeight;
    if (list.some((m) => user && m.sender_id !== user.id && !m.read_at) && !document.hidden) { api.markRead(convId).then(() => refreshChatBadge()).catch(() => {}); }
    if (convInfo && convInfo.status === "request" && convInfo.initiator === (user && user.id)) convHead();
  }
  function bubble(m) {
    const mine = user && m.sender_id === user.id;
    const st = m._state === "pending" ? " 🕓" : m._state === "failed" ? "" : mine ? (m.read_at ? " ✓✓" : " ✓") : "";
    const tm = `<span class="tm">${new Date(m.created_at).toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" })}${st}${mine && m.mod_status === "pending" ? " ⏳" : ""}</span>`;
    const fail = m._state === "failed" ? `<div class="bub-fail"><span>⚠ Не отправлено${m._err ? ": " + esc(m._err) : ""}</span><button data-resend="${m.id}">Повторить</button><button data-drop="${m.id}">Удалить</button></div>` : "";
    const flagged = m.mod_status === "flagged", pendingForThem = m.mod_status === "pending" && !mine && m.kind === "image";
    const cls = `bub ${mine ? "me" : "them"}${m._state ? " " + m._state : ""}`;
    let body = "";
    if (m.kind === "text") {
      body = flagged && !mine ? `<div class="blur-wrap" data-reveal style="border-radius:10px"><div class="bg" style="padding:4px 2px">${esc(m.text)}</div><div class="shield" style="font-size:11px">⚠️ Возможно оскорбительное<button type="button">Показать</button></div></div>` : esc(m.text);
      return `<div class="${cls}" data-msg="${m.id}" translate="no">${body}${flagged && mine ? '<span class="tm">⚠️ скрыто для получателя</span>' : ""}${tm}${fail}</div>`;
    }
    if (m.media_locked || (m.kind !== "text" && !m.media_url)) return `<div class="${cls}" data-msg="${m.id}"><span class="dim">🔒 Файл недоступен</span>${tm}</div>`;
    if (m.kind === "image") {
      const img = `<img src="${esc(m.media_url)}" alt="" loading="lazy" data-zoom>`;
      body = (flagged || pendingForThem) && !mine ? `<div class="blur-wrap" data-reveal>${img}<div class="shield">${flagged ? "⚠️ Возможно неприемлемое фото" : "⏳ Фото проверяется"}<button type="button">Показать</button></div></div>` : img;
    }
    if (m.kind === "video") body = `<video src="${esc(m.media_url)}" controls playsinline preload="metadata"></video>`;
    if (m.kind === "audio") body = `<audio src="${esc(m.media_url)}" controls preload="metadata"></audio>`;
    return `<div class="${cls} media" data-msg="${m.id}">${body}${m.text ? `<div class="cap" translate="no">${esc(m.text)}</div>` : ""}${tm}</div>`;
  }
  $("convMsgs").addEventListener("click", (e) => {
    let b;
    if ((b = e.target.closest("[data-resend]"))) { const m = Conv.msgs.get(b.dataset.resend); if (m) sendText(m.text, m.id); return; }
    if ((b = e.target.closest("[data-drop]"))) { Conv.msgs.delete(b.dataset.drop); render(); if (convInfo) convHead(); return; }
    if ((b = e.target.closest("[data-reveal]"))) { if (e.target.tagName === "BUTTON") { b.classList.remove("blur-wrap"); const s2 = b.querySelector(".shield"); if (s2) s2.remove(); } return; }
    if ((b = e.target.closest("[data-zoom]"))) return openViewer(b.src);
    if ((b = e.target.closest("[data-msg]")) && !e.target.closest("audio,video")) { const m = Conv.msgs.get(b.dataset.msg); if (m && !m._state) msgMenu(m.id, b.classList.contains("me")); }
  });
  function msgMenu(id, mine) {
    const m = Conv.msgs.get(id), txt = (m && m.text) || "";
    openSheet("Сообщение", `${txt ? '<button class="opt-row" id="mmCopy">📋 Копировать текст<span></span></button>' : ""}${mine ? `<button class="opt-row" id="mmDel" style="color:#ff8a95">🗑 Удалить у всех<span></span></button>` : `<button class="opt-row" id="mmRep">⚑ Пожаловаться на сообщение<span>›</span></button>`}`);
    if ($("mmCopy")) $("mmCopy").onclick = async () => { try { await navigator.clipboard.writeText(txt); toast("Скопировано"); } catch (e) { toast("Не удалось скопировать"); } closeSheet(); };
    if ($("mmDel")) $("mmDel").onclick = async () => { closeSheet(); try { await api.deleteMessage(id); Conv.msgs.delete(id); render(); } catch (e) { toast(e.message); } };
    if ($("mmRep")) $("mmRep").onclick = () => reportSheet({ type: "message", id, user_id: convInfo && convInfo.other.id, label: "сообщение" });
  }
  $("msgIn").oninput = () => { const has = !!$("msgIn").value.trim(), files = $("composer").dataset.files === "1"; $("sendBtn").classList.toggle("hidden", !has); $("micBtn").classList.toggle("hidden", has || !files); };
  // текст отправляется сразу в ленту переписки: 🕓 отправляется → ✓ доставлено; при ошибке — "Повторить" (тот же id, без дубля)
  async function sendText(text, id) {
    const cid = convId; if (!cid || !user) return;
    id = id || uuid();
    Conv.put({ id, conversation_id: cid, sender_id: user.id, kind: "text", text, mod_status: "ok", read_at: null, created_at: (Conv.msgs.get(id) || {}).created_at || new Date().toISOString(), _state: "pending" });
    render(true);
    try {
      const row = await api.sendMessage(cid, { text, id });
      if (cid !== convId) return;
      Conv.put({ ...row, _state: undefined }); render(); Sound.play("send");
      Obs.track("message_sent"); usefulAction("message");
      // первый ответ на чужое сообщение в этой переписке — для метрики "время до первого ответа"
      const all = [...Conv.msgs.values()].filter((x) => x.conversation_id === cid);
      if (all.some((x) => x.sender_id !== user.id) && all.filter((x) => x.sender_id === user.id).length === 1) Obs.track("first_reply");
    } catch (e) {
      if (e.code === "23505") { Conv.catchUp(); return; } // уже дошло — повтор не нужен
      if (gateError(e)) { Conv.msgs.delete(id); render(); return; }
      const m = Conv.msgs.get(id); if (m) { m._state = "failed"; m._err = e.message; } render();
      if (/принят|ссылк|Дождитесь|отклонил|недоступен/i.test(e.message)) toast(e.message);
    }
  }
  async function sendPayload(payload) {
    const cid = convId; if (!cid) return;
    try {
      const row = await api.sendMessage(cid, payload, (m) => ($("convProg").textContent = m)); $("convProg").textContent = "";
      if (cid === convId && row) { Conv.put(row); render(true); }
      Sound.play("send"); Obs.track("message_sent"); usefulAction("message");
    } catch (e) { $("convProg").textContent = ""; toast(e.message); throw e; }
  }
  $("composer").onsubmit = async (e) => {
    e.preventDefault(); const v = $("msgIn").value.trim(); if (!v) return;
    if (N.hasBad(v)) toast("🤬 Грубые слова будут скрыты звездочками");
    $("msgIn").value = ""; $("msgIn").oninput();
    sendText(v);
    $("msgIn").focus();
  };
  $("attachBtn").onclick = () => $("chatFile").click();
  $("chatFile").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try { const k = N.validateChatFile(f); if (k === "audio") throw new Error("Выберите фото или видео"); await sendPayload({ file: f, kind: k }); } catch (er) { if (!er.raw) toast(er.message); }
  };
  /* голосовые сообщения */
  let rec = null, recChunks = [], recStart = 0, recTimer = null, recStream = null;
  function pickMime() {
    const c = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    if (!window.MediaRecorder) return null;
    for (const t of c) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) {} }
    return "";
  }
  $("micBtn").onclick = async () => {
    const mime = pickMime();
    if (mime === null || !navigator.mediaDevices) { toast("Запись голоса не поддерживается в этом браузере"); return; }
    try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast("Разрешите доступ к микрофону в настройках браузера"); return; }
    recChunks = []; rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) recChunks.push(ev.data); };
    rec.start(250); recStart = Date.now();
    $("composer").classList.add("hidden"); $("recBar").classList.remove("hidden"); $("recTime").textContent = "0:00";
    recTimer = setInterval(() => { const s2 = Math.floor((Date.now() - recStart) / 1000); $("recTime").textContent = Math.floor(s2 / 60) + ":" + String(s2 % 60).padStart(2, "0"); if (s2 >= 120) $("recSend").click(); }, 250);
  };
  function stopRec(cancel) {
    return new Promise((res) => {
      clearInterval(recTimer);
      if (!rec) { res(null); return; }
      const r = rec; rec = null;
      r.onstop = () => { if (recStream) recStream.getTracks().forEach((t) => t.stop()); recStream = null; $("recBar").classList.add("hidden"); $("composer").classList.toggle("hidden", !!(convInfo && convInfo.blocked));
        if (cancel) { res(null); return; }
        const type = (r.mimeType || "audio/webm").split(";")[0];
        res(new File(recChunks, "voice." + (type.includes("mp4") ? "m4a" : type.split("/")[1]), { type })); };
      try { r.stop(); } catch (e) { res(null); }
    });
  }
  $("recCancel").onclick = () => stopRec(true);
  $("recSend").onclick = async () => {
    const dur = (Date.now() - recStart) / 1000; const f = await stopRec(false);
    if (!f || dur < 0.8) { if (f) toast("Слишком короткое голосовое"); return; }
    try { await sendPayload({ file: f, kind: "audio", duration: dur }); } catch (e) {}
  };

/* ===== 85-moderation.js ===== */
  /* =====================================================
     ПАНЕЛЬ МОДЕРАТОРА
     ===================================================== */
  let modTab = "reports";
  $("modSeg").onclick = (e) => { const b = e.target.closest("[data-t]"); if (!b) return; modTab = b.dataset.t; qa("#modSeg button").forEach((x) => x.classList.toggle("on", x === b)); renderMod(); };
  const TT = { post: "📝 Публикация", comment: "💬 Комментарий", message: "✉️ Сообщение", user: "👤 Пользователь" };
  async function renderMod() {
    const box = $("modList"); box.innerHTML = '<div class="spin"></div>';
    const tAp = document.querySelector('#modSeg [data-t="health"]'); if (tAp) tAp.classList.toggle("hidden", !(user && user.is_admin));
    if (modTab === "posts") return renderModPosts(box);
    if (modTab === "appeals") return renderAppeals(box);
    if (modTab === "health") return renderHealth(box);
    try {
      const list = await api.reportsList();
      const seen = new Set(), uniq = list.filter((r) => { const k = r.target_type + r.target_id; if (seen.has(k)) return false; seen.add(k); return true; });
      $("modSub").textContent = uniq.length ? uniq.length + " на проверке" : "все проверено";
      const admin = user && user.is_admin;
      box.innerHTML = uniq.length ? uniq.map((r) => `<div class="rep" data-rep="${r.id}" data-tt="${r.target_type}" data-tid="${r.target_id}">
        <div class="rh"><span>${TT[r.target_type]} · жалоб: ${r.count}${r.source === "ai" ? ' <span class="tag-mini">ИИ</span>' : ""}</span><span>${timeAgo(r.created_at)}</span></div>
        <div class="rr">${esc(N.REASON_LABELS[r.reason] || r.reason)}</div>
        <div class="dim" style="font-size:11.5px">Автор: <b class="who-link" data-user="${r.target_user || ""}" translate="no">${esc(r.target.name)}</b>${r.target.banned ? " ⛔" : ""} · пожаловался: <span translate="no">${esc(r.reporter.name)}</span></div>
        ${r.details ? `<div class="dim" style="font-size:11.5px;margin-top:4px" translate="no">"${esc(r.details)}"</div>` : ""}
        <div class="pv" translate="no">${esc(r.preview || "—")}</div>${r.media ? (r.media.kind === "image" ? `<img class="rep-img" src="${esc(r.media.url)}" alt="" data-zoom>` : r.media.kind === "audio" ? `<audio controls src="${esc(r.media.url)}"></audio>` : `<video controls playsinline src="${esc(r.media.url)}"></video>`) : ""}
        <div class="ra">${r.target_type === "post" ? `<button data-act="open" data-post="${r.target_id}">Открыть</button><button class="danger" data-act="hide">Скрыть</button><button class="okb" data-act="restore">Вернуть</button>` : ""}
          ${r.target_type !== "user" ? `<button class="danger" data-act="delete">Удалить</button>` : ""}
          ${admin && r.target_user && !r.target.banned ? `<button class="danger" data-act="ban">⛔ Забанить автора</button>` : ""}
          <button data-act="dismiss">Отклонить жалобу</button><button data-act="history">История</button></div></div>`).join("") : '<div class="empty"><b>Жалоб нет 🎉</b>Новые жалобы появятся здесь</div>';
    } catch (e) { box.innerHTML = `<div class="empty"><b>Нет доступа</b>${esc(e.message)}</div>`; }
  }
  async function renderModPosts(box) {
    try {
      const list = remember(await api.modRecentPosts());
      $("modSub").textContent = "последние " + list.length + " публикаций";
      const ST = { active: "", closed: '<span class="tag-mini">закрыто</span>', hidden: '<span class="tag-mini red">скрыто</span>', draft: '<span class="tag-mini">черновик</span>' };
      const admin = user && user.is_admin;
      box.innerHTML = '<div class="dim" style="font-size:11.5px;margin-bottom:10px">Личные переписки модератор видит только по жалобе: каждое открытие записывается в журнал. Мат в текстах скрывается автоматически.</div>'
        + (list.length ? list.map((p) => { const c = CATS[p.category] || CATS.talk, m = p.media[0], flag = p.media.some((x) => x.mod_status === "flagged");
          return `<div class="rep" data-mp="${p.id}" data-uid="${p.user_id}"><div class="rh"><span>${p.is_sos ? "🆘 SOS" : c.e + " " + c.n} ${ST[p.status] || ""}${flag ? ' <span class="tag-mini red">ИИ: фото</span>' : ""}</span><span>${timeAgo(p.created_at)}</span></div>
            <div class="dim" style="font-size:11.5px">Автор: <b class="who-link" data-user="${p.user_id}" translate="no">${esc(p.author.name)}</b></div>
            <div class="pv" translate="no">${esc(p.text)}</div>${m && m.type === "image" && m.url ? `<img class="rep-img" src="${esc(m.url)}" alt="" data-zoom>` : ""}
            <div class="ra"><button data-mact="open">Открыть</button>${p.status === "hidden" ? '<button class="okb" data-mact="restore">Вернуть</button>' : '<button class="danger" data-mact="hide">Скрыть</button>'}<button class="danger" data-mact="delete">Удалить</button>${admin ? '<button class="danger" data-mact="ban">⛔ Бан автора</button>' : ""}<button data-mact="history">История</button></div></div>`; }).join("")
          : '<div class="empty"><b>Публикаций нет</b></div>');
    } catch (e) { box.innerHTML = `<div class="empty"><b>Нет доступа</b>${esc(e.message)}</div>`; }
  }
  async function renderAppeals(box) {
    try {
      const list = await api.appealsList();
      $("modSub").textContent = list.length ? list.length + " апелляций" : "апелляций нет";
      box.innerHTML = list.length ? list.map((a) => `<div class="rep" data-ap="${a.id}"><div class="rh"><span>${a.target_type === "post" ? "📝 Публикация" : "👤 Бан аккаунта"}</span><span>${timeAgo(a.created_at)}</span></div>
          <div class="dim" style="font-size:11.5px">От: <b class="who-link" data-user="${a.user_id}" translate="no">${esc(a.author.name)}</b></div>
          <div class="pv" translate="no">${esc(a.text)}</div>
          <div class="ra">${a.target_type === "post" ? `<button data-act2="open" data-post="${a.target_id}">Открыть</button>` : ""}<button class="okb" data-act2="accept">Принять</button><button class="danger" data-act2="reject">Отклонить</button><button data-act2="history" data-tt="${a.target_type}" data-tid="${a.target_id}">История</button></div></div>`).join("")
        : '<div class="empty"><b>Апелляций нет</b>Здесь появятся просьбы авторов пересмотреть решение</div>';
    } catch (e) { box.innerHTML = `<div class="empty"><b>Ошибка</b>${esc(e.message)}</div>`; }
  }
  // показатели пилота и очереди (только администратор)
  async function renderHealth(box) {
    try {
      const k = await api.kpi(30);
      if (!k) { box.innerHTML = '<div class="empty"><b>Нет данных</b>Показатели доступны на сервере</div>'; return; }
      $("modSub").textContent = "за 30 дней";
      const row = (t, v, note) => `<div class="kpi"><span>${t}</span><b>${v == null ? "—" : v}</b>${note ? `<small>${note}</small>` : ""}</div>`;
      box.innerHTML = `<div class="kpi-grid">${row("Новые пользователи", k.new_users)}${row("Активация", k.activation != null ? k.activation + "%" : null, "цель ≥60%")}
        ${row("D1 / D7 / D30", [k.d1, k.d7, k.d30].map((x) => (x == null ? "—" : x + "%")).join(" / "), "цель 40/20/10%")}${row("DAU / MAU", (k.dau || 0) + " / " + (k.mau || 0), "цель ≥25%")}
        ${row("Публикации", k.posts)}${row("Ответ в чате (медиана)", k.time_to_first_reply_min != null ? k.time_to_first_reply_min + " мин" : null, "цель ≤30 мин")}
        ${row("Очередь модерации", k.mod_queue)}${row("Решение жалобы (медиана)", k.report_median_hours != null ? k.report_median_hours + " ч" : null)}
        ${row("Push отправлено / ошибок", (k.push_sent || 0) + " / " + (k.push_failed || 0))}${row("Push открыто", k.push_opened)}
        ${row("Ошибки приложения за сутки", k.errors_24h)}${row("Файлы в хранилище", k.storage_mb != null ? k.storage_mb + " МБ" : null)}</div>
        <div class="s-note">Цели — гипотезы пилота, а не отраслевые нормы. События псевдонимизированы: без email, текстов и точных координат.</div>
        <div class="lbl mt12">Сообщения об ошибках</div><div id="fbList"><div class="spin"></div></div>`;
      api.feedbackList().then((fb) => { if ($("fbList")) $("fbList").innerHTML = fb.length ? fb.map((f) => `<div class="hist"><b translate="no">${esc(f.text)}</b><span><span translate="no">${esc(f.name || "гость")}</span> · ${timeAgo(f.created_at)}${f.route ? " · " + esc(f.route) : ""}${f.version ? " · v" + esc(f.version) : ""}</span></div>`).join("") : '<div class="dim">нет новых</div>'; }).catch(() => {});
    } catch (e) { box.innerHTML = `<div class="empty"><b>Нет доступа</b>${esc(e.message)}</div>`; }
  }
  async function historySheet(type, id) {
    openSheet("История решений", '<div class="spin"></div>');
    try {
      const h = await api.modHistory(type, id);
      const st = { open: "открыта", resolved: "решена", dismissed: "отклонена" };
      $("bsList").innerHTML = `<div class="lbl">Жалобы</div>${(h.reports || []).map((r) => `<div class="hist"><b>${esc(N.REASON_LABELS[r.reason] || r.reason)}</b><span>${st[r.status] || r.status}${r.source !== "user" ? " · " + (r.source === "ai" ? "ИИ" : "система") : ""} · ${timeAgo(r.created_at)}${r.resolution ? " · " + esc(r.resolution) : ""}</span></div>`).join("") || '<div class="dim">нет</div>'}
        <div class="lbl mt12">Действия модераторов</div>${(h.actions || []).map((a) => `<div class="hist"><b>${esc(a.action)}</b><span>${esc(a.by || "система")} · ${timeAgo(a.created_at)}${a.note ? " · " + esc(a.note) : ""}</span></div>`).join("") || '<div class="dim">нет</div>'}`;
    } catch (e) { $("bsList").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  $("modList").onclick = async (e) => {
    const u = e.target.closest("[data-user]"); if (u && u.dataset.user) return openUser(u.dataset.user);
    const z = e.target.closest("[data-zoom]"); if (z) return openViewer(z.src);
    const ab = e.target.closest("[data-act2]");
    if (ab) {
      const id = ab.closest("[data-ap]").dataset.ap, act = ab.dataset.act2;
      if (act === "open") return openPost(ab.dataset.post);
      if (act === "history") return historySheet(ab.dataset.tt, ab.dataset.tid);
      if (!(await confirmSheet("Апелляция", act === "accept" ? "Принять апелляцию? Публикация вернется в ленту (или будет снят бан)." : "Отклонить апелляцию? Автор получит уведомление.", "Да", act === "reject"))) return;
      try { await api.modAct("appeal", id, act); toast("✓ Готово"); wide = null; feedDirty = true; renderMod(); } catch (er) { toast(er.message); }
      return;
    }
    const mb = e.target.closest("[data-mact]");
    if (mb) {
      const card3 = mb.closest("[data-mp]"), act = mb.dataset.mact, id = card3.dataset.mp;
      if (act === "open") return openPost(id);
      if (act === "history") return historySheet("post", id);
      const L = { hide: "Скрыть публикацию? Автор получит уведомление, файлы станут недоступны по ссылке.", restore: "Вернуть публикацию в ленту?", delete: "Удалить публикацию навсегда? Файлы будут стерты.", ban: "Забанить автора? Он не сможет публиковать и писать." };
      if (!(await confirmSheet("Модерация", L[act], "Да", act !== "restore"))) return;
      try {
        if (act === "ban") await api.modAction("user", card3.dataset.uid, "ban"); else await api.modAction("post", id, act);
        if (act === "hide" || act === "delete") { const p = cache.get(id); if (p) Cache.purge(p.media.flatMap((m) => [m.url, m.thumb, m.poster]).filter(Boolean)); }
        toast("✓ Готово"); wide = null; feedDirty = true; renderMod();
      } catch (er) { toast(er.message); }
      return;
    }
    const b = e.target.closest("[data-act]"); if (!b) return;
    const card2 = b.closest("[data-rep]"), act = b.dataset.act;
    if (act === "open") return openPost(b.dataset.post);
    if (act === "history") return historySheet(card2.dataset.tt, card2.dataset.tid);
    const labels = { hide: "Скрыть публикацию?", restore: "Вернуть публикацию в ленту?", delete: "Удалить навсегда?", ban: "Забанить автора? Он не сможет публиковать и писать.", dismiss: "Отклонить жалобу? Она останется в истории." };
    if (!(await confirmSheet("Модерация", labels[act], "Да", act === "delete" || act === "ban"))) return;
    try {
      await api.resolveReport(card2.dataset.rep, act);
      if ((act === "hide" || act === "delete") && card2.dataset.tt === "post") { const p = cache.get(card2.dataset.tid); if (p) Cache.purge(p.media.flatMap((m) => [m.url, m.thumb, m.poster]).filter(Boolean)); }
      toast("✓ Готово"); wide = null; feedDirty = true; renderMod();
    } catch (er) { toast(er.message); }
  };

/* ===== 90-sos-demo.js ===== */
  /* =====================================================
     DEMO-РАЗДЕЛЫ (SOS, услуги, опросы, помощь, сообщества)
     ===================================================== */
  if ($("urg")) $("urg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; qa("#urg button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); };
  /* SOS-01: явный признак is_sos (не текст), срок 3 часа, подтверждение, кнопка 112, точное место — только по согласию */
  const sosLive = (p) => p.is_sos && p.status === "active" && (!p.expires_at || new Date(p.expires_at) > Date.now());
  let sosActive = null;
  async function renderSOS() {
    const btn = $("sosBtn"), st = $("sosState"), hb = $("sosHist"); if (!btn) return;
    sosActive = null;
    if (!user) { btn.className = "sos-big"; btn.textContent = "SOS"; st.classList.add("hidden"); hb.innerHTML = '<div class="dim" style="font-size:12px">Войдите, чтобы видеть историю</div>'; return; }
    hb.innerHTML = '<div class="spin"></div>';
    try {
      const mine = (await api.myPosts()).filter((p) => p.is_sos); remember(mine);
      sosActive = mine.find(sosLive) || null;
      btn.className = "sos-big" + (sosActive ? " sent" : "");
      btn.innerHTML = sosActive ? "SOS<br><small>активен</small>" : "SOS";
      st.classList.toggle("hidden", !sosActive);
      if (sosActive) {
        const left = sosActive.expires_at ? Math.max(0, Math.round((new Date(sosActive.expires_at) - Date.now()) / 60000)) : null;
        st.innerHTML = `<b>🆘 Ваш SOS виден людям рядом</b><span>Опубликован ${timeAgo(sosActive.created_at)} · ${sosActive.comments} ${plural(sosActive.comments, "отклик", "отклика", "откликов")}${left != null ? ` · сам закроется через ${left >= 60 ? Math.floor(left / 60) + " ч " : ""}${left % 60} мин` : ""}. Доставка не гарантирована, экстренные службы не уведомлены — при опасности звоните 112.</span><div class="row2"><button class="btn btn-ghost" data-post="${sosActive.id}">Открыть</button><button class="btn btn-danger" id="sosCancel">Помощь больше не нужна</button></div>`;
      }
      const label = (p) => (sosLive(p) ? "активен" : p.status === "hidden" ? "скрыт модератором" : p.status === "closed" ? "закрыт" : "срок истек");
      hb.innerHTML = mine.length ? mine.map((p) => `<button class="row-post" data-post="${p.id}"><span class="th" style="background:${sosLive(p) ? "rgba(255,59,92,.2)" : "rgba(155,155,180,.15)"}">${sosLive(p) ? "🆘" : "✓"}</span><div><b translate="no">${esc(p.text)}</b><span>${label(p)} · ${fmtWhen(p.created_at)}</span></div></button>`).join("") : '<div class="dim" style="font-size:12px">Вы еще не отправляли SOS</div>';
    } catch (e) { hb.innerHTML = `<div class="empty"><b>Не удалось загрузить</b>${esc(e.message)}</div>`; }
  }
  if ($("sv-sos")) $("sv-sos").addEventListener("click", async (e) => {
    let b;
    if (e.target.id === "sosCancel") {
      if (!sosActive || !(await confirmSheet("Закрыть SOS?", "Публикация закроется и пропадет с карты, но останется в истории. Все, кто откликнулся, получат уведомление.", "Помощь не нужна", true))) return;
      try { await api.updatePost(sosActive.id, { status: "closed" }); Sound.play("send"); toast("SOS закрыт. Откликнувшиеся получат уведомление"); wide = null; feedDirty = true; if (mapReady) loadMapPosts(true); renderSOS(); } catch (er) { toast(er.message); }
      return;
    }
    if ((b = e.target.closest("[data-post]"))) openPost(b.dataset.post);
  });
  // подтверждение SOS: что увидят люди, что 112 не вызывается, точное место — отдельной галочкой
  function sosConfirm(what) {
    return new Promise((res) => {
      openSheet("Отправить SOS?", `<div class="sos-conf">
        <p><b>"${esc(what)}"</b> увидят люди рядом в ленте, на карте и в push-уведомлениях.</p>
        <div class="warnbox">⚠️ Доставка не гарантирована. Полиция, скорая и спасатели <b>не получат</b> это сообщение.</div>
        <a class="call112" href="tel:112">📞 Позвонить 112</a>
        <label class="rules-check"><input type="checkbox" id="sosExact"> <span>Показать точное место (иначе — примерно, в пределах ~200 м)</span></label>
      </div><div class="sheet-btns"><button class="btn btn-ghost" id="sosNo">Отмена</button><button class="btn btn-danger" id="sosYes">Отправить SOS</button></div>`);
      $("sosNo").onclick = () => { closeSheet(); res(null); };
      $("sosYes").onclick = () => { const exact = $("sosExact").checked; closeSheet(); res({ exact }); };
    });
  }
  let sosBusy = false;
  if ($("sosBtn")) $("sosBtn").onclick = async function () {
    if (sosActive) { $("sosCancel") && $("sosCancel").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    if (!requireAuth("Войдите, чтобы отправить SOS", { t: "sos" })) return;
    if (sosBusy) return; // повторное нажатие не дублирует сигнал
    const u = document.querySelector("#urg .on").textContent.replace(/^\S+\s/, "");
    const ok = await sosConfirm(u); if (!ok) return;
    sosBusy = true; $("sosBtn").classList.add("busy");
    try {
      const g = pos.src === "gps" ? pos : await getGeo(true).catch(() => null);
      if (!g) { toast("Не удалось определить, где вы. Разрешите геопозицию — без нее соседи не найдут вас. При опасности звоните 112"); return; }
      const p = await api.createPost({ category: "incident", text: "SOS: " + u + ". Нужна помощь рядом!", lat: g.lat, lng: g.lng, files: [], is_sos: true, exact: ok.exact, clientKey: "sos-" + N.rid() });
      cache.set(p.id, p); Sound.play("sos"); Obs.track("sos_sent", { ok: ok.exact ? "exact" : "approx" }); usefulAction("sos");
      wide = null; feedDirty = true; if (mapReady) loadMapPosts(true); toast("🆘 SOS опубликован для людей рядом. 112 не вызван");
      renderSOS();
    } catch (e) { toast(e.message); }
    finally { sosBusy = false; $("sosBtn").classList.remove("busy"); }
  };
  const PRO = { "Сантехник": ["Нурлан", "Сергей", "\"Сервис 24\""], "Электрик": ["Бауыржан", "Олег", "\"Свет+\""], "Автомеханик": ["Арман", "СТО \"Мотор\"", "Денис"], "Ремонт": ["Бригада Кайрата", "\"Ремонт-Про\"", "Максат"], "Репетитор": ["Айгерим (математика)", "Анна (англ.)", "Ержан (физика)"], "Уборка": ["\"Чистый дом\"", "Гульнара", "\"Clean KZ\""], "ПК-мастер": ["Даурен", "\"IT-помощь\"", "Артем"] };
  const PA = ["👨‍🔧", "🧰", "🔧", "🛠️", "👩‍🏫", "🧹", "💻"];
  function renderPro(cat) {
    if (!$("proList") || !PRO[cat]) return; const ix = Object.keys(PRO).indexOf(cat);
    $("proList").innerHTML = '<div class="demo-strip">🧪 Пример раздела: это ненастоящие мастера, рейтингов и отзывов нет. Найти мастера сейчас можно через публикацию в ленте.</div>' + PRO[cat].map((n) => `<div class="pro"><span class="pa">${PA[ix]}</span><div><b>${esc(n)}</b><span>${cat} · пример карточки</span></div></div>`).join("")
      + `<button class="btn btn-main full mt12" data-ask="${esc(cat)}">Спросить соседей: нужен ${esc(cat.toLowerCase())}</button>`;
  }
  qa("#svcCats span").forEach((sp) => { sp.dataset.cat = sp.lastChild.textContent.trim(); sp.onclick = () => { qa("#svcCats span").forEach((x) => x.classList.remove("on")); sp.classList.add("on"); renderPro(sp.dataset.cat); }; });
  if ($("proList")) { $("proList").onclick = (e) => { const b = e.target.closest("[data-ask]"); if (b && requireAuth("Войдите, чтобы публиковать")) { openCreate({ type: "talk" }); $("crText").value = "Ищу: " + b.dataset.ask.toLowerCase() + " рядом. Посоветуйте проверенного мастера 🙏"; } }; renderPro("Сантехник"); }
  qa("[data-poll]").forEach((pl) => (pl.onclick = (e) => { const o = e.target.closest(".opt"); if (!o || pl.classList.contains("voted")) return; o.classList.add("mine"); pl.classList.add("voted"); qa(".opt", pl).forEach((x) => (x.querySelector("i").style.width = x.dataset.p + "%")); toast("🧪 Это пример: голос не сохраняется"); }));
  qa("#sv-help .help button").forEach((b) => (b.onclick = () => { const on = b.classList.toggle("done"); b.textContent = on ? "✓ (пример)" : "Помогу"; if (on) toast("🧪 Это пример. Откликайтесь на реальные просьбы в ленте"); }));
  if ($("helpAdd")) $("helpAdd").onclick = () => { if (requireAuth("Войдите, чтобы попросить о помощи")) { openCreate({ type: "talk" }); $("crText").value = "Нужна помощь: "; } };
  qa("#v-com .jn").forEach((b) => (b.onclick = () => {
    const on = b.classList.toggle("in");
    if (b.textContent === "Войти" || b.dataset.w) { b.dataset.w = 1; b.textContent = on ? "✓ Внутри" : "Войти"; } else b.textContent = on ? "✓" : "+";
    b.style.background = on ? "rgba(43,212,125,.15)" : ""; b.style.color = on ? "var(--ok)" : "";
    toast("🧪 Пример: сообщества появятся позже" + (on ? "" : ""));
  }));

/* ===== 99-boot.js ===== */
  /* =====================================================
     BOOT
     ===================================================== */
  function fatal(msg) {
    hideAuth(); $("posts").innerHTML = `<div class="empty"><b>Не удалось запустить NEAR</b>${esc(msg)}<br><button class="btn btn-main mt12" onclick="location.reload()">Перезагрузить</button></div>`;
  }
  /* ---------- обновления в реальном времени; опрос сервера — только если канал оборвался ---------- */
  const Live = {
    state: "idle", off: null, pollT: null, delay: 15000, hidT: null,
    start() {
      this.stop();
      try { this.off = api.subscribe(onLive, (st) => this.onState(st)) || null; } catch (e) { console.warn(e); this.onState("CHANNEL_ERROR"); }
      if (api.mode === "local") this.state = "SUBSCRIBED";
    },
    stop() { if (this.off) { try { this.off(); } catch (e) {} this.off = null; } clearTimeout(this.pollT); this.state = "idle"; },
    onState(st) {
      const was = this.state; this.state = st;
      if (st === "SUBSCRIBED") { clearTimeout(this.pollT); this.delay = 15000; if (was !== "SUBSCRIBED" && was !== "idle") catchUp(); }
      else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(st)) this.poll();
    },
    // запасной режим: опрос с растущим интервалом 15 с → 2 мин
    poll() {
      clearTimeout(this.pollT);
      this.pollT = setTimeout(() => { if (!document.hidden) catchUp(); this.delay = Math.min(this.delay * 2, 120000); if (this.state !== "SUBSCRIBED") this.poll(); }, this.delay);
    }
  };
  function catchUp() { refreshBadge(); refreshChatBadge(); if (cur() === "v-chats") renderChats(); if (convId) Conv.catchUp(); }
  function onLive(type, row) {
    if (type === "post") {
      wide = null; if (mapReady) { clearTimeout(mapT); mapT = setTimeout(loadMapPosts, 800); }
      if (row && N.dist(pos, row) <= R && (!user || row.user_id !== user.id)) {
        $("refreshBtn").classList.add("fresh"); toast(`${(CATS[row.category] || CATS.talk).e} Новая публикация рядом. Нажмите ↻`);
        if (["incident", "event", "deal"].includes(row.category) && prefOn(row.category)) Sound.play(row.is_sos ? "sos" : "post");
      }
    }
    if (type === "notif") { refreshBadge(); refreshChatBadge(); const nt = row && row.type; if (!(nt === "likes" && !prefOn("n_like")) && !(/comment|reply/.test(nt || "") && !prefOn("n_comment"))) Sound.play("notif"); }
    // список переписок изменился (новое сообщение, запрос, принятие)
    if (type === "inbox") { refreshChatBadge(true); if (cur() === "v-chats") renderChats(); if (row && convId === row.id) Conv.statusChanged(row); }
    // демо-режим присылает сами сообщения
    if (type === "message" || type === "message_update") {
      if (convId && row && row.conversation_id === convId) { if (!Conv.off) Conv.onRow(type === "message" ? "insert" : "update", row); }
      else if (type === "message") refreshChatBadge(true);
    }
  }
  // вкладка скрыта дольше 30 секунд — отписываемся; вернулись — подписываемся и догружаем пропущенное
  document.addEventListener("visibilitychange", () => {
    if (!api) return;
    clearTimeout(Live.hidT);
    if (document.hidden) { Live.hidT = setTimeout(() => { Live.stop(); Conv.unsub(); }, 30000); return; }
    if (Live.state === "idle" && api.mode !== "local") { Live.start(); catchUp(); }
    if (convId && !Conv.off) Conv.sub();
  });

  // ссылка из письма устарела или неверна (Supabase добавляет error_code в адрес)
  function linkError() {
    const h = new URLSearchParams(location.hash.replace(/^#/, "")), q = new URLSearchParams(location.search);
    const code = h.get("error_code") || q.get("error_code") || h.get("error") || q.get("error");
    if (!code) return null;
    history.replaceState(null, "", location.pathname);
    if (/access_denied|cancel/i.test(code + (h.get("error_description") || ""))) return "Вход через Google отменен. Можно войти по email или попробовать снова.";
    return /expired/i.test(code + (h.get("error_description") || "")) ? "Ссылка из письма устарела. Войдите или запросите новое письмо: \"Забыли пароль?\" или \"Отправить еще раз\"."
      : "Ссылка из письма недействительна. Запросите новое письмо.";
  }
  // гость видит ленту сразу; полоска сверху предлагает войти
  function guestBar() {
    const b = $("guestBar"); if (!b) return;
    b.classList.toggle("hidden", !!user);
  }
  async function geoGranted() {
    try { if (navigator.permissions && navigator.permissions.query) return (await navigator.permissions.query({ name: "geolocation" })).state === "granted"; } catch (e) {}
    return false;
  }
  function hideDemoSections() {
    if (CFG.SHOW_DEMO_SECTIONS || api.mode === "local") return;
    ["sv-services", "sv-polls", "sv-help", "v-com"].forEach((v) => { const t = document.querySelector(`.dt[data-open="${v}"]`); if (t) t.remove(); });
    const pk = $("parkBtn"); if (pk) pk.remove();
    document.body.classList.add("prod");
  }

  async function boot() {
    I18N.start();
    try {
      if (CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && CFG.ENV !== "demo" && !window.supabase) await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js");
      user = await N.start(); api = N.api; loadHidden(); loadPrefs();
    } catch (e) { fatal(/^(load|timeout) /.test(e.message) ? "Не удалось подключиться к серверу. Проверьте интернет и попробуйте снова." : N.ruError(e)); return; }
    if (api.mode === "local") $("demoStrip").classList.remove("hidden");
    hideDemoSections();
    api.onAuth((u, ev) => {
      if (ev === "recovery") { showAuth("reset"); return; }
      const was = user && user.id; user = u;
      if (u && !was) { loadPrefs(); if (needsCompletion(u)) { showComplete(); return; } hideAuth(); applyPendingInsta(); startSeen(); onUserChange(); runIntent(); }
      else if (!u && was) { Cache.wipe(was); loadPrefs(); onUserChange(); }
      else if (u && ev === "USER_UPDATED") renderProfile();
    });
    const isRecovery = /type=recovery/.test(location.hash), lerr = linkError();
    if (isRecovery) showAuth("reset");
    else if (lerr) showAuth("login", lerr);
    else if (user && needsCompletion(user)) showComplete();
    else hideAuth(); // AUTH-01: лента доступна без входа и без GPS
    guestBar();
    if (user) { applyPendingInsta(); startSeen(); }
    if (!document.querySelector(".view.on:not(#v-auth)")) $("v-feed").classList.add("on");
    // GPS спрашиваем только по нажатию "Определить"; если разрешение уже есть — берем место сразу
    geoGranted().then((ok) => { if (!ok) return; useMyLocation(true).then((g) => { if (g) { loadFeed(); drawMe(); fitRadius(false); } }); });
    $("locName").textContent = "Центр Алматы"; geoBanner();
    await loadFeed();
    if (!isRecovery) maybeOnboard();
    refreshBadge(); refreshChatBadge();
    Live.start();
    if (/src=push/.test(location.hash)) Obs.track("push_opened");
    if (/(post|user|conv|notif)=?/.test(location.hash) && location.hash.length > 1) { openHash(location.hash); history.replaceState(null, "", location.pathname); }
    Push.sync(true); pushInvite();
    Obs.track("app_open", { lang: I18N.lang, theme: document.documentElement.dataset.theme, source: (window.matchMedia && matchMedia("(display-mode: standalone)").matches) ? "pwa" : "web" });
  }
  boot();
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
