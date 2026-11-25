  /* =====================================================
     ВСТРЕЧИ v14.8 (ТЗ 07, 09, 10): список и фильтры, карточка, заявка, создание по 9 категориям,
     управление Host, готовность, посещение, отзывы. Все решения принимает сервер.
     ===================================================== */
  const MF2 = { cats: [], when: "all", r: 10000, free: false, price: null };
  const MEET_FIELDS = {
    games: [["game", "Игра", "CS2, Dota 2, Valorant, EA FC", ["CS2", "Dota 2", "Valorant", "EA FC"]], ["mode", "Режим", "5×5, рейтинг, турнир"], ["level", "Уровень", "любой уровень"], ["club", "Клуб", "Название компьютерного клуба"], ["booking", "Бронь", "ПК забронированы / бронь на месте"], ["price_hour", "Цена за час", "например, 800 ₸"]],
    cinema: [["film", "Фильм", "Название"], ["cinema", "Кинотеатр", "Название"], ["session", "Сеанс", "19:30"], ["lang", "Язык", "русский / казахский / оригинал"], ["format", "Формат", "2D, 3D, IMAX", ["2D", "3D", "IMAX"]], ["price", "Цена билета", "каждый покупает сам"]],
    board: [["game", "Игра", "Мафия, UNO, Catan", ["Мафия", "UNO", "Catan"]], ["level", "Уровень", "новички приветствуются"], ["club", "Клуб или кафе", "Название"], ["inventory", "Инвентарь", "игра есть у организатора"], ["duration", "Длительность", "3 часа"]],
    sport: [["sport", "Вид спорта", "Футбол, волейбол, бег"], ["format", "Формат", "5×5"], ["level", "Уровень", "любительский"], ["venue", "Площадка", "Название или адрес"], ["inventory", "Инвентарь", "мяч, форма"], ["rent", "Аренда", "делим на всех"]],
    cafe: [["goal", "Цель", "Кофе, обсудить книгу, нетворкинг"], ["cafe", "Кафе", "Название"], ["budget", "Бюджет", "каждый платит за себя"], ["table", "Столик", "забронирован / на месте"], ["topic", "Тема", "о чем поговорим"]],
    walk: [["route", "Маршрут", "Терренкур, парк Горького"], ["meet_point", "Точка сбора", "у входа"], ["distance", "Дистанция", "3 км"], ["pace", "Темп", "спокойный темп"], ["duration", "Длительность", "1,5 часа"]],
    mountains: [["route", "Маршрут", "Кок-Жайляу, Фурманова"], ["difficulty", "Сложность", "легкая / средняя / сложная", ["легкая", "средняя сложность", "сложная"]], ["distance", "Дистанция", "8 км"], ["elevation", "Набор высоты", "600 м"], ["gear", "Снаряжение", "треккинговая обувь, вода"], ["return_time", "Возврат", "до 18:00"], ["weather", "Погода", "проверим прогноз накануне"]],
    study: [["topic", "Тема", "IELTS, Python, шахматы"], ["level", "Уровень", "начальный"], ["format", "Формат", "Speaking, разбор задач"], ["place", "Место", "библиотека, коворкинг"], ["materials", "Материалы", "учебник, ноутбук"], ["duration", "Длительность", "2 часа"]],
    other: [["goal", "Конкретная цель", "что будем делать"], ["place", "Место", "где"], ["materials", "Материалы", "что взять"], ["cost", "Стоимость", "если есть"]]
  };
  const money = (p) => (p == null ? "цена не указана" : p === 0 ? "бесплатно" : Number(p).toLocaleString("ru-RU") + " ₸ с человека");
  const when = (iso) => { const d = new Date(iso), t = d.toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" }), n = new Date(), tm = new Date(n); tm.setDate(n.getDate() + 1);
    return (d.toDateString() === n.toDateString() ? "Сегодня" : d.toDateString() === tm.toDateString() ? "Завтра" : dfmt(d, { weekday: "short", day: "numeric", month: "short" })) + ", " + t; };
  const starTxt = (r, role) => { const x = r && r[role]; return x && x.count ? `★ ${String(x.avg).replace(".", ",")} • ${x.count} ${plural(x.count, "отзыв", "отзыва", "отзывов")}` : "нет отзывов"; };

  /* ---------- список "Встречи рядом" ---------- */
  function renderMeetFilters() {
    $("mtCats").innerHTML = `<button data-mc="" class="${MF2.cats.length ? "" : "on"}">Все</button>` + Object.entries(MEET_CATS).map(([k, c]) => `<button data-mc="${k}" class="${MF2.cats.includes(k) ? "on" : ""}">${icon(c.ic, 16)} ${c.n}</button>`).join("");
    $("mtWhen").innerHTML = [["all", "Любая дата"], ["today", "Сегодня"], ["tomorrow", "Завтра"], ["weekend", "Выходные"]].map(([k, t]) => `<button data-mw="${k}" class="${MF2.when === k ? "on" : ""}">${t}</button>`).join("")
      + [[1000, "1 км"], [3000, "3 км"], [10000, "10 км"]].map(([k, t]) => `<button data-mr="${k}" class="${MF2.r === k ? "on" : ""}">${t}</button>`).join("")
      + `<button data-mfree class="${MF2.free ? "on" : ""}">Есть места</button><button data-mprice class="${MF2.price === 0 ? "on" : ""}">Бесплатно</button>`;
  }
  function dateRange(k) {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    if (k === "today") return [new Date(), new Date(d0.getTime() + 86400e3)];
    if (k === "tomorrow") return [new Date(d0.getTime() + 86400e3), new Date(d0.getTime() + 2 * 86400e3)];
    if (k === "weekend") { const dw = d0.getDay(), sat = new Date(d0.getTime() + ((6 - dw + 7) % 7) * 86400e3); return [dw === 0 ? d0 : sat, new Date((dw === 0 ? d0 : sat).getTime() + (dw === 0 ? 1 : 2) * 86400e3)]; }
    return [null, null];
  }
  const meetCard = (m) => { const c = MEET_CATS[m.category] || MEET_CATS.other, left = Math.max(0, m.capacity - m.accepted);
    return `<button class="meet-card" data-meet="${m.id}">
      <span class="mc-ic" style="--c:${c.c}">${icon(c.ic)}</span>
      <span class="tx"><small>${c.n}${m.dist != null ? " • " + fmtDist(m.dist) : ""}</small><b translate="no">${esc(m.title)}</b>
        <span class="mc-meta">${icon("clock", 14)} ${when(m.starts_at)} • ${icon("users", 14)} ${m.accepted} из ${m.capacity}${left ? "" : " • мест нет"}</span>
        <span class="mc-meta">${esc(m.pin || "")}${m.price_kzt != null ? " • " + money(m.price_kzt) : ""}</span></span>
      ${m.my_status ? `<em class="mst">${{ accepted: "Вы участник", requested: "Заявка", waitlist: "Лист ожидания", host: "Вы Host" }[m.my_status] || ""}</em>` : ""}
    </button>`; };
  async function renderMeets() {
    renderMeetFilters();
    const box = $("mtList"); box.innerHTML = '<div class="skel-list"><i></i><i></i><i></i></div>';
    const [from, to] = dateRange(MF2.when);
    try {
      const list = await api.meetingsNear({ lat: pos.lat, lng: pos.lng, radius: MF2.r, cats: MF2.cats, from: from && from.toISOString(), to: to && to.toISOString(), free: MF2.free, maxPrice: MF2.price });
      box.innerHTML = list.length ? list.map(meetCard).join("") : `<div class="empty"><b>Встреч рядом пока нет</b>Измените фильтры или создайте свою — соседи присоединятся<br><button class="btn btn-main mt12" data-mnew>Создать встречу</button></div>`;
    } catch (e) { box.innerHTML = `<div class="err-box"><b>${navigator.onLine ? "Не удалось загрузить встречи" : "Нет интернета"}</b>${esc(e.message)}<button class="btn btn-main mt12" id="mtRetry">Повторить</button></div>`; $("mtRetry").onclick = renderMeets; }
  }
  $("sv-meets").addEventListener("click", (e) => {
    let b;
    if ((b = e.target.closest("[data-mc]"))) { const k = b.dataset.mc; MF2.cats = !k ? [] : MF2.cats.includes(k) ? MF2.cats.filter((x) => x !== k) : [...MF2.cats, k]; return renderMeets(); }
    if ((b = e.target.closest("[data-mw]"))) { MF2.when = b.dataset.mw; return renderMeets(); }
    if ((b = e.target.closest("[data-mr]"))) { MF2.r = +b.dataset.mr; return renderMeets(); }
    if (e.target.closest("[data-mfree]")) { MF2.free = !MF2.free; return renderMeets(); }
    if (e.target.closest("[data-mprice]")) { MF2.price = MF2.price === 0 ? null : 0; return renderMeets(); }
    if ((b = e.target.closest("[data-meet]"))) return openMeet(b.dataset.meet);
    if (e.target.closest("[data-mnew]")) return openMeetCreate();
    if (e.target.closest("[data-mmine]")) return openMyMeets();
  });

  /* ---------- карточка встречи ---------- */
  let meetId = null, meetData = null, meetTick = null;
  async function openMeet(id) {
    meetId = id; meetData = null; go("sv-meet");
    $("mtBody").innerHTML = '<div class="spin"></div>'; $("mtAct").innerHTML = "";
    try { meetData = await api.meeting(id); if (meetId !== id) return; if (!meetData) { $("mtBody").innerHTML = '<div class="empty"><b>Встреча недоступна</b>Ее удалили или скрыли</div>'; return; } renderMeet(); }
    catch (e) { $("mtBody").innerHTML = `<div class="err-box"><b>Не удалось открыть встречу</b>${esc(e.message)}<button class="btn btn-main mt12" id="mRetry">Повторить</button></div>`; $("mRetry").onclick = () => openMeet(id); }
  }
  function renderMeet() {
    const m = meetData, c = MEET_CATS[m.category] || MEET_CATS.other, left = Math.max(0, m.capacity - m.accepted), d = m.details || {};
    $("mtTitle").textContent = m.title;
    const fields = (MEET_FIELDS[m.category] || []).filter(([k]) => d[k]).map(([k, t]) => `<div class="kv"><span>${t}</span><b>${esc(d[k])}</b></div>`).join("");
    $("mtBody").innerHTML = `
      <div class="m-hero" style="--c:${c.c}"><span class="mc-ic">${icon(c.ic, 26)}</span><div><small>${c.n}</small><b translate="no">${esc(m.title)}</b></div></div>
      <div class="m-pin">${icon("pin", 16)} Закреплено • ${esc(m.pin || "")}</div>
      <div class="m-row"><b>${when(m.starts_at)}</b><span>до ${new Date(m.ends_at).toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" })}</span></div>
      <div class="m-timer" id="mtTimer">${meetTimerText(m)}</div>
      <button class="m-row m-host" data-user="${m.host && m.host.id}">${ava({ name: m.host && m.host.nickname, avatar_url: m.host && m.host.avatar_url })}<span><b translate="no">@${esc((m.host && m.host.nickname) || "")}</b><small>Host ${starTxt(m.host && m.host.rating, "host")}</small></span></button>
      <div class="m-row"><b>${m.accepted} из ${m.capacity} участников</b><span>${left ? left + " " + plural(left, "свободное место", "свободных места", "свободных мест") : "мест нет — можно в лист ожидания"}</span></div>
      <div class="m-row"><b>${esc(m.place_name || "Место на карте")}</b><span>${money(m.price_kzt)}</span></div>
      ${fields ? `<div class="kv-box">${fields}</div>` : ""}
      ${m.rules ? `<div class="m-rules"><b>Правила</b><p>${esc(m.rules)}</p></div>` : ""}
      ${m.category === "mountains" ? '<div class="warn-banner">Горы — это риск. Проверьте прогноз погоды, снаряжение и время возврата, сообщите близким маршрут. В экстренной ситуации звоните 112.</div>' : ""}
      <div class="s-note">Встречи — только в публичных местах. NEAR не принимает оплату: каждый платит сам на месте. Рейтинг не гарантирует безопасность.</div>
      ${m.status === "cancelled" ? `<div class="warn-banner">Встреча отменена${m.cancel_reason ? ": " + esc(m.cancel_reason) : ""}</div>` : ""}
      ${m.my_role && m.members ? `<div class="lbl mt12">Участники</div>${m.members.map((u) => `<button class="u-row" data-user="${u.id}">${ava({ name: u.nickname, avatar_url: u.avatar_url })}<div class="tx"><b translate="no">@${esc(u.nickname)}</b><small>${u.role === "host" ? "Host" : u.role === "cohost" ? "co-host" : "участник"}</small></div></button>`).join("")}` : ""}
      <button class="lnk mt12" data-mrep>Пожаловаться на встречу</button>`;
    clearInterval(meetTick); meetTick = setInterval(() => { const t = $("mtTimer"); if (!t || cur() !== "sv-meet") return clearInterval(meetTick); t.textContent = meetTimerText(m); }, 1000);
    renderMeetAction();
  }
  function renderMeetAction() {
    const m = meetData, a = $("mtAct"), st = m.my_status, role = m.my_role, ended = m.status === "finished" || Date.now() > new Date(m.ends_at);
    let h = "";
    if (m.status === "cancelled") h = "";
    else if (role === "host" || role === "cohost") h = `<button class="btn btn-main big" data-ma="manage">Управление встречей${m.requests && m.requests.length ? " • заявки: " + m.requests.length : ""}</button><button class="btn btn-ghost big" data-ma="chat">Открыть чат</button>`;
    else if (st === "accepted" && ended) h = `<button class="btn btn-main big" data-ma="review">Оценить встречу</button>${m.my_attended ? "" : '<button class="btn btn-ghost big" data-ma="attend">Я был на встрече</button>'}`;
    else if (st === "accepted") h = `<button class="btn btn-main big" data-ma="chat">Открыть чат</button><button class="btn btn-ghost big" data-ma="leave">Не смогу прийти</button>`;
    else if (st === "requested") h = `<div class="s-note center">Заявка отправлена. Общий чат откроется после принятия</div><button class="btn btn-ghost big" data-ma="leave">Отозвать заявку</button>`;
    else if (st === "waitlist") h = `<div class="s-note center">Вы в листе ожидания: сообщим, если освободится место</div><button class="btn btn-ghost big" data-ma="leave">Выйти из листа</button>`;
    else if (st === "removed") h = `<div class="s-note center">Организатор исключил вас из этой встречи</div>`;
    else if (!ended && m.status === "open") h = `<button class="btn btn-main big" data-ma="join">${m.accepted >= m.capacity ? "В лист ожидания" : "Подать заявку"}</button><div class="s-note center">Общий чат откроется после принятия</div>`;
    else h = `<div class="s-note center">${ended ? "Встреча прошла" : "Набор закрыт"}</div>`;
    a.innerHTML = h;
  }
  $("mtBody").onclick = (e) => {
    let b;
    if ((b = e.target.closest("[data-user]"))) return b.dataset.user && openUser(b.dataset.user);
    if (e.target.closest("[data-mrep]")) return reportSheet({ type: "meeting", id: meetData.id, user_id: meetData.host && meetData.host.id, label: "встречу" });
  };
  $("mtAct").onclick = async (e) => {
    const b = e.target.closest("[data-ma]"); if (!b) return; const k = b.dataset.ma, m = meetData;
    if (k === "chat") return m.room_id ? openRoom(m.room_id) : toast("Чат откроется после принятия");
    if (k === "manage") return openManage();
    if (k === "review") return openReview();
    if (!requireAuth("Войдите, чтобы участвовать во встречах", { t: "meet", a: m.id })) return;
    try {
      if (k === "join") {
        const acc = await api.account().catch(() => null);
        if (acc && acc.can && !acc.can.meet) return meetGate(acc);
        openSheet("Заявка на встречу", `<p class="muted" style="font-size:13.5px">Организатор увидит ваш ник и рейтинг. Напишите коротко о себе (необязательно).</p>
          <div class="fld"><textarea id="jnNote" maxlength="200" placeholder="Например: играю на позиции AWP"></textarea></div>
          <div class="sheet-btns"><button class="btn btn-ghost" id="jnNo">Отмена</button><button class="btn btn-main" id="jnYes">Отправить</button></div>`);
        $("jnNo").onclick = closeSheet;
        $("jnYes").onclick = async () => { try { const st = await busy($("jnYes"), () => api.meetAct("request_join", { p_meeting: m.id, p_note: $("jnNote").value.trim() || null })); closeSheet(); toast(st === "waitlist" ? "Вы в листе ожидания" : "Заявка отправлена"); openMeet(m.id); } catch (er) { closeSheet(); if (!gateError(er)) toast(er.message); } };
        return;
      }
      if (k === "leave") {
        const late = m.my_status === "accepted" && new Date(m.starts_at) - Date.now() < 2 * 3600e3;
        if (!(await confirmSheet(m.my_status === "accepted" ? "Отказаться от участия?" : "Отозвать заявку?", late ? "До встречи меньше 2 часов: отказ будет учтен как неявка в рейтинге посещаемости" : "Место освободится для других", "Да", true))) return;
        await api.meetAct("leave_meeting", { p_meeting: m.id }); toast("Готово"); return openMeet(m.id);
      }
      if (k === "attend") { await api.meetAct("mark_attended", { p_meeting: m.id }); toast("Отмечено. Host подтвердит посещение"); return openMeet(m.id); }
    } catch (er) { if (!gateError(er)) toast(er.message); }
  };
  function meetGate(acc) {
    openSheet("Встречи пока недоступны", `<p class="muted" style="font-size:13.5px;line-height:1.5">${acc.state !== "active" ? "Подтвердите почту и заполните никнейм, чтобы участвовать во встречах." : "До юридического согласования встречи доступны только после отдельного допуска (проверки возраста). Читать и писать в общих чатах можно уже сейчас."}</p><div class="sheet-btns"><button class="btn btn-main" id="mgOk">Понятно</button></div>`);
    $("mgOk").onclick = closeSheet;
  }

  /* ---------- мои встречи ---------- */
  async function openMyMeets() {
    if (!requireAuth("Войдите, чтобы видеть свои встречи")) return;
    go("sv-mymeets"); const box = $("myMtList"); box.innerHTML = '<div class="spin"></div>';
    try {
      const l = await api.myMeetings(), up = l.filter((m) => m.status !== "finished" && m.status !== "cancelled"), past = l.filter((m) => !up.includes(m));
      const row = (m) => `<button class="u-row" data-meet="${m.id}"><span class="mc-ic sm">${icon((MEET_CATS[m.category] || MEET_CATS.other).ic, 18)}</span><div class="tx"><b translate="no">${esc(m.title)}</b><small>${when(m.starts_at)} • ${{ host: "Host", cohost: "co-host" }[m.my_role] || { accepted: "участник", requested: "заявка", waitlist: "лист ожидания", removed: "исключен", left: "отказ", left_late: "поздний отказ" }[m.my_status] || ""}${m.review_due ? " • оцените участников" : ""}</small></div></button>`;
      box.innerHTML = (up.length ? '<div class="lbl">Предстоящие</div>' + up.map(row).join("") : "") + (past.length ? '<div class="lbl mt12">Архив</div>' + past.map(row).join("") : "") || '<div class="empty"><b>Встреч пока нет</b>Найдите встречу рядом или создайте свою</div>';
    } catch (e) { box.innerHTML = `<div class="err-box"><b>Ошибка</b>${esc(e.message)}</div>`; }
  }
  $("myMtList").onclick = (e) => { const b = e.target.closest("[data-meet]"); if (b) openMeet(b.dataset.meet); };

  /* ---------- управление (Host / co-host) ---------- */
  function openManage() {
    const m = meetData; go("sv-manage");
    const left = Math.max(0, m.capacity - m.accepted), ended = Date.now() > new Date(m.ends_at) || m.status === "finished", isHost = m.my_role === "host";
    const ck = m.checkin, ans = ck ? ck.answers : {};
    $("mgBody").innerHTML = `
      <div class="m-row"><b>${m.accepted} ${plural(m.accepted, "участник", "участника", "участников")} • ${left} ${plural(left, "место", "места", "мест")}</b><span>Заявки: ${(m.requests || []).length}</span></div>
      ${(m.requests || []).map((u) => `<div class="u-row">${ava({ name: u.nickname, avatar_url: u.avatar_url })}<div class="tx"><b translate="no">@${esc(u.nickname)}</b><small>${u.status === "waitlist" ? "лист ожидания • " : ""}${starTxt(u.rating, "member")}${u.note ? " • " + esc(u.note) : ""}</small></div>
        <button class="btn btn-main sm" data-acc="${u.id}">Принять</button><button class="btn btn-ghost sm" data-dec="${u.id}">Отклонить</button></div>`).join("")}
      <div class="lbl mt12">Участники</div>
      ${(m.members || []).map((u) => `<div class="u-row">${ava({ name: u.nickname, avatar_url: u.avatar_url })}<div class="tx"><b translate="no">@${esc(u.nickname)}</b><small>${u.role === "host" ? "Host" : u.role === "cohost" ? "co-host" : "участник"}${ck ? " • " + ({ ready: "Готов", late: "Опаздывает", cant: "Не сможет" }[ans[u.id]] || "Ожидается") : ""}${u.muted_until && new Date(u.muted_until) > Date.now() ? " • не пишет до " + new Date(u.muted_until).toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" }) : ""}${ended ? " • " + ({ confirmed: "был", noshow: "не пришел", claimed: "отметился", disputed: "спор" }[u.attended] || "не отмечен") : ""}</small></div>
        ${u.role !== "host" ? `<button class="btn btn-ghost sm" data-mem="${u.id}" data-nick="${esc(u.nickname)}" data-role="${u.role}">Действия</button>` : ""}</div>`).join("")}
      <div class="sheet-col mt12">
        ${!ended && m.status !== "cancelled" ? '<button class="btn btn-main big" data-mg="checkin">Запросить готовность</button>' : ""}
        ${!ended && m.status !== "cancelled" ? `<button class="btn btn-ghost" data-mg="edit">Изменить место или время</button><button class="btn btn-ghost" data-mg="close">${m.status === "closed" ? "Открыть набор" : "Закрыть набор"}</button>` : ""}
        ${!ended && Date.now() > new Date(m.starts_at) ? '<button class="btn btn-ghost" data-mg="finish">Завершить встречу</button>' : ""}
        ${isHost && !ended && m.status !== "cancelled" ? '<button class="btn btn-ghost red" data-mg="cancel">Отменить встречу</button>' : ""}
        <button class="btn btn-ghost" data-mg="audit">Журнал действий</button>
      </div>`;
  }
  $("mgBody").onclick = async (e) => {
    const m = meetData; let b;
    const reload = async () => { meetData = await api.meeting(m.id); openManage(); };
    try {
      if ((b = e.target.closest("[data-acc]"))) { await busy(b, () => api.meetAct("decide_request", { p_meeting: m.id, p_user: b.dataset.acc, p_accept: true, p_reason: null })); toast("Принят: участник получил доступ к чату"); return reload(); }
      if ((b = e.target.closest("[data-dec]"))) { await api.meetAct("decide_request", { p_meeting: m.id, p_user: b.dataset.dec, p_accept: false, p_reason: null }); toast("Заявка отклонена"); return reload(); }
      if ((b = e.target.closest("[data-mem]"))) return memberMenu(b.dataset.mem, b.dataset.nick, b.dataset.role, reload);
      if ((b = e.target.closest("[data-mg]"))) {
        const k = b.dataset.mg;
        if (k === "checkin") { await api.meetAct("request_checkin", { p_meeting: m.id }); toast("Запрос готовности отправлен всем участникам"); return reload(); }
        if (k === "close") { await api.meetAct("close_recruiting", { p_meeting: m.id, p_closed: m.status !== "closed" }); return reload(); }
        if (k === "finish") { if (await confirmSheet("Завершить встречу?", "Участники смогут отметить посещение и оставить отзывы в течение 7 дней")) { await api.meetAct("finish_meeting", { p_meeting: m.id }); return reload(); } return; }
        if (k === "cancel") return reasonSheet("Отменить встречу", "Причина увидят все участники", async (r) => { await api.meetAct("cancel_meeting", { p_meeting: m.id, p_reason: r }); toast("Встреча отменена, участники уведомлены"); openMeet(m.id); });
        if (k === "edit") return editMeetSheet(reload);
        if (k === "audit") return auditSheet();
      }
    } catch (er) { toast(er.message); }
  };
  function reasonSheet(title, hint, fn) {
    openSheet(title, `<p class="muted" style="font-size:13px">${hint}</p><div class="fld"><textarea id="rsT" maxlength="300" placeholder="Причина"></textarea></div><div class="err" id="rsErr"></div>
      <div class="sheet-btns"><button class="btn btn-ghost" id="rsNo">Отмена</button><button class="btn btn-main" id="rsYes">Подтвердить</button></div>`);
    $("rsNo").onclick = closeSheet;
    $("rsYes").onclick = async () => { const r = $("rsT").value.trim(); if (r.length < 3) { $("rsErr").textContent = "Укажите причину"; $("rsErr").classList.add("on"); return; } try { await busy($("rsYes"), () => fn(r)); closeSheet(); } catch (er) { $("rsErr").textContent = er.message; $("rsErr").classList.add("on"); } };
  }
  function memberMenu(uid, nick, role, reload) {
    const m = meetData, isHost = m.my_role === "host", ended = Date.now() > new Date(m.ends_at) || m.status === "finished";
    openSheet("@" + nick, `<div class="sheet-col">
      ${ended && isHost ? `<button class="btn btn-main" data-mm2="came">Был на встрече</button><button class="btn btn-ghost" data-mm2="nocame">Не пришел</button>` : ""}
      ${!ended ? '<button class="btn btn-ghost" data-mm2="mute">Временно запретить писать</button>' : ""}
      ${isHost && !ended ? `<button class="btn btn-ghost" data-mm2="cohost">${role === "cohost" ? "Снять co-host" : "Назначить co-host"}</button><button class="btn btn-ghost" data-mm2="host">Передать роль Host</button>` : ""}
      ${!ended && (isHost || role !== "cohost") ? '<button class="btn btn-ghost red" data-mm2="kick">Исключить</button>' : ""}
      <button class="btn btn-ghost" data-mm2="profile">Профиль</button></div>`);
    $("bsList").onclick = async (e) => {
      const b = e.target.closest("[data-mm2]"); if (!b) return; const k = b.dataset.mm2; closeSheet();
      try {
        if (k === "profile") return openUser(uid);
        if (k === "came" || k === "nocame") { await api.meetAct("confirm_attendance", { p_meeting: m.id, p_user: uid, p_came: k === "came" }); return reload(); }
        if (k === "mute") { Room.room = { id: m.room_id }; return muteSheet(uid, nick); }
        if (k === "cohost") { await api.meetAct("set_cohost", { p_meeting: m.id, p_user: uid, p_on: role !== "cohost" }); return reload(); }
        if (k === "host") { if (await confirmSheet("Передать роль Host @" + nick + "?", "Вы станете co-host. Отменить это может только новый Host")) { await api.meetAct("transfer_host", { p_meeting: m.id, p_user: uid }); toast("Роль передана"); return openMeet(m.id); } return; }
        if (k === "kick") return reasonSheet("Исключить @" + nick, "Участник потеряет доступ к чату и истории. Уже скачанное отозвать нельзя. Рейтинг и аккаунт это не затрагивает", async (r) => { await api.meetAct("remove_member", { p_meeting: m.id, p_user: uid, p_reason: r }); toast("Участник исключен, место освободилось"); reload(); });
      } catch (er) { toast(er.message); }
    };
  }
  function editMeetSheet(reload) {
    const m = meetData, loc = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
    openSheet("Изменить встречу", `<div class="fld"><label>Название места</label><input id="emPlace" maxlength="120" value="${esc(m.place_name || "")}"></div>
      <div class="row2"><div class="fld"><label>Начало</label><input id="emSt" type="datetime-local" value="${loc(m.starts_at)}"></div><div class="fld"><label>Конец</label><input id="emEn" type="datetime-local" value="${loc(m.ends_at)}"></div></div>
      <div class="fld"><label>Мест (включая вас)</label><input id="emCap" type="number" min="3" max="50" value="${m.capacity}"></div>
      <p class="s-note">При переносе старый запрос готовности закроется, участники получат уведомление</p><div class="err" id="emErr"></div>
      <div class="sheet-btns"><button class="btn btn-ghost" id="emNo">Отмена</button><button class="btn btn-main" id="emYes">Сохранить</button></div>`);
    $("emNo").onclick = closeSheet;
    $("emYes").onclick = async () => {
      try {
        await busy($("emYes"), () => api.meetAct("update_meeting", { p_meeting: m.id, p: { place_name: $("emPlace").value.trim(), starts_at: new Date($("emSt").value).toISOString(), ends_at: new Date($("emEn").value).toISOString(), capacity: +$("emCap").value } }));
        closeSheet(); toast("Сохранено, участники уведомлены"); reload();
      } catch (er) { $("emErr").textContent = er.message; $("emErr").classList.add("on"); }
    };
  }
  async function auditSheet() {
    const m = meetData;
    openSheet("Журнал действий", '<div class="spin"></div>');
    try {
      const rows = await api.meetAudit(m.id);
      const L = { create: "создал встречу", accept: "принял заявку", decline: "отклонил заявку", remove: "исключил участника", mute: "ограничил сообщения", unmute: "снял ограничение", left: "участник отказался", left_late: "поздний отказ", cohost_on: "назначил co-host", cohost_off: "снял co-host", transfer_host: "передал роль Host", update: "изменил встречу", close: "закрыл набор", reopen: "открыл набор", cancel: "отменил встречу", finish: "завершил встречу", attend_yes: "подтвердил посещение", attend_no: "отметил неявку" };
      $("bsList").innerHTML = rows.length ? rows.map((r) => `<div class="audit-row"><small>${shortTime(r.created_at)}</small> ${L[r.action] || r.action}${r.reason && r.action !== "update" ? ": " + esc(r.reason) : ""}</div>`).join("") : '<div class="dim">Пока пусто</div>';
    } catch (e) { $("bsList").innerHTML = `<div class="err on">${esc(e.message)}</div>`; }
  }

  /* ---------- отзывы после встречи ---------- */
  async function openReview() {
    const m = meetData; go("sv-review"); $("rvTitle").textContent = m.title;
    const others = (m.members || []).filter((u) => user && u.id !== user.id);
    $("rvBody").innerHTML = `<p class="s-note">Оценить можно в течение 7 дней. Отзыв станет виден после взаимной оценки или по окончании окна. Оценивать можно только подтвержденных участников.</p>` +
      (others.length ? others.map((u) => `<div class="rv-card" data-rv="${u.id}">
        <div class="u-row">${ava({ name: u.nickname, avatar_url: u.avatar_url })}<div class="tx"><b translate="no">@${esc(u.nickname)}</b><small>${u.role === "host" ? "Host" : "участник"} • ${u.attended === "confirmed" || u.role === "host" ? "подтвержденное участие" : "участие не подтверждено"}</small></div></div>
        <div class="stars" role="radiogroup" aria-label="Оценка">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-st="${n}" aria-label="${n}">${icon("star", 26)}</button>`).join("")}</div>
        <div class="chips-row">${[["punctual", "Пунктуальность"], ["respectful", "Уважение"], ["organized", "Организация"]].map(([k, t]) => `<button type="button" data-tag="${k}">${t}</button>`).join("")}</div>
        <div class="fld"><textarea maxlength="500" placeholder="Комментарий (необязательно)"></textarea></div>
        <button class="btn btn-main" data-rvsend>Отправить отзыв</button></div>`).join("") : '<div class="empty">Некого оценивать</div>');
  }
  $("rvBody").onclick = async (e) => {
    const card = e.target.closest("[data-rv]"); if (!card) return; let b;
    if ((b = e.target.closest("[data-st]"))) { card.dataset.stars = b.dataset.st; qa("[data-st]", card).forEach((x) => x.classList.toggle("on", +x.dataset.st <= +b.dataset.st)); return; }
    if ((b = e.target.closest("[data-tag]"))) { b.classList.toggle("on"); return; }
    if ((b = e.target.closest("[data-rvsend]"))) {
      if (!card.dataset.stars) return toast("Поставьте оценку от 1 до 5");
      const tag = (k) => (card.querySelector(`[data-tag="${k}"]`).classList.contains("on") ? true : null);
      try {
        await busy(b, () => api.meetAct("submit_review", { p_meeting: meetData.id, p_target: card.dataset.rv, p_stars: +card.dataset.stars, p_punctual: tag("punctual"), p_respectful: tag("respectful"), p_organized: tag("organized"), p_comment: card.querySelector("textarea").value.trim() || null }));
        card.innerHTML = '<div class="s-note">Спасибо! Отзыв сохранен</div>';
      } catch (er) { toast(er.message); }
    }
  };

  /* ---------- создание встречи: категория → детали → место/время/лимит → предпросмотр ---------- */
  const MC = { cat: null, loc: null, cover: null, key: null };
  function openMeetCreate(cat) {
    if (!requireAuth("Войдите, чтобы создать встречу", { t: "meetnew" })) return;
    MC.cat = cat || null; MC.cover = null; MC.key = "meet-" + N.rid() + N.rid();
    MC.loc = pos.real ? { lat: pos.lat, lng: pos.lng, how: "here" } : null;
    go("sv-meetnew"); renderMeetForm();
    api.account().then((a) => { if (a && a.can && !a.can.meet) meetGate(a); }).catch(() => {});
  }
  function renderMeetForm() {
    const c = MC.cat, box = $("mnBody");
    box.innerHTML = `<div class="lbl">Категория</div><div class="mcat-grid">${Object.entries(MEET_CATS).map(([k, x]) => `<button type="button" data-ncat="${k}" class="${c === k ? "on" : ""}" style="--c:${x.c}">${icon(x.ic)}<span>${x.n}</span></button>`).join("")}</div>
      ${c ? `${(MEET_FIELDS[c] || []).map(([k, t, ph, opts]) => `<div class="fld"><label for="mf_${k}">${t}</label>${opts ? `<div class="mseg" data-opt="${k}">${opts.map((o) => `<button type="button" data-mv="${esc(o)}">${esc(o)}</button>`).join("")}</div>` : ""}<input id="mf_${k}" maxlength="60" placeholder="${esc(ph)}"></div>`).join("")}
      <div class="fld"><label for="mnTitle">Название</label><input id="mnTitle" maxlength="80" placeholder="Например: CS2 — собираем команду"><div class="hint">5–80 символов</div></div>
      <div class="fld"><label for="mnDesc">Описание</label><textarea id="mnDesc" maxlength="1000" placeholder="Что будем делать, кого ждем"></textarea><div class="hint">10–1000 символов</div></div>
      <div class="lbl mt12">Место и время</div>
      <div class="loc-card" id="mnLoc"><span class="lc-pin">${icon("pin")}</span><div><b id="mnLocT">Место не выбрано</b><span id="mnLocS"></span></div></div>
      <button class="btn btn-ghost full" type="button" id="mnPick">Выбрать на карте</button>
      <div class="fld mt8"><label for="mnPlace">Название места</label><input id="mnPlace" maxlength="120" placeholder="Компьютерный клуб, кафе, вход в парк"></div>
      <label class="rules-check"><input type="checkbox" id="mnPublic"> <span>Это публичное место (клуб, кафе, парк, площадка). Встречи дома не допускаются</span></label>
      <div class="row2"><div class="fld"><label for="mnSt">Начало</label><input id="mnSt" type="datetime-local"></div><div class="fld"><label for="mnEn">Конец</label><input id="mnEn" type="datetime-local"></div></div>
      <div class="row2"><div class="fld"><label for="mnCap">Участников с вами</label><input id="mnCap" type="number" inputmode="numeric" min="3" max="50" value="5"></div>
        <div class="fld"><label for="mnPrice">Цена с человека, ₸</label><input id="mnPrice" inputmode="numeric" maxlength="7" placeholder="0 — бесплатно, пусто — неизвестно"></div></div>
      <div class="fld"><label for="mnRules">Правила</label><textarea id="mnRules" maxlength="500" placeholder="Например: каждый платит за себя, без алкоголя">Каждый платит за себя</textarea></div>
      <div class="fld"><label>Обложка 16:9 (необязательно)</label><button type="button" class="btn btn-ghost full" id="mnCoverBtn">${MC.cover ? "Обложка выбрана · заменить" : "Добавить фото"}</button><input type="file" id="mnCover" accept="image/*" hidden></div>
      ${c === "mountains" ? '<div class="warn-banner">Горы — это риск: погода, снаряжение, время возврата. Укажите сложность и возврат, проверьте прогноз.</div>' : ""}
      <div class="s-note">Без гендерных требований и знакомств. NEAR не принимает оплату через организатора.</div>
      <div class="err" id="mnErr"></div>
      <div class="action-bar"><button class="btn btn-main big" id="mnPreview" type="button">Предпросмотр</button></div>` : '<div class="s-note mt12">Выберите категорию — появятся нужные поля</div>'}`;
    renderMeetLoc();
  }
  function renderMeetLoc() {
    if (!$("mnLocT")) return;
    const L = MC.loc;
    $("mnLocT").textContent = !L ? "Место не выбрано" : L.addr || (L.how === "here" ? "Где я сейчас" : "Точка на карте");
    $("mnLocS").textContent = L ? (L.district || nearestDistrict(L.lat, L.lng)) + " район" : "";
  }
  $("mnBody").addEventListener("click", (e) => {
    let b;
    if ((b = e.target.closest("[data-ncat]"))) { MC.cat = b.dataset.ncat; return renderMeetForm(); }
    if ((b = e.target.closest("[data-mv]"))) { const g = b.closest("[data-opt]"); qa("button", g).forEach((x) => x.classList.toggle("on", x === b)); $("mf_" + g.dataset.opt).value = b.dataset.mv; return; }
    if (e.target.closest("#mnPick")) { pickFor = "meet"; return openPicker(MC.loc || pos); }
    if (e.target.closest("#mnCoverBtn")) return $("mnCover").click();
    if (e.target.closest("#mnPreview")) return meetPreview();
  });
  $("mnBody").addEventListener("change", (e) => { if (e.target.id === "mnCover" && e.target.files[0]) { MC.cover = e.target.files[0]; $("mnCoverBtn").textContent = "Обложка выбрана · заменить"; } });
  function meetPayload() {
    const v = (id) => ($(id) ? $(id).value.trim() : ""), details = {};
    (MEET_FIELDS[MC.cat] || []).forEach(([k]) => { const x = v("mf_" + k); if (x) details[k] = x; });
    const st = v("mnSt") ? new Date(v("mnSt")) : null, en = v("mnEn") ? new Date(v("mnEn")) : null, price = v("mnPrice").replace(/\s/g, "");
    return { category: MC.cat, title: v("mnTitle"), description: v("mnDesc"), details, place_name: v("mnPlace"), public_place: $("mnPublic").checked,
      starts_at: st && st.toISOString(), ends_at: en && en.toISOString(), capacity: +v("mnCap"), price_kzt: price === "" ? null : +price, rules: v("mnRules"),
      lat: MC.loc && MC.loc.lat, lng: MC.loc && MC.loc.lng, exact: true, client_key: MC.key };
  }
  // те же проверки, что на сервере: понятная ошибка до отправки
  function meetCheck(p) {
    if ([...p.title].length < 5 || [...p.title].length > 80) return "Название: от 5 до 80 символов";
    if ([...p.description].length < 10) return "Описание: от 10 символов";
    if (!p.lat) return "Выберите место на карте";
    if (!p.public_place) return "Встречи — только в публичных местах. Отметьте подтверждение";
    if (!p.starts_at || !p.ends_at) return "Укажите начало и конец";
    const st = new Date(p.starts_at), en = new Date(p.ends_at);
    if (st < Date.now() + 15 * 60e3) return "Начало — не раньше чем через 15 минут";
    if (st > Date.now() + 90 * 86400e3) return "Дата — не дальше 90 дней вперед";
    if (en <= st) return "Конец должен быть позже начала";
    if (en - st > 24 * 3600e3) return "Длительность — до 24 часов";
    if (!(p.capacity >= 3 && p.capacity <= 50)) return "Участников: от 3 до 50, включая вас";
    if (p.price_kzt != null && !(p.price_kzt >= 0)) return "Цена — число от 0";
    const br = N.nearBlockReason(p.title + " " + p.description + " " + p.rules); if (br) return N.BLOCK_MSG[br];
    return "";
  }
  function meetPreview() {
    const p = meetPayload(), er = meetCheck(p);
    if (er) { $("mnErr").textContent = er; $("mnErr").classList.add("on"); return; }
    $("mnErr").classList.remove("on");
    const c = MEET_CATS[p.category], fake = { ...p, id: "preview", accepted: 1, pin: "", dist: null };
    openSheet("Так увидят соседи", `<div class="pv">${meetCard(fake)}</div><div class="pv-meta">${esc(p.place_name || "Место на карте")} • ${money(p.price_kzt)} • ${c.n}</div>
      <p class="s-note">После публикации встреча пройдет автоматическую проверку текста. Вы станете Host, откроется закрытый чат с приветствием.</p>
      <div class="sheet-btns"><button class="btn btn-ghost" id="mpEdit">Изменить</button><button class="btn btn-main" id="mpOk">Опубликовать</button></div>`);
    $("mpEdit").onclick = closeSheet;
    $("mpOk").onclick = async () => {
      try {
        const id = await busy($("mpOk"), () => api.createMeeting(p));
        if (MC.cover) await api.attachCover(id, MC.cover).catch((e) => toast("Обложка не загрузилась: " + e.message));
        closeSheet(); toast("Встреча опубликована"); feedDirty = true; openMeet(id);
      } catch (er) { closeSheet(); if (!gateError(er)) { $("mnErr").textContent = er.message; $("mnErr").classList.add("on"); } }
    };
  }
