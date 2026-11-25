  /* =====================================================
     POST DETAIL
     ===================================================== */
  let openPostId = null;
  async function openPost(id, focusComment) {
    openPostId = id; go("sv-post");
    const p0 = cache.get(id);
    if (p0) renderDetail(p0); else $("pdBody").innerHTML = '<div class="spin"></div>';
    try {
      const p = await api.getPost(id);
      if (openPostId !== id) return;
      cache.set(id, p); renderDetail(p);
      if (focusComment) openComments(id);
    } catch (e) { $("pdBody").innerHTML = `<div class="empty"><b>Не открылось</b>${esc(e.message)}</div>`; }
  }
  function renderDetail(p) {
    const c = CATS[p.category] || CATS.talk, mine = user && user.id === p.user_id, closed = p.status === "closed";
    $("pdSub").textContent = c.n + " · " + fmtDist(D(p)) + " от вас";
    const ev = p.event ? `<div class="ev-box"><b>🗓 ${fmtWhen(p.event.starts_at)}</b><div class="muted" style="font-size:12px;margin-top:3px">Участников: ${p.event.members}${p.event.capacity ? " из " + p.event.capacity : ""}</div>
      <div class="row">${closed ? "" : `<button class="btn ${p.event.joined ? "btn-ghost" : "btn-main"}" data-join="${p.id}">${p.event.joined ? "✓ Я иду · отменить" : "Иду"}</button>`}<button class="btn btn-ghost" id="pdCal">📅 В календарь</button></div></div>` : "";
    const closeLabel = closed ? "↩ Вернуть" : (p.category === "lost" || p.category === "found") ? "✅ Вернули хозяину" : "✅ Неактуально";
    const own = mine ? `<div class="own"><button id="pdEdit">✏️ Изменить</button><button id="pdClose">${closeLabel}</button><button class="del" id="pdDel">🗑 Удалить</button></div>` : "";
    const hiddenNote = p.status === "hidden" ? `<div class="warn-banner red" style="margin:0 0 10px">🛡 Публикация скрыта и ждет проверки модератора. Ее видите только вы${user && user.is_mod ? " и модераторы" : ""}.${mine ? '<div class="wb-acts"><button id="pdAppeal">Обжаловать</button></div>' : ""}</div>` : "";
    $("pdBody").innerHTML = `${hiddenNote}<div class="pd-card">${card(p)}</div>${ev}${own}<button class="btn btn-ghost full mt12" data-cmt="${p.id}">💬 ${p.comments ? "Комментарии · " + p.comments : "Написать комментарий"}</button>`;
    wireMedia($("pdBody")); bindDetail(p); return;
  }
  function bindDetail(p) {
    const body = $("pdBody");
    body.onclick = (e) => {
      let b;
      if ((b = e.target.closest("#pdCal, #pdEdit, #pdClose, #pdDel"))) return;
      if (e.target.closest(".post")) { if (e.target.closest("[data-like],[data-save],[data-join],[data-onmap],[data-cmt],[data-share],[data-pmenu],[data-moretext],[data-reveal],.gs,[data-user]")) return postClick(e); return; }
      if ((b = e.target.closest("[data-cmt]"))) return openComments(p.id);
      if ((b = e.target.closest("[data-like]"))) return doLike(p.id);
      if ((b = e.target.closest("[data-save]"))) return doSave(p.id);
      if ((b = e.target.closest("[data-join]"))) return doJoin(p.id);
      if ((b = e.target.closest("[data-onmap]"))) return showOnMap(p.id);
      if ((b = e.target.closest("[data-reveal]"))) { b.classList.remove("blur-wrap"); b.querySelector(".shield").remove(); return; }
      if ((b = e.target.closest("[data-zoom]"))) return openViewer(b.src);
      if ((b = e.target.closest("[data-user]"))) return openUser(b.dataset.user);
    };
    if ($("pdCal")) $("pdCal").onclick = () => addToCalendar(p);
    if ($("pdEdit")) $("pdEdit").onclick = () => openCreate({ edit: p });
    if ($("pdClose")) $("pdClose").onclick = () => toggleClosed(p);
    if ($("pdDel")) $("pdDel").onclick = () => deletePostFlow(p);
    if ($("pdAppeal")) $("pdAppeal").onclick = () => appealSheet("post", p.id);
  }
  // SEC-08: апелляция автора на решение модератора
  function appealSheet(type, id) {
    openSheet("Обжаловать решение", `<p class="muted" style="font-size:13px;margin-bottom:10px">Объясните, почему решение стоит пересмотреть. Модератор ответит уведомлением.</p>
      <div class="fld"><textarea id="apTx" maxlength="1000" placeholder="Например: это не реклама, а объявление соседям" style="min-height:90px"></textarea></div>
      <div class="err" id="apErr"></div><div class="sheet-btns"><button class="btn btn-ghost" id="apNo">Отмена</button><button class="btn btn-main" id="apYes">Отправить</button></div>`);
    $("apNo").onclick = closeSheet;
    $("apYes").onclick = async () => {
      const t = $("apTx").value.trim(); if (t.length < 5) { $("apErr").textContent = "Напишите хотя бы пару слов"; $("apErr").classList.add("on"); return; }
      try { await busy($("apYes"), () => api.appeal(type, id, t)); closeSheet(); toast("Апелляция отправлена модератору"); } catch (e) { $("apErr").textContent = e.message; $("apErr").classList.add("on"); }
    };
  }

  function postLink(p) { return location.origin + location.pathname + "#post=" + p.id; }
  async function sharePost(p) {
    const data = { title: "NEAR", text: p.text.slice(0, 120), url: postLink(p) };
    try { if (navigator.share) { await navigator.share(data); return; } } catch (e) { if (e.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(data.url); toast("🔗 Ссылка скопирована"); } catch (e) { toast(data.url); }
  }
  function addToCalendar(p) {
    const s = new Date(p.event.starts_at), e = new Date(s.getTime() + 2 * 3600e3);
    const f = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NEAR//RU", "BEGIN:VEVENT", "UID:" + p.id + "@near", "DTSTAMP:" + f(new Date()), "DTSTART:" + f(s), "DTEND:" + f(e),
      "SUMMARY:" + p.text.slice(0, 60).replace(/[\n,;]/g, " "), "DESCRIPTION:" + postLink(p), "GEO:" + p.lat + ";" + p.lng, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    try { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" })); a.download = "near-event.ics"; document.body.appendChild(a); a.click(); a.remove(); toast("📅 Файл события скачан, откройте его, чтобы добавить в календарь"); }
    catch (e) { toast("Не удалось создать событие календаря"); }
  }

  /* =====================================================
     CREATE / EDIT
     ===================================================== */
  const ORDER = ["incident", "event", "deal", "meetup", "help", "lost", "found", "ad", "talk"];
  // v14 / 03: семь типов создания — шесть плиток и отдельно SOS. Цвета — как метки на карте (раздел 27)
  const GROUPS = {
    post: { t: "Публикация", s: "Новости и обсуждения, объявления", ic: "talk", c: "#EC398E", types: ["talk", "ad"], title: "Новая публикация" },
    incident: { t: "Происшествие", s: "Дороги и отключения", ic: "incident", c: "#FF7848", types: ["incident"], title: "Происшествие" },
    meetup: { t: "Встреча", s: "Компания для занятия", ic: "meetup", c: "#A54EE7", types: ["meetup"], title: "Новая встреча" },
    event: { t: "Событие", s: "Городское мероприятие", ic: "event", c: "#3da5ff", types: ["event"], title: "Новое событие" },
    deal: { t: "Акция", s: "Предложения бизнеса", ic: "deal", c: "#f5b400", types: ["deal"], title: "Новая акция" },
    help: { t: "Помощь", s: "Потерянное и бытовое", ic: "help", c: "#2bd47d", types: ["help", "lost", "found"], title: "Помощь рядом" }
  };
  const groupOf = (t) => Object.keys(GROUPS).find((g) => GROUPS[g].types.includes(t)) || "post";
  // "+" → "Что создать?". Гость сначала входит, затем меню открывается снова
  function openCreateMenu() {
    if (!requireAuth("Войдите, чтобы публиковать", { t: "create" })) return;
    const pb = $("plusBtn");
    if ($("bsheet").classList.contains("on") && $("bsheet").classList.contains("cr-sheet")) { closeSheet(); return; }
    // ТЗ 02/04, UI-02: список из семи типов, компактно; черновик — отдельной строкой
    openSheet("Что создать?", `<div class="cr-list">${Object.entries(GROUPS).map(([k, g]) => `<button type="button" class="cr-row" data-group="${k}" style="--c:${g.c}"><span class="ci">${icon(g.ic)}</span><span class="tx"><b>${g.t}</b><small>${g.s}</small></span><span class="chev">›</span></button>`).join("")}
      <button type="button" class="cr-row cr-sos-row" id="crSos" style="--c:#e5243b"><span class="ci">${icon("sos")}</span><span class="tx"><b>SOS</b><small>Экстренная помощь · 112 всегда доступен</small></span><span class="chev">›</span></button></div>
      ${draftRow()}<div class="cr-note">Черновик сохраняется на телефоне до публикации</div>`, "cr-sheet");
    if (pb) { pb.classList.add("open"); pb.setAttribute("aria-expanded", "true"); }
    qa("[data-group]", $("bsList")).forEach((b) => (b.onclick = () => { closeSheet(); if (b.dataset.group === "meetup") openMeetCreate(); else openCreate({ group: b.dataset.group }); }));
    $("crSos").onclick = () => { closeSheet(); go("sv-sos"); };
    if ($("crDraft")) $("crDraft").onclick = () => { closeSheet(); openCreate({ draft: true }); };
    if ($("crDraftDel")) $("crDraftDel").onclick = () => { clearDraft(); $("crDraftRow").remove(); toast("Черновик удален"); };
  }
  function readDraft() { try { const d = JSON.parse(localStorage.getItem(draftKey()) || "null"); return d && d.type && Date.now() - d.t < 7 * 86400e3 ? d : null; } catch (e) { return null; } }
  function clearDraft() { try { localStorage.removeItem(draftKey()); } catch (e) {} }
  function draftRow() {
    const d = readDraft(); if (!d) return "";
    const c = CATS[d.type] || CATS.talk;
    return `<div class="cr-draft" id="crDraftRow"><button type="button" id="crDraft"><span>${catIc(d.type, 20)}</span><span><b>Продолжить черновик</b><small>${esc(c.n)} · ${timeAgo(new Date(d.t).toISOString())}${d.text ? " · " + esc(d.text.slice(0, 40)) : ""}</small></span></button><button type="button" class="x" id="crDraftDel" aria-label="Удалить черновик">✕</button></div>`;
  }
  const cr = { type: null, group: null, files: [], loc: null, edit: null, key: null, started: false };
  // POST-01: черновик текста хранится на телефоне до публикации
  const draftKey = () => "near_draft_" + (user ? user.id.slice(0, 12) : "guest");
  // v14.2 / 10: черновик целиком — тип, текст, поля, место, дата. Фото не сохраняются (только в памяти)
  function saveDraft() {
    try {
      if (cr.edit || !cr.type) return;
      const d = { group: cr.group, type: cr.type, text: $("crText").value, meta: readMeta(), loc: cr.loc && cr.loc.how === "map" ? cr.loc : null, fuzzy: $("crFuzzy").classList.contains("on"), when: $("crWhen").value, cap: $("crCap").value, t: Date.now() };
      if (d.text.trim() || Object.keys(d.meta).length || d.when) localStorage.setItem(draftKey(), JSON.stringify(d)); else clearDraft();
    } catch (e) {}
  }
  function renderTypes(types) {
    $("typeGrid").innerHTML = types.map((k) => `<button type="button" data-type="${k}"><span>${catIc(k, 18)}</span>${CATS[k].n}</button>`).join("");
    // один тип — выбирать нечего: плитки скрыты
    $("typeGrid").classList.toggle("hidden", types.length < 2);
  }
  renderTypes(ORDER);
  $("typeGrid").onclick = (e) => { const b = e.target.closest("[data-type]"); if (b) setType(b.dataset.type); };
  /* ---------- v14.2 / 10: поля по типу публикации → meta ---------- */
  const fld = (id, label, html) => `<div class="fld"><label for="${id}">${label}</label>${html}</div>`;
  const inp = (id, ph, v, extra = "") => `<input id="${id}" placeholder="${ph}" value="${esc(v || "")}" ${extra}>`;
  const seg = (id, opts, v) => `<div class="seg mseg" id="${id}">${opts.map(([k, n]) => `<button type="button" data-mv="${k}" class="${String(v) === String(k) ? "on" : ""}">${n}</button>`).join("")}</div>`;
  function renderMeta(t, m = {}) {
    let h = "";
    if (t === "incident") h = fld("mItype", "Что случилось", seg("mItype", Object.entries(ITYPES), m.itype || "")) + fld("mTtl", "Сколько будет актуально", seg("mTtl", [[1, "1 ч"], [3, "3 ч"], [6, "6 ч"], [12, "12 ч"], [24, "24 ч"]], m.ttl_h || 24));
    else if (t === "event") h = fld("mTitle", "Название", inp("mTitle", "Например: Субботник во дворе", m.title, 'maxlength="80"')) + '<div class="row2">' + fld("mOrg", "Организатор", inp("mOrganizer", "Кто проводит", m.organizer, 'maxlength="60"')) + fld("mPrice", "Цена, ₸", inp("mPrice", "0 — бесплатно", m.price_kzt === 0 || m.price_kzt === "free" ? "0" : m.price_kzt, 'inputmode="numeric" maxlength="7"')) + "</div>" + fld("mSrc", "Ссылка на источник", inp("mSrc", "https://...", m.source_url, 'type="url" inputmode="url" maxlength="300"'));
    else if (t === "deal") h = '<div class="row2">' + fld("mDOrg", "Заведение", inp("mDOrg", "Название", m.org, 'maxlength="60"')) + fld("mDPrice", "Цена или скидка", inp("mDPrice", "−20% / 1 500 ₸", m.price_text, 'maxlength="60"')) + "</div>" + '<div class="row2">' + fld("mUntil", "Действует до", `<input id="mUntil" type="date" value="${m.until ? String(m.until).slice(0, 10) : ""}">`) + fld("mUrl", "Ссылка", inp("mUrl", "https://...", m.url, 'type="url" inputmode="url" maxlength="300"')) + "</div>";
    else if (t === "help") h = fld("mHk", "Вы", seg("mHk", [["need", "Нужна помощь"], ["offer", "Предлагаю помощь"]], m.hkind || "need"));
    else if (t === "ad") h = fld("mAdPrice", "Цена", inp("mAdPrice", "Например: 5 000 ₸ / договорная", m.price_text, 'maxlength="60"'));
    $("crMeta").innerHTML = h;
    qa(".mseg", $("crMeta")).forEach((g) => (g.onclick = (e) => { const b = e.target.closest("[data-mv]"); if (!b) return; qa("button", g).forEach((x) => x.classList.toggle("on", x === b)); saveDraftSoon(); }));
    qa("input", $("crMeta")).forEach((x) => x.addEventListener("input", saveDraftSoon));
  }
  function readMeta() {
    const v = (id) => ($(id) ? $(id).value.trim() : ""), sg = (id) => { const b = $(id) && $(id).querySelector(".on"); return b ? b.dataset.mv : ""; };
    const o = {}, put = (k, x) => { if (x !== "" && x != null) o[k] = x; };
    if (cr.type === "incident") { put("itype", sg("mItype")); put("ttl_h", +sg("mTtl") || ""); }
    else if (cr.type === "event") { put("title", v("mTitle")); put("organizer", v("mOrganizer")); const pr = v("mPrice").replace(/\s/g, ""); put("price_kzt", pr === "0" ? "free" : pr); put("source_url", v("mSrc")); }
    else if (cr.type === "deal") { put("org", v("mDOrg")); put("price_text", v("mDPrice")); put("until", v("mUntil") ? v("mUntil") + "T23:59:00+05:00" : ""); put("url", v("mUrl")); }
    else if (cr.type === "help") put("hkind", sg("mHk") || "need");
    else if (cr.type === "ad") put("price_text", v("mAdPrice"));
    return o;
  }
  function saveDraftSoon() { clearTimeout(cr.dt); cr.dt = setTimeout(saveDraft, 400); }
  const cpLen = (t) => [...String(t || "")].length; // считаем символы, а не UTF-16 (эмодзи = 1)
  function updCount() {
    const n = cpLen($("crText").value); $("crCount").textContent = n; $("crCount").parentElement.classList.toggle("over", n > 1000);
    // ТЗ 04: кнопка отключена при пустом тексте, загрузке или исчерпанном лимите
    if (!cr.limitBlocked && !cr.uploading) $("pubBtn").disabled = !$("crText").value.trim() || n > 1000;
  }
  function setType(t, meta) {
    renderMeta(t, meta || (cr.edit && cr.edit.category === t ? cr.edit.meta : {}));
    cr.type = t; qa("#typeGrid [data-type]").forEach((x) => x.classList.toggle("on", x.dataset.type === t));
    $("crEvent").classList.toggle("hidden", !(t === "event" || t === "meetup"));
    const ph = { incident: "Что случилось? Например: ДТП, перекрыта дорога, отключили воду", event: "Что за событие, где и для кого?", deal: "Какая акция, где и до какого времени?", meetup: "Кого ищете и чем займетесь?", lost: "Что потеряли, где и когда? Особые приметы", found: "Что нашли и где? Как с вами связаться", ad: "Продам, отдам, ищу мастера...", talk: "О чем хотите спросить соседей?" };
    if (t === "help") ph.help = "Чем нужно помочь или чем можете помочь вы?";
    $("crText").placeholder = ph[t] || "Опишите, что происходит";
  }
  function openCreate({ type, edit, group, draft } = {}) {
    let dr = !edit && (draft || !type && !group) ? readDraft() : null;
    // без типа и группы и без черновика — сначала меню "Что создать?"
    if (!edit && !type && !group && !dr) { openCreateMenu(); return; }
    if (dr) { type = dr.type; group = dr.group && GROUPS[dr.group] && GROUPS[dr.group].types.includes(dr.type) ? dr.group : null; }
    cr.group = edit ? groupOf(edit.category) : group || groupOf(type);
    renderTypes(edit ? ORDER : GROUPS[cr.group].types);
    cr.files.forEach((f) => f._url && URL.revokeObjectURL(f._url));
    cr.files = []; cr.edit = edit || null; $("crErr").classList.remove("on"); $("crProg").textContent = "";
    $("crFuzzy").classList.toggle("on", dr && dr.fuzzy != null ? !!dr.fuzzy : prefs.fuzz_default ?? true);
    // незавершенная загрузка прошлой публикации отменяется: файлы и строка удаляются
    if (cr.key && cr.started && !edit) api.abandonDraft && api.abandonDraft(cr.key).catch(() => {});
    cr.key = edit ? null : N.rid() + N.rid(); cr.started = false;
    $("crTitle").textContent = edit ? "Редактирование" : GROUPS[cr.group].title;
    $("crSub").textContent = edit ? "фото и место не меняются" : "что происходит рядом?";
    $("crMediaBlock").classList.toggle("hidden", !!edit);
    $("crLocBlock").classList.toggle("hidden", !!edit);
    $("pubBtn").textContent = edit ? "Сохранить изменения" : "Посмотреть и опубликовать";
    $("crBack").classList.remove("hidden");
    $("crText").value = edit ? edit.text : dr ? dr.text || "" : "";
    $("crWhen").value = dr ? dr.when || "" : ""; $("crCap").value = dr ? dr.cap || "" : "";
    if (edit && edit.event) {
      const d = new Date(edit.event.starts_at); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      $("crWhen").value = d.toISOString().slice(0, 16); $("crCap").value = edit.event.capacity || "";
    }
    const gt = GROUPS[cr.group].types;
    setType(edit ? edit.category : type || (gt.length === 1 ? gt[0] : null), dr ? dr.meta : null);
    if (!cr.type) $("crMeta").innerHTML = "";
    if (!edit) { cr.loc = dr && dr.loc ? dr.loc : pos.real ? { lat: pos.lat, lng: pos.lng, how: "here", acc: pos.acc } : null; renderLoc(); }
    if (dr) toast("Черновик восстановлен");
    $("crAuthor").innerHTML = `${ava({ name: user.nickname || user.name, avatar_url: user.avatar_url })}<span><b translate="no">@${esc(user.nickname || user.name || "")}</b><small>Видно всем поблизости</small></span>`;
    $("crSaveDraft").classList.toggle("hidden", !!edit);
    updCount(); renderMedia(); cr.snap = formSnap();
    if (edit) go("v-create"); else { hist = []; go("v-create", false); }
    if (!edit) limitLine();
  }
  // снимок формы: по нему понимаем, есть ли несохраненные изменения
  const formSnap = () => JSON.stringify([cr.type, $("crText").value.trim(), readMeta(), $("crWhen").value, $("crCap").value, cr.files.length]);
  const formDirty = () => cur() === "v-create" && !!cr.snap && formSnap() !== cr.snap && !!($("crText").value.trim() || cr.files.length || Object.keys(readMeta()).length > (cr.type === "help" || cr.type === "incident" ? 1 : 0));
  /* ---------- v14.2 / 10: лимит публикаций и обратный отсчет ---------- */
  let limT = null;
  async function limitLine() {
    clearInterval(limT); $("crLim").textContent = ""; cr.limitBlocked = false; updCount();
    let a = null; try { a = await api.account(); } catch (e) {}
    const L = a && a.limits && a.limits.post; if (!L || !L.limit) return;
    const t0 = Date.now(), p2 = (x) => String(x).padStart(2, "0");
    // ТЗ 04.1: "Использовано 3 из 3. Снова через 00:28:00" — таймер по серверному retry_after, черновик доступен
    const show = () => {
      const left = L.retry_after ? Math.max(0, Math.round(L.retry_after - (Date.now() - t0) / 1000)) : 0;
      if (L.used >= L.limit && left > 0 && !cr.edit) {
        $("crLim").innerHTML = `<b>Использовано ${L.used} из ${L.limit}.</b> Снова через ${p2(Math.floor(left / 3600))}:${p2(Math.floor((left % 3600) / 60))}:${p2(left % 60)}`;
        cr.limitBlocked = true; $("pubBtn").disabled = true;
      } else { $("crLim").textContent = `Использовано ${L.used} из ${L.limit} публикаций сегодня`; if (cr.limitBlocked) { cr.limitBlocked = false; updCount(); } clearInterval(limT); }
    };
    show(); if (cr.limitBlocked) limT = setInterval(() => { if (cur() !== "v-create") return clearInterval(limT); show(); }, 1000);
  }

  $("crBack").onclick = back;
  $("crText").oninput = updCount;
  $("addGallery").onclick = () => $("fileGallery").click();
  $("addCamera").onclick = () => $("fileCamera").click();
  function addFiles(list) {
    const max = CFG.MAX_FILES || 5;
    for (const f of list) {
      if (cr.files.length >= max) { toast(`Можно добавить не больше ${max} файлов`); break; }
      try {
        const kind = N.validateFile(f); f._url = URL.createObjectURL(f); cr.files.push(f);
        if (kind === "video") {
          // проверяем видео сразу, до публикации: формат, длительность, обложка
          f._state = "check";
          N.probeVideo(f).then((m) => { f._meta = m; f._state = "ok"; renderMedia(); })
            .catch((er) => { cr.files = cr.files.filter((x) => x !== f); URL.revokeObjectURL(f._url); renderMedia(); crError(er.message); });
        }
      } catch (e) { toast(e.message); }
    }
    renderMedia();
  }
  $("fileGallery").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  $("fileCamera").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  function renderMedia() {
    qa("#mediaPrev .m-prev").forEach((x) => x.remove());
    const row = $("mediaPrev");
    cr.files.forEach((f, i) => {
      const d = document.createElement("div"); d.className = "m-prev";
      if (/^video\//.test(f.type) || /\.(mov|mp4|m4v|webm)$/i.test(f.name)) d.innerHTML = `<video src="${f._url}#t=0.3" muted playsinline preload="metadata"></video><i>${f._state === "check" ? '<span class="mini-spin"></span>' : f._meta ? "▶ " + fmtDur(f._meta.duration) : "🎬"}</i>`;
      else d.style.backgroundImage = `url('${f._url}')`;
      d.insertAdjacentHTML("beforeend", `<button type="button" data-rm="${i}">✕</button>`);
      row.appendChild(d);
    });
  }
  $("mediaPrev").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]"); if (!b) return;
    const f = cr.files.splice(+b.dataset.rm, 1)[0]; if (f && f._url) URL.revokeObjectURL(f._url); renderMedia();
  });
  function renderLoc() {
    if (!cr.loc) { $("crLocT").textContent = "Место не выбрано"; $("crLocS").textContent = "нажмите кнопку ниже"; return; }
    const L = cr.loc;
    $("crLocT").textContent = L.how === "here" ? "Где я сейчас" : L.addr || "Выбрано на карте";
    $("crLocS").textContent = `${L.district || nearestDistrict(L.lat, L.lng)} район${L.acc ? " · точность ~" + Math.round(L.acc) + " м" : ""}`;
    if (!L.district && L.how !== "here") geoLabel(L.lat, L.lng).then((g) => { if (cr.loc !== L) return; L.addr = g.addr; L.district = g.district; renderLoc(); });
  }
  $("crHere").onclick = async () => {
    $("crLocS").textContent = "определяем...";
    try { const g = await getGeo(true); cr.loc = { ...g, how: "here" }; renderLoc(); }
    catch (e) { toast(e.message); renderLoc(); }
  };
  $("crPick").onclick = () => openPicker(cr.loc || pos);
  $("crFuzzy").onclick = () => $("crFuzzy").classList.toggle("on");
  function crError(m) { $("crErr").textContent = m; $("crErr").classList.add("on"); $("crErr").scrollIntoView({ block: "center", behavior: "smooth" }); }
  $("pubBtn").onclick = async () => {
    if (!requireAuth("Войдите, чтобы публиковать")) return;
    $("crErr").classList.remove("on");
    const text = $("crText").value.trim();
    if (!cr.type) return crError("Выберите тип публикации");
    if (!text) return crError("Добавьте описание");
    if (cpLen(text) > 1000) return crError(`Текст длиннее 1000 символов (сейчас ${cpLen(text)}). Сократите его`);
    let meta;
    try { meta = N.postMetaClean(cr.type, readMeta()); } catch (e) { return crError(e.message); }
    if (cr.type === "incident" && !meta.itype) return crError("Выберите, что случилось");
    let event = null;
    if (cr.type === "event" || cr.type === "meetup") {
      if (!$("crWhen").value) { if (cr.type === "event") return crError("Укажите дату и время события"); }
      else {
        const d = new Date($("crWhen").value);
        if (isNaN(d)) return crError("Проверьте дату");
        if (!cr.edit && d < Date.now() - 3600e3) return crError("Дата события уже прошла");
        const cap = parseInt($("crCap").value, 10), en = $("crEnd").value ? new Date($("crEnd").value) : null;
        if (en && en <= d) return crError("Конец события должен быть позже начала");
        event = { starts_at: d.toISOString(), ends_at: en ? en.toISOString() : null, capacity: cap > 0 ? cap : null };
      }
    }
    if (cr.files.some((f) => f._state === "check")) return crError("Подождите, проверяем видео...");
    if (N.isThreat(text)) return crError("Угрозы запрещены правилами NEAR. Измените текст");
    const br = N.nearBlockReason(text); if (br) return crError(N.BLOCK_MSG[br]);
    if (!cr.edit && !cr.loc) return crError("Укажите место: \"Где я сейчас\" или \"На карте\"");
    if (!cr.edit) return previewSheet({ text, meta, event });
    return doPublish({ text, meta, event });
  };
  // v14.2 / 10: предпросмотр перед публикацией — как карточка в ленте
  function previewSheet({ text, meta, event }) {
    const fake = { id: "preview", user_id: user.id, author: { name: (user.profile && user.profile.nickname) || user.name || "Вы", avatar_url: user.avatar_url }, category: cr.type, text: N.mask(text), meta, media: [], status: "active", created_at: new Date().toISOString(), lat: cr.loc.lat, lng: cr.loc.lng, likes: 0, comments: 0, event: event ? { ...event, members: 0, joined: false } : null };
    const fz = $("crFuzzy").classList.contains("on");
    openSheet("Так увидят соседи", `<div class="pv">${card(fake)}</div>
      <div class="pv-meta">📍 ${esc(cr.loc.addr || $("crLocT").textContent)} · ${fz ? "место скрыто (±200 м)" : "точное место"}${cr.files.length ? ` · файлов: ${cr.files.length}` : ""}</div>
      ${N.hasBad(text) ? '<div class="warn-banner" style="margin:8px 0 0">Грубые слова будут скрыты звездочками</div>' : ""}
      <div class="sheet-btns"><button class="btn btn-ghost" id="pvEdit">Изменить</button><button class="btn btn-main" id="pvOk">Опубликовать</button></div>`);
    qa(".pv button, .pv [data-user]", $("bsList")).forEach((b) => { b.disabled = true; b.removeAttribute("data-user"); });
    $("pvEdit").onclick = closeSheet;
    $("pvOk").onclick = () => { closeSheet(); doPublish({ text, meta, event }); };
  }
  async function doPublish({ text, meta, event }) {
    const btn = $("pubBtn"); btn.disabled = true;
    try {
      if (cr.edit) {
        const np = await api.updatePost(cr.edit.id, { text, category: cr.type, event, meta });
        cr.snap = null; cache.set(np.id, np); toast("✓ Изменения сохранены"); feedDirty = true; wide = null; if (mapReady) loadMapPosts();
        hist.pop(); openPostId = np.id; go("sv-post", false); openPost(np.id);
        return;
      }
      const { lat, lng } = cr.loc;
      // место по умолчанию приблизительное (~200 м, округляет сервер); точное — только если переключатель выключен
      const exact = !$("crFuzzy").classList.contains("on");
      cr.started = true;
      const p = await api.createPost({ category: cr.type, text, lat, lng, files: cr.files, event, exact, meta, clientKey: cr.key }, (m, frac) => { $("crProg").innerHTML = `<div>${esc(m)}</div>${frac != null ? `<div class="pbar"><i style="width:${Math.round(Math.min(1, frac) * 100)}%"></i></div>` : ""}`; });
      cache.set(p.id, p); cr.started = false; cr.key = N.rid() + N.rid();
      cr.files.forEach((f) => f._url && URL.revokeObjectURL(f._url)); cr.files = [];
      $("crProg").textContent = ""; $("crText").value = ""; $("crMeta").innerHTML = ""; clearDraft(); cr.snap = null;
      Obs.track("post_created", { category: p.category, count: p.media.length }); usefulAction("post");
      toast("✓ Опубликовано! Публикация уже в ленте и на карте");
      feedCat = "all"; $("cats").innerHTML = chipsHtml("all"); wide = null;
      if (N.dist(pos, p) > R) setRadius(Math.min(10000, Math.max(R, Math.ceil(N.dist(pos, p) / 1000) * 1000)));
      hist = []; go("v-feed", false); await loadFeed(); if (mapReady) loadMapPosts();
    } catch (e) { if (gateError(e)) { $("crProg").textContent = ""; return; } crError(e.message + (cr.started && !/^NR\d/.test(e.code || "") ? " · Нажмите \"Опубликовать\" еще раз — загрузка продолжится без дублей" : "")); $("crProg").textContent = ""; }
    finally { btn.disabled = false; }
  }
  $("crText").addEventListener("input", saveDraftSoon);
  $("crSaveDraft").onclick = () => { saveDraft(); cr.snap = null; toast("Черновик сохранен: продолжить можно из меню +"); hist = []; go("v-feed", false); };
  $("crWhen").addEventListener("input", saveDraftSoon); $("crCap").addEventListener("input", saveDraftSoon);
  /* ---------- v14.2 / 10: уход с несохраненной формой ---------- */
  leaveGuard = (to, proceed) => {
    if (to === "sv-pick" || !formDirty()) return true;
    openSheet(cr.edit ? "Выйти без сохранения?" : "Сохранить черновик?", `<p class="muted" style="font-size:13.5px;margin-bottom:12px">${cr.edit ? "Изменения не сохранены." : "Текст, поля и место останутся на телефоне. Фото и видео нужно будет добавить заново."}</p>
      <div class="sheet-col">${cr.edit ? "" : '<button class="btn btn-main" id="lvSave">Сохранить черновик</button>'}<button class="btn btn-ghost red" id="lvDel">${cr.edit ? "Выйти без сохранения" : "Удалить"}</button><button class="btn btn-ghost" id="lvStay">Продолжить редактирование</button></div>`);
    const leave = () => { closeSheet(); cr.snap = null; proceed(); };
    if ($("lvSave")) $("lvSave").onclick = () => { saveDraft(); toast("Черновик сохранен"); leave(); };
    $("lvDel").onclick = () => { if (!cr.edit) { clearDraft(); cr.files.forEach((f) => f._url && URL.revokeObjectURL(f._url)); cr.files = []; $("crText").value = ""; } leave(); };
    $("lvStay").onclick = closeSheet;
    return false;
  };
