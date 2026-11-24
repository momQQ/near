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
