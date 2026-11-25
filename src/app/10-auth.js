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
    if (/Подтвердите email|Подтвердите почту/.test(m) || (e && e.hint === "pending_email")) {
      openSheet("Подтвердите email", `<p class="muted" style="font-size:13.5px;margin-bottom:12px">Публиковать, комментировать и писать сообщения можно после подтверждения почты. Мы отправили письмо на <b>${esc((user && user.email) || "")}</b>.</p>
        <div class="sheet-btns"><button class="btn btn-ghost" id="gwNo">Позже</button><button class="btn btn-main" id="gwSend">Отправить письмо еще раз</button></div>`);
      $("gwNo").onclick = closeSheet;
      $("gwSend").onclick = async () => { try { await busy($("gwSend"), () => api.resendConfirm(user.email)); closeSheet(); toast("📬 Письмо отправлено. Следующее — через минуту"); } catch (er) { toast(er.message); } };
      return true;
    }
    if (/Заполните профиль/.test(m)) { showComplete(); return true; }
    if (e && e.hint === "meet_age") { meetGate({ state: "active" }); return true; }
    if (e && e.hint === "legacy_dm") { startChat(); return true; }
    return false;
  }
  function runIntent() {
    let it = null; try { it = JSON.parse(sessionStorage.getItem("near_intent") || "null"); sessionStorage.removeItem("near_intent"); } catch (e) {}
    if (!it || !user || Date.now() - it.at > 15 * 60e3) return;
    setTimeout(() => {
      if (it.t === "like") doLike(it.a); else if (it.t === "save") doSave(it.a); else if (it.t === "join") doJoin(it.a);
      else if (it.t === "create") openCreate({ type: it.a || undefined }); else if (it.t === "comments") openPost(it.a, true);
      else if (it.t === "chat") startChat(it.a); else if (it.t === "room") openRoom(it.a); else if (it.t === "meet") openMeet(it.a); else if (it.t === "meetnew") openMeetCreate(); else if (it.t === "sos") go("sv-sos"); else if (it.t === "notif") go("sv-notif");
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
  qa("[data-guest]").forEach((b) => (b.onclick = () => $("guestBtn").click()));

  // ТЗ 03: вход по нику или email; одинаковая ошибка, пароль нигде не сохраняется
  $("f-login").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target, fd = new FormData(f), login = String(fd.get("login") || "").trim().replace(/^@/, "");
    if (!login || !fd.get("password")) return formErr(f, "Заполните никнейм или email и пароль");
    try { await busy(f.querySelector("[type=submit]"), async () => api.signIn({ login, password: fd.get("password"), captchaToken: await Cap.token(capOf(f)) })); user = api.user(); afterLogin(); }
    catch (err) {
      if (err.code === "email_not_confirmed" || /не подтверждена|Подтвердите почту/.test(err.message)) { if (login.includes("@")) showSent(login, false); else formErr(f, "Подтвердите почту: откройте письмо, которое мы прислали при регистрации"); return; }
      formErr(f, err.message);
    }
    finally { Cap.reset(capOf(f)); f.password.value = ""; }
  };
  /* ---------- регистрация (ТЗ 03): никнейм + пароль + почта + правила → подтверждение почты → активный профиль ---------- */
  const SU = $("f-signup"); let pendingEmail = "";
  // живая проверка никнейма (формат — сразу, занятость — запросом через 400 мс)
  function nickLive(input, hint) {
    let t = null, seq = 0; const base = hint.textContent;
    input.addEventListener("input", () => {
      clearTimeout(t); const v = input.value.trim(), my = ++seq;
      hint.className = "hint"; if (!v) { hint.textContent = base; return; }
      const p = N.nickProblem(v); if (p) { hint.textContent = p; hint.classList.add("bad"); return; }
      hint.textContent = "Проверяем...";
      t = setTimeout(async () => { try { const r = await api.nicknameCheck(v); if (my !== seq) return; hint.textContent = r.ok ? "✓ Никнейм свободен" : r.error === "Этот никнейм уже занят" ? "Никнейм занят" : r.error; hint.classList.add(r.ok ? "good" : "bad"); } catch (e) { if (my === seq) hint.textContent = base; } }, 400);
    });
  }
  nickLive($("cpNick"), $("cpNickHint"));
  nickLive($("suNick"), $("suNickHint"));
  function pwScore(pw) { let n = 0; if (pw.length >= 8) n++; if (/\d/.test(pw) && /[a-zа-я]/i.test(pw)) n++; if (/[A-ZА-Я]/.test(pw) && /[a-zа-я]/.test(pw)) n++; if (/[^\w\s]/.test(pw) || pw.length >= 12) n++; return n; }
  SU.password.oninput = () => {
    const sc = pwScore(SU.password.value), L = ["", "слабый", "средний", "хороший", "надежный"];
    qa(".pw-meter i", SU).forEach((x, i) => (x.className = i < sc ? "s" + sc : ""));
    $("pwHint").textContent = SU.password.value ? "Пароль: " + L[sc] + (SU.password.value.length < 8 ? " · нужно минимум 8 символов" : "") : "Минимум 8 символов, буквы и цифры";
  };
  function suCheck() {
    const nick = SU.nickname.value.trim(), email = SU.email.value.trim(), pw = SU.password.value;
    const np = N.nickProblem(nick); if (!nick) return "Придумайте никнейм"; if (np) return np;
    if (pw.length < 8) return "Пароль должен быть не короче 8 символов";
    if (!/\d/.test(pw) || !/[a-zа-я]/i.test(pw)) return "В пароле нужны и буквы, и цифры";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Проверьте правильность почты";
    if (!SU.rules.checked) return "Чтобы продолжить, примите правила сообщества";
    return "";
  }
  SU.addEventListener("input", () => SU.querySelector("[data-err]").classList.remove("on"));
  SU.onsubmit = async (e) => {
    e.preventDefault();
    const er = suCheck(); if (er) return formErr(SU, er);
    const email = SU.email.value.trim(), nickname = SU.nickname.value.trim();
    try {
      // двойное нажатие не создает второй профиль: кнопка заблокирована на время запроса, сервер — один профиль на auth.uid
      const r = await busy(SU.querySelector("[type=submit]"), async () => {
        const chk = await api.nicknameCheck(nickname); if (!chk.ok) throw new Error(chk.error || "Никнейм занят");
        return api.signUp({ nickname, email, password: SU.password.value, captchaToken: await Cap.token(capOf(SU)) });
      });
      if (r.needsConfirm) { showSent(email, true, r.neutral); SU.password.value = ""; }
      else { user = api.user(); resetSignup(); afterLogin(true); }
    } catch (err) { formErr(SU, err.message || "Не удалось создать аккаунт. Повторите попытку"); } finally { Cap.reset(capOf(SU)); }
  };
  function resetSignup() { SU.reset(); SU.password.oninput(); }
  /* ---------- подтверждение почты ---------- */
  let resendT = 0;
  // ТЗ 38/59: одинаковый ответ для нового и уже зарегистрированного адреса
  function showSent(email, fresh, neutral) {
    pendingEmail = email;
    $("sentText").innerHTML = fresh
      ? `Если адрес <b>${esc(email)}</b> свободен, мы отправили на него письмо: откройте его и нажмите "Подтвердить" — профиль станет активным. До подтверждения можно только читать. Если аккаунт с этим адресом уже есть — войдите или восстановите пароль.`
      : `Почта еще не подтверждена. Мы отправили письмо на <b>${esc(email)}</b>: откройте его и нажмите "Подтвердить".`;
    showAuth("sent"); if (fresh) startResendTimer();
    if (neutral) Obs.track("signup", { state: "neutral" });
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
  // вход через Google показывается, только если он включен в Supabase (GOOGLE_AUTH: true в config.js)
  if (CFG.GOOGLE_AUTH === false) qa("[data-google]").forEach((b) => { b.classList.add("hidden"); const or = b.nextElementSibling; if (or && or.classList.contains("or")) or.classList.add("hidden"); });
  qa("[data-google]").forEach((b) => (b.onclick = async () => {
    try { b.disabled = true; await api.signInWithGoogle(); } catch (er) { formErr(b.closest("form"), er.message); } finally { setTimeout(() => (b.disabled = false), 1500); }
  }));
  // после подтверждения почты, Google или для аккаунта v12: только недостающее — никнейм (и правила, если не приняты)
  function needsCompletion(u) { return u && (!u.nickname || !u.accepted_rules); }
  function showComplete() {
    const f = $("f-complete"); f.nickname.value = (user && user.nickname) || ""; $("cpNickHint").className = "hint";
    $("cpRules").classList.toggle("hidden", !!(user && user.accepted_rules)); f.rules.checked = !!(user && user.accepted_rules);
    f.querySelector(".sub").textContent = user && user.provider === "google" ? "Вы вошли через Google. Имя из Google мы не показываем — соседи увидят только никнейм"
      : user && user.created_at && Date.now() - new Date(user.created_at) > 86400e3 ? "Мы обновили профиль: вместо имени и пола теперь никнейм" : "Шаг 2 из 2 · так вас увидят соседи. Имя и фамилия не нужны";
    showAuth("complete"); $("guestBtn").classList.add("hidden");
  }
  $("f-complete").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target, nick = f.nickname.value.trim();
    const np = N.nickProblem(nick); if (np) return formErr(f, np);
    if (!f.rules.checked) return formErr(f, "Чтобы продолжить, примите правила сообщества");
    try {
      user = await busy(f.querySelector("[type=submit]"), async () => {
        if (!(user && user.accepted_rules)) await api.updateProfile({ acceptRules: true });
        return user && user.nickname === nick ? api.user() : api.setNickname(nick);
      });
      afterLogin(true);
    } catch (er) { formErr(f, /занят/.test(er.message) ? "Никнейм занят" : er.message || "Не удалось сохранить профиль. Повторите попытку"); }
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
