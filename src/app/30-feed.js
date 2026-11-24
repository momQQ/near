  /* =====================================================
     FEED
     ===================================================== */
  let feedDirty = false;
  function chipsHtml(active) { return CHIPS.map(([k, n]) => `<button class="chip${k === active ? " on" : ""}" data-c="${k}">${n}</button>`).join(""); }
  $("cats").innerHTML = chipsHtml("all");
  $("cats").onclick = (e) => { const b = e.target.closest("[data-c]"); if (!b) return; feedCat = b.dataset.c; $("cats").innerHTML = chipsHtml(feedCat); saveFeedPrefs(); Obs.track("filter_changed", { category: feedCat }); loadFeed(); };
  $("radius").onclick = (e) => { const b = e.target.closest("[data-r]"); if (!b) return; setRadius(+b.dataset.r); saveFeedPrefs(); Obs.track("filter_changed", { radius: R }); loadFeed(); };
  function setRadius(r) {
    R = r;
    qa("#radius [data-r], #mapRad [data-r]").forEach((x) => x.classList.toggle("on", +x.dataset.r === r));
    if (mapReady) { drawMe(); if (mapMode === "radius") loadMapPosts(true); }
    if (typeof geoBanner === "function") geoBanner();
  }
  // MAP-01: режим карты — "на экране" (рамка) или "в радиусе" (как лента)
  let mapMode = "screen";

  function shieldFor(m, ownerId) {
    if (!m) return null;
    if (m.mod_status === "flagged") return "⚠️ Возможно неприемлемое фото";
    if (m.mod_status === "pending" && !(user && user.id === ownerId)) return "⏳ Фото проверяется";
    return null;
  }
  /* ---------- иконки панели действий ---------- */
  const IC = {
    heart: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 20.5s-7.5-4.6-9.3-9.1C1.5 8.3 3.4 4.8 6.8 4.5c2-.2 3.6.9 5.2 2.8 1.6-1.9 3.2-3 5.2-2.8 3.4.3 5.3 3.8 4.1 6.9-1.8 4.5-9.3 9.1-9.3 9.1z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    heartOn: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 20.5s-7.5-4.6-9.3-9.1C1.5 8.3 3.4 4.8 6.8 4.5c2-.2 3.6.9 5.2 2.8 1.6-1.9 3.2-3 5.2-2.8 3.4.3 5.3 3.8 4.1 6.9-1.8 4.5-9.3 9.1-9.3 9.1z" fill="#ff3b6b" stroke="#ff3b6b" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    cmt: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M20.5 11.6a8.4 8.4 0 0 1-12.3 7.5L3.5 20.5l1.4-4.4A8.4 8.4 0 1 1 20.5 11.6z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M21 3 10.2 13.8M21 3l-6.8 18-3.9-7.2L3 9.9 21 3z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    save: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M18.5 21 12 15.8 5.5 21V4.5a1.5 1.5 0 0 1 1.5-1.5h10a1.5 1.5 0 0 1 1.5 1.5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    saveOn: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M18.5 21 12 15.8 5.5 21V4.5a1.5 1.5 0 0 1 1.5-1.5h10a1.5 1.5 0 0 1 1.5 1.5z" fill="#ffd166" stroke="#ffd166" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>'
  };
  const fmtDur = (s) => { s = Math.round(s || 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const LONG_TEXT = 240;
  let hiddenPosts = new Set();
  const hiddenKey = () => "near_hidden_" + (user ? user.id : "guest");
  function loadHidden() { try { hiddenPosts = new Set(JSON.parse(localStorage.getItem(hiddenKey()) || "[]")); } catch (e) { hiddenPosts = new Set(); } }
  function saveHidden() { try { localStorage.setItem(hiddenKey(), JSON.stringify([...hiddenPosts])); } catch (e) {} }

  // галерея: все фото и видео публикации, свайп, счетчик 1/N
  function galleryHtml(p) {
    if (!p.media.length) return "";
    const m0 = p.media[0], n = p.media.length;
    const r = m0.w && m0.h ? Math.max(0.6, Math.min(1.25, m0.h / m0.w)) : m0.type === "video" ? 1.25 : 1;
    const slides = p.media.map((m, i) => {
      const sh = shieldFor(m, p.user_id);
      if (m.type === "video") return `<div class="gs vid" data-i="${i}"><video data-src="${esc(m.url)}${m.poster ? "" : "#t=0.3"}"${m.poster ? ` data-poster="${esc(m.poster)}"` : ""} playsinline muted preload="none"></video>
        <button class="vplay" type="button" aria-label="Смотреть видео">▶</button><span class="vdur${m.duration ? "" : " hidden"}">${m.duration ? fmtDur(m.duration) : ""}</span><button class="vfs" type="button" aria-label="На весь экран">⛶</button><span class="vload hidden"><i class="mini-spin"></i></span></div>`;
      if (sh) return `<div class="gs blur-wrap" data-reveal data-i="${i}"><img data-src="${esc(m.thumb || m.url)}" alt="" decoding="async"><div class="shield">${sh}<button type="button">Показать</button></div></div>`;
      return `<div class="gs" data-img data-i="${i}"><img data-src="${esc(m.url)}"${m.thumb && m.thumb !== m.url ? ` data-thumb="${esc(m.thumb)}"` : ""} alt="" decoding="async"></div>`;
    }).join("");
    return `<div class="gal" data-gal="${p.id}" style="--r:${r.toFixed(3)}"><div class="gal-track">${slides}</div>${n > 1 ? `<span class="gal-n">1/${n}</span><div class="gal-dots">${p.media.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div>` : ""}<div class="heart-burst">${IC.heartOn}</div></div>`;
  }
  const expired = (p) => !!(p.expires_at && new Date(p.expires_at) <= Date.now());
  function statusChip(p) {
    if (p.status === "closed") return '<span class="nst done">✅ Неактуально</span>';
    if (p.status === "hidden") return '<span class="nst red">🛡 Скрыто</span>';
    if (p.status === "draft") return '<span class="nst">✎ Черновик</span>';
    if (expired(p)) return '<span class="nst done">⏱ Срок истек</span>';
    if (p.is_sos) return '<span class="nst red">🆘 SOS</span>';
    const h = (Date.now() - new Date(p.created_at)) / 3600e3;
    return h < 24 ? '<span class="nst live">● Актуально</span>' : "";
  }
  function card(p) {
    const c = CATS[p.category] || CATS.talk, closed = p.status === "closed", long = p.text.length > LONG_TEXT || (p.text.match(/\n/g) || []).length > 4;
    const join = p.event && !closed ? `<button class="act${p.event.joined ? " joined" : ""}" data-join="${p.id}">${p.event.joined ? "✓ Иду" : "Иду"} · ${p.event.members}${p.event.capacity ? "/" + p.event.capacity : ""}</button>` : "";
    return `<article class="post${closed || expired(p) ? " closed" : ""}${p.is_sos ? " sos" : ""}" data-post="${p.id}">
      <header class="post-h"><span class="who-link" data-user="${p.user_id}">${ava(p.author, c.c)}</span>
        <div class="who"><b class="who-link" data-user="${p.user_id}" translate="no">${esc(p.author.name)}${vBadge(p.author)}</b><span>${timeAgo(p.created_at)}${p.updated_at && new Date(p.updated_at) - new Date(p.created_at) > 60000 ? " · изменено" : ""}</span></div>
        <span class="cat" style="--c:${c.c}">${p.is_sos ? "🆘 SOS" : c.e + " " + c.n}</span><button class="pmenu" data-pmenu="${p.id}" aria-label="Меню публикации">${IC.more}</button></header>
      <div class="post-d${long ? " clamp" : ""}" translate="no">${esc(p.text)}</div>${long ? '<button class="more-t" data-moretext>Показать полностью</button>' : ""}
      ${galleryHtml(p)}
      <div class="post-near"><button data-onmap="${p.id}">📍 ${fmtDist(D(p))} от вас</button>${statusChip(p)}${p.event ? `<span>🗓 ${fmtWhen(p.event.starts_at)}</span>` : ""}</div>
      <div class="post-f"><button class="ab lk${p.liked ? " on" : ""}" data-like="${p.id}" aria-label="Нравится">${p.liked ? IC.heartOn : IC.heart}<b>${p.likes || ""}</b></button>
        <button class="ab" data-cmt="${p.id}" aria-label="Комментарии">${IC.cmt}<b>${p.comments || ""}</b></button>
        <button class="ab" data-share="${p.id}" aria-label="Поделиться">${IC.share}</button><span class="sp"></span>${join}
        <button class="ab sv${p.saved ? " on" : ""}" data-save="${p.id}" aria-label="Сохранить">${p.saved ? IC.saveOn : IC.save}</button></div>
    </article>`;
  }
  // обновление счетчиков без перерисовки (галерея и видео не сбрасываются)
  function patchCard(p) {
    qa(`.post[data-post="${p.id}"]`).forEach((el) => {
      const lk = el.querySelector("[data-like]"); if (lk) { lk.classList.toggle("on", p.liked); lk.innerHTML = (p.liked ? IC.heartOn : IC.heart) + `<b>${p.likes || ""}</b>`; }
      const cm = el.querySelector("[data-cmt]"); if (cm) cm.innerHTML = IC.cmt + `<b>${p.comments || ""}</b>`;
      const sv = el.querySelector("[data-save]"); if (sv) { sv.classList.toggle("on", p.saved); sv.innerHTML = p.saved ? IC.saveOn : IC.save; }
      const jn = el.querySelector("[data-join]"); if (jn && p.event) { jn.classList.toggle("joined", p.event.joined); jn.textContent = `${p.event.joined ? "✓ Иду" : "Иду"} · ${p.event.members}${p.event.capacity ? "/" + p.event.capacity : ""}`; }
    });
    const pb = document.querySelector("#pdBody > [data-cmt]");
    if (pb && openPostId === p.id) pb.textContent = "💬 " + (p.comments ? "Комментарии · " + p.comments : "Написать комментарий");
  }
  function refreshCardEverywhere(p) {
    qa(`.post[data-post="${p.id}"]`).forEach((el) => { el.outerHTML = card(p); });
    wireMedia(document);
    if (cur() === "sv-post" && openPostId === p.id) renderDetail(p);
  }

  /* ---------- ленивая загрузка фото и видео ---------- */
  // грузим только то, что близко к экрану: ~1 экран вперед. Сначала маленькое превью, потом полное фото
  function loadSlide(gs) {
    if (!gs || gs.dataset.ld) return; gs.dataset.ld = "1";
    const img = gs.querySelector("img[data-src]"), v = gs.querySelector("video[data-src]");
    if (img) {
      const full = img.dataset.src, th = img.dataset.thumb; img.crossOrigin = "anonymous";
      // если сервер не разрешил CORS — грузим обычным способом (без кэша в фоне)
      img.onerror = () => { if (img.crossOrigin) { img.onerror = null; img.removeAttribute("crossorigin"); img.classList.remove("lq"); img.src = full; } };
      if (th) { img.src = th; img.classList.add("lq"); const pre = new Image(); pre.crossOrigin = "anonymous"; pre.decoding = "async"; pre.onload = () => { img.src = full; img.classList.remove("lq"); }; pre.onerror = () => img.classList.remove("lq"); pre.src = full; }
      else img.src = full;
      img.removeAttribute("data-src");
    }
    if (v) { if (v.dataset.poster) v.poster = v.dataset.poster; else v.preload = "metadata"; v.src = v.dataset.src; v.removeAttribute("data-src"); }
  }
  function loadNear(track, i) { const ch = track.children; [i, i + 1].forEach((k) => ch[k] && loadSlide(ch[k])); }
  const lazyIOs = new Map();
  function lazyIO(root) {
    if (!("IntersectionObserver" in window)) return null;
    if (!lazyIOs.has(root)) lazyIOs.set(root, new IntersectionObserver((en, io) => en.forEach((x) => {
      if (!x.isIntersecting) return; io.unobserve(x.target);
      const tr = x.target.querySelector(".gal-track"); if (tr) loadNear(tr, 0); else loadSlide(x.target);
    }), { root, rootMargin: "900px 0px 900px 0px" }));
    return lazyIOs.get(root);
  }
  function lazyMedia(root) {
    qa(".gal:not([data-lz])", root).forEach((g) => {
      g.dataset.lz = "1"; const io = lazyIO(g.closest(".view") || null);
      if (io) io.observe(g); else loadNear(g.querySelector(".gal-track"), 0);
    });
  }

  /* ---------- видео: одно одновременно, пауза вне экрана ---------- */
  const vio = "IntersectionObserver" in window ? new IntersectionObserver((ents) => ents.forEach((en) => { if (!en.isIntersecting && !en.target.paused) en.target.pause(); }), { threshold: 0.25 }) : null;
  function wireMedia(root) {
    lazyMedia(root);
    qa(".gs.vid video:not([data-w])", root).forEach((v) => {
      v.dataset.w = "1"; if (vio) vio.observe(v);
      const box = v.closest(".gs");
      v.addEventListener("loadedmetadata", () => { const d = box.querySelector(".vdur"); if (d && d.classList.contains("hidden") && isFinite(v.duration)) { d.textContent = fmtDur(v.duration); d.classList.remove("hidden"); } });
      v.addEventListener("waiting", () => box.querySelector(".vload").classList.remove("hidden"));
      v.addEventListener("playing", () => { box.querySelector(".vload").classList.add("hidden"); box.classList.add("playing"); });
      v.addEventListener("pause", () => box.classList.remove("playing"));
      v.addEventListener("error", () => { box.classList.add("verr"); box.querySelector(".vplay").textContent = "⚠"; });
    });
  }
  document.addEventListener("play", (e) => { if (e.target.tagName !== "VIDEO") return; qa("video").forEach((v) => { if (v !== e.target && !v.paused && !v.closest(".onb")) v.pause(); }); }, true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) qa(".gs video").forEach((v) => v.pause()); });
  function playInline(box) {
    const v = box.querySelector("video"); loadSlide(box);
    if (box.classList.contains("verr")) return toast("Видео не воспроизводится на этом устройстве");
    v.controls = true; v.preload = "auto"; box.classList.add("started");
    v.play().catch(() => { v.muted = true; v.play().catch(() => toast("Не удалось запустить видео")); });
  }
  // счетчик галереи при свайпе
  document.addEventListener("scroll", (e) => {
    const t = e.target; if (!t.classList || !t.classList.contains("gal-track")) return;
    const i = Math.round(t.scrollLeft / t.clientWidth), g = t.parentElement, n = t.children.length;
    loadNear(t, i);
    const lab = g.querySelector(".gal-n"); if (lab) lab.textContent = `${i + 1}/${n}`;
    qa(".gal-dots i", g).forEach((d, k) => d.classList.toggle("on", k === i));
    qa("video", t).forEach((v, k) => { if (!v.paused && Math.abs(v.closest(".gs").offsetLeft - t.scrollLeft) > 10) v.pause(); });
  }, true);

  /* ---------- полноэкранный просмотр фото и видео ---------- */
  function openMediaViewer(items, start = 0) {
    qa(".gs video").forEach((v) => v.pause());
    const o = document.createElement("div"); o.className = "mv"; o.id = "mv";
    o.innerHTML = `<div class="mv-track">${items.map((m) => m.type === "video"
      ? `<div class="mv-s"><video src="${esc(m.url)}"${m.poster ? ` poster="${esc(m.poster)}"` : ""} controls playsinline preload="metadata"></video></div>`
      : `<div class="mv-s"><img src="${esc(m.url)}" alt="" decoding="async"></div>`).join("")}</div>
      <button class="mv-x" aria-label="Закрыть">✕</button>${items.length > 1 ? `<span class="mv-n">${start + 1}/${items.length}</span>` : ""}`;
    document.body.appendChild(o);
    const tr = o.querySelector(".mv-track");
    requestAnimationFrame(() => { tr.scrollLeft = start * tr.clientWidth; o.classList.add("on"); });
    tr.addEventListener("scroll", () => { const i = Math.round(tr.scrollLeft / tr.clientWidth); const n = o.querySelector(".mv-n"); if (n) n.textContent = `${i + 1}/${items.length}`; qa("video", tr).forEach((v, k) => { if (k !== i && !v.paused) v.pause(); }); });
    const close = () => { qa("video", o).forEach((v) => v.pause()); o.classList.remove("on"); setTimeout(() => o.remove(), 220); document.removeEventListener("keydown", esc2); };
    const esc2 = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", esc2);
    o.querySelector(".mv-x").onclick = close;
    o.addEventListener("click", (e) => { if (e.target.classList.contains("mv-s")) close(); });
    // свайп вниз закрывает
    let y0 = null; o.addEventListener("touchstart", (e) => { if (e.touches.length === 1) y0 = e.touches[0].clientY; }, { passive: true });
    o.addEventListener("touchmove", (e) => { if (y0 == null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) { tr.style.transform = `translateY(${dy}px)`; o.style.background = `rgba(0,0,0,${Math.max(0.3, 0.96 - dy / 400)})`; } }, { passive: true });
    o.addEventListener("touchend", (e) => { if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null; tr.style.transform = ""; o.style.background = ""; if (dy > 110) close(); });
    const v0 = qa("video", tr)[start]; if (v0) setTimeout(() => v0.play().catch(() => {}), 250);
  }
  function openViewer(src) { openMediaViewer([{ type: "image", url: src }], 0); }

  /* ---------- двойное нажатие на фото = лайк ---------- */
  let tapT = null, tapEl = null;
  function photoTap(box, p) {
    if (tapEl === box && tapT) {
      clearTimeout(tapT); tapT = null; tapEl = null;
      const g = box.closest(".gal"), hb = g.querySelector(".heart-burst"); hb.classList.remove("go"); void hb.offsetWidth; hb.classList.add("go");
      if (!p.liked) doLike(p.id); return;
    }
    tapEl = box; tapT = setTimeout(() => { tapT = null; tapEl = null; openMediaViewer(p.media.filter((m) => !shieldFor(m, p.user_id) || m.type === "video"), +box.dataset.i); }, 260);
  }

  /* ---------- меню публикации ⋯ ---------- */
  function postMenu(p) {
    const mine = user && user.id === p.user_id;
    const rows = [];
    if (mine) {
      rows.push(`<button class="opt-row" data-m="edit">✏️ Редактировать<span>›</span></button>`);
      rows.push(`<button class="opt-row" data-m="close">${p.status === "closed" ? "↩ Снова актуально" : "✅ Отметить неактуальным"}<span></span></button>`);
    }
    rows.push(`<button class="opt-row" data-m="link">🔗 Скопировать ссылку<span></span></button>`);
    rows.push(`<button class="opt-row" data-m="share">↗ Поделиться<span></span></button>`);
    if (!mine) {
      rows.push(`<button class="opt-row" data-m="hide">🙈 Скрыть из моей ленты<span></span></button>`);
      rows.push(`<button class="opt-row" data-m="report">⚑ Пожаловаться<span>›</span></button>`);
      rows.push(`<button class="opt-row" data-m="block" style="color:#ff8a95">🚫 Заблокировать ${esc(p.author.name)}<span></span></button>`);
    } else rows.push(`<button class="opt-row" data-m="del" style="color:#ff8a95">🗑 Удалить<span></span></button>`);
    openSheet("Публикация", rows.join(""));
    $("bsList").onclick = async (e) => {
      const b = e.target.closest("[data-m]"); if (!b) return; const m = b.dataset.m;
      if (m === "edit") { closeSheet(); openCreate({ edit: p }); }
      if (m === "close") { closeSheet(); toggleClosed(p); }
      if (m === "del") { closeSheet(); deletePostFlow(p); }
      if (m === "link") { closeSheet(); try { await navigator.clipboard.writeText(postLink(p)); toast("🔗 Ссылка скопирована"); } catch (er) { toast(postLink(p)); } }
      if (m === "share") { closeSheet(); sharePost(p); }
      if (m === "hide") { closeSheet(); hiddenPosts.add(p.id); saveHidden(); qa(`.post[data-post="${p.id}"]`).forEach((el) => { el.style.transition = "opacity .25s,transform .25s"; el.style.opacity = "0"; el.style.transform = "scale(.97)"; setTimeout(() => el.remove(), 260); }); toast("🙈 Скрыто. Вернуть можно в Настройках → Приватность"); }
      if (m === "report") reportSheet({ type: "post", id: p.id, user_id: p.user_id, label: "публикацию" });
      if (m === "block") blockUser(p.user_id, p.author.name, () => { if (cur() === "sv-post") back(); });
    };
  }
  async function toggleClosed(p) {
    try { const np = await api.updatePost(p.id, { status: p.status === "closed" ? "active" : "closed" }); cache.set(p.id, np); refreshCardEverywhere(np); feedDirty = true; wide = null; if (mapReady) loadMapPosts(true); toast(np.status === "closed" ? "✅ Отмечено как неактуальное" : "Публикация снова активна"); }
    catch (e) { toast(e.message); }
  }
  async function deletePostFlow(p) {
    if (!(await confirmSheet("Удалить публикацию?", "Публикация, фото и комментарии будут удалены без возможности восстановления.", "Удалить", true))) return;
    try { await api.deletePost(p.id); cache.delete(p.id); feedPosts = feedPosts.filter((x) => x.id !== p.id); wide = null; feedDirty = true; if (mapReady) loadMapPosts(true); qa(`.post[data-post="${p.id}"]`).forEach((el) => el.remove()); toast("🗑 Публикация удалена"); if (cur() === "sv-post") back(); }
    catch (e) { toast(e.message); }
  }

  /* ---------- комментарии в нижней панели ---------- */
  const CS = { postId: null, list: [], replyTo: null };
  function openComments(id) {
    const p = cache.get(id); if (!p) return;
    CS.postId = id; CS.replyTo = null; $("csReply").classList.add("hidden");
    $("csTitle").textContent = "Комментарии" + (p.comments ? " · " + p.comments : "");
    $("csList").innerHTML = '<div class="spin"></div>';
    $("csForm").classList.toggle("hidden", !user); $("csLogin").classList.toggle("hidden", !!user);
    if (user) $("csAva").innerHTML = ava(user);
    $("csBg").classList.add("on"); $("csheet").classList.add("on"); document.body.classList.add("cs-open");
    fitSheet();
    api.listComments(id).then((cm) => { if (CS.postId !== id) return; CS.list = cm; if (p.comments !== cm.length) { p.comments = cm.length; patchCard(p); } renderComments(); })
      .catch((e) => { $("csList").innerHTML = `<div class="empty"><b>Не удалось загрузить</b>${esc(e.message)}<br><button class="btn btn-main mt12" id="csRetry">Повторить</button></div>`; $("csRetry").onclick = () => openComments(id); });
  }
  function closeComments() { $("csBg").classList.remove("on"); $("csheet").classList.remove("on"); document.body.classList.remove("cs-open"); $("csIn").blur(); CS.postId = null; $("csheet").style.transform = ""; }
  function cmHtml(c, reply) {
    const own = user && user.id === c.user_id;
    const acts = c._state === "failed" ? `<button data-retry="${c.id}" class="red">⚠ Не отправлено · Повторить</button><button data-drop="${c.id}">Удалить</button>`
      : c._state === "sending" ? "" : `<button data-reply="${c.id}">Ответить</button>${own ? `<button data-delc="${c.id}">Удалить</button>` : `<button data-repc="${c.id}" data-uid="${c.user_id}">Пожаловаться</button>`}`;
    return `<div class="cm${reply ? " cm-r" : ""}${c._state ? " " + c._state : ""}" data-cid="${c.id}"><span class="who-link" data-user="${c.user_id}">${ava(c.author)}</span>
      <div class="cm-b"><div class="cm-h"><b class="who-link" data-user="${c.user_id}" translate="no">${esc(c.author.name)}${vBadge(c.author)}</b><span>${c._state === "sending" ? "отправка..." : timeAgo(c.created_at)}</span></div>
      <div class="cm-t" translate="no">${esc(c.text)}</div><div class="cm-a">${acts}</div></div></div>`;
  }
  function renderComments() {
    const p = cache.get(CS.postId); const top = CS.list.filter((c) => !c.parent_id || !CS.list.some((x) => x.id === c.parent_id));
    $("csTitle").textContent = "Комментарии" + (CS.list.length ? " · " + CS.list.length : "");
    $("csList").innerHTML = top.length ? top.map((c) => cmHtml(c) + CS.list.filter((r) => r.parent_id === c.id).map((r) => cmHtml(r, true)).join("")).join("")
      : `<div class="empty cs-empty"><b>Пока нет комментариев</b>${p && user && p.user_id === user.id ? "Здесь появятся ответы соседей" : "Напишите первым!"}</div>`;
  }
  async function sendComment(text, parentId, tmpId) {
    const p = cache.get(CS.postId); const id = CS.postId;
    let tmp = CS.list.find((c) => c.id === tmpId);
    if (!tmp) { tmp = { id: "tmp-" + Date.now(), text, parent_id: parentId, user_id: user.id, author: user, created_at: new Date().toISOString(), _state: "sending" }; CS.list.push(tmp); }
    else tmp._state = "sending";
    renderComments(); const el = $("csList").querySelector(`[data-cid="${tmp.id}"]`); if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    try {
      const real = await api.addComment(id, text, parentId);
      if (CS.postId !== id) return;
      Object.assign(tmp, real || {}, { _state: null }); if (real && real.id) tmp.id = real.id;
      if (p) { p.comments = CS.list.filter((c) => !c._state).length; patchCard(p); }
      renderComments(); Sound.play("send"); Obs.track("comment_created"); usefulAction("comment");
    } catch (e) { if (gateError(e)) { CS.list = CS.list.filter((x) => x !== tmp); renderComments(); return; } tmp._state = "failed"; tmp._err = e.message; renderComments(); toast(e.message); }
  }
  function fitSheet() {
    const vv = window.visualViewport, sh = $("csheet"); if (!sh) return;
    if (!vv) return;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    sh.style.bottom = kb + "px"; sh.style.maxHeight = Math.round(vv.height * (kb > 0 ? 0.92 : 0.82)) + "px";
  }
  if (window.visualViewport) { visualViewport.addEventListener("resize", () => { if (CS.postId) fitSheet(); }); visualViewport.addEventListener("scroll", () => { if (CS.postId) fitSheet(); }); }
  $("csBg").onclick = closeComments; $("csX").onclick = closeComments;
  $("csLogin").onclick = () => { closeComments(); requireAuth("Войдите, чтобы комментировать", { t: "comments", a: CS.postId }); };
  $("csReplyX").onclick = () => { CS.replyTo = null; $("csReply").classList.add("hidden"); };
  $("csForm").onsubmit = (e) => {
    e.preventDefault(); const v = $("csIn").value.trim(); if (!v || !CS.postId) return;
    if (N.hasBad(v)) toast("🤬 Грубые слова будут скрыты звездочками");
    $("csIn").value = ""; const par = CS.replyTo; CS.replyTo = null; $("csReply").classList.add("hidden");
    sendComment(v, par, null);
  };
  $("csList").onclick = async (e) => {
    let b;
    if ((b = e.target.closest("[data-reply]"))) {
      if (!requireAuth("Войдите, чтобы отвечать")) return;
      const c = CS.list.find((x) => x.id === b.dataset.reply); CS.replyTo = c.parent_id || c.id;
      $("csReply").querySelector("span").innerHTML = `Ответ для <b>${esc(c.author.name)}</b>`; $("csReply").classList.remove("hidden"); $("csIn").focus(); return;
    }
    if ((b = e.target.closest("[data-retry]"))) { const c = CS.list.find((x) => x.id === b.dataset.retry); if (c) sendComment(c.text, c.parent_id, c.id); return; }
    if ((b = e.target.closest("[data-drop]"))) { CS.list = CS.list.filter((x) => x.id !== b.dataset.drop); renderComments(); return; }
    if ((b = e.target.closest("[data-delc]"))) {
      if (!(await confirmSheet("Удалить комментарий?", "Ответы на него тоже удалятся.", "Удалить", true))) return;
      try { await api.deleteComment(b.dataset.delc); CS.list = CS.list.filter((x) => x.id !== b.dataset.delc && x.parent_id !== b.dataset.delc); const p = cache.get(CS.postId); if (p) { p.comments = CS.list.length; patchCard(p); } renderComments(); toast("Комментарий удален"); }
      catch (er) { toast(er.message); } return;
    }
    if ((b = e.target.closest("[data-repc]"))) return reportSheet({ type: "comment", id: b.dataset.repc, user_id: b.dataset.uid, label: "комментарий" });
    if ((b = e.target.closest("[data-user]"))) { closeComments(); openUser(b.dataset.user); }
  };
  // свайп вниз по заголовку закрывает панель
  (() => { let y0 = null; const h = $("csHead"), sh = $("csheet");
    h.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    h.addEventListener("touchmove", (e) => { if (y0 == null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) sh.style.transform = `translateY(${dy}px)`; }, { passive: true });
    h.addEventListener("touchend", (e) => { if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null; sh.style.transform = ""; if (dy > 90) closeComments(); });
  })();
  /* ---------- лента порциями + кэш + обновление ---------- */
  const PAGE = 12;
  const F = { ids: new Set(), next: null, done: false, loading: false, seq: 0, newest: null };
  // SEC-06: кэш ленты привязан к аккаунту (или гостю) и версии; при выходе и смене аккаунта стирается
  const feedKey = () => `near_feed_v12_${user ? user.id.slice(0, 12) : "guest"}_${R}_${feedCat}_${FS.sort}_${FS.period || "all"}_${FS.friends ? 1 : 0}_${pos.lat.toFixed(2)}_${pos.lng.toFixed(2)}`;
  let feedCachedAt = 0;
  function saveFeedCache() {
    if (api.mode === "local") return; // в демо фото хранятся внутри данных — кэш не нужен
    try { localStorage.setItem(feedKey(), JSON.stringify({ t: Date.now(), posts: feedPosts.slice(0, PAGE) })); } catch (e) {}
  }
  function readFeedCache() {
    try {
      const c = JSON.parse(localStorage.getItem(feedKey()) || "null");
      if (!c || Date.now() - c.t > 48 * 3600e3) return null;
      feedCachedAt = c.t; const nowS = new Date().toISOString();
      // устаревшие SOS и просроченные происшествия из кэша не показываем
      return c.posts.filter((p) => !p.expires_at || p.expires_at > nowS);
    } catch (e) { return null; }
  }
  const newestOf = (list) => list.reduce((m, p) => (!m || p.created_at > m.ts || (p.created_at === m.ts && p.id > m.id) ? { ts: p.created_at, id: p.id } : m), null);
  function addPosts(list, where) {
    const fresh = list.filter((p) => p && !F.ids.has(p.id)); // без дублей: по уникальному id
    fresh.forEach((p) => F.ids.add(p.id)); remember(fresh);
    if (where === "top") feedPosts = fresh.concat(feedPosts); else feedPosts = feedPosts.concat(fresh);
    if (feedPosts.length) { const n = newestOf(feedPosts); if (!F.newest || n.ts > F.newest.ts || (n.ts === F.newest.ts && n.id > F.newest.id)) F.newest = n; }
    return fresh;
  }
  // UX-02: сортировка ("Новое" по умолчанию — прозрачно), период и "только друзья"; сохраняются для каждого аккаунта
  const FS = { sort: "new", period: null, friends: false };
  const feedArgs = () => ({ lat: pos.lat, lng: pos.lng, radius: R, category: catFilter(feedCat), sort: FS.sort, period: FS.period, friends: FS.friends && !!user });
  function loadFeedPrefs() {
    const f = prefs.feed || {};
    FS.sort = ["new", "near", "top"].includes(f.sort) ? f.sort : "new"; FS.period = ["today", "week"].includes(f.period) ? f.period : null; FS.friends = !!f.friends;
    if ([500, 1000, 3000, 5000, 10000].includes(f.r)) setRadius(f.r);
    if (f.cat && CHIPS.some(([k]) => k === f.cat)) { feedCat = f.cat; $("cats").innerHTML = chipsHtml(feedCat); }
    renderSortBar();
  }
  function saveFeedPrefs() { prefs.feed = { sort: FS.sort, period: FS.period, friends: FS.friends, r: R, cat: feedCat }; savePrefs(); }
  function renderSortBar() {
    const n = (FS.period ? 1 : 0) + (FS.friends ? 1 : 0);
    $("sortBar").innerHTML = `<div class="sort-seg" role="tablist">${[["new", "Новое"], ["near", "Рядом"], ["top", "Для вас"]].map(([k, t]) => `<button role="tab" aria-selected="${FS.sort === k}" data-sort="${k}" class="${FS.sort === k ? "on" : ""}">${t}</button>`).join("")}</div>
      <button class="flt-btn${n ? " on" : ""}" id="fltBtn" aria-label="Фильтры">⚙ Фильтры${n ? ` · ${n}` : ""}</button>`;
  }
  $("sortBar").onclick = (e) => {
    const b = e.target.closest("[data-sort]");
    if (b) { if (FS.sort === b.dataset.sort) return; FS.sort = b.dataset.sort; renderSortBar(); saveFeedPrefs(); Obs.track("filter_changed", { sort: FS.sort }); loadFeed(); return; }
    if (e.target.closest("#fltBtn")) filterSheet();
  };
  function filterSheet() {
    const per = [[null, "Все время"], ["today", "Сегодня"], ["week", "Неделя"]];
    openSheet("Фильтры", `<div class="lbl">Период</div><div class="rad-ch wide" id="fPer">${per.map(([k, t]) => `<button data-per="${k || ""}" class="${FS.period === k ? "on" : ""}">${t}</button>`).join("")}</div>
      <div class="lbl mt12">Кто публикует</div><div class="rad-ch wide" id="fWho"><button data-who="0" class="${FS.friends ? "" : "on"}">Все</button><button data-who="1" class="${FS.friends ? "on" : ""}">Только друзья</button></div>
      ${user ? "" : '<div class="s-note">"Только друзья" работает после входа.</div>'}
      <div class="sheet-btns mt12"><button class="btn btn-ghost" id="fReset">Сбросить</button><button class="btn btn-main" id="fApply">Применить</button></div>`);
    let per0 = FS.period, who = FS.friends;
    qa("#fPer [data-per]").forEach((b) => (b.onclick = () => { per0 = b.dataset.per || null; qa("#fPer button").forEach((x) => x.classList.toggle("on", x === b)); }));
    qa("#fWho [data-who]").forEach((b) => (b.onclick = () => { who = b.dataset.who === "1"; qa("#fWho button").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("fReset").onclick = () => { closeSheet(); FS.period = null; FS.friends = false; renderSortBar(); saveFeedPrefs(); loadFeed(); };
    $("fApply").onclick = () => {
      closeSheet(); if (who && !user) { requireAuth("Войдите, чтобы видеть публикации друзей"); return; }
      FS.period = per0; FS.friends = who; renderSortBar(); saveFeedPrefs(); Obs.track("filter_changed", { period: FS.period || "all", filter: who ? "friends" : "all" }); loadFeed();
    };
  }
  // метка "обновлено N мин назад" для ленты из кэша
  function staleNote(on) {
    let el = $("feedStale");
    if (!on) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement("div"); el.id = "feedStale"; el.className = "feed-stale"; el.setAttribute("role", "status"); $("posts").before(el); }
    el.textContent = "Сохраненная лента · обновлено " + (feedCachedAt ? timeAgo(new Date(feedCachedAt).toISOString()) : "ранее");
  }
  async function loadFeed() {
    feedDirty = false;
    if (!api) return;
    // устаревший запрос (сменили радиус, сортировку, место) отменяется
    if (F.ctrl) try { F.ctrl.abort(); } catch (e) {}
    F.ctrl = "AbortController" in window ? new AbortController() : null;
    const seq = ++F.seq, t0 = performance.now(), prev = feedPosts.slice();
    F.loading = true;
    const cached = readFeedCache();
    // показанная лента не стирается до ответа сервера: при ошибке сети она остается на экране
    if (cached && cached.length) { F.ids = new Set(); feedPosts = []; F.newest = null; addPosts(cached); renderFeed(true); staleNote(true); }
    else if (!prev.length) $("posts").innerHTML = '<div class="post sk"></div><div class="post sk"></div>';
    else $("posts").classList.add("reloading");
    try {
      const r = await api.feedPage({ ...feedArgs(), limit: PAGE, signal: F.ctrl && F.ctrl.signal });
      if (seq !== F.seq) return;
      const shown = feedPosts.slice();
      F.ids = new Set(); feedPosts = []; F.newest = null; addPosts(r.posts); F.next = r.next; F.done = r.done;
      renderFeed(); saveFeedCache(); staleNote(false);
      invalidateGone(shown, r.posts);
      Obs.track("feed_loaded", { ms: Math.round(performance.now() - t0), count: r.posts.length, radius: R, sort: FS.sort });
    } catch (e) {
      if (seq !== F.seq || e.name === "AbortError" || /abort/i.test(e.message)) return;
      if (!feedPosts.length) { $("posts").innerHTML = `<div class="empty"><b>Не удалось загрузить ленту</b>${esc(e.message)}<br><button class="btn btn-main mt12" id="retryFeed">Повторить</button></div>`; $("retryFeed").onclick = loadFeed; }
      else { toast("Нет связи. Показываем последнюю загруженную ленту"); staleNote(true); }
    } finally { if (seq === F.seq) { F.loading = false; $("posts").classList.remove("reloading"); feedTail(); } }
    updateChanges();
  }
  // CACHE-01: публикация была в сохраненной ленте, но сервер ее больше не отдает (скрыта, удалена, истекла) —
  // убираем из памяти и ее фото из кэша телефона. Уже скачанные кем-то копии удалить невозможно.
  function invalidateGone(shown, fresh) {
    if (FS.sort !== "new" || !shown.length || !fresh.length) return;
    const ids = new Set(fresh.map((p) => p.id)), oldest = fresh[fresh.length - 1].created_at;
    const gone = shown.filter((p) => !ids.has(p.id) && p.created_at >= oldest);
    if (!gone.length) return;
    gone.forEach((p) => cache.delete(p.id));
    Cache.purge(gone.flatMap((p) => (p.media || []).flatMap((m) => [m.url, m.thumb, m.poster])).filter(Boolean));
  }
  async function loadMore() {
    if (F.loading || F.done || !feedPosts.length) return;
    const seq = F.seq; F.loading = true; feedTail();
    try {
      const r = await api.feedPage({ ...feedArgs(), limit: PAGE, before: F.next });
      if (seq !== F.seq) return;
      F.next = r.next; F.done = r.done;
      const fresh = addPosts(r.posts).filter((p) => !hiddenPosts.has(p.id));
      if (fresh.length) { $("posts").insertAdjacentHTML("beforeend", fresh.map(card).join("")); wireMedia($("posts")); }
    } catch (e) { toast("Не удалось загрузить еще: " + e.message); F.err = true; }
    finally { if (seq === F.seq) { F.loading = false; feedTail(); } }
  }
  // новые публикации с момента последнего просмотра
  async function refreshNew(silent) {
    // "Рядом" и "Для вас" пересчитываются целиком; "Новое" — догружаются новые сверху
    if (!feedPosts.length || !F.newest || FS.sort !== "new") { await loadFeed(); return 0; }
    const seq = F.seq;
    try {
      const r = await api.feedPage({ ...feedArgs(), after: F.newest });
      if (seq !== F.seq) return 0;
      const fresh = addPosts(r.posts, "top").filter((p) => !hiddenPosts.has(p.id));
      fresh.sort((a, b) => (b.created_at === a.created_at ? (b.id > a.id ? 1 : -1) : b.created_at.localeCompare(a.created_at)));
      if (fresh.length) {
        feedPosts.sort((a, b) => b.created_at.localeCompare(a.created_at));
        const empty = $("posts").querySelector(".empty"); if (empty) empty.remove();
        $("posts").insertAdjacentHTML("afterbegin", fresh.map(card).join("")); wireMedia($("posts")); saveFeedCache();
      }
      if (!silent) toast(fresh.length ? `🆕 ${fresh.length} ${plural(fresh.length, "новая публикация", "новые публикации", "новых публикаций")}` : "Новых публикаций нет");
      updateChanges(); $("refreshBtn").style.background = "";
      return fresh.length;
    } catch (e) { if (!silent) toast("Не удалось обновить: " + e.message); return 0; }
  }
  function feedTail() {
    let t = $("feedTail");
    if (!t) { t = document.createElement("div"); t.id = "feedTail"; t.className = "feed-tail"; $("posts").after(t); }
    if (!feedPosts.length) { t.innerHTML = ""; return; }
    t.innerHTML = F.loading ? '<div class="spin"></div>' : F.done ? `<span>Это все публикации в радиусе ${fmtDist(R)}</span>` : F.err ? '<button class="more" id="tailRetry">Повторить</button>' : "";
    if ($("tailRetry")) $("tailRetry").onclick = () => { F.err = false; loadMore(); };
  }
  // подгрузка следующей порции, когда до конца ленты остается ~1,5 экрана
  const tailIO = "IntersectionObserver" in window ? new IntersectionObserver((en) => { if (en.some((x) => x.isIntersecting) && !F.err) loadMore(); }, { root: $("v-feed"), rootMargin: "0px 0px 1200px 0px" }) : null;
  function renderFeed(fromCache) {
    const vis = feedPosts.filter((p) => !hiddenPosts.has(p.id));
    if (!vis.length) {
      $("posts").innerHTML = F.loading ? '<div class="post sk"></div><div class="post sk"></div>' : `<div class="empty"><b>Здесь пока тихо</b>В радиусе ${fmtDist(R)} нет публикаций${feedCat !== "all" ? " в этой категории" : ""}.<br>Увеличьте радиус или опубликуйте первым!<br><button class="btn btn-main mt12" data-create="talk">+ Опубликовать</button></div>`;
      feedTail(); return;
    }
    $("posts").innerHTML = vis.map(card).join("");
    wireMedia($("posts")); feedTail();
    if (tailIO) { tailIO.disconnect(); tailIO.observe($("feedTail")); }
  }
  async function updateChanges() {
    try {
      const by = await api.recentStats(feedArgs());
      const parts = Object.entries(by).filter(([k]) => CATS[k]);
      $("changesText").textContent = parts.length ? parts.map(([k, v]) => `${CATS[k].e} ${I18N.t(CATS[k].n).toLowerCase()}: ${v}`).join(" · ") : "За последний час новых публикаций нет";
    } catch (e) { $("changesText").textContent = "—"; }
  }
  $("refreshBtn").onclick = () => refreshNew();

  /* ---------- обновление свайпом вниз ---------- */
  (() => {
    const v = $("v-feed"), ind = document.createElement("div"); ind.className = "ptr"; ind.innerHTML = '<i class="ptr-ic">↓</i>'; v.parentElement.insertBefore(ind, v);
    let y0 = null, pull = 0, busyP = false;
    const set = (h, anim) => { ind.style.top = v.offsetTop + "px"; v.style.transition = anim ? "transform .25s" : "none"; ind.style.transition = v.style.transition; v.style.transform = h ? `translateY(${h}px)` : ""; ind.style.opacity = Math.min(1, h / 60); ind.querySelector(".ptr-ic").style.transform = `rotate(${h > 70 ? 180 : 0}deg)`; };
    v.addEventListener("touchstart", (e) => { if (busyP || v.scrollTop > 0 || e.touches.length > 1) { y0 = null; return; } y0 = e.touches[0].clientY; pull = 0; }, { passive: true });
    v.addEventListener("touchmove", (e) => {
      if (y0 == null) return; const dy = e.touches[0].clientY - y0;
      if (dy <= 0 || v.scrollTop > 0) { if (pull) set(0); y0 = dy < 0 ? null : y0; pull = 0; return; }
      if (e.cancelable) e.preventDefault();
      pull = Math.min(120, dy * 0.5); set(pull);
    }, { passive: false });
    v.addEventListener("touchend", async () => {
      if (y0 == null) return; y0 = null;
      if (pull > 70) {
        busyP = true; set(56, true); ind.classList.add("spin-on"); if (navigator.vibrate) navigator.vibrate(10);
        await refreshNew(); ind.classList.remove("spin-on"); set(0, true); busyP = false;
      } else set(0, true);
      pull = 0;
    });
  })();

  /* post actions (shared) */
  async function doLike(id) {
    if (!requireAuth("Войдите, чтобы ставить лайки", { t: "like", a: id })) return;
    const p = cache.get(id); if (!p) return;
    p.liked = !p.liked; p.likes += p.liked ? 1 : -1; patchCard(p);
    if (p.liked) qa(`.post[data-post="${id}"] [data-like]`).forEach((b) => { b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); });
    try { const r = await api.toggleLike(id); p.liked = r.liked; p.likes = r.likes; patchCard(p); }
    catch (e) { p.liked = !p.liked; p.likes += p.liked ? 1 : -1; patchCard(p); toast("Не удалось: " + e.message); }
  }
  async function doSave(id) {
    if (!requireAuth("Войдите, чтобы сохранять публикации", { t: "save", a: id })) return;
    const p = cache.get(id); if (!p) return;
    p.saved = !p.saved; patchCard(p);
    try { p.saved = await api.toggleSave(id); patchCard(p); toast(p.saved ? "🔖 Сохранено в профиль" : "Убрано из сохраненного"); if (cur() === "v-prof" && profTab === "saved") loadProfList(); }
    catch (e) { p.saved = !p.saved; patchCard(p); toast("Не удалось: " + e.message); }
  }
  async function doJoin(id) {
    if (!requireAuth("Войдите, чтобы участвовать", { t: "join", a: id })) return;
    const p = cache.get(id); if (!p || !p.event) return;
    try { const r = await api.toggleJoin(id); p.event.joined = r.joined; p.event.members = r.members; patchCard(p); if (cur() === "sv-events") renderEvents(); toast(r.joined ? "🎉 Вы участвуете! Напомним в календаре" : "Участие отменено"); if (r.joined) usefulAction("join"); }
    catch (e) { toast(e.message); }
  }
  function showOnMap(id) { const p = cache.get(id); if (!p) return; pendingFocus = p; hist = []; go("v-map", false); if (mapReady) focusPost(p); }
  function postClick(e) {
    const t = e.target, art = t.closest(".post[data-post]"), p = art && cache.get(art.dataset.post);
    let b;
    if ((b = t.closest("[data-user]"))) return openUser(b.dataset.user);
    if ((b = t.closest("[data-like]"))) return doLike(b.dataset.like);
    if ((b = t.closest("[data-save]"))) return doSave(b.dataset.save);
    if ((b = t.closest("[data-join]"))) return doJoin(b.dataset.join);
    if ((b = t.closest("[data-onmap]"))) return showOnMap(b.dataset.onmap);
    if ((b = t.closest("[data-cmt]"))) return openComments(b.dataset.cmt);
    if ((b = t.closest("[data-share]"))) { const q = cache.get(b.dataset.share); return q && sharePost(q); }
    if ((b = t.closest("[data-pmenu]"))) { const q = cache.get(b.dataset.pmenu); return q && postMenu(q); }
    if ((b = t.closest("[data-moretext]"))) { b.previousElementSibling.classList.remove("clamp"); b.remove(); return; }
    if ((b = t.closest("[data-reveal]"))) { if (t.closest(".shield button")) { b.classList.remove("blur-wrap"); b.removeAttribute("data-reveal"); b.setAttribute("data-img", ""); b.querySelector(".shield").remove(); } return; }
    if ((b = t.closest(".vfs"))) { const box = b.closest(".gs"); return p && openMediaViewer(p.media, +box.dataset.i); }
    if ((b = t.closest(".gs.vid"))) { if (!b.classList.contains("started")) playInline(b); return; }
    if ((b = t.closest("[data-img]"))) return p && photoTap(b, p);
    if (t.closest(".post-near, .post-f, .gal")) return;
    if (art) return openPost(art.dataset.post);
  }
  $("posts").onclick = postClick;
