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
