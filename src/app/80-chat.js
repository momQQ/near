  /* =====================================================
     ЧАТЫ, ДРУЗЬЯ, ЗАЯВКИ
     ===================================================== */
  let chTab = "chats";
  qa("#chSeg [data-t]").forEach((b) => (b.onclick = () => { chTab = b.dataset.t; qa("#chSeg button").forEach((x) => x.classList.toggle("on", x === b)); renderChats(); }));
  function msgPreview(m) {
    if (!m) return "";
    const pre = user && m.sender_id === user.id ? "Вы: " : "";
    if (m.mod_status === "flagged") return pre + "⚠️ Скрытое сообщение";
    return pre + ({ image: "📷 Фото", video: "🎬 Видео", audio: "🎤 Голосовое" }[m.kind] || m.text || "");
  }
  const shortTime = (iso) => { const d = new Date(iso), n = new Date(); return d.toDateString() === n.toDateString() ? d.toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" }) : dfmt(d, { day: "numeric", month: "short" }); };
  const convRow = (c) => `<button class="u-row${c.unread ? " unread-row" : ""}" data-conv="${c.id}"><span class="ava-w">${ava(c.other)}${isOnline(c.other) ? '<i class="on-dot"></i>' : ""}</span><div class="tx"><b translate="no">${esc(c.other.name)}${vBadge(c.other)}</b>${c.status === "request" && !c.request ? '<span class="tag-mini">запрос отправлен</span>' : c.status === "declined" ? '<span class="tag-mini red">ограничено</span>' : c.friend ? "" : '<span class="tag-mini">не в друзьях</span>'}<span translate="no">${esc(msgPreview(c.last))}</span></div><div class="meta"><small>${shortTime(c.last.created_at)}</small>${c.unread ? `<span class="unread">${c.unread}</span>` : ""}</div></button>`;
  async function renderChats() {
    const box = $("chBody");
    if (!user) { box.innerHTML = `<div class="empty"><b>Сообщения и друзья</b>Войдите, чтобы переписываться с соседями<br><button class="btn btn-main mt12" id="chLogin">Войти</button></div>`; $("chLogin").onclick = () => showAuth("login"); return; }
    if (!box.children.length || box.querySelector(".empty")) box.innerHTML = '<div class="spin"></div>';
    try {
      const [rq, convs] = await Promise.all([api.friendRequests(), chTab === "friends" ? Promise.resolve([]) : api.conversations()]);
      const msgReq = convs.filter((c) => c.request && c.status === "request");
      const nReq = rq.incoming.length + msgReq.length;
      $("reqBadge").textContent = nReq; $("reqBadge").classList.toggle("hidden", !nReq);
      if (chTab === "chats") {
        const list = convs.filter((c) => !c.request);
        box.innerHTML = (msgReq.length ? `<button class="req-strip" data-tab="requests">✉️ ${msgReq.length} ${plural(msgReq.length, "запрос", "запроса", "запросов")} на переписку от незнакомых людей ›</button>` : "")
          + (list.length ? list.map(convRow).join("") : `<div class="empty"><b>Пока нет переписок</b>Откройте профиль соседа и нажмите "Написать"<br><button class="btn btn-main mt12" data-open="sv-find">Найти людей</button></div>`);
      } else if (chTab === "friends") {
        const list = await api.friends();
        box.innerHTML = list.length ? list.map((u) => `<div class="u-row" data-user="${u.id}"><span class="ava-w">${ava(u)}${isOnline(u) ? '<i class="on-dot"></i>' : ""}</span><div class="tx"><b translate="no">${esc(u.name)}${vBadge(u)}</b><span>${isOnline(u) ? '<em class="ok-t">в сети</em> · ' : ""}${u.district ? esc(u.district) + " район" : ""}${u.instagram ? " · @" + esc(u.instagram) : ""}</span></div><button class="pill-btn" data-chat="${u.id}" aria-label="Написать">💬</button></div>`).join("")
          : `<div class="empty"><b>Друзей пока нет</b>Найдите соседей по имени или добавьте автора публикации из его профиля</div>`;
      } else {
        // CHAT-01: запросы на переписку от незнакомых + заявки в друзья
        box.innerHTML = (msgReq.length ? '<div class="lbl">Запросы на переписку</div><div class="s-note" style="margin:0 0 8px">Пока вы не приняли запрос, собеседник не может отправить больше одного сообщения, фото и ссылки.</div>' + msgReq.map(convRow).join("") : "")
          + (rq.incoming.length ? '<div class="lbl mt12">Заявки в друзья</div>' + rq.incoming.map((u) => `<div class="u-row" data-user="${u.id}">${ava(u)}<div class="tx"><b translate="no">${esc(u.name)}</b><span>хочет добавить вас в друзья</span></div><button class="pill-btn" data-accept="${u.id}">Принять</button><button class="pill-btn ghost" data-decline="${u.id}" aria-label="Отклонить">✕</button></div>`).join("") : "")
          + (rq.outgoing.length ? '<div class="lbl mt12">Отправленные заявки</div>' + rq.outgoing.map((u) => `<div class="u-row" data-user="${u.id}">${ava(u)}<div class="tx"><b translate="no">${esc(u.name)}</b><span>ждем ответа</span></div><button class="pill-btn ghost" data-decline="${u.id}">Отменить</button></div>`).join("") : "")
          || '<div class="empty"><b>Запросов нет</b>Здесь появятся запросы на переписку и заявки в друзья</div>';
      }
    } catch (e) { box.innerHTML = `<div class="empty"><b>Ошибка</b>${esc(e.message)}<br><button class="btn btn-main mt12" id="chRetry">Повторить</button></div>`; $("chRetry").onclick = renderChats; }
  }
  $("chBody").onclick = async (e) => {
    let b;
    if ((b = e.target.closest("[data-tab]"))) { const t = document.querySelector(`#chSeg [data-t="${b.dataset.tab}"]`); if (t) t.click(); return; }
    if ((b = e.target.closest("[data-accept]"))) { try { await api.acceptFriend(b.dataset.accept); toast("🤝 Теперь вы друзья"); renderChats(); refreshChatBadge(); } catch (er) { toast(er.message); } return; }
    if ((b = e.target.closest("[data-decline]"))) { try { await api.removeFriend(b.dataset.decline); toast("Заявка удалена"); renderChats(); refreshChatBadge(); } catch (er) { toast(er.message); } return; }
    if ((b = e.target.closest("[data-chat]"))) return startChat(b.dataset.chat);
    if ((b = e.target.closest("[data-conv]"))) return openConv(b.dataset.conv);
    if ((b = e.target.closest("[data-user]"))) return openUser(b.dataset.user);
  };
  // notify — прозвучать и показать подсказку, если непрочитанных стало больше
  let chatSeen = -1;
  async function refreshChatBadge(notify) {
    if (!api || !user) { $("chatBadge").classList.add("hidden"); return; }
    try {
      const [m, rq] = await Promise.all([api.unreadMessages(), api.friendRequests()]);
      const n = m + rq.incoming.length;
      $("chatBadge").textContent = n > 9 ? "9+" : n; $("chatBadge").classList.toggle("hidden", !n);
      if (notify && chatSeen >= 0 && m > chatSeen && cur() !== "sv-conv") { if (prefOn("n_msg")) Sound.play("message"); toast("💬 Новое сообщение"); }
      chatSeen = m;
    } catch (e) {}
  }

  /* поиск людей */
  let fT = null;
  $("fq").oninput = () => { clearTimeout(fT); fT = setTimeout(async () => {
    const q = $("fq").value.trim();
    if (q.length < 2) { $("fRes").innerHTML = '<div class="dim center" style="font-size:12px;padding:20px">Введите минимум 2 буквы</div>'; return; }
    $("fRes").innerHTML = '<div class="spin"></div>';
    try { const list = await api.searchUsers(q); $("fRes").innerHTML = list.length ? list.map((u) => `<button class="u-row" data-user="${u.id}">${ava(u)}<div class="tx"><b>${esc(u.name)}</b><span>${u.district ? esc(u.district) + " район" : "Алматы"}${u.instagram ? " · @" + esc(u.instagram) : ""}</span></div><span class="pill-btn ghost">Профиль</span></button>`).join("") : '<div class="empty"><b>Никого не нашли</b>Проверьте написание имени</div>'; }
    catch (e) { $("fRes").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }, 300); };
  $("fRes").onclick = (e) => { const b = e.target.closest("[data-user]"); if (b) openUser(b.dataset.user); };

  /* =====================================================
     ПЕРЕПИСКА: текст, фото, видео, голосовые
     ===================================================== */
  let convId = null, convInfo = null;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));
  async function startChat(otherId) {
    if (!requireAuth("Войдите, чтобы писать сообщения", { t: "chat", a: otherId })) return;
    try { const cid = await api.openConversation(otherId); openConv(cid); } catch (e) { if (!gateError(e)) toast(e.message); }
  }
  /* CHAT-02: одна переписка — свой канал Realtime; сообщения хранятся по id (без дублей);
     опрос сервера — только когда канал оборвался, с растущим интервалом */
  const Conv = {
    msgs: new Map(), off: null, state: "idle", pollT: null, delay: 5000,
    reset() { this.unsub(); this.msgs = new Map(); },
    sub() {
      this.unsub(); if (!convId || !api.subscribeConversation) return;
      const cid = convId;
      try { this.off = api.subscribeConversation(cid, (t, row) => { if (cid === convId) this.onRow(t, row); }, (st) => this.onState(st)); }
      catch (e) { this.onState("CHANNEL_ERROR"); }
      if (api.mode === "local") this.state = "SUBSCRIBED";
    },
    unsub() { if (this.off) { try { this.off(); } catch (e) {} } this.off = null; clearTimeout(this.pollT); this.state = "idle"; },
    onState(st) {
      const was = this.state; this.state = st;
      if (st === "SUBSCRIBED") { clearTimeout(this.pollT); this.delay = 5000; if (was !== "idle") this.catchUp(); }
      else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(st)) this.poll();
    },
    poll() {
      clearTimeout(this.pollT);
      this.pollT = setTimeout(async () => { if (convId && !document.hidden) await this.catchUp(); this.delay = Math.min(this.delay * 2, 60000); if (convId && this.state !== "SUBSCRIBED") this.poll(); }, this.delay);
    },
    last() { let t = null; this.msgs.forEach((m) => { if (!m._state && (!t || m.created_at > t)) t = m.created_at; }); return t; },
    async catchUp() {
      const cid = convId; if (!cid) return;
      try { const list = await api.messages(cid, this.last()); if (cid !== convId) return; list.forEach((m) => this.put(m)); render(); } catch (e) {}
    },
    put(m) { const old = this.msgs.get(m.id); if (old && old._state === "pending" && !m._state) delete old._state; this.msgs.set(m.id, old ? Object.assign(old, m, { _state: m._state }) : m); },
    async onRow(t, row) {
      if (!row) return;
      if (t === "delete") { this.msgs.delete(row.id); render(); return; }
      if (row.media_path && api.signChat) { try { await api.signChat([row]); } catch (e) {} }
      const isNew = !this.msgs.has(row.id);
      this.put({ ...row, _state: undefined }); render(isNew);
      if (t === "insert" && user && row.sender_id !== user.id) {
        if (prefOn("n_msg")) Sound.play("message");
        if (!document.hidden) api.markRead(convId).then(() => refreshChatBadge()).catch(() => {});
        if (convInfo && convInfo.status === "request" && convInfo.initiator === user.id) { convInfo.status = "accepted"; convHead(); }
      }
    },
    statusChanged(row) { if (!convInfo || !row || !row.status || row.status === convInfo.status) return; convInfo.status = row.status; convHead(); }
  };
  // шапка, предупреждения и поле ввода — по состоянию переписки (запрос, принята, отклонена, блокировка)
  function convHead() {
    if (!convInfo) return;
    const o = convInfo.other, me = user && user.id, st = convInfo.status || "accepted", mine = convInfo.initiator === me;
    $("convWho").innerHTML = `<span class="ava-w">${ava(o)}${isOnline(o) ? '<i class="on-dot"></i>' : ""}</span><div style="min-width:0"><b translate="no">${esc(o.name)}${vBadge(o)}</b><span class="${isOnline(o) ? "ok-t" : ""}">${o.deleted ? "аккаунт удален" : seenText(o) || (convInfo.friend ? "друг" : "не в друзьях")}</span></div>`;
    const w = $("convWarn"); w.className = "warn-banner"; w.classList.remove("hidden");
    let canWrite = true, canFiles = true;
    if (o.deleted) {
      const left = convInfo.orphaned_at ? Math.max(0, 30 - Math.floor((Date.now() - new Date(convInfo.orphaned_at)) / 86400e3)) : 30;
      w.classList.add("red"); w.innerHTML = `Собеседник удалил аккаунт. Переписка доступна только для чтения и будет удалена через ${left} ${plural(left, "день", "дня", "дней")}.`; canWrite = false;
    }
    else if (convInfo.blocked) { w.classList.add("red"); w.innerHTML = "🚫 Переписка недоступна: пользователь заблокирован."; canWrite = false; }
    else if (st === "request" && !mine) {
      w.innerHTML = `<b>Запрос на переписку</b> ${esc(o.name)} нет у вас в друзьях. Не переходите по ссылкам и не сообщайте коды из SMS, данные карт и адрес.
        <div class="wb-acts"><button class="ok" id="cwAccept">✓ Принять</button><button id="cwDecline">Отклонить</button><button id="cwBlock">🚫 Заблокировать</button><button id="cwRep">⚑ Пожаловаться</button></div>`;
      canFiles = false;
    } else if (st === "request" && mine) {
      const sent = [...Conv.msgs.values()].some((m) => m.sender_id === me && m._state !== "failed");
      w.innerHTML = sent ? `<b>Запрос отправлен.</b> Дождитесь, пока ${esc(o.name)} примет его, — тогда можно будет продолжить переписку.`
        : `<b>Это первое сообщение незнакомому человеку.</b> До принятия запроса можно отправить одно сообщение без фото и ссылок.`;
      canWrite = !sent; canFiles = false;
    } else if (st === "declined") {
      w.classList.add("red");
      w.innerHTML = mine ? "Собеседник ограничил переписку. Отправлять сообщения нельзя." : `Вы отклонили запрос.<div class="wb-acts"><button class="ok" id="cwAccept">Все-таки принять</button></div>`;
      canWrite = false;
    } else if (!convInfo.friend) {
      w.innerHTML = `⚠️ ${esc(o.name)} нет у вас в друзьях. Не переходите по ссылкам, не сообщайте коды из SMS, данные карт и адрес.<div class="wb-acts"><button id="cwRep">⚑ Пожаловаться</button><button id="cwBlock">🚫 Заблокировать</button></div>`;
    } else w.classList.add("hidden");
    $("composer").classList.toggle("hidden", !canWrite);
    $("attachBtn").classList.toggle("hidden", !canFiles); $("micBtn").classList.toggle("hidden", !canFiles || !!$("msgIn").value.trim());
    $("composer").dataset.files = canFiles ? "1" : "";
    const on = (id, f) => { const el = $(id); if (el) el.onclick = f; };
    on("cwRep", () => reportSheet({ type: "user", id: o.id, user_id: o.id, label: "пользователя" }));
    on("cwBlock", () => blockUser(o.id, o.name, () => openConv(convId)));
    on("cwAccept", async () => { try { convInfo.status = await api.conversationRespond(convId, true); convHead(); refreshChatBadge(); toast("Запрос принят"); Obs.track("chat_request_accepted"); } catch (e) { toast(e.message); } });
    on("cwDecline", async () => {
      if (!(await confirmSheet("Отклонить запрос?", `${o.name} больше не сможет писать вам в этой переписке. Вы сможете принять запрос позже.`, "Отклонить", true))) return;
      try { convInfo.status = await api.conversationRespond(convId, false); convHead(); refreshChatBadge(); toast("Запрос отклонен"); } catch (e) { toast(e.message); }
    });
  }
  async function openConv(cid) {
    go("sv-conv"); Conv.reset(); convId = cid; convInfo = null; lastSig = "";
    $("convMsgs").innerHTML = '<div class="spin"></div>'; $("convWarn").classList.add("hidden"); $("convWho").innerHTML = ""; $("convProg").textContent = "";
    try {
      convInfo = await api.conversationInfo(cid);
      if (convId !== cid) return;
      const list = await api.messages(cid);
      if (convId !== cid) return;
      list.forEach((m) => Conv.put(m)); convHead(); render(true);
      Conv.sub();
    } catch (e) { $("convMsgs").innerHTML = `<div class="empty"><b>Не открылось</b>${esc(e.message)}</div>`; }
  }
  $("convWho").onclick = () => { if (convInfo && convInfo.other.id) openUser(convInfo.other.id); };
  $("convMenu").onclick = () => {
    if (!convInfo || !convInfo.other.id) return; const o = convInfo.other;
    openSheet(o.name, `<button class="opt-row" id="cmProf">👤 Профиль<span>›</span></button><button class="opt-row" id="cmRep">⚑ Пожаловаться<span>›</span></button><button class="opt-row" id="cmBlock" style="color:#ff8a95">🚫 Заблокировать<span></span></button>`);
    $("cmProf").onclick = () => { closeSheet(); openUser(o.id); };
    $("cmRep").onclick = () => reportSheet({ type: "user", id: o.id, user_id: o.id, label: "пользователя" });
    $("cmBlock").onclick = () => blockUser(o.id, o.name, () => openConv(convId));
  };
  let lastSig = "";
  function render(scroll) {
    const list = [...Conv.msgs.values()].sort((a, b) => (a.created_at === b.created_at ? (a.id > b.id ? 1 : -1) : a.created_at.localeCompare(b.created_at)));
    const sig = list.map((m) => m.id + (m._state || "") + m.mod_status + (m.read_at ? 1 : 0) + (m.media_url || "")).join("|");
    if (sig === lastSig && !scroll) return; lastSig = sig;
    const box = $("convMsgs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    let day = "";
    box.innerHTML = list.length ? list.map((m) => {
      const d = dfmt(m.created_at, { day: "numeric", month: "long" });
      const sep = d !== day ? `<div class="day-sep">${(day = d)}</div>` : "";
      return sep + bubble(m);
    }).join("") : `<div class="empty" style="margin-top:20px"><b>Начните разговор</b>${convInfo && convInfo.status === "request" ? "Первое сообщение — только текст, без ссылок" : "Напишите сообщение, отправьте фото или голосовое 🎤"}</div>`;
    if (scroll || atBottom) box.scrollTop = box.scrollHeight;
    if (list.some((m) => user && m.sender_id !== user.id && !m.read_at) && !document.hidden) { api.markRead(convId).then(() => refreshChatBadge()).catch(() => {}); }
    if (convInfo && convInfo.status === "request" && convInfo.initiator === (user && user.id)) convHead();
  }
  function bubble(m) {
    const mine = user && m.sender_id === user.id;
    const st = m._state === "pending" ? " 🕓" : m._state === "failed" ? "" : mine ? (m.read_at ? " ✓✓" : " ✓") : "";
    const tm = `<span class="tm">${new Date(m.created_at).toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" })}${st}${mine && m.mod_status === "pending" ? " ⏳" : ""}</span>`;
    const fail = m._state === "failed" ? `<div class="bub-fail"><span>⚠ Не отправлено${m._err ? ": " + esc(m._err) : ""}</span><button data-resend="${m.id}">Повторить</button><button data-drop="${m.id}">Удалить</button></div>` : "";
    const flagged = m.mod_status === "flagged", pendingForThem = m.mod_status === "pending" && !mine && m.kind === "image";
    const cls = `bub ${mine ? "me" : "them"}${m._state ? " " + m._state : ""}`;
    let body = "";
    if (m.kind === "text") {
      body = flagged && !mine ? `<div class="blur-wrap" data-reveal style="border-radius:10px"><div class="bg" style="padding:4px 2px">${esc(m.text)}</div><div class="shield" style="font-size:11px">⚠️ Возможно оскорбительное<button type="button">Показать</button></div></div>` : esc(m.text);
      return `<div class="${cls}" data-msg="${m.id}" translate="no">${body}${flagged && mine ? '<span class="tm">⚠️ скрыто для получателя</span>' : ""}${tm}${fail}</div>`;
    }
    if (m.media_locked || (m.kind !== "text" && !m.media_url)) return `<div class="${cls}" data-msg="${m.id}"><span class="dim">🔒 Файл недоступен</span>${tm}</div>`;
    if (m.kind === "image") {
      const img = `<img src="${esc(m.media_url)}" alt="" loading="lazy" data-zoom>`;
      body = (flagged || pendingForThem) && !mine ? `<div class="blur-wrap" data-reveal>${img}<div class="shield">${flagged ? "⚠️ Возможно неприемлемое фото" : "⏳ Фото проверяется"}<button type="button">Показать</button></div></div>` : img;
    }
    if (m.kind === "video") body = `<video src="${esc(m.media_url)}" controls playsinline preload="metadata"></video>`;
    if (m.kind === "audio") body = `<audio src="${esc(m.media_url)}" controls preload="metadata"></audio>`;
    return `<div class="${cls} media" data-msg="${m.id}">${body}${m.text ? `<div class="cap" translate="no">${esc(m.text)}</div>` : ""}${tm}</div>`;
  }
  $("convMsgs").addEventListener("click", (e) => {
    let b;
    if ((b = e.target.closest("[data-resend]"))) { const m = Conv.msgs.get(b.dataset.resend); if (m) sendText(m.text, m.id); return; }
    if ((b = e.target.closest("[data-drop]"))) { Conv.msgs.delete(b.dataset.drop); render(); if (convInfo) convHead(); return; }
    if ((b = e.target.closest("[data-reveal]"))) { if (e.target.tagName === "BUTTON") { b.classList.remove("blur-wrap"); const s2 = b.querySelector(".shield"); if (s2) s2.remove(); } return; }
    if ((b = e.target.closest("[data-zoom]"))) return openViewer(b.src);
    if ((b = e.target.closest("[data-msg]")) && !e.target.closest("audio,video")) { const m = Conv.msgs.get(b.dataset.msg); if (m && !m._state) msgMenu(m.id, b.classList.contains("me")); }
  });
  function msgMenu(id, mine) {
    const m = Conv.msgs.get(id), txt = (m && m.text) || "";
    openSheet("Сообщение", `${txt ? '<button class="opt-row" id="mmCopy">📋 Копировать текст<span></span></button>' : ""}${mine ? `<button class="opt-row" id="mmDel" style="color:#ff8a95">🗑 Удалить у всех<span></span></button>` : `<button class="opt-row" id="mmRep">⚑ Пожаловаться на сообщение<span>›</span></button>`}`);
    if ($("mmCopy")) $("mmCopy").onclick = async () => { try { await navigator.clipboard.writeText(txt); toast("Скопировано"); } catch (e) { toast("Не удалось скопировать"); } closeSheet(); };
    if ($("mmDel")) $("mmDel").onclick = async () => { closeSheet(); try { await api.deleteMessage(id); Conv.msgs.delete(id); render(); } catch (e) { toast(e.message); } };
    if ($("mmRep")) $("mmRep").onclick = () => reportSheet({ type: "message", id, user_id: convInfo && convInfo.other.id, label: "сообщение" });
  }
  $("msgIn").oninput = () => { const has = !!$("msgIn").value.trim(), files = $("composer").dataset.files === "1"; $("sendBtn").classList.toggle("hidden", !has); $("micBtn").classList.toggle("hidden", has || !files); };
  // текст отправляется сразу в ленту переписки: 🕓 отправляется → ✓ доставлено; при ошибке — "Повторить" (тот же id, без дубля)
  async function sendText(text, id) {
    const cid = convId; if (!cid || !user) return;
    id = id || uuid();
    Conv.put({ id, conversation_id: cid, sender_id: user.id, kind: "text", text, mod_status: "ok", read_at: null, created_at: (Conv.msgs.get(id) || {}).created_at || new Date().toISOString(), _state: "pending" });
    render(true);
    try {
      const row = await api.sendMessage(cid, { text, id });
      if (cid !== convId) return;
      Conv.put({ ...row, _state: undefined }); render(); Sound.play("send");
      Obs.track("message_sent"); usefulAction("message");
      // первый ответ на чужое сообщение в этой переписке — для метрики "время до первого ответа"
      const all = [...Conv.msgs.values()].filter((x) => x.conversation_id === cid);
      if (all.some((x) => x.sender_id !== user.id) && all.filter((x) => x.sender_id === user.id).length === 1) Obs.track("first_reply");
    } catch (e) {
      if (e.code === "23505") { Conv.catchUp(); return; } // уже дошло — повтор не нужен
      if (gateError(e)) { Conv.msgs.delete(id); render(); return; }
      const m = Conv.msgs.get(id); if (m) { m._state = "failed"; m._err = e.message; } render();
      if (/принят|ссылк|Дождитесь|отклонил|недоступен/i.test(e.message)) toast(e.message);
    }
  }
  async function sendPayload(payload) {
    const cid = convId; if (!cid) return;
    try {
      const row = await api.sendMessage(cid, payload, (m) => ($("convProg").textContent = m)); $("convProg").textContent = "";
      if (cid === convId && row) { Conv.put(row); render(true); }
      Sound.play("send"); Obs.track("message_sent"); usefulAction("message");
    } catch (e) { $("convProg").textContent = ""; toast(e.message); throw e; }
  }
  $("composer").onsubmit = async (e) => {
    e.preventDefault(); const v = $("msgIn").value.trim(); if (!v) return;
    if (N.hasBad(v)) toast("🤬 Грубые слова будут скрыты звездочками");
    $("msgIn").value = ""; $("msgIn").oninput();
    sendText(v);
    $("msgIn").focus();
  };
  $("attachBtn").onclick = () => $("chatFile").click();
  $("chatFile").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try { const k = N.validateChatFile(f); if (k === "audio") throw new Error("Выберите фото или видео"); await sendPayload({ file: f, kind: k }); } catch (er) { if (!er.raw) toast(er.message); }
  };
  /* голосовые сообщения */
  let rec = null, recChunks = [], recStart = 0, recTimer = null, recStream = null;
  function pickMime() {
    const c = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    if (!window.MediaRecorder) return null;
    for (const t of c) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) {} }
    return "";
  }
  $("micBtn").onclick = async () => {
    const mime = pickMime();
    if (mime === null || !navigator.mediaDevices) { toast("Запись голоса не поддерживается в этом браузере"); return; }
    try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast("Разрешите доступ к микрофону в настройках браузера"); return; }
    recChunks = []; rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) recChunks.push(ev.data); };
    rec.start(250); recStart = Date.now();
    $("composer").classList.add("hidden"); $("recBar").classList.remove("hidden"); $("recTime").textContent = "0:00";
    recTimer = setInterval(() => { const s2 = Math.floor((Date.now() - recStart) / 1000); $("recTime").textContent = Math.floor(s2 / 60) + ":" + String(s2 % 60).padStart(2, "0"); if (s2 >= 120) $("recSend").click(); }, 250);
  };
  function stopRec(cancel) {
    return new Promise((res) => {
      clearInterval(recTimer);
      if (!rec) { res(null); return; }
      const r = rec; rec = null;
      r.onstop = () => { if (recStream) recStream.getTracks().forEach((t) => t.stop()); recStream = null; $("recBar").classList.add("hidden"); $("composer").classList.toggle("hidden", !!(convInfo && convInfo.blocked));
        if (cancel) { res(null); return; }
        const type = (r.mimeType || "audio/webm").split(";")[0];
        res(new File(recChunks, "voice." + (type.includes("mp4") ? "m4a" : type.split("/")[1]), { type })); };
      try { r.stop(); } catch (e) { res(null); }
    });
  }
  $("recCancel").onclick = () => stopRec(true);
  $("recSend").onclick = async () => {
    const dur = (Date.now() - recStart) / 1000; const f = await stopRec(false);
    if (!f || dur < 0.8) { if (f) toast("Слишком короткое голосовое"); return; }
    try { await sendPayload({ file: f, kind: "audio", duration: dur }); } catch (e) {}
  };
