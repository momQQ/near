  /* =====================================================
     РЕДАКТОР ВИДЕО: обрезка, обложка, поворот, пропорции, без звука, возврат оригинала.
     Оригинал не меняется: параметры уходят на сервер, где их применяет FFmpeg worker.
     ===================================================== */
  const ASPECTS = [["orig", "Оригинал"], ["9:16", "9:16"], ["1:1", "1:1"], ["4:5", "4:5"]];
  const editLen = (f) => { const d = (f._meta && f._meta.duration) || 0, e = f._edit || {}; return Math.max(0, (e.end || d) - (e.start || 0)); };
  const edKey = (f) => "near_vedit_" + [f.name, f.size, f.lastModified].join(":");
  function openEditor(f, onDone) {
    const dur = (f._meta && f._meta.duration) || 0;
    let saved = null; try { saved = JSON.parse(localStorage.getItem(edKey(f)) || "null"); } catch (e) {}
    const st = { start: 0, end: Math.min(dur, 30), cover: 0, rotate: 0, aspect: "orig", mute: false, ...(f._edit || saved || {}) };
    let mode = "trim";
    const o = document.createElement("div"); o.className = "ved"; o.id = "ved"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "Редактирование видео");
    o.innerHTML = `<div class="ved-top"><button class="ved-x" aria-label="Закрыть без сохранения">✕</button><b>Редактирование</b><button class="ved-done lnk">Готово</button></div>
      <div class="ved-stage"><div class="ved-frame"><video src="${f._url}" playsinline muted preload="auto"></video></div><button class="ved-play" aria-label="Воспроизвести">▶</button></div>
      <div class="ved-time"><span class="ved-pt">0:00</span> / <span class="ved-len"></span></div>
      <div class="ved-tl" aria-label="Таймлайн: перетащите края, чтобы обрезать"><div class="ved-thumbs"></div><div class="ved-sel"><b class="h l" role="slider" aria-label="Начало" tabindex="0"></b><b class="h r" role="slider" aria-label="Конец" tabindex="0"></b></div><i class="ved-ph"></i><i class="ved-cv" title="Обложка"></i>
        <div class="ved-scale"><span>0:00</span><span>${fmtDur(dur)}</span></div></div>
      <div class="ved-tools"><button data-m="trim" class="on">✂<span>Обрезать</span></button><button data-m="cover">🖼<span>Обложка</span></button><button data-m="sound">🔊<span>Звук</span></button><button data-m="format">⬚<span>Формат</span></button><button data-m="rotate">⟳<span>Поворот</span></button></div>
      <div class="ved-hint"></div>
      <div class="ved-btns"><button class="btn btn-ghost" id="vedReset">Вернуть оригинал</button><button class="btn btn-main" id="vedSave">Сохранить видео</button></div>`;
    document.body.appendChild(o); requestAnimationFrame(() => o.classList.add("on"));
    const v = o.querySelector("video"), tl = o.querySelector(".ved-tl"), sel = o.querySelector(".ved-sel"), ph = o.querySelector(".ved-ph"), cv = o.querySelector(".ved-cv"), hint = o.querySelector(".ved-hint");
    const pct = (t) => (dur ? (t / dur) * 100 : 0);
    const draw = () => {
      sel.style.left = pct(st.start) + "%"; sel.style.width = pct(st.end - st.start) + "%"; cv.style.left = pct(st.cover) + "%";
      const len = st.end - st.start; o.querySelector(".ved-len").textContent = fmtDur(len);
      o.querySelector(".ved-len").classList.toggle("bad", len > 30.05);
      const fr = o.querySelector(".ved-frame"); fr.dataset.aspect = st.aspect; fr.style.setProperty("--rot", st.rotate + "deg");
      v.muted = true; o.querySelector('[data-m="sound"] span').textContent = st.mute ? "Без звука" : "Звук"; o.querySelector('[data-m="sound"]').classList.toggle("off", st.mute);
      o.querySelector('[data-m="format"] span').textContent = (ASPECTS.find((a) => a[0] === st.aspect) || ASPECTS[0])[1];
      hint.textContent = mode === "cover" ? "Передвиньте кадр на таймлайне — он станет обложкой" : len > 30.05 ? "Итоговое видео — не длиннее 30 секунд" : "Перетащите края, чтобы выбрать фрагмент";
    };
    // миниатюры таймлайна (без загрузки на сервер)
    (async () => {
      const th = o.querySelector(".ved-thumbs"), n = 8, tv = document.createElement("video"); tv.src = f._url; tv.muted = true; tv.playsInline = true; tv.preload = "auto";
      await new Promise((r) => { tv.onloadeddata = r; tv.onerror = r; setTimeout(r, 4000); });
      for (let i = 0; i < n && o.isConnected; i++) {
        await new Promise((r) => { tv.onseeked = r; tv.currentTime = (dur * (i + 0.5)) / n; setTimeout(r, 1500); });
        try { const c = document.createElement("canvas"); c.width = 80; c.height = 80; const k = Math.max(80 / tv.videoWidth, 80 / tv.videoHeight); c.getContext("2d").drawImage(tv, (80 - tv.videoWidth * k) / 2, (80 - tv.videoHeight * k) / 2, tv.videoWidth * k, tv.videoHeight * k); th.insertAdjacentHTML("beforeend", `<img src="${c.toDataURL("image/jpeg", 0.6)}" alt="">`); } catch (e) { th.insertAdjacentHTML("beforeend", "<i></i>"); }
      }
    })();
    v.addEventListener("timeupdate", () => {
      ph.style.left = pct(v.currentTime) + "%"; o.querySelector(".ved-pt").textContent = fmtDur(Math.max(0, v.currentTime - st.start));
      if (v.currentTime >= st.end - 0.05) { v.currentTime = st.start; }
    });
    const playBtn = o.querySelector(".ved-play");
    playBtn.onclick = () => { if (v.paused) { if (v.currentTime < st.start || v.currentTime > st.end) v.currentTime = st.start; v.play(); playBtn.classList.add("hide"); } else { v.pause(); playBtn.classList.remove("hide"); } };
    v.onclick = () => playBtn.click();
    const tAt = (x) => { const r = tl.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * dur; };
    let drag = null;
    tl.addEventListener("pointerdown", (e) => {
      tl.setPointerCapture(e.pointerId); const t = tAt(e.clientX);
      if (mode === "cover") drag = "cover";
      else drag = e.target.classList.contains("l") ? "l" : e.target.classList.contains("r") ? "r" : Math.abs(t - st.start) < Math.abs(t - st.end) ? "l" : "r";
      move(e);
    });
    const move = (e) => {
      if (!drag) return; const t = tAt(e.clientX);
      if (drag === "cover") { st.cover = Math.max(st.start, Math.min(st.end, t)); v.currentTime = st.cover; }
      else if (drag === "l") { st.start = Math.max(0, Math.min(t, st.end - 0.5)); if (st.end - st.start > 30) st.end = st.start + 30; v.currentTime = st.start; }
      else { st.end = Math.min(dur, Math.max(t, st.start + 0.5)); if (st.end - st.start > 30) st.start = st.end - 30; v.currentTime = st.end - 0.1; }
      if (st.cover < st.start || st.cover > st.end) st.cover = st.start;
      draw();
    };
    tl.addEventListener("pointermove", move);
    tl.addEventListener("pointerup", () => (drag = null)); tl.addEventListener("pointercancel", () => (drag = null));
    qa(".h", sel).forEach((h) => h.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 0.5 : e.key === "ArrowLeft" ? -0.5 : 0; if (!d) return; e.preventDefault();
      if (h.classList.contains("l")) st.start = Math.max(0, Math.min(st.start + d, st.end - 0.5)); else st.end = Math.min(dur, Math.max(st.end + d, st.start + 0.5)); draw();
    }));
    o.querySelector(".ved-tools").onclick = (e) => {
      const b = e.target.closest("[data-m]"); if (!b) return; const m = b.dataset.m;
      if (m === "trim" || m === "cover") { mode = m; qa(".ved-tools [data-m]", o).forEach((x) => x.classList.toggle("on", x.dataset.m === m)); }
      if (m === "sound") st.mute = !st.mute;
      if (m === "format") { const i = ASPECTS.findIndex((a) => a[0] === st.aspect); st.aspect = ASPECTS[(i + 1) % ASPECTS.length][0]; }
      if (m === "rotate") st.rotate = (st.rotate + 90) % 360;
      draw();
    };
    const close = () => { v.pause(); o.classList.remove("on"); setTimeout(() => o.remove(), 200); };
    o.querySelector(".ved-x").onclick = close;
    $("vedReset").onclick = () => { Object.assign(st, { start: 0, end: Math.min(dur, 30), cover: 0, rotate: 0, aspect: "orig", mute: false }); draw(); toast("Вернули оригинал"); };
    const save = () => {
      if (st.end - st.start > 30.05) return toast("Итоговое видео — не длиннее 30 секунд");
      f._edit = { start: +st.start.toFixed(2), end: +st.end.toFixed(2), cover: +st.cover.toFixed(2), rotate: st.rotate, aspect: st.aspect, mute: st.mute };
      try { localStorage.setItem(edKey(f), JSON.stringify(f._edit)); } catch (e) {}   // параметры — в черновике
      close(); onDone && onDone(); toast("✂ Изменения сохранены в черновике");
    };
    $("vedSave").onclick = save; o.querySelector(".ved-done").onclick = save;
    draw();
  }
