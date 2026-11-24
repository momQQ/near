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
    $("pdSub").textContent = c.e + " " + c.n + " · " + fmtDist(D(p)) + " от вас";
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
  const ORDER = ["incident", "event", "deal", "meetup", "lost", "found", "ad", "talk"];
  // v14 / 03: семь типов создания — шесть плиток и отдельно SOS. Цвета — как метки на карте (раздел 27)
  const GROUPS = {
    post: { t: "Публикация", s: "Новость, вопрос, объявление", e: "📝", c: "#ec398e", types: ["talk", "ad"], title: "Новая публикация" },
    incident: { t: "Происшествие", s: "ДТП, отключения, перекрытия", e: "🚨", c: "#ff873b", types: ["incident"], title: "Происшествие" },
    meetup: { t: "Встреча", s: "Группа по интересам", e: "🤝", c: "#9855e9", types: ["meetup"], title: "Новая встреча" },
    event: { t: "Событие", s: "Открытое мероприятие", e: "🎉", c: "#3da5ff", types: ["event"], title: "Новое событие" },
    deal: { t: "Акция", s: "Предложение бизнеса", e: "🏷️", c: "#f5b400", types: ["deal"], title: "Новая акция" },
    help: { t: "Помощь", s: "Потеря, находка, помощь соседям", e: "🔑", c: "#2bd47d", types: ["lost", "found"], title: "Помощь рядом" }
  };
  const groupOf = (t) => Object.keys(GROUPS).find((g) => GROUPS[g].types.includes(t)) || "post";
  // "+" → "Что создать?". Гость сначала входит, затем меню открывается снова
  function openCreateMenu() {
    if (!requireAuth("Войдите, чтобы публиковать", { t: "create" })) return;
    const pb = $("plusBtn");
    if ($("bsheet").classList.contains("on") && $("bsheet").classList.contains("cr-sheet")) { closeSheet(); return; }
    openSheet("Что создать?", `<div class="cr-grid">${Object.entries(GROUPS).map(([k, g]) => `<button type="button" class="cr-tile" data-group="${k}" style="--c:${g.c}"><span class="ci">${g.e}</span><b>${g.t}</b><small>${g.s}</small></button>`).join("")}</div>
      <button type="button" class="cr-sos" id="crSos"><span class="sb">SOS</span><span><b>SOS — срочная помощь</b><small>сообщить людям рядом · не заменяет 112</small></span></button>
      <div class="cr-note">Черновик сохраняется на телефоне до публикации</div>`, "cr-sheet");
    if (pb) { pb.classList.add("open"); pb.setAttribute("aria-expanded", "true"); }
    qa("[data-group]", $("bsList")).forEach((b) => (b.onclick = () => { closeSheet(); openCreate({ group: b.dataset.group }); }));
    $("crSos").onclick = () => { closeSheet(); go("sv-sos"); };
  }
  const cr = { type: null, group: null, files: [], loc: null, edit: null, key: null, started: false };
  // POST-01: черновик текста хранится на телефоне до публикации
  const draftKey = () => "near_draft_" + (user ? user.id.slice(0, 12) : "guest");
  function saveDraft() { try { if (cr.edit) return; const t = $("crText").value; if (t.trim()) localStorage.setItem(draftKey(), JSON.stringify({ type: cr.type, text: t, t: Date.now() })); else localStorage.removeItem(draftKey()); } catch (e) {} }
  function renderTypes(types) {
    $("typeGrid").innerHTML = types.map((k) => `<button type="button" data-type="${k}"><span>${CATS[k].e}</span>${CATS[k].n}</button>`).join("");
    // один тип — выбирать нечего: плитки скрыты
    $("typeGrid").classList.toggle("hidden", types.length < 2);
  }
  renderTypes(ORDER);
  $("typeGrid").onclick = (e) => { const b = e.target.closest("[data-type]"); if (b) setType(b.dataset.type); };
  function setType(t) {
    cr.type = t; qa("#typeGrid [data-type]").forEach((x) => x.classList.toggle("on", x.dataset.type === t));
    $("crEvent").classList.toggle("hidden", !(t === "event" || t === "meetup"));
    const ph = { incident: "Что случилось? Например: ДТП, перекрыта дорога, отключили воду", event: "Что за событие, где и для кого?", deal: "Какая акция, где и до какого времени?", meetup: "Кого ищете и чем займетесь?", lost: "Что потеряли, где и когда? Особые приметы", found: "Что нашли и где? Как с вами связаться", ad: "Продам, отдам, ищу мастера...", talk: "О чем хотите спросить соседей?" };
    $("crText").placeholder = ph[t] || "Опишите, что происходит";
  }
  function openCreate({ type, edit, group } = {}) {
    // без типа и группы (например, после входа) — сначала меню "Что создать?"
    if (!edit && !type && !group) { let dr = null; try { dr = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch (e) {} if (dr && dr.type) type = dr.type; else { openCreateMenu(); return; } }
    cr.group = edit ? groupOf(edit.category) : group || groupOf(type);
    renderTypes(edit ? ORDER : GROUPS[cr.group].types);
    cr.files.forEach((f) => f._url && URL.revokeObjectURL(f._url));
    cr.files = []; cr.edit = edit || null; $("crErr").classList.remove("on"); $("crProg").textContent = "";
    $("crFuzzy").classList.toggle("on", prefs.fuzz_default ?? true);
    // незавершенная загрузка прошлой публикации отменяется: файлы и строка удаляются
    if (cr.key && cr.started && !edit) api.abandonDraft && api.abandonDraft(cr.key).catch(() => {});
    cr.key = edit ? null : N.rid() + N.rid(); cr.started = false;
    $("crTitle").textContent = edit ? "Редактирование" : GROUPS[cr.group].title;
    $("crSub").textContent = edit ? "фото и место не меняются" : "что происходит рядом?";
    $("crMediaBlock").classList.toggle("hidden", !!edit);
    $("crLocBlock").classList.toggle("hidden", !!edit);
    $("pubBtn").textContent = edit ? "Сохранить изменения" : "Опубликовать";
    $("crBack").classList.toggle("hidden", !edit);
    $("crText").value = edit ? edit.text : ""; $("crCount").textContent = $("crText").value.length;
    $("crWhen").value = ""; $("crCap").value = "";
    if (edit && edit.event) {
      const d = new Date(edit.event.starts_at); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      $("crWhen").value = d.toISOString().slice(0, 16); $("crCap").value = edit.event.capacity || "";
    }
    let dr = null; if (!edit) { try { dr = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch (e) {} }
    if (dr && dr.text && Date.now() - dr.t < 7 * 86400e3) { $("crText").value = dr.text; $("crCount").textContent = dr.text.length; toast("Восстановлен черновик"); }
    const gt = GROUPS[cr.group].types;
    setType(edit ? edit.category : type || (dr && gt.includes(dr.type) ? dr.type : null) || (gt.length === 1 ? gt[0] : null));
    if (!edit) { cr.loc = pos.real ? { lat: pos.lat, lng: pos.lng, how: "here" } : null; renderLoc(); }
    renderMedia();
    if (edit) go("v-create"); else { hist = []; go("v-create", false); }
  }
  $("crBack").onclick = back;
  $("crText").oninput = () => { $("crCount").textContent = $("crText").value.length; };
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
    qa("#mediaRow .m-prev").forEach((x) => x.remove());
    const row = $("mediaRow");
    cr.files.forEach((f, i) => {
      const d = document.createElement("div"); d.className = "m-prev";
      if (/^video\//.test(f.type) || /\.(mov|mp4|m4v|webm)$/i.test(f.name)) d.innerHTML = `<video src="${f._url}#t=0.3" muted playsinline preload="metadata"></video><i>${f._state === "check" ? '<span class="mini-spin"></span>' : f._meta ? "▶ " + fmtDur(f._meta.duration) : "🎬"}</i>`;
      else d.style.backgroundImage = `url('${f._url}')`;
      d.insertAdjacentHTML("beforeend", `<button type="button" data-rm="${i}">✕</button>`);
      row.insertBefore(d, $("addCamera"));
    });
  }
  $("mediaRow").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]"); if (!b) return;
    const f = cr.files.splice(+b.dataset.rm, 1)[0]; if (f && f._url) URL.revokeObjectURL(f._url); renderMedia();
  });
  function renderLoc() {
    if (!cr.loc) { $("crLocT").textContent = "Место не выбрано"; $("crLocS").textContent = "нажмите кнопку ниже"; return; }
    $("crLocT").textContent = cr.loc.how === "here" ? "Где я сейчас" : "Выбрано на карте";
    $("crLocS").textContent = `${cr.loc.lat.toFixed(5)}, ${cr.loc.lng.toFixed(5)}${cr.loc.acc ? " · точность ~" + Math.round(cr.loc.acc) + " м" : ""}`;
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
    let event = null;
    if (cr.type === "event" || cr.type === "meetup") {
      if (!$("crWhen").value) { if (cr.type === "event") return crError("Укажите дату и время события"); }
      else {
        const d = new Date($("crWhen").value);
        if (isNaN(d)) return crError("Проверьте дату");
        if (!cr.edit && d < Date.now() - 3600e3) return crError("Дата события уже прошла");
        const cap = parseInt($("crCap").value, 10);
        event = { starts_at: d.toISOString(), capacity: cap > 0 ? cap : null };
      }
    }
    if (cr.files.some((f) => f._state === "check")) return crError("Подождите, проверяем видео...");
    if (N.isThreat(text)) return crError("Угрозы запрещены правилами NEAR. Измените текст");
    if (N.hasBad(text)) toast("Грубые слова будут скрыты: " + N.mask(text).slice(0, 60));
    const btn = $("pubBtn"); btn.disabled = true;
    try {
      if (cr.edit) {
        const np = await api.updatePost(cr.edit.id, { text, category: cr.type, event });
        cache.set(np.id, np); toast("✓ Изменения сохранены"); feedDirty = true; wide = null; if (mapReady) loadMapPosts();
        hist.pop(); openPostId = np.id; go("sv-post", false); openPost(np.id);
        return;
      }
      if (!cr.loc) return crError("Укажите место: \"Где я сейчас\" или \"На карте\"");
      const { lat, lng } = cr.loc;
      // место по умолчанию приблизительное (~200 м, округляет сервер); точное — только если переключатель выключен
      const exact = !$("crFuzzy").classList.contains("on");
      cr.started = true;
      const p = await api.createPost({ category: cr.type, text, lat, lng, files: cr.files, event, exact, clientKey: cr.key }, (m, frac) => { $("crProg").innerHTML = `<div>${esc(m)}</div>${frac != null ? `<div class="pbar"><i style="width:${Math.round(Math.min(1, frac) * 100)}%"></i></div>` : ""}`; });
      cache.set(p.id, p); cr.started = false; cr.key = N.rid() + N.rid();
      cr.files.forEach((f) => f._url && URL.revokeObjectURL(f._url)); cr.files = [];
      $("crProg").textContent = ""; $("crText").value = ""; saveDraft();
      Obs.track("post_created", { category: p.category, count: p.media.length }); usefulAction("post");
      toast("✓ Опубликовано! Публикация уже в ленте и на карте");
      feedCat = "all"; $("cats").innerHTML = chipsHtml("all"); wide = null;
      if (N.dist(pos, p) > R) setRadius(Math.min(10000, Math.max(R, Math.ceil(N.dist(pos, p) / 1000) * 1000)));
      hist = []; go("v-feed", false); await loadFeed(); if (mapReady) loadMapPosts();
    } catch (e) { if (gateError(e)) { $("crProg").textContent = ""; return; } crError(e.message + (cr.started && !/^NR\d/.test(e.code || "") ? " · Нажмите \"Опубликовать\" еще раз — загрузка продолжится без дублей" : "")); $("crProg").textContent = ""; }
    finally { btn.disabled = false; }
  };
  $("crText").addEventListener("input", () => { clearTimeout(cr.dt); cr.dt = setTimeout(saveDraft, 400); });
