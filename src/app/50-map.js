  /* =====================================================
     MAP (MapLibre GL + OpenFreeMap: векторная карта, без ключей)
     ===================================================== */
  const ML_VER = "5.24.1", OFM = "https://tiles.openfreemap.org/styles/";
  let mlP = null, map = null, mapReady = false, mapPosts = [], mapCat = "all", mapT = null, pendingFocus = null, meMarker = null, selId = null;
  let loadedArea = null, reqSeq = 0;
  const htmlMarkers = new Map();
  // карта по умолчанию в теме приложения; кнопка 🌓 запоминает выбор отдельно
  const appTheme = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  let mapTheme = appTheme(); try { mapTheme = localStorage.getItem("near_map_theme") || appTheme(); } catch (e) {}
  async function syncMapTheme() {
    let fixed = null; try { fixed = localStorage.getItem("near_map_theme"); } catch (e) {}
    const want = fixed || appTheme(); if (want === mapTheme) return;
    mapTheme = want; $("v-map").classList.toggle("light-map", mapTheme === "light");
    if (mapReady) { try { map.setStyle(await mapStyle(mapTheme), { diff: false }); } catch (e) {} }
  }
  function loadML() {
    if (!mlP) mlP = (async () => {
      if (!document.getElementById("mlcss")) { const l = document.createElement("link"); l.id = "mlcss"; l.rel = "stylesheet"; l.href = `https://unpkg.com/maplibre-gl@${ML_VER}/dist/maplibre-gl.css`; document.head.appendChild(l); }
      if (!window.maplibregl) await loadScript(`https://unpkg.com/maplibre-gl@${ML_VER}/dist/maplibre-gl.js`, 20000);
      return window.maplibregl;
    })().catch((e) => { mlP = null; throw e; });
    return mlP;
  }
  // подписи на русском, где есть перевод в OpenStreetMap
  function ruLabels(st) {
    st.layers.forEach((l) => {
      const lay = l.layout || {}; const tf = lay["text-field"];
      if (tf && JSON.stringify(tf).includes("name")) lay["text-field"] = ["coalesce", ["get", "name:ru"], ["get", "name"]];
    });
    return st;
  }
  // фирменная ночная палитра NEAR
  function tuneDark(st) {
    const C = { bg: "#12131c", res: "#161723", water: "#13233d", waterLine: "#1b3152", park: "#132a20", bld: "#1d1f2e", bldLine: "#272a3c",
      minor: "#272b3f", path: "#22263a", major: "#3b405e", motor: "#6a4fa0", casing: "#0c0d14", rail: "#2c2f45", label: "#9aa0bd", place: "#e2e4f3", wlabel: "#5f86bd" };
    st.layers.forEach((l) => {
      const id = l.id, p = (l.paint = l.paint || {});
      if (l.type === "background") p["background-color"] = C.bg;
      else if (id === "water") p["fill-color"] = C.water;
      else if (id === "waterway") p["line-color"] = C.waterLine;
      else if (id === "landuse_residential") { p["fill-color"] = C.res; p["fill-opacity"] = 1; }
      else if (id === "landcover_wood" || id === "landuse_park") { p["fill-color"] = C.park; p["fill-opacity"] = 0.95; }
      else if (id === "building") { p["fill-color"] = C.bld; p["fill-outline-color"] = C.bldLine; }
      else if (id.startsWith("aeroway")) { if (l.type === "fill") p["fill-color"] = C.bld; else p["line-color"] = C.minor; }
      else if (id.includes("casing")) p["line-color"] = C.casing;
      else if (id.startsWith("highway_motorway")) p["line-color"] = C.motor;
      else if (id.startsWith("highway_major")) p["line-color"] = C.major;
      else if (id === "highway_minor" || id === "road_pier") p["line-color"] = C.minor;
      else if (id === "highway_path") p["line-color"] = C.path;
      else if (id.startsWith("railway")) p["line-color"] = C.rail;
      else if (id.startsWith("boundary")) p["line-color"] = "#3a3d55";
      else if (l.type === "symbol") {
        p["text-color"] = id.startsWith("place") ? C.place : id === "water_name" ? C.wlabel : C.label;
        p["text-halo-color"] = C.bg; p["text-halo-width"] = 1.3;
      }
    });
    return st;
  }
  const styleCache = {};
  function mapStyle(theme) {
    const name = theme === "light" ? "liberty" : "dark";
    if (!styleCache[name]) styleCache[name] = fetch(OFM + name).then((r) => { if (!r.ok) throw new Error("Стиль карты недоступен"); return r.json(); })
      .then((st) => (name === "dark" ? tuneDark(ruLabels(st)) : ruLabels(st))).catch((e) => { delete styleCache[name]; throw e; });
    return styleCache[name].then((s) => JSON.parse(JSON.stringify(s)));
  }
  function circlePoly(lat, lng, r, n = 72) {
    const c = [], dLat = r / 111320, dLng = r / (111320 * Math.cos((lat * Math.PI) / 180));
    for (let i = 0; i <= n; i++) { const a = (i / n) * 2 * Math.PI; c.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]); }
    return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [c] } };
  }
  const radBounds = (r = R) => { const b = N.boundsAround(pos.lat, pos.lng, r); return [[b.w, b.s], [b.e, b.n]]; };
  const MAP_PAD = () => ({ top: 150, bottom: 130, left: 24, right: 24 });
  function fitRadius(anim = true) { if (mapReady) map.fitBounds(radBounds(), { padding: MAP_PAD(), duration: anim ? 600 : 0 }); }

  $("mapCats").innerHTML = chipsHtml("all");
  $("mapCats").onclick = (e) => { const b = e.target.closest("[data-c]"); if (!b) return; mapCat = b.dataset.c; $("mapCats").innerHTML = chipsHtml(mapCat); loadMapPosts(true); };
  $("mapRad").onclick = (e) => { const b = e.target.closest("[data-r]"); if (!b) return; setRadius(+b.dataset.r); feedDirty = true; fitRadius(); };

  function addOverlays() {
    const empty = { type: "FeatureCollection", features: [] };
    if (!map.getSource("radius")) {
      map.addSource("radius", { type: "geojson", data: empty });
      map.addLayer({ id: "radius-fill", type: "fill", source: "radius", paint: { "fill-color": "#ff2e88", "fill-opacity": 0.05 } });
      map.addLayer({ id: "radius-line", type: "line", source: "radius", paint: { "line-color": "#ff2e88", "line-width": 1.6, "line-opacity": 0.75, "line-dasharray": [3, 2] } });
    }
    if (!map.getSource("acc")) {
      map.addSource("acc", { type: "geojson", data: empty });
      map.addLayer({ id: "acc-fill", type: "fill", source: "acc", paint: { "fill-color": "#3da5ff", "fill-opacity": 0.12 } });
      map.addLayer({ id: "acc-line", type: "line", source: "acc", paint: { "line-color": "#3da5ff", "line-width": 1, "line-opacity": 0.5 } });
    }
    if (!map.getSource("posts")) map.addSource("posts", { type: "geojson", data: empty, cluster: true, clusterRadius: 46, clusterMaxZoom: 16 });
    // невидимый слой: без него MapLibre не строит кластеры для HTML-меток
    if (!map.getLayer("posts-hit")) map.addLayer({ id: "posts-hit", type: "circle", source: "posts", paint: { "circle-radius": 1, "circle-opacity": 0 } });
    drawMe(); setPostsData();
  }
  async function initMap() {
    if (mapReady) { setTimeout(() => { map.resize(); if (pendingFocus) focusPost(pendingFocus); }, 60); return; }
    $("mapMsg").classList.remove("hidden"); $("mapMsg").innerHTML = '<div><div class="spin"></div>Загружаем карту...</div>';
    let style;
    try { await loadML(); style = await mapStyle(mapTheme); }
    catch (e) { $("mapMsg").innerHTML = `<div>🗺️<br>Карта не загрузилась. Проверьте интернет.<br><button class="btn btn-main mt12" id="mapRetry">Повторить</button></div>`; $("mapRetry").onclick = initMap; return; }
    map = new maplibregl.Map({ container: "map", style, bounds: radBounds(), fitBoundsOptions: { padding: MAP_PAD() }, minZoom: 9, maxZoom: 18.5,
      attributionControl: { compact: true }, dragRotate: false, touchPitch: false, pitchWithRotate: false, fadeDuration: 150 });
    map.touchZoomRotate.disableRotation();
    map.on("style.load", addOverlays);
    map.on("load", () => { $("mapMsg").classList.add("hidden"); });
    // MAP-01: при перемещении карта не грузит данные сама — появляется кнопка "Искать здесь"
    map.on("moveend", () => { clearTimeout(mapT); mapT = setTimeout(() => { if (mapMode === "screen" && needsArea()) $("mapHere").classList.remove("hidden"); updateCount(); }, 250); });
    map.on("render", () => { if (map.getSource("posts") && map.isSourceLoaded("posts")) syncMarkers(); });
    map.on("click", (e) => { if (!e.originalEvent.target.closest(".ml-pin,.ml-cl")) hideMapCard(); });
    map.on("error", (e) => console.warn("map", e && e.error));
    const me = document.createElement("div"); me.className = "me-dot";
    meMarker = new maplibregl.Marker({ element: me }).setLngLat([pos.lng, pos.lat]).addTo(map);
    mapReady = true; geoBanner();
    await new Promise((r) => (map.loaded() ? r() : map.once("load", r)));
    await loadMapPosts(true);
    if (pendingFocus) focusPost(pendingFocus);
  }
  $("mapTheme").onclick = async () => {
    mapTheme = mapTheme === "dark" ? "light" : "dark"; try { localStorage.setItem("near_map_theme", mapTheme); } catch (e) {}
    $("v-map").classList.toggle("light-map", mapTheme === "light");
    if (!mapReady) return;
    try { map.setStyle(await mapStyle(mapTheme), { diff: false }); } catch (e) { toast("Не удалось сменить стиль карты"); }
  };
  $("v-map").classList.toggle("light-map", mapTheme === "light");

  function drawMe() {
    geoBanner();
    if (!mapReady || !map.getSource("radius")) return;
    map.getSource("radius").setData(circlePoly(pos.lat, pos.lng, R));
    map.getSource("acc").setData(pos.src === "gps" && pos.acc ? circlePoly(pos.lat, pos.lng, Math.max(pos.acc, 15)) : { type: "FeatureCollection", features: [] });
    meMarker.setLngLat([pos.lng, pos.lat]);
    meMarker.getElement().className = "me-dot" + (pos.src === "gps" ? "" : " approx");
  }
  // индикатор: откуда взято местоположение
  function geoText() {
    if (pos.src === "gps") return pos.acc > 500 ? { k: "warn", t: `📡 GPS неточный: ±${fmtDist(pos.acc)}` } : { k: "ok", t: `📍 GPS · точность ±${fmtDist(Math.max(pos.acc || 0, 5))}` };
    if (pos.src === "district") return { k: "warn", t: `📍 ${pos.name} район · примерно, по центру района` };
    if (pos.src === "place") return { k: "warn", t: `⭐ ${pos.name} · избранное место` };
    return { k: "bad", t: "⚠️ Местоположение не определено — показан центр Алматы" };
  }
  function geoBanner() {
    const g = geoText(), el = $("mapGeo");
    if (el) { el.className = "map-geo " + g.k; el.innerHTML = `<span>${g.t}</span>${pos.src === "gps" ? "" : '<button type="button" id="geoFix">Определить</button>'}`; }
    const pill = $("locBtn"); if (pill) { pill.dataset.src = pos.src; pill.title = g.t.replace(/^\S+\s/, ""); }
    // постоянная подпись: район/GPS, радиус и точность; без GPS — кнопка "Рядом со мной" (разрешение спрашиваем только по нажатию)
    const fl = $("feedLoc");
    if (fl) {
      const where = pos.src === "gps" ? "📍 Рядом с вами" : pos.src === "district" ? `📍 ${pos.name} район` : pos.src === "place" ? `⭐ ${esc(pos.name)}` : "📍 Центр Алматы";
      const acc = pos.src === "gps" ? (pos.acc ? ` · точность ±${fmtDist(Math.max(pos.acc, 5))}` : "") : " · примерно";
      fl.className = "feed-loc " + g.k;
      fl.innerHTML = `<button type="button" class="fl-t" id="feedLocPick" aria-label="Выбрать место">${where} · ${fmtDist(R)}${acc}</button>${pos.src === "gps" ? "" : '<button type="button" class="fl-b" id="feedGeoFix">Рядом со мной</button>'}`;
    }
  }
  document.addEventListener("click", (e) => { if (e.target.closest("#feedLocPick")) $("locBtn").click(); });
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("#geoFix,#feedGeoFix")) return;
    if (await useMyLocation()) { wide = null; feedDirty = true; drawMe(); fitRadius(); loadFeed(); toast("📍 " + geoText().t.replace(/^\S+\s/, "")); }
  });

  function setPostsData() {
    if (!mapReady || !map.getSource("posts")) return;
    map.getSource("posts").setData({ type: "FeatureCollection", features: mapPosts.map((p) => {
      const c = CATS[p.category] || CATS.talk;
      return { type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { id: p.id, color: c.c, emoji: c.e, sos: p.is_sos ? 1 : 0, fresh: Date.now() - new Date(p.created_at) < 3600e3 ? 1 : 0, ended: postEnded(p) ? 1 : 0 } };
    }) });
  }
  function syncMarkers() {
    const feats = map.querySourceFeatures("posts"), seen = new Set();
    for (const f of feats) {
      const pr = f.properties, cl = !!pr.cluster, key = cl ? "c" + pr.cluster_id : "p" + pr.id;
      if (seen.has(key)) continue; seen.add(key);
      let mk = htmlMarkers.get(key);
      if (!mk) {
        const el = document.createElement("button"); el.type = "button";
        if (cl) {
          el.className = "ml-cl"; el.style.setProperty("--s", Math.round(36 + Math.min(24, Math.log2(pr.point_count) * 5)) + "px"); el.textContent = pr.point_count_abbreviated;
          el.onclick = (ev) => { ev.stopPropagation(); map.getSource("posts").getClusterExpansionZoom(pr.cluster_id).then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z + 0.3, 18) })).catch(() => {}); };
        } else {
          // завершенное событие — другая форма (квадрат) и подпись, а не только цвет
          el.className = "ml-pin" + (pr.ended ? " ended" : pr.sos ? " sos" : pr.fresh ? " fresh" : ""); el.style.setProperty("--c", pr.color);
          el.innerHTML = `<span>${pr.emoji}</span>${pr.ended ? "<em>завершено</em>" : ""}`; el.setAttribute("aria-label", pr.ended ? "Завершенное событие" : pr.sos ? "SOS" : "Публикация");
          el.onclick = (ev) => { ev.stopPropagation(); const p = cache.get(pr.id); if (p) selectPost(p); };
        }
        mk = new maplibregl.Marker({ element: el, anchor: cl ? "center" : "bottom" }).setLngLat(f.geometry.coordinates).addTo(map);
        htmlMarkers.set(key, mk);
      }
      if (!cl) mk.getElement().classList.toggle("sel", pr.id === selId);
    }
    for (const [k, mk] of htmlMarkers) if (!seen.has(k)) { mk.remove(); htmlMarkers.delete(k); }
  }
  // запрос только при выходе за загруженную область (с запасом 35%) или через 90 сек
  // MAP-01: кто и за какой период (идея "Все / Друзья / Горячее" и "Сегодня / Неделя"); сохраняется для аккаунта
  const MF = { who: "all", period: null };
  const postEnded = (p) => !!(p.event && new Date(p.event.starts_at).getTime() + 3 * 3600e3 < Date.now());
  const isHot = (p) => p.is_sos || (p.category === "incident" && Date.now() - new Date(p.created_at) < 3 * 3600e3) || (p.likes || 0) + (p.comments || 0) * 2 >= 4;
  function loadMapFilters() { const m = prefs.map || {}; MF.who = ["all", "friends", "hot"].includes(m.who) ? m.who : "all"; MF.period = ["today", "week"].includes(m.period) ? m.period : null; renderMapFlt(); }
  function renderMapFlt() {
    $("mapFlt").innerHTML = [["all", "Все"], ["friends", "Друзья"], ["hot", "🔥 Горячее"]].map(([k, t]) => `<button data-who="${k}" class="${MF.who === k ? "on" : ""}">${t}</button>`).join("")
      + '<span class="sep"></span>' + [[null, "Все время"], ["today", "Сегодня"], ["week", "Неделя"]].map(([k, t]) => `<button data-per="${k || ""}" class="${MF.period === k ? "on" : ""}">${t}</button>`).join("");
  }
  $("mapFlt").onclick = (e) => {
    const w = e.target.closest("[data-who]"), pe = e.target.closest("[data-per]");
    if (w) { if (w.dataset.who === "friends" && !requireAuth("Войдите, чтобы видеть публикации друзей")) return; MF.who = w.dataset.who; }
    else if (pe) MF.period = pe.dataset.per || null; else return;
    prefs.map = { who: MF.who, period: MF.period }; savePrefs(); renderMapFlt(); Obs.track("filter_changed", { filter: "map_" + MF.who, period: MF.period || "all" }); loadMapPosts(true);
  };
  // нужна ли новая выборка для текущей области экрана
  function needsArea() {
    const A = loadedArea; if (!A || A.mode !== "screen") return true;
    const bb = map.getBounds();
    return !(bb.getSouth() >= A.b.s && bb.getNorth() <= A.b.n && bb.getWest() >= A.b.w && bb.getEast() <= A.b.e);
  }
  $("mapHere").onclick = () => { $("mapHere").classList.add("hidden"); loadMapPosts(true); };
  let mapCtrl = null;
  async function loadMapPosts(force) {
    if (!mapReady) return;
    $("mapHere").classList.add("hidden");
    const bb = map.getBounds(), v = { s: bb.getSouth(), n: bb.getNorth(), w: bb.getWest(), e: bb.getEast() };
    const A = loadedArea;
    if (mapMode === "radius") {
      if (!force && A && A.mode === "radius" && A.cat === mapCat && A.r === R && A.lat === pos.lat && Date.now() - A.at < 90000) return updateCount();
    } else if (!force && A && A.mode === "screen" && A.cat === mapCat && Date.now() - A.at < 90000 && v.s >= A.b.s && v.n <= A.b.n && v.w >= A.b.w && v.e <= A.b.e) return updateCount();
    const dy = (v.n - v.s) * 0.35, dx = (v.e - v.w) * 0.35, b = { s: v.s - dy, n: v.n + dy, w: v.w - dx, e: v.e + dx };
    // устаревший ответ (пользователь уже сдвинул карту) отбрасывается по номеру запроса
    const seq = ++reqSeq; $("mapCount").innerHTML = '<i class="mini-spin"></i> Загружаем...';
    if (mapCtrl) try { mapCtrl.abort(); } catch (e) {}
    mapCtrl = "AbortController" in window ? new AbortController() : null;
    try {
      const ext = { period: MF.period, friends: MF.who === "friends" && !!user, signal: mapCtrl && mapCtrl.signal };
      const args = mapMode === "radius" ? { lat: pos.lat, lng: pos.lng, radius: R, category: catFilter(mapCat), limit: 400, ...ext } : { bounds: b, category: catFilter(mapCat), limit: 400, ...ext };
      const list = remember(await api.listPosts(args));
      if (seq !== reqSeq) return;
      loadedArea = { b, cat: mapCat, at: Date.now(), mode: mapMode, r: R, lat: pos.lat };
      mapPosts = list.filter((p) => p.status !== "closed" && (MF.who !== "hot" || isHot(p)));
      setPostsData(); updateCount();
      if (!$("mapList").classList.contains("hidden")) renderMapList();
    } catch (e) { if (seq === reqSeq && e.name !== "AbortError" && !/abort/i.test(e.message)) $("mapCount").textContent = "Не удалось загрузить: " + e.message; }
  }
  function inView() { if (mapMode === "radius") return mapPosts.slice(); const b = map.getBounds(); return mapPosts.filter((p) => b.contains([p.lng, p.lat])); }
  $("mapMode").onclick = (e) => {
    const b = e.target.closest("[data-mm]"); if (!b) return;
    mapMode = b.dataset.mm; prefs.map_mode = mapMode; savePrefs();
    qa("#mapMode [data-mm]").forEach((x) => x.classList.toggle("on", x === b));
    if (mapReady) { if (mapMode === "radius") fitRadius(); loadMapPosts(true); }
  };
  function updateCount() {
    const n = inView().length, where = mapMode === "radius" ? `в радиусе ${fmtDist(R)}` : "на экране";
    $("mapCount").textContent = n ? `${n} ${plural(n, "публикация", "публикации", "публикаций")} ${where}` : `${where[0].toUpperCase() + where.slice(1)} пока пусто — опубликуйте первым`;
  }

  function selectPost(p) {
    selId = p.id; syncMarkers();
    const c = CATS[p.category] || CATS.talk, m = p.media && p.media[0], img = m && m.type === "image" && !shieldFor(m, p.user_id);
    $("mapCard").innerHTML = `<div class="mc-grab"></div>
      <div class="mc-top"><span class="mc-cat" style="--c:${c.c}">${c.e} ${c.n}</span><span class="mc-meta">${fmtDist(D(p))} · ${timeAgo(p.created_at)}</span><button class="x" id="mcX" aria-label="Закрыть">✕</button></div>
      <div class="mc-body"><div class="th" style="${img ? `background-image:url('${esc(m.url)}')` : `background:${c.c}2b`}">${img ? "" : c.e}</div>
        <div class="tx"><b translate="no">${esc(p.text)}</b><span><i translate="no">${esc(p.author.name)}</i>${p.media.length > 1 ? " · 📷 " + p.media.length : ""}</span></div></div>
      <div class="mc-acts"><button class="btn btn-main" data-post="${p.id}">Открыть</button><a class="btn btn-ghost" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener">Маршрут</a></div>`;
    $("mapCard").classList.remove("hidden"); $("v-map").classList.add("carded");
    $("mcX").onclick = (e) => { e.stopPropagation(); hideMapCard(); };
  }
  function hideMapCard() { $("mapCard").classList.add("hidden"); $("v-map").classList.remove("carded"); if (selId) { selId = null; if (mapReady) syncMarkers(); } }
  $("mapCard").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };
  // свайп вниз закрывает карточку
  (() => { let y0 = null; const el = $("mapCard");
    el.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    el.addEventListener("touchmove", (e) => { if (y0 == null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) el.style.transform = `translateY(${dy}px)`; }, { passive: true });
    el.addEventListener("touchend", (e) => { const dy = y0 == null ? 0 : e.changedTouches[0].clientY - y0; el.style.transform = ""; y0 = null; if (dy > 70) hideMapCard(); });
  })();
  function focusPost(p) {
    pendingFocus = null; $("mapList").classList.add("hidden"); $("mapListBtn").textContent = "☰";
    map.flyTo({ center: [p.lng, p.lat], zoom: 16.3, offset: [0, -60], duration: 700 });
    if (!mapPosts.some((x) => x.id === p.id) && p.status !== "closed") { mapPosts.push(p); setPostsData(); }
    selectPost(p);
  }
  $("mapLocate").onclick = async () => { if (await useMyLocation()) { feedDirty = true; wide = null; drawMe(); fitRadius(); } else fitRadius(); };
  $("mapListBtn").onclick = () => { const l = $("mapList"); l.classList.toggle("hidden"); $("mapListBtn").textContent = l.classList.contains("hidden") ? "☰" : "🗺"; if (!l.classList.contains("hidden")) renderMapList(); };
  function rowPost(p) {
    const c = CATS[p.category] || CATS.talk, m = p.media[0];
    return `<button class="row-post" data-post="${p.id}"><span class="th" style="${m && m.type === "image" ? `background-image:url('${esc(m.url)}')` : `background:${c.c}33`}">${m && m.type === "image" ? "" : c.e}</span><div><b>${esc(p.text)}</b><span>${c.e} ${c.n} · ${fmtDist(D(p))} · ${timeAgo(p.created_at)}${p.status === "closed" ? " · закрыто" : ""}</span></div></button>`;
  }
  function renderMapList() {
    const list = (mapReady ? inView() : mapPosts).sort((a, b) => D(a) - D(b));
    $("mapList").innerHTML = '<div class="lbl">На экране, по расстоянию</div>' + (list.length ? list.map(rowPost).join("") : '<div class="empty"><b>Пусто</b>В видимой области нет публикаций. Отдалите карту или смените категорию.</div>');
  }
  $("mapList").onclick = (e) => { const b = e.target.closest("[data-post]"); if (b) openPost(b.dataset.post); };

  /* picker */
  let pick = null;
  async function openPicker(center) {
    go("sv-pick");
    let style;
    try { await loadML(); style = await mapStyle(mapTheme); } catch (e) { toast("Карта не загрузилась. Проверьте интернет."); back(); return; }
    if (!pick) {
      pick = new maplibregl.Map({ container: "pickMap", style, center: [center.lng, center.lat], zoom: 16, minZoom: 9, dragRotate: false, touchPitch: false, attributionControl: { compact: true } });
      pick.touchZoomRotate.disableRotation();
      pick.on("move", () => { const c = pick.getCenter(); $("pickHint").textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`; });
    } else pick.jumpTo({ center: [center.lng, center.lat], zoom: 16 });
    setTimeout(() => pick.resize(), 80);
  }
  $("pickBack").onclick = back;
  $("pickOk").onclick = () => { if (pick) { const c = pick.getCenter(); cr.loc = { lat: c.lat, lng: c.lng, how: "map" }; renderLoc(); } back(); };
