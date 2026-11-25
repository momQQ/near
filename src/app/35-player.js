  /* =====================================================
     ВИДЕОПЛЕЕР (ТЗ плеера v14.9): автозапуск без звука, одно активное видео,
     жесты (тап, двойной тап, удержание края 2×, перемотка), полный экран, просмотры.
     Декодер создается только у видео на экране; остальным src не выдается.
     ===================================================== */
  const vpPref = (k, d) => (prefs[k] === undefined ? d : !!prefs[k]);
  const saveData = () => vpPref("v_saver", false) || !!(navigator.connection && navigator.connection.saveData);
  const autoplayOn = () => vpPref("v_autoplay", true) && !saveData();
  function videoSlide(p, m, i) {
    const dur = m.duration ? fmtDur(m.duration) : "0:00";
    const tall = m.w && m.h && m.h > m.w;
    return `<div class="gs vid${tall ? " tall" : ""}" data-i="${i}" data-mid="${esc(m.id || "")}" data-post="${p.id}" tabindex="0" role="group" aria-label="Видео, ${dur}. Пробел — пауза, стрелки — перемотка">
      <video data-src="${esc(m.url)}"${m.poster ? ` poster="${esc(m.poster)}"` : ""} playsinline muted loop preload="none" disablepictureinpicture></video>
      <div class="vp-hit" aria-hidden="true"></div>
      <button class="vp-big" type="button" aria-label="Смотреть видео">▶</button>
      <span class="vp-rate" aria-hidden="true">2× »</span>
      <span class="vp-load hidden" aria-hidden="true"><i class="mini-spin"></i></span>
      <div class="vp-net hidden"><span>Нет связи</span><button type="button" class="vp-retry">Повторить</button></div>
      <div class="vp-ctl"><button type="button" class="vp-snd" aria-label="Включить звук">${IC.mute || "🔇"}</button><button type="button" class="vp-fs" aria-label="На весь экран">⛶</button></div>
      <div class="vp-bar" role="slider" aria-label="Перемотка" aria-valuemin="0" aria-valuemax="${Math.round(m.duration || 0)}" aria-valuenow="0" tabindex="-1"><div class="vp-track"><i class="vp-fill"></i><b class="vp-knob"></b></div><span class="vp-time">0:00 / ${dur}</span></div>
      <div class="heart-burst">${IC.heartOn}</div>
    </div>`;
  }
  // свои вложения в обработке: другие их не видят (сервер не выдает), автор видит статус
  function stateSlide(p, m, i) {
    const T = { uploading: "Загрузка...", processing: "Обрабатываем видео", pending_review: "На проверке", rejected: "Отклонено" + (m.error ? ": " + m.error : ""), failed: "Не удалось обработать" };
    const bad = m.state === "rejected" || m.state === "failed";
    return `<div class="gs vstate${bad ? " bad" : ""}" data-i="${i}">${m.poster || m.thumb ? `<img src="${esc(m.poster || m.thumb)}" alt="">` : ""}
      <div class="mstate${bad ? " bad" : ""}">${bad ? "⚠️" : '<i class="mini-spin"></i>'} <span>${esc(T[m.state] || m.state)}</span>${m.state === "failed" && m.id ? `<button type="button" data-mretry="${esc(m.id)}">Повторить</button>` : ""}${m.state === "rejected" ? '<button type="button" data-appeal-media>Обжаловать</button>' : ""}</div></div>`;
  }
  const Player = {
    vis: new Map(), manual: new WeakSet(), active: null, io: null, seen: new Set(),
    init() {
      if (this.io || !("IntersectionObserver" in window)) return;
      this.io = new IntersectionObserver((en) => {
        en.forEach((x) => this.vis.set(x.target, x.isIntersecting ? x.intersectionRatio : 0));
        this.pick();
      }, { threshold: [0, 0.2, 0.4, 0.55, 0.7, 0.85, 1] });
      document.addEventListener("visibilitychange", () => { if (document.hidden) this.pauseAll(true); else this.pick(); });
      window.addEventListener("pagehide", () => this.pauseAll(true));
    },
    scan(root) {
      this.init();
      qa(".gs.vid:not([data-pw])", root).forEach((box) => { box.dataset.pw = "1"; if (this.io) this.io.observe(box); this.wire(box); });
    },
    // видимость ≥70% — запуск, <40% — пауза, между — без изменений; только одно видео с максимальной видимостью
    pick() {
      if (document.hidden || document.querySelector(".vfull")) return;
      let best = null, br = 0;
      this.vis.forEach((r, box) => {
        if (!box.isConnected) { this.vis.delete(box); return; }
        const slideOn = this.slideVisible(box);
        const ratio = slideOn ? r : 0;
        if (ratio < 0.4) { this.stop(box); return; }
        if (ratio >= 0.7 && ratio > br && !this.manual.has(box)) { best = box; br = ratio; }
      });
      const view = best && best.closest(".view");
      if (best && best !== this.active && autoplayOn() && (!view || view.classList.contains("on"))) this.play(best, true);
      if (best) this.prefetchNext(best);
    },
    slideVisible(box) { const tr = box.parentElement; if (!tr || !tr.classList.contains("gal-track")) return true; return Math.abs(box.offsetLeft - tr.scrollLeft) < box.clientWidth / 2; },
    // метаданные — максимум у одного следующего видео
    prefetchNext(box) {
      const all = qa(".gs.vid", box.closest(".view") || document); const k = all.indexOf(box), nx = all[k + 1];
      all.forEach((b) => { const v = b.querySelector("video"); if (b !== box && b !== nx && v.dataset.pre) { v.preload = "none"; delete v.dataset.pre; } });
      if (nx && !saveData()) { const v = nx.querySelector("video"); if (!v.src && !v.dataset.pre) { v.dataset.pre = "1"; v.preload = "metadata"; } }
    },
    attach(box) { const v = box.querySelector("video"); if (!v.src && v.dataset.src) { v.src = v.dataset.src; if (v.dataset.t) v.currentTime = +v.dataset.t; } return v; },
    // освобождаем декодер: позиция сохраняется
    release(box) { const v = box.querySelector("video"); if (!v.src) return; v.dataset.t = v.currentTime || 0; v.pause(); v.removeAttribute("src"); v.load(); box.classList.remove("playing", "started"); },
    async play(box, auto) {
      if (this.active && this.active !== box) this.stop(this.active);
      this.active = box; const v = this.attach(box);
      // первый запуск — без звука (muted + playsinline); звук включает человек кнопкой или настройкой
      if (auto || v.dataset.snd !== "1") v.muted = !(vpPref("v_sound", false) && !auto) && v.dataset.snd !== "1";
      v.playbackRate = 1;
      try { await v.play(); box.classList.add("started", "playing"); box.classList.remove("needs-tap"); this.showCtl(box); }
      catch (e) { box.classList.add("needs-tap"); }   // отказ play(): показываем кнопку Play
    },
    stop(box) {
      const v = box.querySelector("video"); if (!v.paused) v.pause(); v.playbackRate = 1; box.classList.remove("playing", "fast");
      if (this.active === box) this.active = null;
      // далеко за экраном — отдаем декодер
      if ((this.vis.get(box) || 0) === 0 && v.src) this.release(box);
    },
    pauseAll(reset) { qa(".gs.vid video").forEach((v) => { if (!v.paused) v.pause(); if (reset) v.playbackRate = 1; v.closest(".gs").classList.remove("playing", "fast"); }); this.active = null; },
    showCtl(box) { box.classList.add("ctl-on"); clearTimeout(box._ct); box._ct = setTimeout(() => { if (!box.querySelector("video").paused) box.classList.remove("ctl-on"); }, 2500); },
    toggle(box) {
      const v = this.attach(box);
      if (v.paused) { this.manual.delete(box); this.play(box, false); }
      else { v.pause(); this.manual.add(box); box.classList.remove("playing"); box.classList.add("ctl-on"); flash(box, "pause"); }
    },
    seekBy(box, s) { const v = this.attach(box); if (isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(v.duration - 0.05, v.currentTime + s)); this.showCtl(box); },
    wire(box) {
      const v = box.querySelector("video"), hit = box.querySelector(".vp-hit"), bar = box.querySelector(".vp-bar"), fill = box.querySelector(".vp-fill"), knob = box.querySelector(".vp-knob"), time = box.querySelector(".vp-time");
      let watched = 0, lastT = null;
      const upd = () => {
        const d = isFinite(v.duration) ? v.duration : 0, f = d ? v.currentTime / d : 0;
        fill.style.width = f * 100 + "%"; knob.style.left = f * 100 + "%";
        time.textContent = fmtDur(v.currentTime) + " / " + fmtDur(d); bar.setAttribute("aria-valuenow", Math.round(v.currentTime));
      };
      v.addEventListener("timeupdate", () => {
        upd();
        // просмотр: 3 секунды видимого воспроизведения, один раз за сутки на зрителя (сервер считает уникальных)
        if (!v.paused && lastT != null && v.currentTime > lastT) watched += Math.min(1, v.currentTime - lastT);
        lastT = v.currentTime;
        const mid = box.dataset.mid; if (mid && watched >= 3 && !this.seen.has(mid)) { this.seen.add(mid); api.mediaView(mid, watched).catch(() => {}); }
      });
      v.addEventListener("loadedmetadata", upd);
      v.addEventListener("waiting", () => box.querySelector(".vp-load").classList.remove("hidden"));
      v.addEventListener("playing", () => { box.querySelector(".vp-load").classList.add("hidden"); box.querySelector(".vp-net").classList.add("hidden"); });
      // потеря сети: обложка и "Повторить" с восстановлением позиции
      v.addEventListener("error", () => { if (!v.src) return; v.dataset.t = v.currentTime || v.dataset.t || 0; box.querySelector(".vp-net").classList.remove("hidden"); box.classList.remove("playing"); });
      box.querySelector(".vp-retry").onclick = (e) => { e.stopPropagation(); const t = +v.dataset.t || 0; v.removeAttribute("src"); v.load(); v.src = v.dataset.src; v.currentTime = t; this.play(box, false); };
      box.querySelector(".vp-big").onclick = (e) => { e.stopPropagation(); this.manual.delete(box); this.play(box, false); };
      box.querySelector(".vp-snd").onclick = (e) => { e.stopPropagation(); const vv = this.attach(box); vv.muted = !vv.muted; e.currentTarget.innerHTML = vv.muted ? IC.mute || "🔇" : IC.sound || "🔊"; e.currentTarget.setAttribute("aria-label", vv.muted ? "Включить звук" : "Выключить звук"); vv.dataset.snd = vv.muted ? "" : "1"; if (vv.paused) this.play(box, false); this.showCtl(box); };
      box.querySelector(".vp-fs").onclick = (e) => { e.stopPropagation(); openVideoFs(box); };
      // полоска: тап и перетаскивание меняют currentTime; свайп галереи при этом не срабатывает
      const seekAt = (x) => { const r = bar.querySelector(".vp-track").getBoundingClientRect(), vv = this.attach(box); if (!isFinite(vv.duration)) return; vv.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * vv.duration; upd(); };
      bar.addEventListener("pointerdown", (e) => { e.stopPropagation(); bar.setPointerCapture(e.pointerId); box.classList.add("seeking"); seekAt(e.clientX); });
      bar.addEventListener("pointermove", (e) => { if (bar.hasPointerCapture(e.pointerId)) seekAt(e.clientX); });
      const endSeek = (e) => { if (bar.hasPointerCapture && bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId); box.classList.remove("seeking"); this.showCtl(box); };
      bar.addEventListener("pointerup", endSeek); bar.addEventListener("pointercancel", endSeek);
      bar.addEventListener("click", (e) => e.stopPropagation());
      // жесты: тап (через 250 мс) — пауза; двойной тап — лайк (не снимает); удержание края 350 мс — 2×
      let x0 = 0, y0 = 0, holdT = null, holding = false, tapT = null, lastTap = 0, moved = false;
      hit.addEventListener("pointerdown", (e) => {
        x0 = e.clientX; y0 = e.clientY; moved = false; holding = false;
        const r = box.getBoundingClientRect(), edge = (e.clientX - r.left) / r.width;
        clearTimeout(holdT);
        if (edge < 0.25 || edge > 0.75) holdT = setTimeout(() => { const vv = this.attach(box); if (vv.paused) return; holding = true; vv.playbackRate = 2; box.classList.add("fast"); }, 350);
      });
      hit.addEventListener("pointermove", (e) => { if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) { moved = true; clearTimeout(holdT); if (holding) this.endHold(box); holding = false; } });
      const up = (e, cancel) => {
        clearTimeout(holdT);
        if (holding) { holding = false; this.endHold(box); return; }
        if (cancel || moved) return;
        const now = Date.now();
        if (now - lastTap < 250) { clearTimeout(tapT); lastTap = 0; const pid = box.dataset.post; heartBurst(box); doLike(pid, true); return; }
        lastTap = now;
        tapT = setTimeout(() => { if (box.classList.contains("started") || !v.paused) this.toggle(box); else this.play(box, false); }, 250);
      };
      hit.addEventListener("pointerup", (e) => up(e, false));
      hit.addEventListener("pointercancel", (e) => up(e, true));
      hit.addEventListener("contextmenu", (e) => e.preventDefault());
      box.addEventListener("keydown", (e) => {
        if (e.target !== box) return;
        if (e.key === " " || e.key === "k") { e.preventDefault(); this.toggle(box); }
        else if (e.key === "ArrowRight") { e.preventDefault(); this.seekBy(box, 5); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); this.seekBy(box, -5); }
        else if (e.key === "m") box.querySelector(".vp-snd").click();
        else if (e.key === "f") openVideoFs(box);
      });
    },
    endHold(box) { const v = box.querySelector("video"); v.playbackRate = 1; box.classList.remove("fast"); }
  };
  function flash(box, kind) { box.classList.remove("fl-pause"); void box.offsetWidth; if (kind === "pause") box.classList.add("fl-pause"); }
  function heartBurst(box) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const hb = box.querySelector(".heart-burst") || (box.closest(".gal") || box).querySelector(".heart-burst"); if (!hb) return;
    hb.classList.remove("go"); void hb.offsetWidth; hb.classList.add("go");
  }

  /* ---------- полный экран внутри приложения: без нижней навигации, оригинальные пропорции ---------- */
  function openVideoFs(box) {
    const v0 = Player.attach(box), pid = box.dataset.post, p = cache.get(pid);
    const t0 = v0.currentTime || 0, wasMuted = v0.muted; Player.stop(box);
    const o = document.createElement("div"); o.className = "vfull"; o.id = "vfull"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "Видео на весь экран");
    o.innerHTML = `<div class="vfs-top"><button class="vfs-x" aria-label="Закрыть">‹</button><span>${p && p.media.length > 1 ? (+box.dataset.i + 1) + " из " + p.media.length : ""}</span><button class="vfs-more" aria-label="Пожаловаться">⋯</button></div>
      ${videoSlide(p || { id: pid }, { id: box.dataset.mid, url: v0.dataset.src || v0.src, poster: v0.poster, duration: v0.duration })}
      <div class="vfs-acts"><button class="vfs-c" aria-label="Комментарии">${IC.cmt}<span>${p ? p.comments : ""}</span></button><button class="vfs-l${p && p.liked ? " on" : ""}" aria-label="Нравится">${p && p.liked ? IC.heartOn : IC.heart}<span>${p ? p.likes : ""}</span></button></div>`;
    document.body.appendChild(o); document.body.classList.add("in-vfs");
    const fb = o.querySelector(".gs.vid"); fb.classList.add("fs"); Player.wire(fb);
    const v = Player.attach(fb); v.currentTime = t0; v.muted = wasMuted; v.play().then(() => fb.classList.add("started", "playing")).catch(() => fb.classList.add("needs-tap"));
    requestAnimationFrame(() => o.classList.add("on"));
    const close = () => {
      const t = v.currentTime; v.pause(); o.classList.remove("on"); document.body.classList.remove("in-vfs"); document.removeEventListener("keydown", key);
      setTimeout(() => o.remove(), 200);
      // позиция возвращается в карточку
      v0.dataset.t = t; if (v0.src) v0.currentTime = t; Player.manual.add(box);
    };
    const key = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", key);
    o.querySelector(".vfs-x").onclick = close;
    // комментарии поверх полноэкранного видео: панель переносится на верхний уровень (видео продолжает играть)
    o.querySelector(".vfs-c").onclick = () => { if ($("csheet").parentElement !== document.body) document.body.append($("csBg"), $("csheet")); openComments(pid); };
    o.querySelector(".vfs-l").onclick = async (e) => { await doLike(pid); const q = cache.get(pid); if (q) e.currentTarget.innerHTML = (q.liked ? IC.heartOn : IC.heart) + `<span>${q.likes}</span>`; e.currentTarget.classList.toggle("on", !!(q && q.liked)); };
    o.querySelector(".vfs-more").onclick = () => { if (p) reportSheet({ type: "post", id: p.id, user_id: p.user_id, label: "видео", timecode: v.currentTime }); };
    // свайп вниз (вне полоски) закрывает
    let y0 = null;
    o.addEventListener("touchstart", (e) => { if (e.target.closest(".vp-bar")) return; if (e.touches.length === 1) y0 = e.touches[0].clientY; }, { passive: true });
    o.addEventListener("touchend", (e) => { if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null; if (dy > 110) close(); });
  }
