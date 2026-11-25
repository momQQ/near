  /* =====================================================
     NEAR REPUTATION, отзывы после встречи, встречи (Host, co-host, посещаемость)
     ===================================================== */
  const REP_TXT = { high: "Высокая репутация", good: "Хорошая репутация", medium: "Средняя репутация", low: "Низкая репутация", new: "Новый участник · недостаточно данных" };
  const repSkeleton = () => '<div class="rep-card"><div class="spin"></div></div>';
  // полукруглая шкала; заполнение 600 мс (без анимации при reduced motion)
  function gauge(score) {
    const L = 157, v = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
    return `<svg class="gauge" viewBox="0 0 120 70" aria-hidden="true"><defs><linearGradient id="gg" x1="0" x2="1"><stop offset="0" stop-color="#FF7848"/><stop offset=".55" stop-color="#EC398E"/><stop offset="1" stop-color="#A54EE7"/></linearGradient></defs>
      <path d="M10 62a50 50 0 0 1 100 0" fill="none" stroke="var(--line)" stroke-width="10" stroke-linecap="round"/>
      <path class="g-fill" d="M10 62a50 50 0 0 1 100 0" fill="none" stroke="url(#gg)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${L}" stroke-dashoffset="${L}" style="--to:${(L * (1 - v)).toFixed(1)}"/></svg>`;
  }
  const stars = (r) => (r == null ? "—" : "★ " + String(r).replace(".", ","));
  async function loadRep(box, uid, mine) {
    if (!box) return;
    let r; try { r = await api.reputation(uid); } catch (e) { box.innerHTML = ""; return; }
    const fresh = r.score == null;
    box.innerHTML = `<div class="rep-card">
      <div class="rep-h"><b>Репутация</b><button class="rep-i" id="repInfo" aria-label="Как считается репутация">ⓘ</button></div>
      <div class="rep-g">${gauge(r.score)}<div class="rep-n">${fresh ? '<b class="new">Новый</b>' : `<b>${r.score}</b><small>из 100</small>`}</div></div>
      <div class="rep-l lvl-${r.level}">${REP_TXT[r.level]}</div>
      <div class="rep-2"><div><small>Организатор</small><b>${stars(r.host_rating)}</b><span>${r.host_reviews} ${plural(r.host_reviews, "отзыв", "отзыва", "отзывов")}</span></div>
        <div><small>Участник</small><b>${stars(r.member_rating)}</b><span>${r.member_reviews} ${plural(r.member_reviews, "отзыв", "отзыва", "отзывов")}</span></div></div>
      <div class="rep-3"><div><small>Посещаемость встреч</small><b>${r.attendance_pct == null ? "—" : r.attendance_pct + "%"}</b></div><div><small>Благодарности</small><b>${r.thanks}</b></div></div>
      <p class="rep-note">${fresh ? "Балл появится после 3 отзывов от разных людей и 3 завершенных встреч." : "Репутация не является гарантией безопасности."}</p></div>`;
    requestAnimationFrame(() => { const f = box.querySelector(".g-fill"); if (f) f.style.strokeDashoffset = f.style.getPropertyValue("--to"); });
    $("repInfo").onclick = () => openSheet("Из чего складывается репутация", `<div class="rep-parts">${[["Отзывы участников", 30], ["Посещаемость встреч", 25], ["Соблюдение правил", 25], ["Полезная активность", 10], ["История аккаунта", 10]]
      .map(([t, w]) => `<div><span>${t}</span><b>${w}%</b><i style="width:${w * 2.4}%"></i></div>`).join("")}</div>
      <p class="dim" style="font-size:12.5px;margin-top:8px">Неподтвержденные жалобы, мало лайков или отсутствие активности балл не снижают. Учитываются только решения модераторов. Начальные веса уточняются по итогам пилота.</p>
      ${mine && r.components ? `<p class="dim" style="font-size:12px;margin-top:6px">Ваши компоненты: отзывы ${r.components.V ?? "—"}, посещаемость ${r.components.A ?? "—"}, правила ${r.components.S ?? "—"}, активность ${r.components.U ?? "—"}, история ${r.components.H ?? "—"}</p>` : ""}`);
  }
  async function openReviews(uid, title) {
    go("sv-reviews"); $("rvSub").textContent = title || ""; const box = $("rvBody"); box.innerHTML = '<div class="spin"></div>';
    try {
      const list = await api.userReviews(uid);
      box.innerHTML = list.length ? list.map((r) => `<div class="rv-row"><div class="rv-h">${ava({ name: (r.reviewer && r.reviewer.nickname) || "?", avatar_url: r.reviewer && r.reviewer.avatar_url })}<div><b translate="no">@${esc((r.reviewer && r.reviewer.nickname) || "")}</b><small>${r.target_role === "host" ? "об организаторе" : "об участнике"} · ${timeAgo(r.created_at)}</small></div><span class="rv-s">${"★".repeat(r.rating)}<i>${"★".repeat(5 - r.rating)}</i></span></div>
        ${r.meeting_title ? `<div class="rv-m" translate="no">🤝 ${esc(r.meeting_title.slice(0, 70))}</div>` : ""}${(r.tags || []).length ? `<div class="rv-tags">${r.tags.map((t) => `<span>${esc(N.REVIEW_TAGS[t] || t)}</span>`).join("")}</div>` : ""}
        ${r.comment ? `<p translate="no">${esc(r.comment)}</p>` : ""}<button class="lnk rv-rep" data-rvrep="${r.id}">Пожаловаться</button></div>`).join("")
        : '<div class="empty"><b>Отзывов пока нет</b>Отзывы оставляют участники после встречи</div>';
      box.onclick = (e) => { const b = e.target.closest("[data-rvrep]"); if (b) reportSheet({ type: "review", id: b.dataset.rvrep, user_id: uid, label: "отзыв" }); };
    } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  /* ---------- оценка после встречи ---------- */
  async function reviewSheet(postId) {
    if (!requireAuth("Войдите, чтобы оставить отзыв")) return;
    const [targets, p] = await Promise.all([api.reviewTargets(postId).catch(() => []), api.getPost(postId).catch(() => null)]);
    const left = targets.filter((t) => !t.done);
    if (!left.length) return toast(targets.length ? "Вы уже оценили всех участников этой встречи 💜" : "Отзыв могут оставить только подтвержденные участники в течение 7 дней после встречи");
    const t = left[0]; let rating = 0; const tags = new Set();
    const mc = p && p.event && N.MEET_CATS[p.event.meet_cat];
    openSheet("Оцените встречу", `<div class="rvf">
      <div class="rvf-meet"><span>${mc ? mc.e : "🤝"}</span><div><b translate="no">${esc(p ? p.text.slice(0, 60) : "Встреча")}</b><small>Встреча завершена</small></div></div>
      <div class="rvf-who">${ava({ name: t.nickname || "?", avatar_url: t.avatar_url })}<b translate="no">@${esc(t.nickname || "")}</b><small>${t.role === "host" ? "Организатор встречи" : "Участник встречи"}</small></div>
      <div class="rvf-stars" role="radiogroup" aria-label="Оценка">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-st="${n}" role="radio" aria-checked="false" aria-label="${n} из 5">☆</button>`).join("")}</div>
      <div class="rvf-n" id="rvN">Выберите оценку</div>
      <div class="lbl">Что вам понравилось?</div>
      <div class="rvf-tags">${Object.entries(N.REVIEW_TAGS).map(([k, v]) => `<button type="button" data-tag="${k}">${v}</button>`).join("")}</div>
      <textarea id="rvTx" maxlength="500" rows="3" placeholder="Расскажите о встрече..."></textarea><div class="rvf-cnt"><span id="rvCnt">0</span>/500</div>
      <button class="btn btn-main big" id="rvSend" disabled>Отправить отзыв</button>
      <p class="dim center" style="font-size:12px;margin-top:8px">Отзыв могут оставить только подтвержденные участники. ${left.length > 1 ? `Еще ${left.length - 1} — после этого.` : ""}</p></div>`);
    const L = $("bsList");
    qa("[data-st]", L).forEach((b) => (b.onclick = () => {
      rating = +b.dataset.st; qa("[data-st]", L).forEach((x) => { const on = +x.dataset.st <= rating; x.textContent = on ? "★" : "☆"; x.classList.toggle("on", on); x.setAttribute("aria-checked", +x.dataset.st === rating ? "true" : "false"); });
      b.classList.remove("pick"); void b.offsetWidth; b.classList.add("pick");
      $("rvN").textContent = rating + "/5"; $("rvSend").disabled = false;
    }));
    qa("[data-tag]", L).forEach((b) => (b.onclick = () => { b.classList.toggle("on"); if (tags.has(b.dataset.tag)) tags.delete(b.dataset.tag); else tags.add(b.dataset.tag); }));
    $("rvTx").oninput = () => ($("rvCnt").textContent = $("rvTx").value.length);
    $("rvSend").onclick = async () => {
      try { await busy($("rvSend"), () => api.reviewSubmit(postId, t.user_id, rating, [...tags], $("rvTx").value)); closeSheet(); toast("⭐ Спасибо за отзыв!"); if (left.length > 1) setTimeout(() => reviewSheet(postId), 400); }
      catch (e) { toast(e.message); }
    };
  }
  /* ---------- встреча: участники, отметки, организатор ---------- */
  async function meetingSheet(postId) {
    const [mi, p] = await Promise.all([api.meetingInfo(postId), api.getPost(postId).catch(() => null)]);
    if (!mi) return toast("Встреча не найдена");
    const role = mi.role, started = new Date(mi.starts_at) < Date.now(), going = mi.members.filter((m) => m.status === "going");
    const mc = N.MEET_CATS[mi.meet_cat] || N.MEET_CATS.other;
    const ATT = { attended: "✓ был(а)", missed: "не пришел(ла)", disputed: "спорно — проверит модератор", unknown: "не отмечено" };
    openSheet("Встреча", `<div class="mt-h"><span class="mt-c">${mc.e} ${mc.n}</span><b translate="no">${esc(p ? p.text.slice(0, 80) : "")}</b>
      <small>${fmtWhen(mi.starts_at)}${mi.ends_at ? " — " + fmtWhen(mi.ends_at) : ""} · ${going.length}${mi.capacity ? "/" + mi.capacity : ""} участников</small>
      ${mi.status === "cancelled" ? `<div class="warn-banner red">Встреча отменена${mi.cancel_reason ? ": " + esc(mi.cancel_reason) : ""}</div>` : ""}</div>
      <div class="lbl">Организатор</div><div class="u-row" data-user="${mi.host_id}">${ava({ name: (mi.host && mi.host.nickname) || "?", avatar_url: mi.host && mi.host.avatar_url })}<div class="tx"><b translate="no">@${esc((mi.host && mi.host.nickname) || "")}</b><span>Host${mi.cohost_id ? " · есть co-host" : ""}</span></div></div>
      <div class="lbl mt8">Участники</div>${going.length ? going.map((m) => `<div class="u-row mt-m"><span data-user="${m.user_id}">${ava({ name: m.nickname || "?", avatar_url: m.avatar_url })}</span><div class="tx"><b translate="no">@${esc(m.nickname || "")}${m.user_id === mi.cohost_id ? " · co-host" : ""}</b><span>${started ? ATT[m.attendance] : "идет"}</span></div>
        ${role === "host" || role === "cohost" ? (started ? `<button class="pill-btn" data-mark="${m.user_id}" data-v="1" aria-label="Был">✓</button><button class="pill-btn ghost" data-mark="${m.user_id}" data-v="0" aria-label="Не пришел">✕</button>` : `<button class="pill-btn ghost" data-mact="${m.user_id}" aria-label="Действия с участником">⋯</button>`) : ""}</div>`).join("") : '<div class="empty-mini">Пока никто не вступил</div>'}
      <div class="mt-btns">
        ${role === "member" && started ? '<button class="btn btn-ghost" id="mtSelfY">Я был(а) на встрече</button><button class="btn btn-ghost" id="mtSelfN">Я не пришел(ла)</button>' : ""}
        ${mi.chat_id && role ? '<button class="btn btn-ghost" id="mtChat">💬 Чат встречи</button>' : ""}
        ${role === "member" && !started && mi.status !== "cancelled" ? '<button class="btn btn-ghost" id="mtLeave">Не смогу прийти</button>' : ""}
        ${role === "host" && !started && mi.status !== "cancelled" ? '<button class="btn btn-ghost danger-o" id="mtCancel">Отменить встречу</button>' : ""}
      </div>
      <p class="dim" style="font-size:12px;margin-top:8px">Организатор может исключить участника только из своей встречи или ограничить его в чате встречи. Блокировка аккаунта — только решение модератора.</p>`);
    const L = $("bsList");
    qa("[data-mark]", L).forEach((b) => (b.onclick = async () => { try { const r = await api.meetingMark(postId, b.dataset.mark, b.dataset.v === "1"); toast(r === "disputed" ? "Отметки расходятся — решит модератор" : "Отмечено"); meetingSheet(postId); } catch (e) { toast(e.message); } }));
    qa("[data-mact]", L).forEach((b) => (b.onclick = () => {
      const uid2 = b.dataset.mact;
      openSheet("Участник", `${role === "host" ? '<button class="opt-row" id="mcCo">⭐ Сделать co-host</button>' : ""}<button class="opt-row danger" id="mcEx">🚪 Исключить из встречи</button>`);
      if ($("mcCo")) $("mcCo").onclick = async () => { try { await api.meetingSetCohost(postId, uid2); toast("Co-host назначен"); meetingSheet(postId); } catch (e) { toast(e.message); } };
      $("mcEx").onclick = async () => { if (!(await confirmSheet("Исключить участника?", "Он не сможет снова вступить в эту встречу. Это не блокирует аккаунт в NEAR.", "Исключить", true))) return; try { await api.meetingExclude(postId, uid2, "Исключен организатором"); toast("Участник исключен из встречи"); meetingSheet(postId); } catch (e) { toast(e.message); } };
    }));
    if ($("mtSelfY")) $("mtSelfY").onclick = async () => { try { await api.meetingMark(postId, user.id, true); toast("Спасибо! Посещаемость учтена"); closeSheet(); } catch (e) { toast(e.message); } };
    if ($("mtSelfN")) $("mtSelfN").onclick = async () => { try { await api.meetingMark(postId, user.id, false); toast("Отмечено"); closeSheet(); } catch (e) { toast(e.message); } };
    if ($("mtChat")) $("mtChat").onclick = () => { closeSheet(); openConv(mi.chat_id); };
    if ($("mtLeave")) $("mtLeave").onclick = async () => { try { await api.meetingLeave(postId); toast(new Date(mi.starts_at) - Date.now() > 2 * 3600e3 ? "Участие отменено — спасибо, что предупредили" : "Участие отменено"); closeSheet(); const q = cache.get(postId); if (q && q.event) { q.event.joined = false; q.event.members--; patchCard(q); } } catch (e) { toast(e.message); } };
    if ($("mtCancel")) $("mtCancel").onclick = async () => { if (!(await confirmSheet("Отменить встречу?", "Участники получат уведомление.", "Отменить встречу", true))) return; try { await api.meetingCancel(postId, "Организатор отменил встречу"); toast("Встреча отменена, участники уведомлены"); closeSheet(); } catch (e) { toast(e.message); } };
    L.onclick = (e) => { const u2 = e.target.closest("[data-user]"); if (u2 && !e.target.closest("button[data-mark],button[data-mact]")) { closeSheet(); openUser(u2.dataset.user); } };
  }
  async function myMeetings() {
    const [mine, pend] = await Promise.all([api.myPosts().catch(() => []), api.reviewsPending().catch(() => [])]);
    const hosted = mine.filter((p) => p.category === "meetup");
    openSheet("Мои встречи", `${pend.length ? '<div class="lbl">Ждут вашего отзыва</div>' + pend.map((x) => `<button class="opt-row" data-rv="${x.post_id}">⭐ <span translate="no">${esc(x.title)}</span><span>${x.left_count}</span></button>`).join("") : ""}
      <div class="lbl mt8">Организую</div>${hosted.length ? hosted.map((p) => `<button class="opt-row" data-mt="${p.id}">🤝 <span translate="no">${esc(p.text.slice(0, 50))}</span><span>${p.event ? fmtWhen(p.event.starts_at) : ""}</span></button>`).join("") : '<div class="empty-mini">Вы еще не создавали встреч</div>'}
      <button class="btn btn-main full mt12" data-create="meetup">+ Создать встречу</button>`);
    qa("[data-rv]", $("bsList")).forEach((b) => (b.onclick = () => { closeSheet(); reviewSheet(b.dataset.rv); }));
    qa("[data-mt]", $("bsList")).forEach((b) => (b.onclick = () => { closeSheet(); meetingSheet(b.dataset.mt); }));
  }
  // после встречи: предложение оставить отзыв (один раз на встречу в этой вкладке)
  async function promptReviews() {
    if (!user) return;
    const list = await api.reviewsPending().catch(() => []);
    const seen = JSON.parse(sessionStorage.getItem("near_rv_seen") || "[]");
    const x = list.find((r) => !seen.includes(r.post_id)); if (!x) return;
    seen.push(x.post_id); sessionStorage.setItem("near_rv_seen", JSON.stringify(seen));
    const t = $("toast"); t.innerHTML = `⭐ Встреча "${esc(x.title.slice(0, 30))}" завершена. <button class="lnk" id="rvGo">Оценить</button>`; t.classList.add("on");
    $("rvGo").onclick = () => { t.classList.remove("on"); reviewSheet(x.post_id); };
    setTimeout(() => t.classList.remove("on"), 7000);
  }
