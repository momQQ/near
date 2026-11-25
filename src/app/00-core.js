  const CFG = window.NEAR_CONFIG || {};
  const APP_VERSION = "14.8";
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
  /* ---------- v14.8 (ТЗ 02): SVG-иконки вместо emoji в интерфейсе ---------- */
  const IC_PATHS = {
    feed: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chat: '<path d="M4 5h16v11H9l-5 4V5z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    talk: '<path d="M4 5h16v11H9l-5 4V5z"/><path d="M8 9h8M8 12h5"/>',
    incident: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17v.5"/>',
    meetup: '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M2 20c1-3 3-5 6-5s5 2 6 5M14 15c3 0 5 2 6 5"/>',
    event: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    deal: '<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
    help: '<path d="M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-3 4.5 4.5 0 0 1 8 3c0 6-8 11-8 11z"/>',
    lost: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>', found: '<path d="m5 12 4 4 10-10"/>', ad: '<path d="M4 9v6h4l7 4V5L8 9H4z"/>',
    sos: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16v.5"/>',
    city: '<path d="M3 21V9l6-3v15M9 21V4l6 3v14M15 21V10l6 2v9"/>', district: '<path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    topic: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    games: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 11v3M5.5 12.5h3M16 12h.5M18 14h.5"/>',
    cinema: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 6l2 4M12 6l2 4M17 6l2 4"/>',
    board: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>',
    sport: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.6 5.6c3 3 3 9.8 0 12.8M18.4 5.6c-3 3-3 9.8 0 12.8"/>',
    cafe: '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9zM16 10h2a2 2 0 0 1 0 4h-2M8 3v3M12 3v3"/>',
    walk: '<circle cx="13" cy="4" r="2"/><path d="m9 21 2-6 3 3v3M7 12l3-4 4 1 2 4M11 15l-1-4"/>',
    mountains: '<path d="m2 20 7-12 4 6 3-4 6 10H2z"/>',
    study: '<path d="M2 8l10-4 10 4-10 4L2 8z"/><path d="M6 10v5c3 2 9 2 12 0v-5"/>',
    other: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', pin: '<path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c1-4 4-6 7-6s6 2 7 6M16 4a3.5 3.5 0 0 1 0 7M18 14c2 1 3.5 3 4 6"/>',
    star: '<path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5 6.5 20.4l1-6.3L3 9.7l6.2-.9L12 3z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z"/>', bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 20a2 2 0 0 0 4 0"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4V3z"/>', edit: '<path d="M4 20h4L20 8l-4-4L4 16v4z"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', drafts: '<path d="M6 3h9l4 4v14H6V3z"/><path d="M15 3v4h4M9 12h6M9 16h4"/>',
    check: '<path d="m5 12 4 4 10-10"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>', back: '<path d="m15 5-7 7 7 7"/>', search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'
  };
  const CAT_IC = { incident: "incident", event: "event", deal: "deal", lost: "lost", found: "found", help: "help", meetup: "meetup", ad: "ad", talk: "talk" };
  const catIc = (k, s = 14) => icon(CAT_IC[k] || "talk", s);
  const icon = (n, s = 22) => `<svg class="ic" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC_PATHS[n] || IC_PATHS.other}</svg>`;
  qa("[data-ic]").forEach((el) => (el.innerHTML = icon(el.dataset.ic, +el.dataset.s || 22)));
  // девять категорий встреч (ТЗ 07.1)
  const MEET_CATS = {
    games: { n: "Компьютерные игры", ic: "games", c: "#A54EE7" }, cinema: { n: "Кино", ic: "cinema", c: "#EC398E" }, board: { n: "Настольные игры", ic: "board", c: "#FF7848" },
    sport: { n: "Спорт", ic: "sport", c: "#2bd47d" }, cafe: { n: "Кафе", ic: "cafe", c: "#ffb020" }, walk: { n: "Прогулки", ic: "walk", c: "#3da5ff" },
    mountains: { n: "Горы", ic: "mountains", c: "#00b4a6" }, study: { n: "Обучение", ic: "study", c: "#7c8cff" }, other: { n: "Другое", ic: "other", c: "#A29CB3" }
  };
  // таймер встречи: один локальный тик; >24 ч — дни и часы, затем ч:м:с, после начала — "Встреча идет"
  function meetTimerText(m) {
    if (!m || !m.starts_at) return "";
    if (m.status === "cancelled") return "Встреча отменена";
    const now = Date.now(), st = new Date(m.starts_at).getTime(), en = new Date(m.ends_at).getTime();
    if (m.status === "finished" || now >= en) return "Встреча завершена";
    if (now >= st) return "Встреча идет";
    const s = Math.floor((st - now) / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
    const p2 = (x) => String(x).padStart(2, "0");
    return d >= 1 ? `До начала ${d} ${plural(d, "день", "дня", "дней")} ${h} ч` : `До начала ${p2(h)} : ${p2(mi)} : ${p2(se)}`;
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
  const CHIPS = [["all", "🔥 Все"], ["incident", "🚨 Происшествия"], ["event", "🎉 События"], ["deal", "🏷️ Акции"], ["help", "🤲 Помощь"], ["lostfound", "🔎 Потери и находки"], ["meetup", "⚽ Встречи"], ["ad", "📢 Объявления"], ["talk", "💬 Обсуждения"]];
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
  const ROOT_VIEWS = ["v-feed", "v-map", "v-chats", "v-prof", "v-disc"];
  // v14.8: клавиатура на iOS — высота видимой области, чтобы поле ввода и кнопка не уходили под клавиатуру
  if (window.visualViewport) {
    const setVV = () => document.documentElement.style.setProperty("--vvh", Math.round(visualViewport.height) + "px");
    visualViewport.addEventListener("resize", setVV); setVV();
  }
  // v14.2: форма может попросить подтверждение перед уходом (несохраненный черновик)
  let leaveGuard = null;
  function go(id, push = true, force) {
    const c = cur();
    if (c === id) return;
    if (!force && leaveGuard && leaveGuard(id, () => go(id, push, true)) === false) return;
    if (push) hist.push(c);
    qa(".view").forEach((v) => { if (v.id !== "v-auth") v.classList.remove("on", "nav-fwd", "nav-back", "nav-tab"); });
    // анимация перехода: вперед — справа, назад — слева, вкладки — плавно
    const anim = push ? "nav-fwd" : TABS.includes(id) && TABS.includes(c) ? (TABS.indexOf(id) > TABS.indexOf(c) ? "nav-tab r" : "nav-tab l") : "nav-back";
    $(id).classList.remove("r", "l"); $(id).classList.add("on", ...anim.split(" "));
    $(id).scrollTop = 0;
    document.body.classList.toggle("picking", id === "sv-pick"); document.body.classList.toggle("creating", id === "v-create"); document.body.classList.toggle("in-conv", id === "sv-room");
    // ТЗ 02 / UI-01: на внутренних маршрутах (формы, чат, выбор места, встречи) нет глобальной шапки и нижнего меню
    document.body.classList.toggle("inner", !ROOT_VIEWS.includes(id));
    if (id !== "sv-room") { roomId = null; Room.unsub(); }
    const tab = TABS.includes(id) ? id : null;
    if (tab) qa(".tb,.tb-plus").forEach((x) => x.classList.toggle("on", x.dataset.v === tab));
    onEnter(id);
  }
  function back() {
    const to = hist[hist.length - 1] || "v-feed", run = () => { hist.pop(); go(to, false, true); };
    if (leaveGuard && leaveGuard(to, run) === false) return;
    run();
  }
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
    if (id === "sv-meets") renderMeets();
    if (id === "sv-mod") renderMod();
    if (id === "v-feed" && feedDirty) loadFeed();
  }
  qa("[data-v]").forEach((b) => (b.onclick = () => {
    if (b.dataset.v === "v-create") { openCreateMenu(); return; }
    // v14.2: повторное нажатие на текущую вкладку — наверх
    if (cur() === b.dataset.v) { const v = $(b.dataset.v); v.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); window.scrollTo({ top: 0 }); return; }
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
    else if ((m = h.match(/room=([\w-]+)/))) openRoom(m[1]);
    else if ((m = h.match(/meet=([\w-]+)/))) openMeet(m[1]);
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
      ${on ? r("msg", "✉️", "Чаты встреч и упоминания") + r("comment", "💬", "Комментарии и ответы") + r("like", "❤️", "Лайки") + r("friend", "🤝", "Заявки в друзья")
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
        const was = user && user.id; Room.unsub(); closeSheet(); user = null; cache.clear(); Cache.wipe(was);
        onUserChange(); hist = []; go("v-feed", false); toast("Аккаунт удален. Спасибо, что были с NEAR");
      } catch (e) { $("delErr").textContent = e.message; $("delErr").classList.add("on"); }
    };
  }
