  /* =====================================================
     NEAR SHIELD ADMIN: решения только с причиной, все действия — в журнале аудита.
     Роли: модератор (временные санкции), старший администратор (бессрочные, пересмотр), аудит (журнал).
     ===================================================== */
  const ShieldAdmin = {
    tab: "users", role: null,
    async open() {
      go("sv-shield"); const box = $("shBody"); box.innerHTML = '<div class="spin"></div>';
      this.role = await api.staffRole().catch(() => null);
      if (!this.role || !(this.role.moderator || this.role.admin || this.role.auditor)) { box.innerHTML = '<div class="empty">Раздел доступен модераторам и администраторам</div>'; return; }
      if (this.role.mfa_required && this.role.aal !== "aal2") return this.mfa(box);
      $("shSub").textContent = this.role.admin ? "старший администратор" : this.role.moderator ? "модератор" : "аудит";
      let ov = {}; try { ov = await api.shieldOverview(); } catch (e) {}
      box.innerHTML = `<div class="adm-tiles"><div><b class="red">${ov.active_bans ?? "—"}</b><span>Активные баны</span></div><div><b class="org">${ov.evasion ?? "—"}</b><span>Подозрения на обход</span></div>
        <div><b class="vio">${ov.appeals ?? "—"}</b><span>Апелляции${ov.overdue_appeals ? ` · <em>${ov.overdue_appeals} просрочено</em>` : ""}</span></div><div><b>${ov.reports ?? "—"}</b><span>Новые жалобы</span></div></div>
        <div class="seg" id="admSeg"><button data-t="users" class="${this.tab === "users" ? "on" : ""}">Пользователи</button><button data-t="queue" class="${this.tab === "queue" ? "on" : ""}">Очередь · ${ov.queue ?? 0}</button>${this.role.auditor || this.role.admin ? `<button data-t="audit" class="${this.tab === "audit" ? "on" : ""}">Журнал</button>` : ""}</div>
        <div id="admBody"></div>`;
      qa("#admSeg [data-t]").forEach((b) => (b.onclick = () => { this.tab = b.dataset.t; qa("#admSeg button").forEach((x) => x.classList.toggle("on", x === b)); this.render(); }));
      this.render();
    },
    render() { if (this.tab === "users") this.users(); else if (this.tab === "queue") this.queue(); else this.audit(); },
    async users(q = "") {
      const box = $("admBody");
      box.innerHTML = `<input class="qin" id="admQ" type="search" placeholder="🔍 Поиск по нику или ID" value="${esc(q)}" autocomplete="off"><div id="admList"><div class="spin"></div></div>`;
      let t = null; $("admQ").oninput = () => { clearTimeout(t); t = setTimeout(() => this.list($("admQ").value), 300); };
      this.list(q);
    },
    async list(q) {
      const L = $("admList"); if (!L) return;
      try {
        const rows = await api.shieldFind(q);
        const ST = { active: "", restricted: "ограничен", banned_until: "активная блокировка", banned_permanent: "бессрочная блокировка" };
        L.innerHTML = rows.length ? rows.map((u) => `<button class="u-row" data-adm="${u.id}">${ava({ name: u.nickname || "?" })}<div class="tx"><b translate="no">@${esc(u.nickname || u.name || "")}</b><span>${ST[u.state] ? `<em class="red-t">${ST[u.state]}</em> · ` : ""}риск ${u.risk}</span></div><span class="chev">›</span></button>`).join("") : '<div class="empty-mini">Никого не нашли</div>';
        L.onclick = (e) => { const b = e.target.closest("[data-adm]"); if (b) this.card(b.dataset.adm); };
      } catch (e) { L.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    },
    async card(id) {
      const box = $("admBody"); box.innerHTML = '<div class="spin"></div>';
      let c; try { c = await api.shieldUserCard(id); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      const acc = c.account || {}, rep = c.reputation || {}, last = (c.decisions || [])[0];
      const banned = /banned/.test(acc.state), term = acc.state === "banned_permanent" ? "Бессрочно" : acc.expires_at ? durWords(new Date(acc.expires_at) - new Date(acc.starts_at || Date.now())) : "—";
      const RISK = { evasion: "Подозрение на обход бана", mass_reg: "Массовая регистрация", violation: "Подтвержденные нарушения", suspicious: "Подозрительная активность" };
      box.innerHTML = `<button class="lnk" id="admBack">‹ К списку</button>
        <div class="adm-card"><div class="adm-h">${ava({ name: c.user.nickname || "?" })}<div><b translate="no">@${esc(c.user.nickname || "")}</b>${banned ? '<em class="red-t"> Активная блокировка</em>' : acc.state === "restricted" ? '<em class="org-t"> Ограничение</em>' : ""}<small>В NEAR с ${dfmt(c.user.created_at, { day: "numeric", month: "long", year: "numeric" })}</small></div></div>
        <div class="adm-grid">
          <div><small>Репутация</small><b>${rep.score == null ? "нет данных" : rep.score + "/100"}</b></div><div><small>Risk Score</small><b class="${c.risk >= 75 ? "red-t" : c.risk >= 50 ? "org-t" : ""}">${c.risk}/100${c.hold ? " · на проверке" : ""}</b></div>
          <div><small>Всего жалоб</small><b>${c.reports.total}</b></div><div><small>Подтверждено</small><b>${c.reports.confirmed}</b></div>
          <div><small>Отклонено</small><b>${c.reports.rejected}</b></div><div><small>На проверке</small><b>${c.reports.open}</b></div>
          <div><small>Связанные аккаунты — кандидаты</small><b>${(c.links || []).filter((l) => l.status === "pending").length}</b></div><div><small>Срок блокировки</small><b>${banned || acc.state === "restricted" ? term : "—"}</b></div></div>
        ${last ? `<div class="adm-last"><small>Причина последнего решения · ${esc(last.no)}</small><p>${esc(last.reason)}</p></div>` : ""}
        ${(c.risk_events || []).length ? `<div class="adm-risk"><b>NEAR Risk Engine</b>${c.risk_events.map((r) => `<div><span>${RISK[r.type] || r.type}${r.confirmed ? " ✓" : ""}</span><em>+${r.weight}</em></div>`).join("")}<p class="dim">Высокий риск сам по себе не основание для бессрочного бана. Сигналы без подтверждения истекают через 7 дней.</p></div>` : ""}
        </div>
        <div class="adm-acts">
          <button class="btn adm-b vio" id="admLinks">Проверить связанные аккаунты</button>
          ${banned && acc.expires_at ? '<button class="btn adm-b red" id="admExt">Продлить блокировку</button>' : ""}
          ${acc.ban_id ? '<button class="btn btn-ghost" id="admLift">Снять ограничение</button>' : ""}
          <button class="btn btn-main" id="admSanc">Вынести решение</button>
          ${c.hold ? '<button class="btn btn-ghost" id="admRisk">Решение по проверке риска</button>' : ""}
          <button class="btn btn-ghost" id="admHist">История нарушений</button>
        </div>`;
      $("admBack").onclick = () => this.users();
      $("admLinks").onclick = () => this.links(c);
      if ($("admExt")) $("admExt").onclick = () => this.extend(c);
      if ($("admLift")) $("admLift").onclick = () => this.lift(c);
      if ($("admRisk")) $("admRisk").onclick = () => this.riskDecide(c);
      $("admSanc").onclick = () => this.sanction(c);
      $("admHist").onclick = () => this.history(c);
    },
    // матрица пилота: срок предлагается по правилу и повторности, причина обязательна
    sanction(c) {
      const R = c.rules || N.BAN_RULES, prior = (c.decisions || []).filter((d) => d.status === "active" || d.status === "revoked").length;
      openSheet("Решение по @" + (c.user.nickname || ""), `<div class="lbl">Нарушение</div><select id="snRule">${Object.entries(R).map(([k, v]) => `<option value="${k}">${esc(v.title)}</option>`).join("")}</select>
        <div class="lbl mt8">Вид</div><div class="seg" id="snKind"><button data-k="warning">Предупреждение</button><button data-k="restricted">Ограничение</button><button data-k="ban" class="on">Бан</button></div>
        <div class="lbl mt8">Срок</div><select id="snTerm"><option value="24">24 часа</option><option value="168">7 дней</option><option value="720">30 дней</option>${this.role.admin ? '<option value="perm">Бессрочно (старший администратор)</option>' : ""}</select>
        <div class="s-note" id="snHint"></div>
        <textarea id="snReason" maxlength="500" rows="3" placeholder="Причина (обязательно): что нарушено и где"></textarea>
        <textarea id="snEv" maxlength="2000" rows="2" class="mt8" placeholder="Доказательства: ссылки на публикации, номера жалоб"></textarea>
        <div class="sheet-btns"><button class="btn btn-ghost" id="snNo">Отмена</button><button class="btn btn-main" id="snYes">Подтвердить решение</button></div>`);
      let kind = "ban";
      const hint = () => { const r = R[$("snRule").value]; const h = prior ? r.repeat : r.first; $("snHint").textContent = `Матрица пилота: ${prior ? "повторное" : "первое"} нарушение — ${h === 0 ? "предупреждение" : h == null ? "бессрочно" : durWords(h * 3600e3)}. Окончательный выбор — по тяжести и доказательствам.`;
        if (h && h <= 720) $("snTerm").value = String(h); };
      $("snRule").onchange = hint; hint();
      qa("#snKind [data-k]").forEach((b) => (b.onclick = () => { kind = b.dataset.k; qa("#snKind button").forEach((x) => x.classList.toggle("on", x === b)); $("snTerm").disabled = kind === "warning"; }));
      $("snNo").onclick = closeSheet;
      $("snYes").onclick = async () => {
        const reason = $("snReason").value.trim(); if (reason.length < 5) return toast("Укажите причину решения");
        const tv = $("snTerm").value, hours = kind === "warning" ? null : tv === "perm" ? null : +tv;
        if (!(await confirmSheet("Подтвердить решение?", `${kind === "ban" ? "Бан" : kind === "restricted" ? "Ограничение" : "Предупреждение"}${hours ? " на " + durWords(hours * 3600e3) : kind === "warning" ? "" : " бессрочно"}. Решение получит номер и попадет в журнал.`, "Подтвердить", kind === "ban"))) return;
        try { const r = await api.shieldSanction(c.user.id, $("snRule").value, kind, hours, reason, $("snEv").value.trim()); closeSheet(); toast("Решение " + (r.decision_no || "") + " вынесено"); this.card(c.user.id); }
        catch (e) { toast(e.message); }
      };
    },
    extend(c) {
      openSheet("Продлить блокировку", `<p class="muted" style="font-size:13px">Только за доказанный обход блокировки, не больше 30 дней от нового решения.</p>
        <select id="exDays"><option value="7">7 дней</option><option value="14">14 дней</option><option value="30">30 дней</option></select>
        <textarea id="exWhy" class="mt8" rows="3" maxlength="500" placeholder="Доказательства обхода (обязательно)"></textarea>
        <div class="sheet-btns"><button class="btn btn-ghost" id="exNo">Отмена</button><button class="btn btn-main" id="exYes">Продлить</button></div>`);
      $("exNo").onclick = closeSheet;
      $("exYes").onclick = async () => { try { await api.shieldExtend(c.account.ban_id, +$("exDays").value, $("exWhy").value); closeSheet(); toast("Блокировка продлена"); this.card(c.user.id); } catch (e) { toast(e.message); } };
    },
    lift(c) {
      openSheet("Снять ограничение", `<p class="muted" style="font-size:13px">Права восстановятся, штраф репутации будет сторнирован. Другие действующие решения останутся.</p>
        <textarea id="lfWhy" rows="3" maxlength="500" placeholder="Причина (обязательно)"></textarea>
        <div class="sheet-btns"><button class="btn btn-ghost" id="lfNo">Отмена</button><button class="btn btn-main" id="lfYes">Снять</button></div>`);
      $("lfNo").onclick = closeSheet;
      $("lfYes").onclick = async () => { try { await api.shieldRevoke(c.account.ban_id, $("lfWhy").value); closeSheet(); toast("Ограничение снято"); this.card(c.user.id); } catch (e) { toast(e.message); } };
    },
    links(c) {
      const L = c.links || [];
      openSheet("Связанные аккаунты", L.length ? L.map((l) => `<div class="dec-row"><div><b translate="no">@${esc(l.nickname || "")}</b><small>совпадение: ${esc((l.evidence && l.evidence.match) === "installation" ? "установка NEAR" : JSON.stringify(l.evidence))} · ${l.status === "pending" ? "на проверке" : l.status === "confirmed" ? "подтверждено" : "отклонено"}</small></div>
        ${l.status === "pending" ? `<button class="btn btn-ghost sm" data-lk="${l.id}" data-ok="1">Подтвердить</button><button class="btn btn-ghost sm" data-lk="${l.id}" data-ok="0">Отклонить</button>` : ""}</div>`).join("")
        + '<p class="dim" style="font-size:12px;margin-top:8px">Совпадение установки, IP или телефона само по себе не доказывает обход. Подтверждение применяет оставшийся срок исходного бана.</p>'
        : '<div class="empty-mini">Кандидатов нет</div>');
      qa("[data-lk]", $("bsList")).forEach((b) => (b.onclick = async () => {
        const note = await askText(b.dataset.ok === "1" ? "Обоснование подтверждения связи" : "Почему связь отклонена"); if (!note) return;
        try { await api.shieldLinkDecide(b.dataset.lk, b.dataset.ok === "1", note); closeSheet(); toast("Решение по связи сохранено"); this.card(c.user.id); } catch (e) { toast(e.message); }
      }));
    },
    riskDecide(c) {
      openSheet("Проверка риска", `<p class="muted" style="font-size:13px">Рискованные действия ограничены не дольше 24 часов до вашего решения. Автоматически не продлевается.</p>
        <textarea id="rkWhy" rows="2" maxlength="300" placeholder="Комментарий"></textarea>
        <div class="sheet-btns"><button class="btn btn-ghost" id="rkKeep">Оставить</button><button class="btn btn-main" id="rkClear">Снять ограничение</button></div>`);
      const go2 = async (clear) => { try { await api.riskDecide(c.user.id, clear, $("rkWhy").value); closeSheet(); toast("Решение сохранено"); this.card(c.user.id); } catch (e) { toast(e.message); } };
      $("rkKeep").onclick = () => go2(false); $("rkClear").onclick = () => go2(true);
    },
    history(c) {
      const K = { warning: "Предупреждение", restricted: "Ограничение", ban: "Бан" };
      openSheet("История нарушений", (c.decisions || []).length ? c.decisions.map((d) => `<div class="dec-row"><div><b>${esc(d.no)} · ${K[d.kind] || d.kind}${d.scope !== "global" ? " (" + (d.scope === "meeting" ? "встреча" : "чат") + ")" : ""}</b>
        <small>${fmtWhen(d.starts_at)}${d.expires_at ? " → " + fmtWhen(d.expires_at) : d.kind === "ban" ? " · бессрочно" : ""} · ${d.status === "revoked" ? "отменено" : "действует"} · автор @${esc(d.moderator || "—")}</small><p>${esc(d.reason)}</p></div></div>`).join("")
        + (c.appeals || []).map((a) => `<div class="dec-row"><div><b>Апелляция · ${({ pending: "ждет", in_review: "на рассмотрении", upheld: "оставлено", overturned: "отменено" })[a.status] || a.status}</b><small>до ${fmtWhen(a.due_at)}</small><p>${esc(a.message)}</p></div>
          ${["pending", "in_review"].includes(a.status) ? `<button class="btn btn-ghost sm" data-ap="${a.id}" data-ov="1">Отменить решение</button><button class="btn btn-ghost sm" data-ap="${a.id}" data-ov="0">Оставить</button>` : ""}</div>`).join("")
        : '<div class="empty-mini">Нарушений нет</div>');
      qa("[data-ap]", $("bsList")).forEach((b) => (b.onclick = async () => {
        const note = await askText("Мотивировка решения по апелляции"); if (!note) return;
        try { await api.appealDecide(b.dataset.ap, b.dataset.ov === "1", note); closeSheet(); toast("Апелляция рассмотрена, пользователь уведомлен"); this.card(c.user.id); } catch (e) { toast(e.message); }
      }));
    },
    async queue() {
      const box = $("admBody"); box.innerHTML = '<div class="spin"></div>';
      try {
        const rows = await api.shieldQueue();
        const RS = { threat: "🚨 Угроза", minors: "⛔ Несовершеннолетние", intimate: "🔞 Интимный контент", insult: "Оскорбление", evasion: "Подозрение на обход", risk_hold: "Высокий риск", appeal: "Апелляция", media_review: "Файл на проверке", disputed: "Спорная посещаемость", ai_unavailable: "ИИ недоступен" };
        box.innerHTML = rows.length ? rows.map((q) => `<div class="q-row p${q.priority}"><div><b>${RS[q.reason] || esc(q.reason)}</b><small>${esc(q.content_type)} · @${esc(q.nickname || "—")} · ${timeAgo(q.created_at)}</small>${q.preview ? `<p translate="no">${esc(q.preview)}</p>` : ""}</div>
          ${q.content_type === "post_media" ? `<button class="btn btn-ghost sm" data-md="${q.content_id}" data-ok="1">Опубликовать</button><button class="btn btn-ghost sm" data-md="${q.content_id}" data-ok="0">Отклонить</button>` : q.user_id ? `<button class="btn btn-ghost sm" data-qu="${q.user_id}">Карточка</button>` : ""}</div>`).join("")
          : '<div class="empty-mini">Очередь пуста 🎉</div>';
        box.onclick = async (e) => {
          const md = e.target.closest("[data-md]"); if (md) { try { await api.mediaDecide(md.dataset.md, md.dataset.ok === "1"); toast("Решение сохранено"); this.queue(); } catch (er) { toast(er.message); } return; }
          const qu = e.target.closest("[data-qu]"); if (qu) { this.tab = "users"; qa("#admSeg button").forEach((x) => x.classList.toggle("on", x.dataset.t === "users")); this.card(qu.dataset.qu); }
        };
      } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    },
    async audit() {
      const box = $("admBody"); box.innerHTML = '<div class="spin"></div>';
      try {
        const rows = await api.auditList();
        box.innerHTML = rows.length ? rows.map((a) => `<div class="hist-row"><b>${esc(a.action)}</b><small>${fmtWhen(a.created_at)} · ${esc(JSON.stringify(a.details || {})).slice(0, 140)}</small></div>`).join("") : '<div class="empty-mini">Журнал пуст</div>';
      } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    },
    // второй фактор для администраторов (TOTP)
    async mfa(box) {
      const f = api.mfaFactors ? await api.mfaFactors().catch(() => []) : [];
      const verified = f.find((x) => x.status === "verified");
      box.innerHTML = `<div class="empty"><b>Нужен второй фактор</b>Для панели NEAR Shield включите вход с кодом из приложения-аутентификатора (Google Authenticator, 1Password и др.).
        ${verified ? "" : '<div id="mfaQr" class="mfa-qr"></div>'}<input id="mfaCode" class="mt12" inputmode="numeric" maxlength="6" placeholder="Код из приложения"><button class="btn btn-main mt12" id="mfaGo">${verified ? "Подтвердить" : "Подключить"}</button></div>`;
      let factor = verified;
      if (!verified) { try { factor = await api.mfaEnroll(); $("mfaQr").innerHTML = `<img src="${factor.totp.qr_code}" alt="QR-код для приложения-аутентификатора"><small>${esc(factor.totp.secret)}</small>`; } catch (e) { toast(e.message); } }
      $("mfaGo").onclick = async () => { try { await api.mfaVerify(factor.id, $("mfaCode").value); toast("Второй фактор подтвержден"); this.open(); } catch (e) { toast(e.message); } };
    }
  };
  // короткий ввод текста в нижней панели (вместо системного prompt)
  function askText(title, ph = "") {
    return new Promise((res) => {
      openSheet(title, `<textarea id="askTx" rows="3" maxlength="500" placeholder="${esc(ph || "Минимум 5 символов")}"></textarea>
        <div class="sheet-btns"><button class="btn btn-ghost" id="askNo">Отмена</button><button class="btn btn-main" id="askYes">Готово</button></div>`);
      $("askNo").onclick = () => { closeSheet(); res(null); };
      $("askYes").onclick = () => { const v = $("askTx").value.trim(); if (v.length < 5) return toast("Минимум 5 символов"); closeSheet(); res(v); };
    });
  }
