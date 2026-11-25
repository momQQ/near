  /* =====================================================
     ЧАТЫ v14.8 (ТЗ 08, 09): общие комнаты — город, районы, темы и закрытые комнаты встреч.
     Личных диалогов и друзей нет. Сообщения пишутся только через сервер (send_message).
     ===================================================== */
  let chTab = "near", roomId = null, roomQT = null;
  const ROOM_IC = { city: "city", district: "district", topic: "topic", meeting: "meetup" };
  qa("#chSeg [data-t]").forEach((b) => (b.onclick = () => { chTab = b.dataset.t; qa("#chSeg button").forEach((x) => x.classList.toggle("on", x === b)); renderChats(); }));
  $("roomQ").oninput = () => { clearTimeout(roomQT); roomQT = setTimeout(renderChats, 300); };
  const shortTime = (iso) => { if (!iso) return ""; const d = new Date(iso), n = new Date(); return d.toDateString() === n.toDateString() ? d.toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" }) : dfmt(d, { day: "numeric", month: "short" }); };
  const roomRow = (r) => `<button class="room-row${r.unread ? " unread-row" : ""}" data-room="${r.id}">
      <span class="room-ic t-${r.type}">${icon(ROOM_IC[r.type] || "chat")}</span>
      <span class="tx"><b translate="no">${esc(r.title)}</b><small>${r.preview ? esc(r.preview) : esc(r.about || (r.type === "meeting" ? "Чат встречи" : ""))}</small></span>
      <span class="rr-end">${r.last ? `<small>${shortTime(r.last)}</small>` : ""}${r.unread ? `<i class="ubadge">${r.unread > 99 ? "99+" : r.unread}</i>` : r.joined || r.type === "meeting" ? "" : '<em class="join-chip">Вступить</em>'}</span>
    </button>`;
  async function renderChats() {
    const box = $("chBody");
    if ((chTab === "meet" || chTab === "mine") && !user) {
      box.innerHTML = `<div class="empty"><b>${chTab === "meet" ? "Чаты встреч" : "Мои комнаты"}</b>Войдите, чтобы вступать в комнаты и встречи<br><button class="btn btn-main mt12" data-login>Войти</button></div>`;
      return;
    }
    if (!box.children.length || box.querySelector(".empty,.err-box")) box.innerHTML = '<div class="skel-list"><i></i><i></i><i></i></div>';
    try {
      const list = await api.roomsList(chTab, $("roomQ").value.trim() || null);
      if (!list.length) {
        box.innerHTML = chTab === "meet" ? `<div class="empty"><b>Пока нет встреч</b>Подайте заявку на встречу — после принятия здесь откроется общий чат<br><button class="btn btn-main mt12" data-open="sv-meets">Найти встречу</button></div>`
          : chTab === "mine" ? `<div class="empty"><b>Вы еще не в комнатах</b>Откройте вкладку "Рядом" и вступите в городской или районный чат</div>`
          : `<div class="empty"><b>Ничего не нашлось</b>Попробуйте другое название</div>`;
        return;
      }
      const groups = chTab === "near" ? [["Город", list.filter((r) => r.type === "city")], ["Районы", list.filter((r) => r.type === "district")], ["Темы", list.filter((r) => r.type === "topic")]] : [["", list]];
      box.innerHTML = groups.filter((g) => g[1].length).map(([t, l]) => (t ? `<div class="lbl">${t}</div>` : "") + l.map(roomRow).join("")).join("");
    } catch (e) {
      box.innerHTML = `<div class="err-box"><b>${navigator.onLine ? "Не удалось загрузить чаты" : "Нет интернета"}</b>${esc(e.message)}<button class="btn btn-main mt12" id="chRetry">Повторить</button></div>`;
      $("chRetry").onclick = renderChats;
    }
  }
  $("chBody").onclick = (e) => {
    let b;
    if ((b = e.target.closest("[data-login]"))) return requireAuth("Войдите, чтобы пользоваться чатами");
    if ((b = e.target.closest("[data-room]"))) return openRoom(b.dataset.room);
  };
  // общий счетчик непрочитанных — по моим комнатам
  let chatSeen = -1;
  async function refreshChatBadge(notify) {
    if (!api || !user) { $("chatBadge").classList.add("hidden"); return; }
    try {
      const n = (await api.roomsList("mine")).reduce((s, r) => s + (r.unread || 0), 0);
      $("chatBadge").textContent = n > 9 ? "9+" : n; $("chatBadge").classList.toggle("hidden", !n);
      if (notify && chatSeen >= 0 && n > chatSeen && cur() !== "sv-room") { if (prefOn("n_msg")) Sound.play("message"); }
      chatSeen = n;
    } catch (e) {}
  }

  /* ---------- комната ---------- */
  const Room = {
    off: null, room: null, meet: null, msgs: [], pending: [], replyTo: null, hb: null, tick: null,
    unsub() { if (this.off) { this.off(); this.off = null; } clearInterval(this.hb); this.hb = null; clearInterval(this.tick); this.tick = null; if (this.room && user) api.roomSettings(this.room.id, { active: false }).catch(() => {}); },
    sub() {
      if (this.off || !this.room) return;
      this.off = api.subscribeRoom(this.room.id, (t, row) => this.onRow(t, row), (st) => { $("roomLive").classList.toggle("hidden", st === "SUBSCRIBED"); });
    },
    async onRow(t, row) {
      if (!this.room || row.room_id !== this.room.id) return;
      if (t === "update") { const i = this.msgs.findIndex((m) => m.id === row.id); if (i >= 0) { this.msgs[i] = { ...this.msgs[i], ...row }; renderMsgs(); } return; }
      if (this.msgs.some((m) => m.id === row.id)) return;
      if (row.sender_id && api.isBlocked && api.isBlocked(row.sender_id)) return;
      const author = row.sender_id ? (this.msgs.find((m) => m.sender_id === row.sender_id) || {}).author || (await api.profileLite(row.sender_id).catch(() => null)) : null;
      this.msgs.push({ ...row, author }); renderMsgs(true);
      if (row.kind === "checkin" || (row.meta && row.meta.tpl === "moved")) loadMeetPanel();
      api.roomSettings(this.room.id, { read: true }).catch(() => {});
    },
    catchUp() { if (this.room) loadMsgs(); }
  };
  const Conv = Room; // совместимость со старым кодом (выход, жизненный цикл)
  async function openRoom(id) {
    Room.unsub(); roomId = id; Room.room = null; Room.meet = null; Room.msgs = []; Room.pending = []; Room.replyTo = null;
    go("sv-room");
    $("roomTitle").textContent = "Загрузка..."; $("roomSub").textContent = ""; $("roomPin").classList.add("hidden"); $("roomMeet").innerHTML = ""; $("roomQuick").innerHTML = "";
    $("roomMsgs").innerHTML = '<div class="spin"></div>'; renderReply();
    try {
      const r = await api.room(id);
      if (!r) { $("roomMsgs").innerHTML = `<div class="empty"><b>Нет доступа</b>Комната закрыта или вы не участник</div>`; $("composer").classList.add("hidden"); return; }
      Room.room = r;
      $("roomTitle").textContent = r.title;
      $("roomSub").textContent = r.type === "meeting" ? "закрытый чат встречи" : `${r.members_count || 0} ${plural(r.members_count || 0, "участник", "участника", "участников")}`;
      if (r.pinned) { $("roomPin").classList.remove("hidden"); $("roomPinT").textContent = r.pinned; }
      if (r.type === "meeting") await loadMeetPanel();
      await loadMsgs();
      Room.sub();
      if (user) { api.roomSettings(id, { read: true, active: true }).catch(() => {}); Room.hb = setInterval(() => api.roomSettings(id, { active: true }).catch(() => {}), 60e3); }
      renderComposer(); refreshChatBadge();
    } catch (e) { $("roomMsgs").innerHTML = `<div class="err-box"><b>Не удалось открыть чат</b>${esc(e.message)}<button class="btn btn-main mt12" id="rmRetry">Повторить</button></div>`; $("rmRetry").onclick = () => openRoom(id); }
  }
  async function loadMsgs() {
    const list = await api.roomFeed(Room.room.id);
    Room.msgs = list; renderMsgs(true);
  }
  // кто я в комнате: гость, читатель, участник
  function myRoomState() {
    const r = Room.room; if (!r) return "none";
    if (!user) return "guest";
    if (r.type === "meeting") return Room.meet && Room.meet.my_role ? "member" : "none";
    return r.joined || (Room.joined ?? false) ? "member" : "reader";
  }
  async function renderComposer() {
    const r = Room.room, c = $("composer"), j = $("roomJoin");
    let joined = false;
    if (user && r.type !== "meeting") { try { const l = await api.roomsList("mine"); joined = l.some((x) => x.id === r.id); } catch (e) {} }
    Room.joined = joined;
    const st = myRoomState();
    const archived = r.type === "meeting" && Room.meet && (Room.meet.status === "cancelled" || (Room.meet.ends_at && Date.now() - new Date(Room.meet.ends_at) > 7 * 86400e3));
    c.classList.toggle("hidden", st !== "member" || archived);
    j.classList.toggle("hidden", st === "member" && !archived);
    j.innerHTML = archived ? '<div class="s-note">Чат встречи в архиве: только чтение</div>'
      : st === "guest" ? '<button class="btn btn-main big" data-rjoin>Войти, чтобы писать</button>'
      : st === "reader" ? '<button class="btn btn-main big" data-rjoin>Вступить в комнату</button>'
      : r.type === "meeting" ? '<div class="s-note">Писать могут только принятые участники встречи</div>' : "";
    renderQuick();
  }
  $("roomJoin").onclick = async (e) => {
    if (!e.target.closest("[data-rjoin]")) return;
    if (!requireAuth("Войдите, чтобы писать в чатах", { t: "room", a: roomId })) return;
    try { await api.joinRoom(roomId); toast("Вы в комнате"); renderComposer(); } catch (er) { if (!gateError(er)) toast(er.message); }
  };
  const isMine = (m) => user && m.sender_id === user.id;
  function mentionHtml(t) { return esc(t).replace(/(^|\s)(@[\wА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]{2,20})/g, '$1<span class="mention">$2</span>'); }
  function msgHtml(m, prev) {
    const day = new Date(m.created_at).toDateString(), sep = !prev || new Date(prev.created_at).toDateString() !== day ? `<div class="day-sep">${dfmt(new Date(m.created_at), { day: "numeric", month: "long" })}</div>` : "";
    if (!m.sender_id) return sep + `<div class="msg-sys">${esc(m.body_masked)}</div>`;
    if (m.status === "hidden") return sep + `<div class="msg-sys">Сообщение скрыто модератором</div>`;
    const mine = isMine(m), grouped = prev && prev.sender_id === m.sender_id && prev.kind === m.kind && new Date(m.created_at) - new Date(prev.created_at) < 5 * 60e3 && !sep;
    const reply = m.reply_to ? Room.msgs.find((x) => x.id === m.reply_to) : null;
    const who = m.author || {};
    const body = m.kind === "checkin" ? `<b>${mentionHtml(m.body_masked)}</b>` : m.kind === "action" ? `<span class="act-pill">${esc(m.body_masked)}</span>` : mentionHtml(m.body_masked);
    const mentioned = user && user.nickname && new RegExp("@" + user.nickname + "(?![\\wА-Яа-я])", "i").test(m.body_masked || "");
    return sep + `<div class="msg${mine ? " me" : ""}${grouped ? " grp" : ""}${mentioned || (m.meta && m.meta.all) ? " hl" : ""}${m._pending ? " pending" : ""}${m._failed ? " failed" : ""}" data-mid="${m.id}">
      ${mine || grouped ? "" : `<button class="m-ava" data-user="${m.sender_id}">${ava({ name: who.nickname, avatar_url: who.avatar_url })}</button>`}
      <div class="bubble">${mine || grouped ? "" : `<b class="m-who" translate="no">@${esc(who.nickname || "участник")}</b>`}
        ${reply ? `<div class="m-reply">↩ @${esc((reply.author || {}).nickname || "")}: ${esc((reply.body_masked || "").slice(0, 60))}</div>` : ""}
        <div class="m-t" translate="no">${body}</div>
        <span class="m-time">${m._failed ? '<button class="lnk" data-retry>Не отправлено · повторить</button>' : m._pending ? "отправляется..." : shortTime(m.created_at)}</span></div>
      ${m._pending || m._failed ? "" : `<button class="m-more" data-mmore aria-label="Действия с сообщением">⋯</button>`}
    </div>`;
  }
  function renderMsgs(scroll) {
    const box = $("roomMsgs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const all = [...Room.msgs, ...Room.pending];
    box.innerHTML = all.length ? all.map((m, i) => msgHtml(m, all[i - 1])).join("") : '<div class="empty"><b>Сообщений пока нет</b>Напишите первым</div>';
    if (scroll || atBottom) box.scrollTop = box.scrollHeight;
  }
  // подгрузка старых при прокрутке вверх
  $("roomMsgs").addEventListener("scroll", async () => {
    const box = $("roomMsgs");
    if (box.scrollTop > 40 || Room.loadingOld || !Room.room || Room.msgs.length < 40 || Room.noMore) return;
    Room.loadingOld = true;
    try {
      const h = box.scrollHeight, older = await api.roomFeed(Room.room.id, Room.msgs[0]);
      if (!older.length) Room.noMore = true;
      Room.msgs = [...older.filter((o) => !Room.msgs.some((m) => m.id === o.id)), ...Room.msgs]; renderMsgs(); box.scrollTop = box.scrollHeight - h;
    } catch (e) {} finally { Room.loadingOld = false; }
  }, { passive: true });
  $("roomMsgs").onclick = (e) => {
    let b;
    if ((b = e.target.closest("[data-user]"))) return openUser(b.dataset.user);
    if ((b = e.target.closest("[data-retry]"))) { const id = b.closest("[data-mid]").dataset.mid; const p = Room.pending.find((x) => x.id === id); if (p) { p._failed = false; p._pending = true; renderMsgs(); sendPending(p); } return; }
    if ((b = e.target.closest("[data-mmore]"))) return msgMenu(b.closest("[data-mid]").dataset.mid);
  };
  function msgMenu(id) {
    const m = Room.msgs.find((x) => x.id === id); if (!m) return;
    const role = Room.meet && Room.meet.my_role, canMod = role === "host" || role === "cohost" || (user && user.is_mod);
    const mine = isMine(m);
    openSheet("Сообщение", `<div class="sheet-col">
      ${myRoomState() === "member" ? '<button class="btn btn-ghost" data-mm="reply">Ответить</button>' : ""}
      ${m.sender_id && !mine ? '<button class="btn btn-ghost" data-mm="mention">Упомянуть автора</button>' : ""}
      ${m.sender_id && !mine ? '<button class="btn btn-ghost" data-mm="report">Пожаловаться</button>' : ""}
      ${m.sender_id && !mine ? '<button class="btn btn-ghost red" data-mm="block">Заблокировать автора</button>' : ""}
      ${canMod && !mine && m.sender_id ? '<button class="btn btn-ghost" data-mm="hide">Скрыть сообщение</button><button class="btn btn-ghost" data-mm="mute">Временно запретить писать</button>' : ""}
      <button class="btn btn-ghost" data-mm="x">Отмена</button></div>`);
    $("bsList").onclick = async (e) => {
      const b = e.target.closest("[data-mm]"); if (!b) return; const a = b.dataset.mm; closeSheet();
      const nick = (m.author || {}).nickname || "";
      if (a === "reply") { Room.replyTo = m; renderReply(); $("msgIn").focus(); }
      else if (a === "mention") { $("msgIn").value = ("@" + nick + " " + $("msgIn").value).slice(0, 1000); $("msgIn").focus(); syncSend(); }
      else if (a === "report") reportSheet({ type: "room_message", id: m.id, user_id: m.sender_id, label: "сообщение" });
      else if (a === "block") blockUser(m.sender_id, "@" + nick, () => { Room.msgs = Room.msgs.filter((x) => x.sender_id !== m.sender_id); renderMsgs(); });
      else if (a === "hide") { try { await api.hideMessage(m.id, "Нарушение правил комнаты"); m.status = "hidden"; renderMsgs(); toast("Сообщение скрыто"); } catch (er) { toast(er.message); } }
      else if (a === "mute") muteSheet(m.sender_id, nick);
    };
  }
  function muteSheet(uid, nick) {
    openSheet("Запретить писать @" + nick, `<div class="sheet-col">${[[15, "15 минут"], [60, "1 час"], [1440, "1 день"], [10080, "7 дней"]].map(([v, t]) => `<button class="btn btn-ghost" data-mute="${v}">${t}</button>`).join("")}<button class="btn btn-ghost" data-mute="0">Снять ограничение</button></div>`);
    $("bsList").onclick = async (e) => { const b = e.target.closest("[data-mute]"); if (!b) return; closeSheet(); try { await api.setMute(Room.room.id, uid, +b.dataset.mute, "Решение организатора"); toast(+b.dataset.mute ? "Ограничение установлено" : "Ограничение снято"); } catch (er) { toast(er.message); } };
  }
  function renderReply() {
    const r = Room.replyTo;
    $("replyBar").classList.toggle("hidden", !r);
    if (r) $("replyT").textContent = "↩ @" + ((r.author || {}).nickname || "") + ": " + (r.body_masked || "").slice(0, 60);
  }
  $("replyX").onclick = () => { Room.replyTo = null; renderReply(); };
  const syncSend = () => { $("sendBtn").disabled = !$("msgIn").value.trim(); };
  $("msgIn").addEventListener("input", syncSend);
  // отправка: ключ клиента → повтор не создает дубль; без сети — "не отправлено, повторить"
  async function sendPending(p) {
    try {
      const r = await api.sendMessage(Room.room.id, p.body_masked, p.client_id, p.reply_to, p._action);
      Room.pending = Room.pending.filter((x) => x !== p);
      if (!Room.msgs.some((m) => m.id === r.id)) Room.msgs.push({ ...p, id: r.id, created_at: r.created_at, _pending: false, body_masked: N.mask(p.body_masked) });
      renderMsgs(true);
    } catch (e) {
      if (!navigator.onLine || /связ|network|fetch/i.test(e.message)) { p._pending = false; p._failed = true; renderMsgs(); return; }
      Room.pending = Room.pending.filter((x) => x !== p); renderMsgs();
      if (!gateError(e)) toast(e.message);
      if (!p._action) $("msgIn").value = $("msgIn").value || p.body_masked; syncSend();
    }
  }
  function queueSend(text, action) {
    const p = { id: "tmp-" + N.rid(), client_id: action ? "act:" + action : "c-" + N.rid() + N.rid(), sender_id: user.id, author: { nickname: user.nickname, avatar_url: user.avatar_url },
      body_masked: text, reply_to: Room.replyTo ? Room.replyTo.id : null, kind: action ? "action" : "text", created_at: new Date().toISOString(), _pending: true, _action: action || null };
    Room.pending.push(p); Room.replyTo = null; renderReply(); renderMsgs(true); sendPending(p);
  }
  $("composer").onsubmit = (e) => {
    e.preventDefault(); const t = $("msgIn").value.trim(); if (!t || !Room.room) return;
    if ([...t].length > 1000) return toast("Сообщение длиннее 1000 символов");
    const br = N.nearBlockReason(t); if (br) return toast(N.BLOCK_MSG[br]);
    $("msgIn").value = ""; syncSend(); queueSend(t);
  };
  window.addEventListener("online", () => Room.pending.filter((p) => p._failed).forEach((p) => { p._failed = false; p._pending = true; sendPending(p); }));

  /* ---------- быстрые действия категории (идемпотентны: одно действие — одно сообщение) ---------- */
  const QUICK = {
    games: [["ready", "Я готов"], ["booked", "ПК забронирован"], ["going", "Я выезжаю"]],
    cinema: [["ticket", "Билет куплен"], ["seat", "Выбираю место"], ["here", "Я на месте"]],
    board: [["rules_ok", "Знаю правила"], ["newbie", "Я новичок"], ["bring", "Принесу игру"]],
    sport: [["in", "Участвую"], ["ball", "Есть мяч"], ["gear", "Нужен инвентарь"]],
    cafe: [["table", "Столик забронирован"], ["going", "Я выезжаю"], ["late", "Опаздываю"]],
    walk: [["going", "Я выезжаю"], ["here", "Я на месте"], ["route", "Предложить маршрут"]],
    mountains: [["gear_ok", "Снаряжение готово"], ["route_check", "Проверить маршрут"], ["cant", "Не смогу прийти"]],
    study: [["materials", "Материалы готовы"], ["question", "Есть вопрос"], ["here", "Я на месте"]],
    other: [["in", "Участвую"], ["question", "Есть вопрос"], ["late", "Опаздываю"]]
  };
  function renderQuick() {
    const m = Room.meet, box = $("roomQuick");
    if (!m || !m.my_role || myRoomState() !== "member" || m.status === "cancelled" || m.status === "finished") { box.innerHTML = ""; return; }
    box.innerHTML = (QUICK[m.category] || QUICK.other).map(([k, t]) => `<button type="button" data-q="${k}">${esc(t)}</button>`).join("");
  }
  $("roomQuick").onclick = (e) => {
    const b = e.target.closest("[data-q]"); if (!b) return;
    if (Room.msgs.concat(Room.pending).some((m) => m.client_id === "act:" + b.dataset.q && m.sender_id === user.id)) return toast("Уже отправлено");
    queueSend(b.textContent, b.dataset.q);
  };

  /* ---------- панель встречи в чате: таймер, готовность ---------- */
  async function loadMeetPanel() {
    const r = Room.room; if (!r || !r.meeting_id) return;
    try { Room.meet = await api.meeting(r.meeting_id); } catch (e) { Room.meet = null; }
    renderMeetPanel(); renderQuick();
  }
  function renderMeetPanel() {
    const m = Room.meet, box = $("roomMeet"); if (!m) { box.innerHTML = ""; return; }
    const ck = m.checkin, ans = ck && user ? ck.answers[user.id] : null, n = ck ? Object.values(ck.answers) : [];
    const ready = n.filter((x) => x === "ready").length, wait = Math.max(0, (m.accepted || 0) - n.length);
    box.innerHTML = `<button class="meet-strip" data-meetopen="${m.id}"><span>${icon(MEET_CATS[m.category] ? MEET_CATS[m.category].ic : "meetup")}</span><span class="tx"><b>${esc(m.title)}</b><small id="meetTimer">${meetTimerText(m)}</small></span><span class="chev">›</span></button>
      ${ck ? `<div class="ready-box"><b>@all • Подтвердите готовность</b><small>${ready} ${plural(ready, "готов", "готовы", "готовы")} • ${wait} ${plural(wait, "ожидается", "ожидаются", "ожидаются")}</small>
        <div class="seg ready-seg">${[["ready", "Готов"], ["late", "Опаздываю"], ["cant", "Не смогу"]].map(([k, t]) => `<button data-ans="${k}" class="${ans === k ? "on" : ""}">${t}</button>`).join("")}</div></div>` : ""}`;
    clearInterval(Room.tick);
    Room.tick = setInterval(() => { const t = $("meetTimer"); if (!t || cur() !== "sv-room") return clearInterval(Room.tick); t.textContent = meetTimerText(m); }, 1000);
  }
  $("roomMeet").onclick = async (e) => {
    let b;
    if ((b = e.target.closest("[data-meetopen]"))) return openMeet(b.dataset.meetopen);
    if ((b = e.target.closest("[data-ans]"))) {
      try { await api.meetAct("answer_checkin", { p_checkin: Room.meet.checkin.id, p_answer: b.dataset.ans }); Room.meet.checkin.answers[user.id] = b.dataset.ans; renderMeetPanel(); }
      catch (er) { toast(er.message); loadMeetPanel(); }
    }
  };

  /* ---------- меню комнаты: уведомления, правила, выход, жалоба ---------- */
  $("roomMenu").onclick = () => {
    const r = Room.room; if (!r) return;
    const st = myRoomState();
    openSheet(r.title, `<div class="sheet-col">
      ${r.rules ? '<button class="btn btn-ghost" data-rm="rules">Правила комнаты</button>' : ""}
      ${st === "member" ? '<button class="btn btn-ghost" data-rm="notify">Уведомления</button>' : ""}
      ${r.type === "meeting" ? `<button class="btn btn-ghost" data-rm="meet">Встреча и участники</button>` : ""}
      ${st === "member" && r.type !== "meeting" ? '<button class="btn btn-ghost red" data-rm="leave">Выйти из комнаты</button>' : ""}
      <button class="btn btn-ghost" data-rm="x">Закрыть</button></div>`);
    $("bsList").onclick = async (e) => {
      const b = e.target.closest("[data-rm]"); if (!b) return; const a = b.dataset.rm; closeSheet();
      if (a === "rules") openSheet("Правила", `<p class="muted" style="font-size:14px;line-height:1.5">${esc(r.rules)}</p>`);
      else if (a === "meet") openMeet(r.meeting_id);
      else if (a === "leave") { if (await confirmSheet("Выйти из комнаты?", "Сообщения останутся, вы перестанете получать уведомления")) { try { await api.leaveRoom(r.id); toast("Вы вышли из комнаты"); back(); } catch (er) { toast(er.message); } } }
      else if (a === "notify") {
        openSheet("Уведомления комнаты", `<div class="sheet-col">${[["all", "Все сообщения"], ["mentions", "Только упоминания и важное"], ["silent", "Без звука"], ["off", "Отключить"]].map(([k, t]) => `<button class="btn btn-ghost" data-nt="${k}">${t}</button>`).join("")}</div>`);
        $("bsList").onclick = async (ev) => { const x = ev.target.closest("[data-nt]"); if (!x) return; closeSheet(); try { await api.roomSettings(r.id, { notify: x.dataset.nt }); toast("Сохранено"); } catch (er) { toast(er.message); } };
      }
    };
  };
  // старые ссылки на личные чаты: контролируемый отказ
  function startChat() { openSheet("Личных сообщений больше нет", `<p class="muted" style="font-size:13.5px;margin-bottom:12px">Общайтесь в городском и районных чатах или во встречах — так безопаснее для всех.</p><div class="sheet-btns"><button class="btn btn-main" id="dmOk">Открыть чаты</button></div>`); $("dmOk").onclick = () => { closeSheet(); go("v-chats"); }; }
  const openConv = startChat;
  let convId = null;
  const stopRec = () => {};
