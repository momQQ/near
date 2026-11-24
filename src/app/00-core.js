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
