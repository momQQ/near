  /* =====================================================
     NEAR SHIELD: вход с нового устройства, экран блокировки, центр безопасности
     Все решения принимает сервер; приложение только показывает состояние.
     ===================================================== */
  const Shield = {
    busy: null, acc: null, offset: 0, timer: null,
    // проверка после входа, при запуске и при возвращении в приложение
    gate() {
      if (!user || !api || !api.sessionBegin) return Promise.resolve("guest");
      if (this.busy) return this.busy;
      this.busy = (async () => {
        let r;
        try { r = await api.sessionBegin(); }
        catch (e) {
          if (!navigator.onLine) { const last = this.lastKnown(); if (last && /banned/.test(last.state)) { this.banScreen(last, true); return "banned"; } return "offline"; }
          throw e;
        }
        if (!r) return "active";
        if (r.state === "banned") { this.banScreen(r.account); return "banned"; }
        if (r.state === "revoked") { await this.revoked(r.reason); return "revoked"; }
        if (r.state === "challenge") { this.deviceScreen(r); return "challenge"; }
        this.closeOverlay();
        this.applyAccount(r.account);
        return "active";
      })().finally(() => setTimeout(() => (this.busy = null), 50));
      return this.busy;
    },
    lastKey: () => "near_acc_" + (user ? user.id : ""),
    lastKnown() { try { return JSON.parse(localStorage.getItem(this.lastKey()) || "null"); } catch (e) { return null; } },
    remember(acc) { try { if (acc) localStorage.setItem(this.lastKey(), JSON.stringify(acc)); } catch (e) {} },
    applyAccount(acc) {
      this.acc = acc || null; this.remember(acc);
      const b = $("restrictBar"); if (!b) return;
      const on = acc && acc.state === "restricted";
      b.classList.toggle("hidden", !on);
      if (on) b.innerHTML = `⚠️ Действия ограничены до ${acc.expires_at ? fmtWhen(acc.expires_at) : "решения модератора"} · решение ${esc(acc.decision_no || "")} <button class="lnk" id="rbMore">Подробнее</button>`;
      if (on) $("rbMore").onclick = () => this.banScreen(acc);
    },
    overlay(cls, html) {
      const o = $("shieldOv");
      o.className = "shield-ov " + cls; o.innerHTML = `<div class="sh-card">${html}</div>`;
      document.body.classList.add("shielded");
      requestAnimationFrame(() => o.classList.add("on"));
      return o;
    },
    closeOverlay() { const o = $("shieldOv"); clearInterval(this.timer); if (o && o.classList.contains("on")) { o.classList.remove("on"); setTimeout(() => { if (!o.classList.contains("on")) { o.innerHTML = ""; o.className = "shield-ov"; } }, 220); } document.body.classList.remove("shielded"); },

    /* ---------- вход с нового устройства ---------- */
    deviceScreen(ch) {
      const o = this.overlay("device", `
        <div class="sh-ico">${IC.shield || "🛡"}</div>
        <h2>Вход с нового устройства</h2>
        <p class="sh-sub">Ваш аккаунт уже используется на другом устройстве.</p>
        <div class="dev-card"><span class="dev-i">📱</span><div><b>${esc(ch.old_device || "Другое устройство")}</b><small>Последняя активность: ${ch.old_last_seen ? timeAgo(ch.old_last_seen) : "недавно"}</small><em>● Активная сессия</em></div></div>
        <div class="dev-swap" aria-hidden="true"><span class="ph old">✕</span><i></i><span class="ph new">✓</span></div>
        <div class="dev-lbl" aria-hidden="true"><span>Старое</span><span>Новое</span></div>
        <p class="sh-note">Мы отправили код на вашу почту. Введите его — предыдущая сессия будет автоматически завершена.</p>
        ${ch.demo_code ? `<p class="demo-code">🧪 Демо-режим: код <b>${esc(ch.demo_code)}</b></p>` : ""}
        <form id="devForm" class="code-form" autocomplete="one-time-code">
          <input id="devCode" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="••••••" aria-label="Код из письма" autocomplete="one-time-code">
          <div class="err" id="devErr"></div>
          <button class="btn btn-main big" type="submit" id="devOk">Подтвердить вход</button>
        </form>
        <div class="row2"><button class="btn btn-ghost" id="devResend" disabled>Отправить код еще раз</button><button class="btn btn-ghost" id="devCancel">Отмена</button></div>
        <p class="sh-foot">Если подтверждение не пройдено, старая сессия продолжает работать.</p>`);
      const resend = $("devResend"); let left = Math.max(0, Math.round((new Date(ch.resend_at) - new Date(ch.server_now || Date.now())) / 1000));
      clearInterval(this.timer);
      const tick = () => { if (left > 0) { resend.disabled = true; resend.textContent = `Еще раз через ${left} с`; left--; } else { resend.disabled = false; resend.textContent = "Отправить код еще раз"; } };
      tick(); this.timer = setInterval(tick, 1000);
      setTimeout(() => $("devCode") && $("devCode").focus(), 300);
      $("devCode").oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); $("devErr").classList.remove("on"); };
      $("devForm").onsubmit = async (e) => {
        e.preventDefault(); const code = $("devCode").value;
        if (code.length !== 6) { $("devErr").textContent = "Введите 6 цифр из письма"; $("devErr").classList.add("on"); return; }
        let r; try { r = await busy($("devOk"), () => api.sessionConfirm(ch.challenge_id, code)); } catch (er) { $("devErr").textContent = er.message; $("devErr").classList.add("on"); return; }
        if (r.state === "banned") return this.banScreen(r.account);
        if (!r.ok) {
          $("devErr").textContent = r.error + (r.attempts_left != null && !r.final ? ` · осталось попыток: ${r.attempts_left}` : ""); $("devErr").classList.add("on");
          if (r.final) setTimeout(() => this.abandon(), 1600);
          return;
        }
        o.classList.add("confirmed");
        $("devOk").innerHTML = '<span class="okmark" aria-hidden="true"></span> Вход подтвержден';
        setTimeout(() => { this.closeOverlay(); Obs.track("session_confirmed"); afterLogin(false); }, 650);
      };
      resend.onclick = async () => { const r = await api.sessionResend(ch.challenge_id).catch((er) => ({ ok: false, error: er.message })); toast(r.ok ? "📬 Новый код отправлен" + (r.demo_code ? ` (демо: ${r.demo_code})` : "") : r.error); if (r.ok) { left = 60; tick(); } };
      $("devCancel").onclick = () => this.abandon();
    },
    async abandon() { await api.sessionCancel().catch(() => {}); user = null; this.closeOverlay(); showAuth("login", "Вход отменен. Старая сессия продолжает работать"); },
    // старое устройство: сессию завершил вход на другом
    async revoked(reason) {
      const txt = reason === "new_device" ? "Вы вышли из аккаунта: выполнен вход на другом устройстве"
        : reason === "banned" ? "Сессия завершена решением модератора" : reason === "password_changed" ? "Пароль изменен. Войдите снова" : "Сессия завершена. Войдите снова";
      const was = user && user.id;
      try { await api.signOut(); } catch (e) {}
      user = null; Cache.wipe(was); cache.clear(); onUserChange();
      this.closeOverlay(); showAuth("login", txt);
    },
    // любая ошибка сервера с признаком отозванной сессии или бана
    handle(e) {
      const m = (e && e.message) || "";
      if (/выполнен вход на другом устройстве|session_revoked/.test(m)) { this.revoked("new_device"); return true; }
      if (/Аккаунт заблокирован/.test(m)) { api.accountState().then((a) => this.banScreen(a)).catch(() => {}); return true; }
      if (/Подтвердите вход с этого устройства/.test(m)) { this.gate(); return true; }
      return false;
    },

    /* ---------- экран блокировки ---------- */
    banScreen(acc, offline) {
      if (!acc) return;
      this.acc = acc; this.remember(acc);
      this.offset = acc.server_now ? new Date(acc.server_now).getTime() - Date.now() : 0;
      const perm = acc.state === "banned_permanent", restricted = acc.state === "restricted";
      const term = perm ? "Бессрочно" : acc.expires_at ? durWords(new Date(acc.expires_at) - new Date(acc.starts_at || acc.server_now)) : "";
      this.overlay("ban", `
        <div class="sh-ico red">⛔</div>
        <h2>${restricted ? "Действия ограничены" : "Аккаунт заблокирован"}</h2>
        <p class="sh-sub">Доступ к функциям NEAR ${restricted ? "частично " : ""}ограничен за нарушение правил сообщества.</p>
        <div class="ban-box"><small>Причина</small><b>${esc(acc.reason || acc.rule_title || "Нарушение правил")}</b>
          <div class="ban-row"><span><small>Срок блокировки</small><b>${esc(term)}</b></span><span><small>Номер решения</small><b>${esc(acc.decision_no || "—")}</b></span></div></div>
        ${perm ? "" : `<div class="ban-timer" aria-live="off"><small>До окончания блокировки</small><div class="tm"><span><b id="tD">0</b><i>Дней</i></span><span><b id="tH">0</b><i>Часов</i></span><span><b id="tM">0</b><i>Минут</i></span><span><b id="tS">0</b><i>Секунд</i></span></div></div>`}
        ${offline ? '<p class="sh-note">Нет связи. Показано последнее известное состояние.</p>' : ""}
        <p class="sh-note">Создание новых аккаунтов для обхода блокировки запрещено.</p>
        <button class="btn btn-main big" id="banAppeal">${acc.appeal ? "Апелляция: " + ({ pending: "на рассмотрении", in_review: "на рассмотрении", upheld: "решение оставлено", overturned: "решение отменено" }[acc.appeal] || acc.appeal) : "Подать апелляцию"}</button>
        <button class="btn btn-ghost big" id="banRules">Правила сообщества</button>
        <div class="ban-links"><button class="lnk" id="banHelp">Связаться с поддержкой</button>${restricted ? '<button class="lnk" id="banClose">Продолжить просмотр</button>' : '<button class="lnk" id="banOut">Выйти</button><button class="lnk danger" id="banDel">Удалить аккаунт</button>'}</div>`);
      $("banAppeal").disabled = !!acc.appeal && acc.appeal !== "pending" && acc.appeal !== "in_review" ? false : !!acc.appeal;
      $("banAppeal").onclick = () => this.appealForm(acc);
      $("banRules").onclick = () => showRules();
      $("banHelp").onclick = () => { if (CFG.SUPPORT_EMAIL) location.href = "mailto:" + CFG.SUPPORT_EMAIL + "?subject=" + encodeURIComponent("NEAR: решение " + (acc.decision_no || "")); else bugSheet(); };
      if ($("banOut")) $("banOut").onclick = async () => { this.closeOverlay(); const was = user && user.id; await api.signOut().catch(() => {}); user = null; Cache.wipe(was); onUserChange(); showAuth("login"); };
      if ($("banDel")) $("banDel").onclick = () => deleteAccountFlow();
      if ($("banClose")) $("banClose").onclick = () => { this.closeOverlay(); this.applyAccount(acc); };
      clearInterval(this.timer);
      if (!perm && acc.expires_at) {
        const end = new Date(acc.expires_at).getTime();
        const tick = () => {
          const left = Math.max(0, end - (Date.now() + this.offset));
          const d = Math.floor(left / 864e5), h = Math.floor(left / 36e5) % 24, mi = Math.floor(left / 6e4) % 60, s = Math.floor(left / 1e3) % 60;
          [["tD", d], ["tH", h], ["tM", mi], ["tS", s]].forEach(([id, v]) => { const el = $(id); if (el && el.textContent !== String(v).padStart(2, "0")) el.textContent = String(v).padStart(2, "0"); });
          // срок истек: разблокирует только сервер (повторная проверка), локально — нет
          if (left <= 0 && !offline) { clearInterval(this.timer); setTimeout(() => this.gate(), 800); }
        };
        tick(); this.timer = setInterval(tick, 1000);
      }
    },
    appealForm(acc) {
      if (acc.appeal) return toast("Апелляция уже подана. Ответ придет в уведомлениях, обычно в течение 72 часов");
      openSheet("Апелляция", `<p class="muted" style="font-size:13.5px;margin-bottom:10px">Решение ${esc(acc.decision_no || "")}. Опишите, почему считаете его ошибочным. Апелляцию рассмотрит другой модератор, обычно в течение 72 часов.</p>
        <textarea id="apTx" maxlength="1000" rows="5" placeholder="Например: это было объявление о потере, а не реклама"></textarea>
        <div class="sheet-btns"><button class="btn btn-ghost" id="apNo">Отмена</button><button class="btn btn-main" id="apYes">Отправить</button></div>`);
      $("apNo").onclick = closeSheet;
      $("apYes").onclick = async () => {
        try { const r = await busy($("apYes"), () => api.appealSubmit(acc.ban_id, $("apTx").value)); closeSheet(); toast("✅ Апелляция отправлена"); this.banScreen({ ...acc, appeal: r.status }); }
        catch (e) { toast(e.message); }
      };
    },

    /* ---------- центр безопасности ---------- */
    async center() {
      go("sv-security");
      const box = $("secBody"); box.innerHTML = '<div class="spin"></div>';
      let sessions = [], acc = null;
      try { [sessions, acc] = await Promise.all([api.sessionList(), api.accountState()]); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      const curS = sessions.find((s) => s.current) || sessions.find((s) => s.status === "active");
      const ok = acc && acc.state === "active" && user.verified;
      const row = (k, ico, t, sub) => `<button class="sec-row" data-sec="${k}"><span class="sec-i">${ico}</span><div><b>${t}</b><small>${sub}</small></div><span class="chev">›</span></button>`;
      box.innerHTML = `
        <div class="sec-top${ok ? "" : " warn"}"><span>${ok ? "✅" : "⚠️"}</span><div><b>${ok ? "Аккаунт защищен" : acc.state === "restricted" ? "Действия ограничены" : /banned/.test(acc.state) ? "Аккаунт заблокирован" : "Подтвердите почту"}</b><small>${user.verified ? "Электронная почта подтверждена" : "Почта не подтверждена"}</small></div></div>
        ${curS ? `<div class="sec-dev"><span>📱</span><div><b>${esc(curS.device_label || "Это устройство")}</b><small>Текущее устройство</small></div><em>Активно</em></div>` : ""}
        ${row("secPw", "🔑", "Изменить пароль", "Управление доступом")}
        ${row("secMail", "✉️", "Электронная почта", user.verified ? "Подтверждена" : "Не подтверждена")}
        ${row("secHist", "🕘", "История входов", "Последние авторизации")}
        ${row("secBlock", "🚫", "Заблокированные пользователи", "Управление списком")}
        ${row("secReports", "🚩", "Мои жалобы", "Статусы рассмотрения")}
        ${row("secViol", "🛡", "Мои нарушения", "Предупреждения и ограничения")}
        ${row("secAppeals", "📄", "Апелляции", "Обжалование решений")}
        ${row("secHelp", "🎧", "Поддержка NEAR", "Связаться с нами")}
        <button class="btn btn-ghost big danger-o mt12" id="secEnd">Завершить активную сессию</button>
        <p class="dim center" style="font-size:11.5px;margin-top:10px">Активной может быть только одна сессия. Вход с нового устройства подтверждается кодом из письма.</p>`;
      const A = { secPw: () => changePasswordSheet(), secMail: () => this.changeEmail(), secHist: () => this.history(sessions), secBlock: () => blockedSheet(),
        secReports: () => this.myReports(), secViol: () => this.violations(false), secAppeals: () => this.violations(true),
        secHelp: () => (CFG.SUPPORT_EMAIL ? (location.href = "mailto:" + CFG.SUPPORT_EMAIL) : bugSheet()) };
      qa("[data-sec]", box).forEach((b) => (b.onclick = () => A[b.dataset.sec]()));
      $("secEnd").onclick = async () => { if (!(await confirmSheet("Завершить сессию?", "Вы выйдете из NEAR на этом устройстве.", "Выйти", true))) return; await logout(); };
    },
    history(list) {
      const R = { new_device: "вход на другом устройстве", logout: "выход", banned: "решение модератора", password_changed: "смена пароля", same_device: "повторный вход", cancelled: "вход отменен", deleted: "удаление" };
      openSheet("История входов", list.length ? list.map((s) => `<div class="hist-row"><b>${esc(s.device_label || "Устройство")}${s.current ? " · это устройство" : ""}</b>
        <small>${fmtWhen(s.created_at)} · ${s.status === "active" ? '<em class="ok">активна</em>' : s.status === "pending" ? "ждет подтверждения" : "завершена" + (s.revoke_reason ? ": " + (R[s.revoke_reason] || s.revoke_reason) : "")}</small></div>`).join("")
        : '<div class="dim">История пуста</div>');
    },
    async violations(appealsOnly) {
      const list = (await api.myDecisions().catch(() => [])).filter((d) => !appealsOnly || d.appeal_status);
      const K = { warning: "Предупреждение", restricted: "Ограничение", ban: "Блокировка" }, S = { active: "действует", expired: "срок истек", revoked: "отменено" };
      const A = { pending: "на рассмотрении", in_review: "на рассмотрении", upheld: "решение оставлено", overturned: "решение отменено" };
      openSheet(appealsOnly ? "Апелляции" : "Мои нарушения", list.length ? list.map((d) => `<div class="dec-row"><div><b>${K[d.kind] || d.kind} · ${esc(d.rule_title || d.rule)}</b>
        <small>${esc(d.decision_no)} · ${fmtWhen(d.starts_at)}${d.expires_at ? " → " + fmtWhen(d.expires_at) : d.kind === "ban" ? " · бессрочно" : ""} · ${S[d.status] || d.status}</small>
        <p>${esc(d.reason)}</p>${d.appeal_status ? `<em>Апелляция: ${A[d.appeal_status] || d.appeal_status}${d.appeal_note ? " — " + esc(d.appeal_note) : ""}</em>` : ""}</div>
        ${d.status === "active" && !d.appeal_status && d.kind !== "warning" ? `<button class="btn btn-ghost sm" data-appeal="${d.id}">Обжаловать</button>` : ""}</div>`).join("")
        : `<div class="empty-mini">${appealsOnly ? "Апелляций нет" : "Нарушений нет — спасибо, что соблюдаете правила 💜"}</div>`);
      qa("[data-appeal]", $("bsList")).forEach((b) => (b.onclick = async () => { const acc = await api.accountState(); closeSheet(); this.appealForm({ ...acc, ban_id: b.dataset.appeal, decision_no: (list.find((x) => x.id === b.dataset.appeal) || {}).decision_no }); }));
    },
    async myReports() {
      const list = await (api.myReports ? api.myReports() : Promise.resolve([])).catch(() => []);
      openSheet("Мои жалобы", list.length ? list.map((r) => `<div class="hist-row"><b>${esc(REASON_TXT(r.reason))}</b><small>${fmtWhen(r.created_at)} · ${{ open: "на рассмотрении", resolved: "приняты меры", dismissed: "нарушений не найдено" }[r.status] || r.status}</small></div>`).join("")
        : '<div class="empty-mini">Вы еще не отправляли жалоб</div>');
    },
    changeEmail() {
      // повторное подтверждение личности, затем письмо на новую почту
      openSheet("Изменить почту", `<p class="muted" style="font-size:13px;margin-bottom:10px">Сначала подтвердите, что это вы: введите текущий пароль.</p>
        <input id="ceOld" type="password" placeholder="Текущий пароль" autocomplete="current-password"><input id="ceNew" type="email" class="mt8" placeholder="Новая почта" autocomplete="email">
        <div class="sheet-btns"><button class="btn btn-ghost" id="ceNo">Отмена</button><button class="btn btn-main" id="ceYes">Изменить</button></div>`);
      $("ceNo").onclick = closeSheet;
      $("ceYes").onclick = async () => {
        try {
          await busy($("ceYes"), async () => { await api.reauth($("ceOld").value); await api.changeEmail($("ceNew").value); });
          closeSheet(); toast("📬 Подтвердите новую почту по ссылке из письма");
        } catch (e) { toast(e.message); }
      };
    }
  };
  const REASON_TXT = (r) => (N.REASON_LABELS && N.REASON_LABELS[r]) || r;
  function durWords(ms) {
    const h = Math.round(ms / 36e5);
    if (h <= 24) return h + " " + plural(h, "час", "часа", "часов");
    const d = Math.round(h / 24); return d + " " + plural(d, "день", "дня", "дней");
  }
  function changePasswordSheet() {
    openSheet("Изменить пароль", `<input id="cpOld" type="password" placeholder="Текущий пароль" autocomplete="current-password"><input id="cpNew" type="password" class="mt8" placeholder="Новый пароль (минимум 8 символов)" autocomplete="new-password">
      <p class="dim" style="font-size:11.5px;margin-top:8px">После смены пароля все остальные сессии завершатся.</p>
      <div class="sheet-btns"><button class="btn btn-ghost" id="cpNo">Отмена</button><button class="btn btn-main" id="cpYes">Сохранить</button></div>`);
    $("cpNo").onclick = closeSheet;
    $("cpYes").onclick = async () => {
      const nw = $("cpNew").value; if (nw.length < 8 || !/\d/.test(nw) || !/\p{L}/u.test(nw)) return toast("Пароль: минимум 8 символов, буквы и цифры");
      try { await busy($("cpYes"), async () => { await api.reauth($("cpOld").value); await api.updatePassword(nw); }); closeSheet(); toast("🔑 Пароль изменен"); Shield.gate(); }
      catch (e) { toast(e.message); }
    };
  }
  // возвращение в приложение: сервер мог завершить сессию или вынести решение
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !user || !api || !api.sessionState) return;
    api.sessionState().then((s) => {
      if (!s) return;
      if (s.state === "revoked") return Shield.revoked(s.reason);
      if (s.account && /banned/.test(s.account.state)) return Shield.banScreen(s.account);
      if ($("shieldOv").classList.contains("ban") && s.account && !/banned/.test(s.account.state)) Shield.closeOverlay();
      Shield.applyAccount(s.account);
    }).catch(() => {});
  });
