  /* =====================================================
     DEMO-РАЗДЕЛЫ (SOS, услуги, опросы, помощь, сообщества)
     ===================================================== */
  if ($("urg")) $("urg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; qa("#urg button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); };
  /* SOS-01: явный признак is_sos (не текст), срок 3 часа, подтверждение, кнопка 112, точное место — только по согласию */
  const sosLive = (p) => p.is_sos && p.status === "active" && (!p.expires_at || new Date(p.expires_at) > Date.now());
  let sosActive = null;
  async function renderSOS() {
    const btn = $("sosBtn"), st = $("sosState"), hb = $("sosHist"); if (!btn) return;
    sosActive = null;
    if (!user) { btn.className = "sos-big"; btn.textContent = "SOS"; st.classList.add("hidden"); hb.innerHTML = '<div class="dim" style="font-size:12px">Войдите, чтобы видеть историю</div>'; return; }
    hb.innerHTML = '<div class="spin"></div>';
    try {
      const mine = (await api.myPosts()).filter((p) => p.is_sos); remember(mine);
      sosActive = mine.find(sosLive) || null;
      btn.className = "sos-big" + (sosActive ? " sent" : "");
      btn.innerHTML = sosActive ? "SOS<br><small>активен</small>" : "SOS";
      st.classList.toggle("hidden", !sosActive);
      if (sosActive) {
        const left = sosActive.expires_at ? Math.max(0, Math.round((new Date(sosActive.expires_at) - Date.now()) / 60000)) : null;
        st.innerHTML = `<b>🆘 Ваш SOS виден людям рядом</b><span>Опубликован ${timeAgo(sosActive.created_at)} · ${sosActive.comments} ${plural(sosActive.comments, "отклик", "отклика", "откликов")}${left != null ? ` · сам закроется через ${left >= 60 ? Math.floor(left / 60) + " ч " : ""}${left % 60} мин` : ""}. Доставка не гарантирована, экстренные службы не уведомлены — при опасности звоните 112.</span><div class="row2"><button class="btn btn-ghost" data-post="${sosActive.id}">Открыть</button><button class="btn btn-danger" id="sosCancel">Помощь больше не нужна</button></div>`;
      }
      const label = (p) => (sosLive(p) ? "активен" : p.status === "hidden" ? "скрыт модератором" : p.status === "closed" ? "закрыт" : "срок истек");
      hb.innerHTML = mine.length ? mine.map((p) => `<button class="row-post" data-post="${p.id}"><span class="th" style="background:${sosLive(p) ? "rgba(255,59,92,.2)" : "rgba(155,155,180,.15)"}">${sosLive(p) ? "🆘" : "✓"}</span><div><b translate="no">${esc(p.text)}</b><span>${label(p)} · ${fmtWhen(p.created_at)}</span></div></button>`).join("") : '<div class="dim" style="font-size:12px">Вы еще не отправляли SOS</div>';
    } catch (e) { hb.innerHTML = `<div class="empty"><b>Не удалось загрузить</b>${esc(e.message)}</div>`; }
  }
  if ($("sv-sos")) $("sv-sos").addEventListener("click", async (e) => {
    let b;
    if (e.target.id === "sosCancel") {
      if (!sosActive || !(await confirmSheet("Закрыть SOS?", "Публикация закроется и пропадет с карты, но останется в истории. Все, кто откликнулся, получат уведомление.", "Помощь не нужна", true))) return;
      try { await api.updatePost(sosActive.id, { status: "closed" }); Sound.play("send"); toast("SOS закрыт. Откликнувшиеся получат уведомление"); wide = null; feedDirty = true; if (mapReady) loadMapPosts(true); renderSOS(); } catch (er) { toast(er.message); }
      return;
    }
    if ((b = e.target.closest("[data-post]"))) openPost(b.dataset.post);
  });
  // подтверждение SOS: что увидят люди, что 112 не вызывается, точное место — отдельной галочкой
  function sosConfirm(what) {
    return new Promise((res) => {
      openSheet("Отправить SOS?", `<div class="sos-conf">
        <p><b>"${esc(what)}"</b> увидят люди рядом в ленте, на карте и в push-уведомлениях.</p>
        <div class="warnbox">⚠️ Доставка не гарантирована. Полиция, скорая и спасатели <b>не получат</b> это сообщение.</div>
        <a class="call112" href="tel:112">📞 Позвонить 112</a>
        <label class="rules-check"><input type="checkbox" id="sosExact"> <span>Показать точное место (иначе — примерно, в пределах ~200 м)</span></label>
      </div><div class="sheet-btns"><button class="btn btn-ghost" id="sosNo">Отмена</button><button class="btn btn-danger" id="sosYes">Отправить SOS</button></div>`);
      $("sosNo").onclick = () => { closeSheet(); res(null); };
      $("sosYes").onclick = () => { const exact = $("sosExact").checked; closeSheet(); res({ exact }); };
    });
  }
  let sosBusy = false;
  if ($("sosBtn")) $("sosBtn").onclick = async function () {
    if (sosActive) { $("sosCancel") && $("sosCancel").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    if (!requireAuth("Войдите, чтобы отправить SOS", { t: "sos" })) return;
    if (sosBusy) return; // повторное нажатие не дублирует сигнал
    const u = document.querySelector("#urg .on").textContent.replace(/^\S+\s/, "");
    const ok = await sosConfirm(u); if (!ok) return;
    sosBusy = true; $("sosBtn").classList.add("busy");
    try {
      const g = pos.src === "gps" ? pos : await getGeo(true).catch(() => null);
      if (!g) { toast("Не удалось определить, где вы. Разрешите геопозицию — без нее соседи не найдут вас. При опасности звоните 112"); return; }
      const p = await api.createPost({ category: "incident", text: "SOS: " + u + ". Нужна помощь рядом!", lat: g.lat, lng: g.lng, files: [], is_sos: true, exact: ok.exact, clientKey: "sos-" + N.rid() });
      cache.set(p.id, p); Sound.play("sos"); Obs.track("sos_sent", { ok: ok.exact ? "exact" : "approx" }); usefulAction("sos");
      wide = null; feedDirty = true; if (mapReady) loadMapPosts(true); toast("🆘 SOS опубликован для людей рядом. 112 не вызван");
      renderSOS();
    } catch (e) { toast(e.message); }
    finally { sosBusy = false; $("sosBtn").classList.remove("busy"); }
  };
  const PRO = { "Сантехник": ["Нурлан", "Сергей", "\"Сервис 24\""], "Электрик": ["Бауыржан", "Олег", "\"Свет+\""], "Автомеханик": ["Арман", "СТО \"Мотор\"", "Денис"], "Ремонт": ["Бригада Кайрата", "\"Ремонт-Про\"", "Максат"], "Репетитор": ["Айгерим (математика)", "Анна (англ.)", "Ержан (физика)"], "Уборка": ["\"Чистый дом\"", "Гульнара", "\"Clean KZ\""], "ПК-мастер": ["Даурен", "\"IT-помощь\"", "Артем"] };
  const PA = ["👨‍🔧", "🧰", "🔧", "🛠️", "👩‍🏫", "🧹", "💻"];
  function renderPro(cat) {
    if (!$("proList") || !PRO[cat]) return; const ix = Object.keys(PRO).indexOf(cat);
    $("proList").innerHTML = '<div class="demo-strip">🧪 Пример раздела: это ненастоящие мастера, рейтингов и отзывов нет. Найти мастера сейчас можно через публикацию в ленте.</div>' + PRO[cat].map((n) => `<div class="pro"><span class="pa">${PA[ix]}</span><div><b>${esc(n)}</b><span>${cat} · пример карточки</span></div></div>`).join("")
      + `<button class="btn btn-main full mt12" data-ask="${esc(cat)}">Спросить соседей: нужен ${esc(cat.toLowerCase())}</button>`;
  }
  qa("#svcCats span").forEach((sp) => { sp.dataset.cat = sp.lastChild.textContent.trim(); sp.onclick = () => { qa("#svcCats span").forEach((x) => x.classList.remove("on")); sp.classList.add("on"); renderPro(sp.dataset.cat); }; });
  if ($("proList")) { $("proList").onclick = (e) => { const b = e.target.closest("[data-ask]"); if (b && requireAuth("Войдите, чтобы публиковать")) { openCreate({ type: "talk" }); $("crText").value = "Ищу: " + b.dataset.ask.toLowerCase() + " рядом. Посоветуйте проверенного мастера 🙏"; } }; renderPro("Сантехник"); }
  qa("[data-poll]").forEach((pl) => (pl.onclick = (e) => { const o = e.target.closest(".opt"); if (!o || pl.classList.contains("voted")) return; o.classList.add("mine"); pl.classList.add("voted"); qa(".opt", pl).forEach((x) => (x.querySelector("i").style.width = x.dataset.p + "%")); toast("🧪 Это пример: голос не сохраняется"); }));
  qa("#sv-help .help button").forEach((b) => (b.onclick = () => { const on = b.classList.toggle("done"); b.textContent = on ? "✓ (пример)" : "Помогу"; if (on) toast("🧪 Это пример. Откликайтесь на реальные просьбы в ленте"); }));
  if ($("helpAdd")) $("helpAdd").onclick = () => { if (requireAuth("Войдите, чтобы попросить о помощи")) { openCreate({ type: "talk" }); $("crText").value = "Нужна помощь: "; } };
  qa("#v-com .jn").forEach((b) => (b.onclick = () => {
    const on = b.classList.toggle("in");
    if (b.textContent === "Войти" || b.dataset.w) { b.dataset.w = 1; b.textContent = on ? "✓ Внутри" : "Войти"; } else b.textContent = on ? "✓" : "+";
    b.style.background = on ? "rgba(43,212,125,.15)" : ""; b.style.color = on ? "var(--ok)" : "";
    toast("🧪 Пример: сообщества появятся позже" + (on ? "" : ""));
  }));
