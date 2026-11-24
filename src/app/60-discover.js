  /* =====================================================
     DISCOVER (реальные данные)
     ===================================================== */
  let wide = null, wideAt = 0;
  async function loadWide() {
    if (wide && Date.now() - wideAt < 60000) return wide;
    wide = remember(await api.listPosts({ lat: pos.lat, lng: pos.lng, radius: 10000, limit: 500 })); wideAt = Date.now(); return wide;
  }
  function setCnt(id, n) { const e = $(id); e.textContent = n; e.classList.toggle("hidden", !n); }
  function upcoming(list) { return list.filter((p) => p.event && p.status !== "closed" && new Date(p.event.starts_at) > Date.now() - 3 * 3600e3).sort((a, b) => a.event.starts_at.localeCompare(b.event.starts_at)); }
  function updateDiscCounts() {
    if (!wide) return; const act = wide.filter((p) => p.status !== "closed");
    setCnt("cntRadar", act.filter((p) => D(p) <= 10000 && Date.now() - new Date(p.created_at) < 86400e3).length);
    setCnt("cntEvents", upcoming(wide).length);
    setCnt("cntDeals", act.filter((p) => p.category === "deal").length);
    setCnt("cntLost", act.filter((p) => p.category === "lost" || p.category === "found").length);
  }
  async function withWide(boxId, fn) {
    $(boxId).innerHTML = '<div class="spin"></div>';
    try { fn(await loadWide()); } catch (e) { $(boxId).innerHTML = `<div class="empty"><b>Ошибка</b>${esc(e.message)}</div>`; }
  }
  // радар до 10 км; шкала нелинейная, чтобы ближние точки не слипались в центре
  const RINGS = [[0, 0], [500, 0.22], [1000, 0.40], [3000, 0.62], [5000, 0.80], [10000, 1]];
  function radarFrac(d) {
    for (let i = 1; i < RINGS.length; i++) if (d <= RINGS[i][0]) { const [d0, f0] = RINGS[i - 1], [d1, f1] = RINGS[i]; return f0 + ((d - d0) / (d1 - d0)) * (f1 - f0); }
    return 1;
  }
  function renderRadar() {
    withWide("radarRows", (list) => {
      const act = list.filter((p) => p.status === "active" && D(p) <= 10000);
      const box = $("radarBox"); qa(".bl", box).forEach((x) => x.remove());
      act.slice(0, 60).forEach((p) => {
        const dy = (p.lat - pos.lat) * 111320, dx = (p.lng - pos.lng) * 111320 * Math.cos((pos.lat * Math.PI) / 180);
        const d = Math.hypot(dx, dy) || 1, f = radarFrac(d) * 0.5, c = CATS[p.category] || CATS.talk;
        box.insertAdjacentHTML("beforeend", `<span class="bl" data-post="${p.id}" style="left:${50 + (dx / d) * f * 100}%;top:${50 - (dy / d) * f * 100}%;background:${c.c};cursor:pointer">${c.e}</span>`);
      });
      const rings = [[0, 500, "500 м"], [500, 1000, "1 км"], [1000, 3000, "3 км"], [3000, 5000, "5 км"], [5000, 10000, "10 км"]];
      $("radarSub").textContent = `${act.length} ${plural(act.length, "публикация", "публикации", "публикаций")} в радиусе 10 км` + (pos.src === "gps" ? "" : " · от центра " + (pos.src === "district" ? "района" : "Алматы"));
      $("radarRows").innerHTML = rings.map(([a, b, n]) => {
        const ps = act.filter((p) => D(p) > a && D(p) <= b); const by = {};
        ps.forEach((p) => (by[p.category] = (by[p.category] || 0) + 1));
        const txt = ps.length ? Object.entries(by).map(([k, v]) => `${(CATS[k] || CATS.talk).e} ${v}`).join("  ") : "тихо";
        return `<button class="rrow" data-rr="${b}"><span class="rd2">${n}</span><span>${ps.length ? ps.length + " · " : ""}${txt}</span></button>`;
      }).join("");
    });
  }
  $("radarRows").onclick = (e) => { const b = e.target.closest("[data-rr]"); if (!b) return; setRadius(+b.dataset.rr); hist = []; go("v-feed", false); loadFeed(); };
  $("radarBox").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };

  // события по дням (идея из Posse): колонка даты слева, карточки справа; "Все / Сегодня / Неделя"
  let evPeriod = "all", evKind = null;
  // v14: быстрые входы ленты — "Встречи" и "События" открывают один календарь с фильтром по типу
  qa("[data-quick]").forEach((b) => (b.onclick = () => { evKind = b.dataset.quick; go("sv-events"); }));
  document.addEventListener("click", (e) => { const o = e.target.closest('[data-open="sv-events"]'); if (o && !o.closest("#quick")) evKind = null; }, true);
  qa("#evSeg [data-ev]").forEach((b) => (b.onclick = () => { evPeriod = b.dataset.ev; qa("#evSeg button").forEach((x) => x.classList.toggle("on", x === b)); renderEvents(); }));
  const dayKey = (d) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Almaty" });
  function renderEvents() {
    withWide("eventsList", (list) => {
      const now = new Date(), today = dayKey(now), wk = Date.now() + 7 * 86400e3;
      $("evTitle").textContent = evKind === "meetup" ? "Встречи" : evKind === "event" ? "События" : "События и встречи";
      const cb = document.querySelector("#sv-events [data-create]"); if (cb) { cb.dataset.create = evKind === "meetup" ? "meetup" : "event"; cb.textContent = evKind === "meetup" ? "+ Создать встречу" : "+ Создать событие"; }
      const ev = upcoming(list).filter((p) => !evKind || p.category === evKind).filter((p) => { const t = new Date(p.event.starts_at); return evPeriod === "all" || (evPeriod === "today" ? dayKey(t) === today : t.getTime() < wk); });
      if (!ev.length) { $("eventsList").innerHTML = `<div class="empty"><b>${evKind === "meetup" ? (evPeriod === "today" ? "Сегодня встреч нет" : "Ближайших встреч нет") : evPeriod === "today" ? "Сегодня событий нет" : "Ближайших событий нет"}</b>${evKind === "meetup" ? "Расширьте радиус или создайте встречу: футбол, настолки, прогулка" : "Создайте первое: концерт, ярмарку или встречу соседей"}</div>`; return; }
      const groups = []; ev.forEach((p) => { const k = dayKey(new Date(p.event.starts_at)); const g = groups.find((x) => x.k === k); if (g) g.items.push(p); else groups.push({ k, items: [p] }); });
      const tomorrow = dayKey(new Date(Date.now() + 86400e3));
      $("eventsList").innerHTML = groups.map((g) => {
        const d = new Date(g.items[0].event.starts_at);
        const lbl = g.k === today ? "Сегодня" : g.k === tomorrow ? "Завтра" : "";
        return `<section class="ev-day${g.k === today ? " today" : ""}"><div class="ev-date"><small>${lbl}</small><b>${dfmt(d, { day: "numeric", timeZone: "Asia/Almaty" })}</b><span>${dfmt(d, { weekday: "short", timeZone: "Asia/Almaty" })}</span></div>
          <div class="ev-items">${g.items.map((p) => {
            const c = CATS[p.category], m = p.media[0], img = m && (m.thumb || (m.type === "image" ? m.url : m.poster));
            const t = new Date(p.event.starts_at).toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Almaty" });
            const full = p.event.capacity && p.event.members >= p.event.capacity;
            return `<article class="ev2" data-post="${p.id}"><div class="ev2-im" style="${img ? `background-image:url('${esc(img)}')` : `background:linear-gradient(135deg,${c.c}cc,${c.c}55)`}">${img ? "" : `<span>${c.e}</span>`}${p.event.members >= 10 ? `<i class="ev2-hot">🔥 ${p.event.members} идут</i>` : ""}</div>
              <div class="ev2-b"><b translate="no">${esc(p.text.split("\n")[0].slice(0, 70))}</b><span>📍 ${fmtDist(D(p))} · <span translate="no">${esc(p.author.name)}</span></span>
                <div class="ev2-t"><b>${t}</b> · ${p.event.members}${p.event.capacity ? " из " + p.event.capacity : ""} ${plural(p.event.members, "участник", "участника", "участников")}</div>
                <div class="ev2-a"><button class="go${p.event.joined ? " in" : ""}" data-join="${p.id}" ${full && !p.event.joined ? "disabled" : ""}>${p.event.joined ? "✓ Иду" : full ? "Мест нет" : "Иду"}</button><button data-cal="${p.id}" aria-label="В календарь">📅</button><button data-share="${p.id}" aria-label="Поделиться">↗</button></div></div></article>`;
          }).join("")}</div></section>`;
      }).join("");
    });
  }
  $("eventsList").onclick = (e) => {
    let b;
    if ((b = e.target.closest("[data-join]"))) return doJoin(b.dataset.join);
    if ((b = e.target.closest("[data-cal]"))) return addToCalendar(cache.get(b.dataset.cal));
    if ((b = e.target.closest("[data-share]"))) { const q = cache.get(b.dataset.share); return q && sharePost(q); }
    if ((b = e.target.closest("[data-post]"))) return openPost(b.dataset.post);
  };

  let cTimer = null;
  function renderDeals() {
    withWide("dealsList", (list) => {
      const ds = list.filter((p) => p.category === "deal" && p.status !== "closed").sort((a, b) => D(a) - D(b));
      $("dealsList").innerHTML = ds.length ? ds.map((p) => {
        const m = p.media[0];
        return `<div class="deal" data-post="${p.id}"><span class="di" style="${m && m.type === "image" ? `background:url('${esc(m.url)}') center/cover` : "background:rgba(255,176,32,.15)"}">${m && m.type === "image" ? "" : "🏷️"}</span><div style="flex:1;min-width:0"><b style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(p.text)}</b><span>${esc(p.author.name)} · ${fmtDist(D(p))}</span></div><button class="ac" data-coupon="${p.id}">Купон</button></div>`;
      }).join("") : '<div class="empty"><b>Акций рядом пока нет</b>Есть кафе или магазин? Добавьте свою акцию</div>';
    });
  }
  $("dealsList").onclick = (e) => {
    const b = e.target.closest("[data-coupon]");
    if (b) {
      const p = cache.get(b.dataset.coupon); let h = 0; for (const ch of p.id + (user ? user.id : "guest")) h = (h * 31 + ch.charCodeAt(0)) % 9000;
      $("cpName").textContent = p.author.name + " · " + p.text.slice(0, 50); $("cpCode").textContent = "NEAR-" + (1000 + h);
      $("coupon").classList.add("on"); $("sv-deals").scrollTop = 0;
      let t = 899; clearInterval(cTimer); $("ctm").textContent = "14:59";
      cTimer = setInterval(() => { t--; $("ctm").textContent = Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); if (t <= 0) { clearInterval(cTimer); $("coupon").classList.remove("on"); } }, 1000);
      toast("🧪 Демо-купон: заведение пока не подключено к NEAR"); return;
    }
    const c = e.target.closest("[data-post]"); if (c) openPost(c.dataset.post);
  };

  let lfMode = "lost";
  function renderLost() {
    withWide("lfGrid", (list) => {
      const ls = list.filter((p) => p.category === lfMode && p.status !== "closed").sort((a, b) => b.created_at.localeCompare(a.created_at));
      $("lfGrid").innerHTML = ls.length ? ls.map((p) => {
        const c = CATS[p.category], m = p.media[0];
        return `<button class="lf" data-post="${p.id}"><div class="im" style="${m && m.type === "image" ? `background:url('${esc(m.url)}') center/cover` : `background:linear-gradient(135deg,${c.c}88,#1f1f2e)`}">${m && m.type === "image" ? "" : c.e}</div><div class="t"><b style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(p.text)}</b><span>${fmtDist(D(p))} · ${timeAgo(p.created_at)}</span></div></button>`;
      }).join("") : `<div class="empty" style="grid-column:span 2"><b>Пока пусто</b>${lfMode === "lost" ? "Никто ничего не потерял рядом 🙂" : "Находок рядом пока нет"}</div>`;
    });
  }
  qa("#lfSeg [data-lf]").forEach((b) => (b.onclick = () => { qa("#lfSeg button").forEach((x) => x.classList.toggle("on", x === b)); lfMode = b.dataset.lf; renderLost(); }));
  $("lfGrid").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };
  $("lfAdd").onclick = () => { if (requireAuth("Войдите, чтобы публиковать")) openCreate({ type: lfMode }); };
  $("parkBtn").onclick = () => toast("🅿️ Парковки появятся на следующих этапах");

  /* =====================================================
     SEARCH
     ===================================================== */
  let qT = null;
  qa("[data-search]").forEach((b) => (b.onclick = async () => { $("q").value = ""; go("sv-search"); setTimeout(() => $("q").focus(), 150); runSearch(); }));
  async function runSearch() {
    const q = $("q").value.trim().toLowerCase();
    $("qRes").innerHTML = '<div class="spin"></div>';
    try {
      const list = await loadWide();
      const words = q.split(/\s+/).filter(Boolean);
      const r = !q ? [...list].sort((a, b) => D(a) - D(b)).slice(0, 10)
        : list.filter((p) => { const hay = (p.text + " " + CATS[p.category].n + " " + p.author.name).toLowerCase(); return words.every((w) => hay.includes(w)); });
      $("qRes").innerHTML = (q ? "" : '<div class="lbl">Ближайшие публикации</div>') + (r.length ? r.map(rowPost).join("") : '<div class="empty"><b>Ничего не нашли</b>Попробуйте другое слово или увеличьте радиус</div>');
    } catch (e) { $("qRes").innerHTML = `<div class="empty"><b>Ошибка поиска</b>${esc(e.message)}</div>`; }
  }
  $("q").oninput = () => { clearTimeout(qT); qT = setTimeout(runSearch, 250); };
  $("qTags").onclick = (e) => { const b = e.target.closest("button"); if (b) { $("q").value = b.textContent; runSearch(); } };
  $("qRes").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };

  /* =====================================================
     NOTIFICATIONS
     ===================================================== */
  async function refreshBadge() {
    if (!api || !user) { $("bellBadge").classList.add("hidden"); return; }
    try { const n = await api.unreadCount(); $("bellBadge").textContent = n > 9 ? "9+" : n; $("bellBadge").classList.toggle("hidden", !n); } catch (e) {}
  }
  $("bellBtn").onclick = () => { if (!requireAuth("Войдите, чтобы видеть уведомления", { t: "notif" })) return; go("sv-notif"); };
  async function renderNotifs() {
    $("nfList").innerHTML = '<div class="spin"></div>';
    try {
      const list = await api.notifications();
      const unread = list.filter((n) => !n.read).length;
      $("nfSub").textContent = unread ? unread + " новых" : "все прочитано";
      const ic = { like: "♥", likes: "♥", comment: "💬", comments: "💬", join: "🎉", event_members: "🎉", friend_request: "👋", friend_accept: "🤝", post_hidden: "🛡", sos_closed: "✅", appeal: "⚖️", reply: "↩️" };
      // группировка: лайки и участники одной публикации — одной строкой ("Айгерим и еще 2")
      const GROUP = new Set(["like", "likes", "join", "event_members"]), groups = [];
      list.forEach((n) => { const g = GROUP.has(n.type) && n.post_id && groups.find((x) => x.type === n.type && x.post_id === n.post_id); if (g) { g.more.push(n); if (!n.read) g.read = false; } else groups.push({ ...n, more: [] }); });
      $("nfList").innerHTML = groups.length ? groups.map((n) => { const names = [...new Set([n.actor.name, ...n.more.map((x) => x.actor.name)])];
        const who = names.length > 1 ? `${esc(names[0])} и еще ${names.length - 1}` : esc(names[0]);
        return `<button class="res${n.read ? "" : " unread"}" data-post="${n.post_id || ""}" data-actor="${(n.type || "").startsWith("friend") ? (n.actor && n.actor.id) || n.actor_id || "" : ""}"><span class="e">${ic[n.type] || "🔔"}</span><div><b translate="no">${who}</b><span>${esc(n.text || "")} · ${timeAgo(n.created_at)}</span></div></button>`; }).join("")
        : '<div class="empty"><b>Уведомлений пока нет</b>Здесь появятся лайки, комментарии и участники ваших событий</div>';
      if (unread) { await api.markNotificationsRead(); refreshBadge(); }
    } catch (e) { $("nfList").innerHTML = `<div class="empty"><b>Ошибка</b>${esc(e.message)}</div>`; }
  }
  $("nfList").onclick = (e) => { const b = e.target.closest("[data-post]"); if (!b) return; if (b.dataset.actor) { if (b.dataset.actor) openUser(b.dataset.actor); return; } if (b.dataset.post) openPost(b.dataset.post); };
