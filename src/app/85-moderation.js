  /* =====================================================
     ПАНЕЛЬ МОДЕРАТОРА
     ===================================================== */
  let modTab = "reports";
  $("modSeg").onclick = (e) => { const b = e.target.closest("[data-t]"); if (!b) return; modTab = b.dataset.t; qa("#modSeg button").forEach((x) => x.classList.toggle("on", x === b)); renderMod(); };
  const TT = { post: "📝 Публикация", comment: "💬 Комментарий", message: "✉️ Сообщение", user: "👤 Пользователь" };
  async function renderMod() {
    const box = $("modList"); box.innerHTML = '<div class="spin"></div>';
    const tAp = document.querySelector('#modSeg [data-t="health"]'); if (tAp) tAp.classList.toggle("hidden", !(user && user.is_admin));
    // ТЗ 45/60: модератор работает только со вторым фактором (TOTP); без него сервер не дает прав
    if (api.mode !== "local") {
      const acc = await api.account().catch(() => null);
      if (acc && acc.mod_role && !acc.mfa_ok) return renderMfa(box);
    }
    if (modTab === "media") return renderModMedia(box);
    if (modTab === "city") return renderCity(box);
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
          ${r.target_user ? `<button data-act="restrict" data-uid="${r.target_user}">⏸ Ограничить</button>` : ""}
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
    const md = e.target.closest("[data-media]");
    if (md) {
      const id = md.closest("[data-mid]").dataset.mid, ok = md.dataset.media === "ok";
      if (ok) { try { await api.modMedia(id, true); toast("Файл одобрен"); renderMod(); } catch (er) { toast(er.message); } return; }
      openSheet("Отклонить файл", `<div class="fld"><label for="mdWhy">Причина (увидит автор)</label><input id="mdWhy" maxlength="160" value="Нарушает правила сообщества"></div>
        <div class="sheet-btns"><button class="btn btn-ghost" id="mdNo">Отмена</button><button class="btn btn-danger" id="mdYes">Отклонить</button></div>`);
      $("mdNo").onclick = closeSheet;
      $("mdYes").onclick = async () => { try { await busy($("mdYes"), () => api.modMedia(id, false, $("mdWhy").value.trim())); closeSheet(); toast("Файл отклонен"); renderMod(); } catch (er) { toast(er.message); } };
      return;
    }
    const b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "restrict") return restrictSheet(b.dataset.uid);
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

  /* ---------- v14.2: второй фактор для модератора (ТЗ 45/60) ---------- */
  async function renderMfa(box) {
    $("modSub").textContent = "нужна двухэтапная защита";
    box.innerHTML = '<div class="spin"></div>';
    try {
      const st = await api.mfaState();
      if (st.factorId) {
        box.innerHTML = `<div class="mfa"><b>🔐 Подтвердите вход</b><p>Введите 6 цифр из приложения-аутентификатора (Google Authenticator, Яндекс Ключ, 1Password и т. п.).</p>
          <input id="mfaCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"><div class="err" id="mfaErr" role="alert"></div>
          <button class="btn btn-main full" id="mfaGo">Подтвердить</button></div>`;
        $("mfaGo").onclick = () => verify(st.factorId);
      } else {
        box.innerHTML = `<div class="mfa"><b>🔐 Включите двухэтапную защиту</b><p>Права модератора работают только со вторым фактором: так чужой человек не получит доступ к жалобам и решениям, даже узнав пароль.</p>
          <button class="btn btn-main full" id="mfaNew">Включить</button></div>`;
        $("mfaNew").onclick = async () => {
          try {
            const f = await busy($("mfaNew"), () => api.mfaEnroll());
            box.innerHTML = `<div class="mfa"><b>1. Отсканируйте код</b><p>в приложении-аутентификаторе на телефоне</p><img class="mfa-qr" src="${esc(f.qr)}" alt="QR-код для приложения-аутентификатора">
              <p class="dim">Или введите ключ вручную: <code translate="no">${esc(f.secret)}</code></p>
              <b>2. Введите 6 цифр из приложения</b><input id="mfaCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"><div class="err" id="mfaErr" role="alert"></div>
              <button class="btn btn-main full" id="mfaGo">Подтвердить</button></div>`;
            $("mfaGo").onclick = () => verify(f.factorId);
          } catch (e) { toast(e.message); }
        };
      }
    } catch (e) { box.innerHTML = `<div class="empty"><b>Не удалось проверить защиту</b>${esc(e.message)}</div>`; }
    async function verify(fid) {
      try { await busy($("mfaGo"), () => api.mfaVerify(fid, $("mfaCode").value)); user = api.user(); toast("Защита подтверждена"); renderMod(); }
      catch (e) { $("mfaErr").textContent = e.message; $("mfaErr").classList.add("on"); }
    }
  }

  /* ---------- v14.2: очередь файлов (ТЗ 06): без одобрения файл видит только автор ---------- */
  async function renderModMedia(box) {
    try {
      const list = await api.modMediaQueue();
      $("modSub").textContent = list.length ? list.length + " файлов ждут проверки" : "все файлы проверены";
      const ST = { review: "ждет модератора", pending: "проверяет ИИ", flagged: "ИИ: подозрение" };
      box.innerHTML = list.length ? list.map((m) => `<div class="rep" data-mid="${m.id}"><div class="rh"><span>${m.type === "video" ? "🎬 Видео" : "🖼 Фото"} · ${ST[m.status] || m.status}</span><span>${timeAgo(m.created_at)}</span></div>
          <div class="dim" style="font-size:11.5px">Автор: <b translate="no">${esc(m.author || "?")}</b></div><div class="pv" translate="no">${esc(m.text || "")}</div>
          ${m.url ? (m.type === "video" ? `<video class="rep-img" src="${esc(m.url)}" controls muted playsinline preload="metadata"></video>` : `<img class="rep-img" src="${esc(m.url)}" alt="" data-zoom>`) : '<div class="dim">файл недоступен</div>'}
          <div class="ra"><button data-act2="open" data-post="${m.post_id}">Публикация</button><button class="okb" data-media="ok">Одобрить</button><button class="danger" data-media="no">Отклонить</button></div></div>`).join("")
        : '<div class="empty"><b>Очередь пуста</b>Новые фото и видео появятся здесь, если ИИ-проверка выключена или сомневается</div>';
    } catch (e) { box.innerHTML = `<div class="empty"><b>Нет доступа</b>${esc(e.message)}</div>`; }
  }

  /* ---------- v14.2: ограничение функции на срок (ТЗ 10/45) ---------- */
  function restrictSheet(uid) {
    const admin = user && user.is_admin;
    openSheet("Ограничить пользователя", `<div class="fld"><label for="rsScope">Что ограничить</label><select id="rsScope"><option value="comment">Комментарии</option><option value="post">Публикации</option><option value="chat">Сообщения</option><option value="meet">Встречи</option><option value="all">Все действия</option></select></div>
      <div class="fld"><label for="rsDays">Срок</label><select id="rsDays"><option value="1">24 часа — повторный спам</option><option value="7">7 дней — травля</option><option value="30">30 дней — тяжелое нарушение</option>${admin ? '<option value="">Бессрочно (только администратор)</option>' : ""}</select></div>
      <div class="fld"><label for="rsWhy">Причина (увидит пользователь)</label><textarea id="rsWhy" maxlength="500" style="min-height:70px" placeholder="Например: повторяющиеся рекламные комментарии"></textarea></div>
      <div class="err" id="rsErr" role="alert"></div><div class="sheet-btns"><button class="btn btn-ghost" id="rsNo">Отмена</button><button class="btn btn-main" id="rsYes">Ограничить</button></div>`);
    $("rsNo").onclick = closeSheet;
    $("rsYes").onclick = async () => {
      try { await busy($("rsYes"), () => api.modRestrict(uid, $("rsScope").value, $("rsDays").value ? +$("rsDays").value : null, $("rsWhy").value.trim())); closeSheet(); toast("Ограничение назначено"); renderMod(); }
      catch (e) { $("rsErr").textContent = e.message; $("rsErr").classList.add("on"); }
    };
  }

  /* ---------- v14.2: NEAR City — официальные карточки (ТЗ 55) ---------- */
  async function renderCity(box) {
    $("modSub").textContent = "официальные сообщения города";
    box.innerHTML = `<div class="s-note">Только проверенная информация из источника: акимат, Алматы Су, энергоснабжение, Казгидромет, организаторы. Не придумывайте сроки — пишите, только если они известны. Повторное сохранение с тем же ID источника обновляет карточку, каждая версия сохраняется в журнал.</div>
      <button class="btn btn-main full mt12" id="cityNew">+ Новая официальная карточка</button><div id="cityList" class="mt12"><div class="spin"></div></div>`;
    $("cityNew").onclick = () => cityForm();
    try {
      const list = await api.cityList();
      $("cityList").innerHTML = list.length ? list.map((p) => `<div class="rep"><div class="rh"><span>${(CATS[p.category] || CATS.talk).e} ${esc(p.source_name || "")}${p.status === "closed" ? ' <span class="tag-mini">закрыто</span>' : ""}</span><span>проверено ${timeAgo(p.verified_at || p.created_at)}</span></div>
          <div class="pv" translate="no"><b>${esc((p.meta && p.meta.title) || "")}</b> ${esc(p.text)}</div><div class="ra"><button data-act2="open" data-post="${p.id}">Открыть</button></div></div>`).join("")
        : '<div class="empty"><b>Пока пусто</b>Добавьте первое официальное сообщение для пилотного района</div>';
    } catch (e) { $("cityList").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  function cityForm() {
    openSheet("Официальная карточка", `<div class="fld"><label for="ctSrc">Источник</label><input id="ctSrc" maxlength="80" placeholder="Например: Алматы Су"></div>
      <div class="fld"><label for="ctUrl">Ссылка на источник (https)</label><input id="ctUrl" inputmode="url" placeholder="https://..."></div>
      <div class="fld"><label for="ctId">ID в источнике <small class="dim">для обновления той же карточки</small></label><input id="ctId" maxlength="120" placeholder="almatysu:2026-11-24-1"></div>
      <div class="row2"><div class="fld"><label for="ctCat">Тип</label><select id="ctCat"><option value="incident">Происшествие / отключение</option><option value="event">Событие</option><option value="talk">Новость</option></select></div>
        <div class="fld"><label for="ctIt">Вид</label><select id="ctIt"><option value="">—</option><option value="water">Вода</option><option value="power">Свет</option><option value="gas">Газ</option><option value="heat">Отопление</option><option value="road">Дорога</option><option value="other">Другое</option></select></div></div>
      <div class="fld"><label for="ctTitle">Заголовок</label><input id="ctTitle" maxlength="80" placeholder="Временное отключение воды"></div>
      <div class="fld"><label for="ctText">Описание</label><textarea id="ctText" maxlength="1000" style="min-height:80px" placeholder="Район, улицы, время восстановления — только если известно"></textarea></div>
      <div class="fld"><label for="ctExp">Актуально до <small class="dim">необязательно</small></label><input id="ctExp" type="datetime-local"></div>
      <div class="loc-box"><span class="e">📍</span><div><b id="ctLocT">Место: ${esc(pos.src === "gps" ? "где я" : "центр карты")}</b><span>точка на карте — по центру текущего места</span></div></div>
      <div class="err" id="ctErr" role="alert"></div><div class="sheet-btns"><button class="btn btn-ghost" id="ctNo">Отмена</button><button class="btn btn-main" id="ctYes">Опубликовать</button></div>`);
    $("ctNo").onclick = closeSheet;
    $("ctYes").onclick = async () => {
      const exp = $("ctExp").value ? new Date($("ctExp").value).toISOString() : null;
      const item = { source_name: $("ctSrc").value.trim(), source_url: $("ctUrl").value.trim() || null, source_id: $("ctId").value.trim() || null, category: $("ctCat").value,
        itype: $("ctIt").value || null, title: $("ctTitle").value.trim() || null, text: $("ctText").value.trim(), lat: pos.lat, lng: pos.lng, expires_at: exp };
      try { await busy($("ctYes"), () => api.cityUpsert(item)); closeSheet(); toast("Карточка опубликована"); feedDirty = true; wide = null; renderMod(); }
      catch (e) { $("ctErr").textContent = e.message; $("ctErr").classList.add("on"); }
    };
  }
