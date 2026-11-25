  /* =====================================================
     ОБЩИЕ ЧАТЫ (город, район, встреча) и друзья. Личных сообщений нет (v14.8).
     ===================================================== */
  let chTab = "chats", chatSeen = -1, convId = null, convInfo = null, replyTo = null;
  qa("#chSeg [data-t]").forEach((b) => (b.onclick = () => { chTab = b.dataset.t; qa("#chSeg button").forEach((x) => x.classList.toggle("on", x === b)); renderChats(); }));
  const shortTime = (iso) => { const d = new Date(iso), n = new Date(); return d.toDateString() === n.toDateString() ? d.toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" }) : dfmt(d, { day: "numeric", month: "short" }); };
  const CHAT_ICO = { city: "🏙️", district: "🏘️", meeting: "🤝" };
  const chatRow = (c) => `<button class="u-row chat-row${c.unread ? " unread-row" : ""}" data-conv="${c.id}"><span class="chat-ico k-${c.kind}">${CHAT_ICO[c.kind] || "💬"}</span>
    <div class="tx"><b translate="no">${esc(c.title)}</b><span>${c.last_text ? `<i translate="no">@${esc(c.last_nick || "")}</i>: <span translate="no">${esc(c.last_text)}</span>` : c.kind === "city" ? "Городское сообщество" : c.kind === "district" ? "Соседи вашего района" : "Чат участников встречи"}</span></div>
    <div class="meta">${c.last_message_at ? `<small>${shortTime(c.last_message_at)}</small>` : ""}${c.unread ? `<span class="badge-n">${c.unread > 99 ? "99+" : c.unread}</span>` : ""}</div></button>`;
  async function renderChats() {
    const box = $("chBody");
    if (!user) { box.innerHTML = `<div class="empty"><b>Общие чаты</b>Городской чат, чат района и чаты встреч — после входа<br><button class="btn btn-main mt12" id="chLogin">Войти</button></div>`; $("chLogin").onclick = () => showAuth("login"); return; }
    if (!box.children.length || box.querySelector(".empty")) box.innerHTML = '<div class="spin"></div>';
    try {
      const rq = await api.friendRequests();
      $("reqBadge").textContent = rq.incoming.length; $("reqBadge").classList.toggle("hidden", !rq.incoming.length);
      if (chTab === "chats") {
        const list = await api.chatList();
        box.innerHTML = (list.length ? list.map(chatRow).join("") : `<div class="empty"><b>Чатов пока нет</b>Выберите район в профиле или вступите во встречу</div>`)
          + (!user.district ? `<button class="req-strip" data-open="sv-settings">🏘️ Укажите район в профиле — откроется чат соседей ›</button>` : "");
      } else {
        const fr = await api.friends();
        box.innerHTML = (rq.incoming.length ? '<div class="lbl">Заявки в друзья</div>' + rq.incoming.map((u) => `<div class="u-row" data-user="${u.id}">${ava(u)}<div class="tx"><b translate="no">@${esc(u.nickname || u.name)}</b><span>хочет добавить вас в друзья</span></div><button class="pill-btn" data-accept="${u.id}">✓ Принять</button><button class="pill-btn ghost" data-decline="${u.id}" aria-label="Отклонить">✕</button></div>`).join("") : "")
          + '<div class="lbl mt12">Друзья</div>' + (fr.length ? fr.map((u) => `<div class="u-row" data-user="${u.id}"><span class="ava-w">${ava(u)}</span><div class="tx"><b translate="no">@${esc(u.nickname || u.name)}${vBadge(u)}</b><span>${u.district ? esc(u.district) : "Алматы"}</span></div></div>`).join("")
            : '<div class="empty-mini">Друзей пока нет. Добавить можно из профиля участника встречи или автора публикации</div>')
          + '<button class="search mt12" data-open="sv-find">🔍 Найти по никнейму</button>';
      }
    } catch (e) { box.innerHTML = `<div class="empty"><b>Ошибка</b>${esc(e.message)}<br><button class="btn btn-main mt12" id="chRetry">Повторить</button></div>`; $("chRetry").onclick = renderChats; }
  }
  $("chBody").onclick = async (e) => {
    let b;
    if ((b = e.target.closest("[data-accept]"))) { try { await api.acceptFriend(b.dataset.accept); toast("🤝 Теперь вы друзья"); renderChats(); refreshChatBadge(); } catch (er) { toast(er.message); } return; }
    if ((b = e.target.closest("[data-decline]"))) { try { await api.removeFriend(b.dataset.decline); toast("Заявка удалена"); renderChats(); refreshChatBadge(); } catch (er) { toast(er.message); } return; }
    if ((b = e.target.closest("[data-conv]"))) return openConv(b.dataset.conv);
    if ((b = e.target.closest("[data-user]"))) return openUser(b.dataset.user);
  };
  async function refreshChatBadge(notify) {
    if (!api || !user) { $("chatBadge").classList.add("hidden"); return; }
    try {
      const [list, rq] = await Promise.all([api.chatList(), api.friendRequests()]);
      const m = list.reduce((t, c) => t + (c.unread || 0), 0), n = Math.min(m, 99) + rq.incoming.length;
      $("chatBadge").textContent = n > 9 ? "9+" : n; $("chatBadge").classList.toggle("hidden", !n);
      if (notify && chatSeen >= 0 && m > chatSeen && cur() !== "sv-conv" && prefOn("n_msg")) Sound.play("message");
      chatSeen = m;
    } catch (e) {}
  }
  // личных сообщений нет: из профиля можно добавить в друзья или встретиться в общем чате
  function startChat() { toast("Личных сообщений в NEAR нет. Общайтесь в общих чатах и чатах встреч"); hist = []; go("v-chats", false); }

  /* поиск по никнейму */
  let fT = null;
  $("fq").oninput = () => { clearTimeout(fT); fT = setTimeout(async () => {
    const q = $("fq").value.trim().replace(/^@/, "");
    if (q.length < 2) { $("fRes").innerHTML = '<div class="dim center" style="font-size:12px;padding:20px">Введите минимум 2 символа никнейма</div>'; return; }
    $("fRes").innerHTML = '<div class="spin"></div>';
    try { const list = await api.searchUsers(q); $("fRes").innerHTML = list.length ? list.map((u) => `<button class="u-row" data-user="${u.id}">${ava(u)}<div class="tx"><b translate="no">@${esc(u.nickname || u.name)}</b><span>${u.district ? esc(u.district) : "Алматы"}</span></div></button>`).join("") : '<div class="empty">Никого не нашли</div>'; }
    catch (e) { $("fRes").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }, 300); };
  $("fRes").onclick = (e) => { const b = e.target.closest("[data-user]"); if (b) openUser(b.dataset.user); };

  /* =====================================================
     ОТКРЫТЫЙ ЧАТ: сообщения, ответы, реакции
     ===================================================== */
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));
  const REACT = ["❤️", "👍", "😂", "😮", "😢", "🙏"];
  const Conv = {
    msgs: new Map(), off: null,
    reset() { this.msgs.clear(); this.unsub(); },
    sub() { this.unsub(); if (!convId || !api.subscribeChat) return; const id = convId; this.off = api.subscribeChat(id, (t) => { if (t === "insert" && convId === id) this.catchUp(); }, (st) => { if (["CHANNEL_ERROR", "TIMED_OUT"].includes(st)) this.poll(); }); },
    unsub() { if (this.off) { try { this.off(); } catch (e) {} this.off = null; } clearTimeout(this.pT); },
    poll() { clearTimeout(this.pT); this.pT = setTimeout(() => { if (convId && !document.hidden) this.catchUp(); this.poll(); }, 15000); },
    async catchUp() { if (!convId) return; const id = convId; const rows = await api.chatPage(id).catch(() => null); if (!rows || convId !== id) return; rows.forEach((m) => this.msgs.set(m.id, m)); render(true); api.chatRead(id).catch(() => {}); },
    statusChanged() {}, onRow() { this.catchUp(); }
  };
  async function openConv(cid) {
    if (!requireAuth("Войдите, чтобы открыть чат", { t: "chat", a: cid })) return;
    go("sv-conv"); Conv.reset(); convId = cid; replyTo = null; $("cvReply").classList.add("hidden");
    $("convMsgs").innerHTML = '<div class="spin"></div>';
    const list = await api.chatList().catch(() => []);
    convInfo = list.find((c) => c.id === cid) || { id: cid, title: "Чат", kind: "city" };
    $("convWho").innerHTML = `<span class="chat-ico k-${convInfo.kind}">${CHAT_ICO[convInfo.kind] || "💬"}</span><div><b translate="no">${esc(convInfo.title)}</b><small>${convInfo.kind === "city" ? "Городское сообщество" : convInfo.kind === "district" ? "Чат района" : "Участники встречи"}</small></div>`;
    try { const rows = await api.chatPage(cid); rows.forEach((m) => Conv.msgs.set(m.id, m)); render(true); api.chatRead(cid).catch(() => {}); refreshChatBadge(); }
    catch (e) { $("convMsgs").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    Conv.sub();
  }
  function render(scroll) {
    const box = $("convMsgs"), atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const list = [...Conv.msgs.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    box.innerHTML = list.length ? list.map(bubble).join("") : '<div class="empty-mini">Сообщений пока нет. Начните разговор — вежливо и по делу 🙂</div>';
    if (scroll || atEnd) box.scrollTop = box.scrollHeight;
  }
  function bubble(m) {
    const mine = user && m.sender_id === user.id, R = m.reactions || {};
    const reacts = Object.keys(R).length ? `<div class="rx">${Object.entries(R).map(([e, n]) => `<button class="rx-b${(m.mine_reactions || []).includes(e) ? " on" : ""}" data-react="${m.id}" data-e="${e}" aria-label="${e} ${n}">${e} ${n}</button>`).join("")}</div>` : "";
    return `<div class="gmsg${mine ? " mine" : ""}${m.pending ? " sending" : ""}" data-msg="${m.id}">
      ${mine ? "" : `<button class="g-ava" data-user="${m.sender_id}" aria-label="@${esc(m.nickname || "")}">${ava({ name: m.nickname || "?", avatar_url: m.avatar_url })}</button>`}
      <div class="g-b">${mine ? "" : `<b class="g-nick" data-user="${m.sender_id}" translate="no">@${esc(m.nickname || "")}</b>`}
        ${m.reply_to ? `<div class="g-reply" translate="no"><b>@${esc(m.reply_nick || "")}</b> ${esc(m.reply_text || "")}</div>` : ""}
        <div class="g-t" translate="no">${esc(m.text)}</div>
        <div class="g-m">${m.mod_status === "pending" ? "🛡 на проверке · " : ""}${m.pending ? "🕓" : shortTime(m.created_at)}</div></div>
      <button class="g-more" data-mmenu="${m.id}" aria-label="Действия с сообщением">⋯</button>${reacts}</div>`;
  }
  $("convMsgs").onclick = async (e) => {
    let b;
    if ((b = e.target.closest("[data-user]"))) return openUser(b.dataset.user);
    if ((b = e.target.closest("[data-react]"))) return react(b.dataset.react, b.dataset.e);
    if ((b = e.target.closest("[data-mmenu]"))) return msgMenu(b.dataset.mmenu);
  };
  async function react(id, emoji) {
    const m = Conv.msgs.get(id); if (!m) return;
    try { const on = await api.chatReact(id, emoji); m.reactions = m.reactions || {}; m.mine_reactions = m.mine_reactions || [];
      m.reactions[emoji] = Math.max(0, (m.reactions[emoji] || 0) + (on ? 1 : -1)); if (!m.reactions[emoji]) delete m.reactions[emoji];
      m.mine_reactions = on ? [...m.mine_reactions, emoji] : m.mine_reactions.filter((x) => x !== emoji); render(); }
    catch (er) { toast(er.message); }
  }
  function msgMenu(id) {
    const m = Conv.msgs.get(id); if (!m) return;
    const mine = user && m.sender_id === user.id, host = convInfo && convInfo.kind === "meeting" && ["host", "cohost"].includes(convInfo.role);
    openSheet("Сообщение", `<div class="rx-pick">${REACT.map((e) => `<button data-pick="${e}" aria-label="Реакция ${e}">${e}</button>`).join("")}</div>
      <button class="opt-row" id="mmReply">↩️ Ответить</button><button class="opt-row" id="mmCopy">📋 Скопировать текст</button>
      ${mine ? "" : `<button class="opt-row" id="mmReport">🚩 Пожаловаться</button>`}${host && !mine ? `<button class="opt-row danger" id="mmRestrict">⏸ Ограничить в этом чате на 24 часа</button>` : ""}`);
    qa("[data-pick]", $("bsList")).forEach((b) => (b.onclick = () => { closeSheet(); react(id, b.dataset.pick); }));
    $("mmReply").onclick = () => { closeSheet(); replyTo = m; $("cvReply").querySelector("span").innerHTML = `Ответ <b>@${esc(m.nickname || "")}</b>: ${esc(m.text.slice(0, 60))}`; $("cvReply").classList.remove("hidden"); $("msgIn").focus(); };
    $("mmCopy").onclick = () => { closeSheet(); navigator.clipboard && navigator.clipboard.writeText(m.text).then(() => toast("Скопировано")); };
    if ($("mmReport")) $("mmReport").onclick = () => { closeSheet(); reportSheet({ type: "chat_message", id, user_id: m.sender_id, label: "сообщение" }); };
    if ($("mmRestrict")) $("mmRestrict").onclick = async () => { closeSheet(); try { await api.chatRestrict(convId, m.sender_id, 24); toast("Участник ограничен в этом чате на 24 часа"); } catch (er) { toast(er.message); } };
  }
  $("cvReplyX").onclick = () => { replyTo = null; $("cvReply").classList.add("hidden"); };
  $("convMenu").onclick = () => {
    if (!convInfo) return;
    openSheet(convInfo.title, `${convInfo.kind === "meeting" && convInfo.post_id ? `<button class="opt-row" id="cmMeet">🤝 Открыть встречу</button>` : ""}<button class="opt-row" id="cmRules">📜 Правила общения</button>`);
    if ($("cmMeet")) $("cmMeet").onclick = () => { closeSheet(); openPost(convInfo.post_id); };
    $("cmRules").onclick = () => { closeSheet(); showRules(); };
  };
  $("composer").onsubmit = async (e) => {
    e.preventDefault(); const inp = $("msgIn"), text = inp.value.trim(); if (!text || !convId) return;
    const pre = N.clean(text, "chat");
    if (pre.verdict === "block") return toast(pre.reasons.includes("bad_link") ? "Ссылка выглядит небезопасной. Уберите ее" : pre.reasons.includes("scam_request") ? "Нельзя просить данные карт и коды из SMS" : "Сообщение не прошло проверку NEAR Clean");
    const key = uuid(), tmp = { id: "tmp-" + key, sender_id: user.id, nickname: user.nickname, text: pre.text, created_at: new Date().toISOString(), pending: true, reply_to: replyTo && replyTo.id, reply_nick: replyTo && replyTo.nickname, reply_text: replyTo && replyTo.text };
    Conv.msgs.set(tmp.id, tmp); render(true); inp.value = "";
    const rt = replyTo; replyTo = null; $("cvReply").classList.add("hidden");
    try {
      const m = await api.chatSend(convId, text, key, rt && rt.id);
      Conv.msgs.delete(tmp.id); Conv.msgs.set(m.id, { ...tmp, ...m, nickname: user.nickname, pending: false, reactions: {}, mine_reactions: [] }); render(true);
      Obs.track("message_sent");
    } catch (er) { Conv.msgs.delete(tmp.id); render(); inp.value = text; if (!gateError(er)) toast(er.message); }
  };
  function stopRec() {}
