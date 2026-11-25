  /* =====================================================
     LOCATION
     ===================================================== */
  function getGeo(highAcc = false) {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error("Геолокация не поддерживается"));
      navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => rej(new Error(e.code === 1 ? "Доступ к геопозиции запрещен. Разрешите его в настройках браузера." : "Не удалось определить местоположение")),
        { enableHighAccuracy: highAcc, timeout: 10000, maximumAge: 120000 }
      );
    });
  }
  async function useMyLocation(silent) {
    try {
      const g = await getGeo();
      // если пользователь далеко от города — показываем Алматы (приложение пока для Алматы)
      if (N.dist(g, CITY) > 60000) { if (!silent) toast("Вы далеко от Алматы, показываем центр города"); return false; }
      pos = { lat: g.lat, lng: g.lng, real: true, src: "gps", acc: g.acc || null }; $("locName").textContent = "Рядом со мной";
      if (typeof Push !== "undefined") Push.sync();
      if (typeof geoBanner === "function") geoBanner();
      return true;
    } catch (e) { if (!silent) toast(e.message); return false; }
  }
  // где смотреть: GPS, избранные места (приватные) или район
  $("locBtn").onclick = async () => {
    let places = []; try { places = user ? await api.placesList() : []; } catch (e) {}
    const cur = $("locName").textContent;
    openSheet("Где смотреть?", `<button class="opt-row${pos.src === "gps" ? " on" : ""}" data-loc="me">📍 Мое местоположение<span>${pos.src === "gps" ? "✓" : ""}</span></button>`
      + (places.length ? '<div class="lbl mt8">Избранные места</div>' + places.map((p) => `<button class="opt-row${pos.src === "place" && pos.pid === p.id ? " on" : ""}" data-place="${p.id}"><span class="pl-n">⭐ <span translate="no">${esc(p.name)}</span> · ${fmtDist(p.radius)}${p.notify ? " · 🔔" : ""}</span><span>${pos.src === "place" && pos.pid === p.id ? "✓" : ""}</span></button>`).join("") : "")
      + (user ? `<button class="opt-row" data-addplace>＋ Сохранить ${pos.src === "city" ? "центр" : "это место"} в избранное<span>›</span></button>` : "")
      + '<div class="lbl mt8">Районы</div>'
      + DISTRICTS.map((d) => `<button class="opt-row${cur === d[0] ? " on" : ""}" data-loc="${d[0]}">${d[0]} район<span>${cur === d[0] ? "✓" : ""}</span></button>`).join(""));
    const apply = (name) => { $("locName").textContent = name; wide = null; feedDirty = true; loadFeed(); drawMe(); fitRadius(); geoBanner(); toast("📍 " + name); };
    qa("[data-loc]", $("bsList")).forEach((b) => (b.onclick = async () => {
      closeSheet();
      if (b.dataset.loc === "me") { Obs.track("location_permission", { state: "asked" }); const ok = await useMyLocation(); Obs.track("location_permission", { state: ok ? "granted" : "denied" }); if (!ok) return; apply("Рядом со мной"); return; }
      const d = DISTRICTS.find((x) => x[0] === b.dataset.loc); pos = { lat: d[1], lng: d[2], real: false, src: "district", name: d[0], acc: null }; apply(d[0]);
    }));
    qa("[data-place]", $("bsList")).forEach((b) => (b.onclick = () => {
      closeSheet(); const p = places.find((x) => x.id === b.dataset.place); if (!p) return;
      pos = { lat: p.lat, lng: p.lng, real: false, src: "place", name: p.name, pid: p.id, acc: null };
      if ([500, 1000, 3000, 5000, 10000].includes(p.radius)) setRadius(p.radius);
      apply(p.name);
    }));
    const ap = $("bsList").querySelector("[data-addplace]"); if (ap) ap.onclick = () => placeSheet(null);
  };
  // избранное место: название, радиус, уведомления (по умолчанию выключены — только по согласию)
  function placeSheet(pl) {
    const p = pl || { name: "", lat: pos.lat, lng: pos.lng, radius: 1000, notify: false };
    openSheet(pl ? "Избранное место" : "Сохранить место", `<div class="fld"><label for="plName">Название</label><input id="plName" maxlength="40" value="${esc(p.name)}" placeholder="Например: Дом, Работа, Школа"></div>
      <div class="lbl">Радиус</div><div class="rad-ch wide" id="plRad">${[500, 1000, 3000, 5000].map((r) => `<button data-r="${r}" class="${p.radius === r ? "on" : ""}">${fmtDist(r)}</button>`).join("")}</div>
      <label class="rules-check mt12"><input type="checkbox" id="plNotify" ${p.notify ? "checked" : ""}> <span>Присылать push о происшествиях и SOS рядом с этим местом</span></label>
      <div class="s-note">Место видите только вы. Точка хранится с точностью около 100 м.</div>
      <div class="err" id="plErr"></div>
      <div class="sheet-btns">${pl ? '<button class="btn btn-ghost" id="plDel">Удалить</button>' : '<button class="btn btn-ghost" id="plNo">Отмена</button>'}<button class="btn btn-main" id="plOk">Сохранить</button></div>`);
    let rad = p.radius;
    qa("#plRad [data-r]").forEach((b) => (b.onclick = () => { rad = +b.dataset.r; qa("#plRad button").forEach((x) => x.classList.toggle("on", x === b)); }));
    if ($("plNo")) $("plNo").onclick = closeSheet;
    if ($("plDel")) $("plDel").onclick = async () => { try { await api.placeDelete(pl.id); closeSheet(); toast("Место удалено"); if (cur() === "sv-settings") renderSettings(); } catch (e) { toast(e.message); } };
    $("plOk").onclick = async () => {
      try {
        await busy($("plOk"), () => api.placeSave({ id: pl && pl.id, name: $("plName").value, lat: p.lat, lng: p.lng, radius: rad, notify: $("plNotify").checked }));
        closeSheet(); toast("⭐ Место сохранено"); if (cur() === "sv-settings") renderSettings();
      } catch (e) { $("plErr").textContent = e.message; $("plErr").classList.add("on"); }
    };
  }

  /* ---------- v14.2 / 11: адрес точки (обратное геокодирование) ---------- */
  // Nominatim (OpenStreetMap): не чаще 1 запроса в секунду, ответы кэшируются (~30 м), без координат в тексте для людей
  const nearestDistrict = (lat, lng) => DISTRICTS.reduce((b, d) => { const k = N.dist({ lat, lng }, { lat: d[1], lng: d[2] }); return k < b.k ? { k, n: d[0] } : b; }, { k: 1e9, n: "" }).n;
  const geoCache = new Map(); let geoLast = 0, geoCtl = null;
  // ТЗ 05: после moveend, с паузой 350–500 мс (в выборе точки), старый запрос отменяется; не найдено — "Точка на карте · адрес не определен"
  async function geoLabel(lat, lng) {
    const key = lat.toFixed(4) + "," + lng.toFixed(4), district = nearestDistrict(lat, lng);
    if (geoCache.has(key)) return geoCache.get(key);
    const fallback = { addr: "Точка на карте", district, unknown: true };
    if (api.mode === "local" || CFG.GEOCODE === false || !navigator.onLine) return fallback;
    if (geoCtl) geoCtl.abort();
    const ctl = (geoCtl = new AbortController());
    const wait = geoLast + 1100 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (ctl.signal.aborted) return fallback;
    geoLast = Date.now();
    try {
      const tm = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=ru&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`, { signal: ctl.signal, referrerPolicy: "strict-origin" });
      clearTimeout(tm); if (!r.ok) return fallback;
      const j = await r.json(), a = j.address || {};
      const street = a.road || a.pedestrian || a.footway || a.neighbourhood || a.quarter || "";
      const name = j.name && j.name !== street ? j.name : "";
      const addr = [name, street && (street + (a.house_number ? ", " + a.house_number : ""))].filter(Boolean).join(" · ");
      const out = addr ? { addr, district: (a.city_district || "").replace(/ район$/i, "") || district } : fallback;
      if (geoCache.size > 300) geoCache.clear(); geoCache.set(key, out); return out;
    } catch (e) { return fallback; }
  }
  async function geoSearch(q) {
    if (api.mode === "local" || CFG.GEOCODE === false || !q || q.length < 3) return [];
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=ru&bounded=1&viewbox=76.70,43.40,77.15,43.10&q=${encodeURIComponent(q)}`, { referrerPolicy: "strict-origin" });
    if (!r.ok) return [];
    return (await r.json()).map((x) => ({ name: String(x.display_name || "").split(",").slice(0, 3).join(","), lat: +x.lat, lng: +x.lon }));
  }
