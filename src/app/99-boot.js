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
      // своя публикация прошла проверку файлов — появляется в ленте
      if (row && user && row.user_id === user.id) { feedDirty = true; if (cur() === "v-feed") loadFeed(); toast("✓ Публикация прошла проверку и опубликована"); return; }
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
      if (u && !was) {
        loadPrefs();
        Shield.gate().then((g) => { if (g !== "active") return; if (needsCompletion(user)) { showComplete(); return; } hideAuth(); applyPendingInsta(); startSeen(); onUserChange(); runIntent(); }).catch(() => {});
      }
      else if (!u && was) { Cache.wipe(was); loadPrefs(); onUserChange(); }
      else if (u && ev === "USER_UPDATED") renderProfile();
    });
    const isRecovery = /type=recovery/.test(location.hash), lerr = linkError();
    if (isRecovery) showAuth("reset");
    else if (lerr) showAuth("login", lerr);
    else hideAuth(); // AUTH-01: лента доступна без входа и без GPS
    guestBar();
    // NEAR Shield: актуальная сессия этого устройства и состояние аккаунта (бан, ограничение)
    if (user && !isRecovery) Shield.gate().then((g) => { if (g === "active" && needsCompletion(user)) showComplete(); }).catch(() => {});
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
