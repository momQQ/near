/* =====================================================
   NEAR — слой данных
   Два режима:
   • "supabase" — реальный сервер (если в config.js указаны ключи)
   • "local"    — демо-режим, данные хранятся в этом браузере
   Интерфейс у обоих режимов одинаковый: window.NEAR.api
   ===================================================== */
(function () {
  const CFG = window.NEAR_CONFIG || {};
  const CITY = CFG.CITY || { name: "Алматы", lat: 43.2389, lng: 76.8897, zoom: 13 };

  const CATS = {
    incident: { e: "🚨", n: "Происшествие", c: "#ff4d5e", ttl: 6 },
    event:    { e: "🎉", n: "Событие",      c: "#a63cff", ttl: 72 },
    deal:     { e: "🏷️", n: "Акция",        c: "#ffb020", ttl: 48 },
    lost:     { e: "🔎", n: "Потеряно",     c: "#ff6a3d", ttl: 24 * 14 },
    found:    { e: "🙌", n: "Найдено",      c: "#2bd47d", ttl: 24 * 14 },
    meetup:   { e: "🤝", n: "Встреча",      c: "#A54EE7", ttl: 24 },
    ad:       { e: "📢", n: "Объявление",   c: "#00b4a6", ttl: 24 * 7 },
    talk:     { e: "💬", n: "Обсуждение",   c: "#ff2e88", ttl: 24 * 3 }
  };

  // v14.9: 9 категорий встреч, теги отзывов, матрица санкций пилота
  const MEET_CATS = {
    sport: { e: "⚽", n: "Спорт" }, games: { e: "🎮", n: "Игры" }, walk: { e: "🚶", n: "Прогулки" }, food: { e: "☕", n: "Еда и кофе" },
    study: { e: "📚", n: "Учеба" }, creative: { e: "🎨", n: "Творчество" }, volunteer: { e: "🤝", n: "Волонтерство" }, family: { e: "👨‍👩‍👧", n: "Семья и дети" }, other: { e: "✨", n: "Другое" }
  };
  const REVIEW_TAGS = { punctual: "Пунктуальный", polite: "Вежливый", responsible: "Ответственный", organized: "Хорошая организация", as_described: "Все по описанию", team: "Командный игрок" };
  const BAN_RULES = {
    minor: { title: "Незначительное нарушение", first: 0, repeat: 24 }, spam: { title: "Спам", first: 24, repeat: 168 }, ads: { title: "Массовая реклама", first: 24, repeat: 720 },
    insult: { title: "Оскорбления", first: 0, repeat: 168 }, harassment: { title: "Домогательства", first: 720, repeat: null }, intimate: { title: "Интимный контент", first: 720, repeat: null },
    threat: { title: "Угрозы", first: 720, repeat: null }, scam: { title: "Подтвержденный скам", first: null, repeat: null }, evasion: { title: "Подтвержденный обход бана", first: 720, repeat: null },
    boosting: { title: "Накрутка рейтинга", first: 24, repeat: 720 }
  };
  // случайный идентификатор установки NEAR (не отпечаток устройства); очистка браузера создает новый
  function installId() {
    try { let v = localStorage.getItem("near_install"); if (!v) { v = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); localStorage.setItem("near_install", v); } return v; }
    catch (e) { return "no-storage"; }
  }
  function deviceLabel(ua = navigator.userAgent) {
    const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Устройство";
    const br = /YaBrowser/.test(ua) ? "Яндекс" : /Edg\//.test(ua) ? "Edge" : /(Chrome|CriOS)\//.test(ua) ? "Chrome" : /(Firefox|FxiOS)\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Браузер";
    return os + " · " + br;
  }
  const REP_LEVEL = (s) => (s == null ? "new" : s >= 90 ? "high" : s >= 75 ? "good" : s >= 50 ? "medium" : "low");
  const repFormula = (v, a, sc, u, h) => { const parts = [[v, 0.3], [a, 0.25], [sc, 0.25], [u, 0.1], [h, 0.1]].filter(([x]) => x != null); const w = parts.reduce((t, [, k]) => t + k, 0); return w ? Math.round(parts.reduce((t, [x, k]) => t + x * k, 0) / w) : null; };
  const attendance = (hm, sm) => (hm == null && sm == null ? "unknown" : hm != null && sm != null && hm !== sm ? "disputed" : (hm ?? sm) ? "attended" : "missed");

  /* ---------- утилиты ---------- */
  const rad = (x) => (x * Math.PI) / 180;
  function dist(a, b) {
    const R = 6371000, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function boundsAround(lat, lng, r) {
    const dLat = r / 111320, dLng = r / (111320 * Math.cos(rad(lat)));
    return { s: lat - dLat, n: lat + dLat, w: lng - dLng, e: lng + dLng };
  }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  const nowISO = () => new Date().toISOString();

  /* Сжатие фото перед загрузкой: до 1600 px по длинной стороне, JPEG 82% */
  // сжатие фото; withDims: вернуть еще ширину и высоту
  async function compressImage(file, maxSide = 1600, quality = 0.82, withDims = false) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("Не удалось прочитать фото. Попробуйте JPG или PNG."));
        i.src = url;
      });
      const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
      return withDims ? { blob, w, h } : blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

  // видео: размеры, длительность и обложка (кадр на 0.5 сек). Заодно проверяем, что браузер умеет его воспроизвести
  function probeVideo(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), v = document.createElement("video");
      let done = false; const fin = (fn, x) => { if (done) return; done = true; clearTimeout(to); URL.revokeObjectURL(url); fn(x); };
      const to = setTimeout(() => fin(rej, new Error(`Видео "${file.name}" не открывается в браузере. На iPhone включите: Настройки → Камера → Форматы → "Наиболее совместимый", или выберите MP4.`)), 15000);
      v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
      v.onerror = () => fin(rej, new Error(`Формат видео "${file.name}" не поддерживается этим браузером. Выберите MP4 (H.264). На iPhone: Настройки → Камера → Форматы → "Наиболее совместимый".`));
      v.onloadedmetadata = () => {
        if (!v.videoWidth) return fin(rej, new Error(`В файле "${file.name}" нет видеодорожки, которую можно показать`));
        if (v.duration > (CFG.MAX_VIDEO_SEC || 180)) return fin(rej, new Error(`Видео длиннее ${Math.round((CFG.MAX_VIDEO_SEC || 180) / 60)} мин. Обрежьте его и попробуйте снова`));
        v.currentTime = Math.min(0.5, (v.duration || 1) / 3);
      };
      v.onseeked = () => {
        try {
          const k = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight)), c = document.createElement("canvas");
          c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          c.toBlob((poster) => fin(res, { w: v.videoWidth, h: v.videoHeight, duration: v.duration, poster }), "image/jpeg", 0.8);
        } catch (e) { fin(res, { w: v.videoWidth, h: v.videoHeight, duration: v.duration, poster: null }); }
      };
    });
  }
  function validateFile(f) {
    const isImg = /^image\//.test(f.type), isVid = /^video\//.test(f.type) || /\.(mov|mp4|m4v|webm)$/i.test(f.name || "");
    if (!isImg && !isVid) throw new Error(`Файл "${f.name}" не поддерживается. Можно фото (JPG, PNG, WEBP) или видео (MP4, MOV).`);
    if (isImg && f.size > (CFG.MAX_IMAGE_MB || 15) * 1048576) throw new Error(`Фото "${f.name}" больше ${CFG.MAX_IMAGE_MB || 15} МБ.`);
    if (isVid && f.size > (CFG.MAX_VIDEO_MB || 20) * 1048576) throw new Error(`Видео "${f.name}" больше ${CFG.MAX_VIDEO_MB || 20} МБ. Обрежьте его на телефоне или выберите короче.`);
    return isImg ? "image" : "video";
  }

  /* фильтр грубых слов (такой же работает на сервере в schema.sql) */
  const BAD = /[а-яёa-z]*(хуй|хуе|хуё|хуя|пизд|ебан|ебат|ебал|еблан|ёбан|выеб|заеб|уеб|бляд|блят|сука|суки|сучк|мудак|мудил|гандон|пидор|пидар|шлюх|долбоеб|залуп|қотақ|сігей|сигей|шешеңді)[а-яёa-zқңғүұөһі]*/giu;
  /* NEAR Clean v14.9: та же логика, что clean_text на сервере (сервер проверяет всегда, это — для демо и подсказок) */
  const LOOK = { a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", k: "к", m: "м", t: "т", b: "в", h: "н", 0: "о", 1: "и", 3: "з", 4: "ч", 6: "б", 9: "б", "@": "а", $: "с" };
  const TR = [["sch", "щ"], ["sh", "ш"], ["ch", "ч"], ["zh", "ж"], ["kh", "х"], ["ya", "я"], ["yo", "е"], ["yu", "ю"], ["ts", "ц"], ["ye", "е"]];
  const TR1 = { a: "а", b: "б", v: "в", g: "г", d: "д", e: "е", z: "з", i: "и", j: "й", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", r: "р", s: "с", t: "т", u: "у", f: "ф", h: "х", c: "ц", y: "ы", x: "х", w: "в", 0: "о", 1: "и", 3: "з", 4: "ч", 6: "б", "@": "а", $: "с" };
  const fold = (s) => s.replace(/[ёъь]/g, (c) => (c === "ё" ? "е" : "")).replace(/[^\p{L}]/gu, "").replace(/(.)\1+/gu, "$1");
  function skels(w) {
    const s = String(w).normalize("NFKC").toLowerCase();
    const a = [...s].map((c) => LOOK[c] || c).join("");
    let b = s; TR.forEach(([k, v]) => (b = b.split(k).join(v))); b = [...b].map((c) => TR1[c] || c).join("").replace(/ый/g, "уй").replace(/ыя/g, "уя");
    const c = [...s].map((ch) => ({ 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s" }[ch] || ch)).join("");
    return [fold(a), fold(b), fold(c), fold(s)];
  }
  const MAT = /^(на|по|за|от|вы|при|у|до|пере|рас|раз|из|под|о|об|недо|ни)?(ху[йеяюи]|пизд|пезд|еб[аеилнуоы]|еб$|бля|мудак|мудил|мудозв|пид[оа]р|педик|гандон|шлюх|залуп|манд[ауеы]$|сука$|суки$|суку$|сукой$|сукин|сучк|сучар)|^(motherf|fuck|fuk|fck|shit|bitch|cunt|asshole|dickhead|whore|slut)|^(қотақ|котак|сігейін|сигейин|сігем|сігіп|сігер|амыңды|аныңды)/u;
  const INSULT = /^(дебил|идиот|урод|твар[ьи]|мраз|чмо$|лох$|лохи$|даун$|кретин|ублюд|сволоч|ақымақ|акымак|idiot|moron|retard)/u;
  const wordKind = (w) => { const k = skels(w); if (k.some((x) => MAT.test(x))) return "mat"; if (k.some((x) => INSULT.test(x))) return "insult"; return null; };
  const maskTok = (tok) => { const m = tok.match(/^([^\p{L}\p{N}@$]*)(.*?)([^\p{L}\p{N}@$]*)$/u); if (!m || !m[2]) return tok; return m[1] + [...m[2]][0] + "*".repeat(Math.max([...m[2]].length - 1, 3)) + m[3]; };
  function clean(src, ctx = "text") {
    let t = String(src == null ? "" : src), masked = false; const reasons = [];
    if (!t) return { text: t, verdict: "allow", reasons, masked };
    const n = t.normalize("NFKC").toLowerCase();
    const warn = /(не\s+(сообщ|говор|перед|дава|отправл|скидыв)|никому\s+не|осторожн|мошенник|развод|аферист|алаяқ|абайла|scam|do not share|never share)/u.test(n);
    t = t.replace(/(?<![\p{L}\p{N}@$])(?:[\p{L}\p{N}@$][ ._*-]+){2,}[\p{L}\p{N}@$](?![\p{L}\p{N}@$])/gu, (run) => { const j = run.replace(/[ ._*-]/g, ""); if (wordKind(j) === "mat") { masked = true; return run[0] + "*".repeat(Math.max(j.length - 1, 3)); } return run; });
    t = t.split(/(\s+)/).map((tok) => { if (/^\s+$/.test(tok) || !tok) return tok; const k = wordKind(tok); if (k === "mat") { masked = true; return maskTok(tok); } if (k === "insult" && !reasons.includes("insult")) reasons.push("insult"); return tok; }).join("");
    if (/((ищу|познаком|нужн[аы]?|кто\s+хочет).{0,40}(секс|интим|на\s+ночь|без\s+обязательств|вирт|эскорт)|интим[- ]?услуг|эскорт|проститут|nudes|hookup|sex\s*partner|onlyfans)/u.test(n)) reasons.push("sex");
    if (/(\bубью\b|убить\s+тебя|зарежу|прибью|взорву|найду\s+тебя\s+и|тебе\s+конец|өлтіремін|i\s+will\s+kill)/u.test(n)) reasons.push("threat");
    if (!warn && /((номер|данные|реквизит|цифр|фото)\S*\s.{0,20}(карт|card)|\bcvv2?\b|\bcvc\b|(код|пароль)\S*.{0,20}(смс|sms|сообщени)|(смс|sms)\W{0,3}код|(скаж|продикт|пришл|отправ|скин|назов)\S*.{0,15}(код|пароль)|card\s*number|sms\s*code)/u.test(n)) reasons.push("scam_request");
    for (const m of n.matchAll(/((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]{1,24}(?:\/\S*)?)/g)) {
      const host = m[1].replace(/^https?:\/\//, "").split("/")[0];
      if (/^[0-9.]+$/.test(host) || host.includes("@") || /(^|\.)xn--/.test(host) || /^(bit\.ly|tinyurl\.com|cutt\.ly|clck\.ru|t\.ly|goo\.su|is\.gd|rb\.gy|shorturl\.at|tiny\.cc|u\.to|vk\.cc)$/.test(host)
        || /\.(xyz|top|click|zip|mov|icu|cfd|sbs|rest|gq|tk|ml|cf|buzz|cam)$/.test(host) || (/kaspi/.test(host) && !/(^|\.)kaspi\.kz$/.test(host)) || (/halyk/.test(host) && !/(^|\.)halykbank\.kz$/.test(host)) || (/egov/.test(host) && !/(^|\.)egov\.kz$/.test(host))) { if (!reasons.includes("bad_link")) reasons.push("bad_link"); }
    }
    let verdict = reasons.includes("threat") ? "hold" : reasons.some((r) => ["sex", "scam_request", "bad_link"].includes(r)) ? "block" : reasons.includes("insult") ? "review" : "allow";
    if (ctx === "nickname" && (masked || reasons.includes("insult"))) verdict = "block";
    return { text: t, verdict, reasons, masked };
  }
  const CLEAN_MSG = { sex: "Поиск интимных знакомств и интимный контент в NEAR запрещены", scam_request: "Нельзя просить данные карт, коды из SMS и пароли", bad_link: "Ссылка выглядит небезопасной. Уберите ее или дайте официальный адрес" };
  function cleanOrThrow(t, ctx) { const r = clean(t, ctx); if (r.verdict === "block") throw new Error(CLEAN_MSG[r.reasons.find((x) => CLEAN_MSG[x])] || "Текст не прошел проверку NEAR Clean"); return r; }
  const mask = (t) => (t == null ? t : clean(t).text);
  const hasBad = (t) => { BAD.lastIndex = 0; const r = BAD.test(String(t || "")); BAD.lastIndex = 0; return r; };
  const cleanInsta = (v) => { v = String(v || "").trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/^@/, "").replace(/\/.*$/, ""); if (v && !/^[A-Za-z0-9._]{1,30}$/.test(v)) throw new Error("Ник Instagram: только латиница, цифры, точка и _"); return v || null; };
  function validateChatFile(f) {
    const t = f.type || "";
    if (/^image\//.test(t)) { if (f.size > (CFG.MAX_IMAGE_MB || 15) * 1048576) throw new Error("Фото слишком большое"); return "image"; }
    if (/^video\//.test(t)) { if (f.size > (CFG.MAX_VIDEO_MB || 30) * 1048576) throw new Error(`Видео больше ${CFG.MAX_VIDEO_MB || 30} МБ`); return "video"; }
    if (/^audio\//.test(t)) return "audio";
    throw new Error("Можно отправить фото, видео или голосовое");
  }
  const REASONS = { spam: "Спам или реклама", abuse: "Оскорбления, травля", fraud: "Мошенничество", threat: "Угрозы", intimate: "Интимный контент", minors: "Вред несовершеннолетним", nsfw: "Неприемлемые фото или видео", fake: "Ложная информация", danger: "Опасность, насилие", other: "Другое" };
  // подписи причин в панели модератора (в т.ч. автоматические)
  const REASON_LABELS = { ...REASONS, ai_unavailable: "ИИ-проверка недоступна — нужна ручная проверка" };

  function ruError(e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e);
    const map = [
      [/Invalid login credentials/i, "Неверная почта или пароль"],
      [/captcha/i, "Проверка \"я не робот\" не пройдена. Отметьте ее еще раз"],
      [/Email address not authorized|not authorized/i, "Не удалось отправить письмо на этот email: почтовый сервис NEAR еще не настроен. Напишите администратору."],
      [/Error sending confirmation|sending.*email/i, "Не удалось отправить письмо подтверждения. Попробуйте позже."],
      [/Email not confirmed/i, "Почта не подтверждена. Откройте письмо от NEAR и перейдите по ссылке."],
      [/already registered|already been registered/i, "Этот email уже зарегистрирован. Попробуйте войти."],
      [/at least 6/i, "Пароль должен быть не короче 6 символов"],
      [/valid email|invalid format|Unable to validate email/i, "Проверьте правильность email"],
      [/security purposes|rate limit|too many/i, "Слишком много попыток. Подождите минуту и попробуйте снова."],
      [/Failed to fetch|NetworkError|Load failed/i, "Нет связи с сервером. Проверьте интернет."],
      [/JWT|not authenticated|session/i, "Сессия истекла. Войдите снова."],
      [/row-level security/i, "Нет прав на это действие"],
      [/Payload too large|exceeded the maximum/i, "Файл слишком большой"],
      [/otp_expired|expired/i, "Ссылка устарела. Запросите новое письмо"],
      [/permission denied/i, "Нет прав на это действие"],
      [/duplicate key/i, "Это уже сделано"]
    ];
    for (const [re, t] of map) if (re.test(m)) return t;
    return m;
  }
  // стабильные коды ошибок сервера (SQLSTATE NRxxx) → понятный текст
  const CODES = { NR429: "Слишком часто. Попробуйте немного позже", "23505": "Это уже сделано", "42501": "Нет прав на это действие" };
  let lastReq = "";
  const fail = (e) => {
    const code = e && e.code ? String(e.code) : "";
    const msg = /^NR\d{3}$/.test(code) && e.message ? e.message : CODES[code] && !/[а-я]/i.test(e.message || "") ? CODES[code] : ruError(e);
    const err = new Error(msg); err.raw = e; err.code = code; err.requestId = lastReq; throw err;
  };
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  // курсор ленты: время + id (у публикаций с одинаковым временем порядок по id)
  const cursorOf = (p) => (p ? { ts: p.created_at, id: p.id } : null);
  const olderThan = (p, c) => !c || p.created_at < c.ts || (p.created_at === c.ts && p.id < c.id);
  const byNewest = (a, b) => (b.created_at === a.created_at ? (b.id > a.id ? 1 : -1) : b.created_at.localeCompare(a.created_at));
  // приблизительное место: сетка ~200 м (так же делает сервер)
  const snap = (lat, lng) => ({ lat: Math.round(lat / 0.002) * 0.002, lng: Math.round(lng / 0.0026) * 0.0026 });
  // UX-02: период ("сегодня" — с полуночи по Алматы, "неделя") и оценка для сортировки "Для вас" (как на сервере)
  function periodOk(p, period) {
    if (!period) return true;
    if (period === "week") return Date.now() - new Date(p.created_at) < 7 * 86400e3;
    const now = new Date(Date.now() + 5 * 3600e3); now.setUTCHours(0, 0, 0, 0);
    return new Date(p.created_at).getTime() >= now.getTime() - 5 * 3600e3;
  }
  function score(p, d) {
    const age = (Date.now() - new Date(p.created_at)) / 1000;
    return ((p.is_sos || (p.category === "incident" && age < 3 * 3600)) ? 1000 : 0) + 100 * Math.exp(-age / 86400) + 40 * Math.exp(-d / 1500)
      + 8 * Math.log(1 + (p.comments || 0)) + 3 * Math.log(1 + (p.likes || 0));
  }
  // POST-01: из MP4/MOV убираются метаданные (в т.ч. GPS): блоки udta и meta переименовываются в free
  async function stripVideoMeta(file) {
    try {
      if (!/mp4|quicktime|m4v/i.test(file.type || "") && !/\.(mp4|mov|m4v)$/i.test(file.name || "")) return file;
      const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
      const typ = (o) => String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
      const CONT = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);
      let hits = 0;
      const walk = (start, end) => {
        let o = start;
        while (o + 8 <= end) {
          let size = dv.getUint32(o), hdr = 8; const t = typ(o);
          if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
          if (size < hdr || o + size > end) break;
          if (t === "udta" || t === "meta") { buf[o + 4] = 102; buf[o + 5] = 114; buf[o + 6] = 101; buf[o + 7] = 101; buf.fill(0, o + hdr, o + size); hits++; }
          else if (CONT.has(t)) walk(o + hdr, o + size);
          o += size;
        }
      };
      walk(0, buf.length);
      return hits ? new File([buf], file.name || "video.mp4", { type: file.type || "video/mp4" }) : file;
    } catch (e) { return file; }
  }

  /* =====================================================
     ЛОКАЛЬНЫЙ ДЕМО-РЕЖИМ
     ===================================================== */
  function LocalBackend() {
    const KEY = "near_db_v2";
    let db;
    const listeners = [];

    function seed() {
      const U = [
        ["u-erlan", "Ерлан"], ["u-dinara", "Динара"], ["u-asel", "Асель"], ["u-timur", "Тимур"],
        ["u-arman", "Кофейня \"Арман\""], ["u-arbat", "Арбат Live"], ["u-aliya", "Алия"], ["u-max", "Максат"]
      ];
      const d = { v: 2, users: [], session: null, sid: null, sessions: [], challenges: [], bans: [], appeals: [], reviews: [], chats: [], chatMsgs: [], reactions: [], audit: [], posts: [], media: [], comments: [], likes: [], saved: [], events: [], members: [], notifs: [] };
      const G = { "u-erlan": "m", "u-dinara": "f", "u-asel": "f", "u-timur": "m", "u-aliya": "f", "u-max": "m" }, SEEN = { "u-erlan": 0, "u-dinara": 7, "u-asel": 95, "u-timur": 1500, "u-aliya": 2 };
      const NICK = { "u-erlan": "erlan", "u-dinara": "dinara.k", "u-asel": "asel_a", "u-timur": "timur", "u-arman": "arman.coffee", "u-arbat": "arbat.live", "u-aliya": "aliya", "u-max": "maksat" };
      U.forEach(([id, name]) => d.users.push({ id, email: id + "@demo.near", pwh: null, name, nickname: NICK[id], accepted_rules_at: nowISO(), avatar_url: null, district: "Бостандыкский", created_at: nowISO(),
        gender: G[id] || null, verified: id !== "u-max", last_seen_at: SEEN[id] != null ? new Date(Date.now() - SEEN[id] * 60000).toISOString() : null }));
      const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
      const P = [
        ["u-erlan", "meetup", "Ищем 4 игроков на футбол 5×5 сегодня в 19:00. Уровень любой, мяч есть 🙂", 43.1885, 76.8835, 12],
        ["u-timur", "incident", "ДТП на Аль-Фараби возле Есентая, две машины, правый ряд перекрыт. Лучше объехать.", 43.2183, 76.9278, 4],
        ["u-arman", "deal", "Кофе за 500 ₸ первым 100 гостям сегодня! Покажите это сообщение на кассе ☕", 43.2380, 76.9130, 30],
        ["u-dinara", "found", "Нашли корги без ошейника во дворе на Сатпаева. Рыжий, очень дружелюбный. Ищем хозяина!", 43.2365, 76.9050, 60],
        ["u-arbat", "event", "Фестиваль уличной еды на Арбате: музыка, фудтраки, вход свободный до 22:00", 43.2603, 76.9440, 120],
        ["u-asel", "lost", "Потеряла черный кошелек в районе ТРЦ Mega. Внутри документы. Прошу вернуть, вознаграждение!", 43.2018, 76.8920, 300],
        ["u-aliya", "talk", "Кто знает, почему перекрыли Достык возле Кок-Тобе? Надолго?", 43.2330, 76.9760, 45],
        ["u-max", "ad", "Отдам диван бесплатно, самовывоз. 3 этаж, лифт есть.", 43.2420, 76.8920, 200],
        ["u-erlan", "event", "Настольные игры соседей в субботу в 18:00. Будут Каркассон и Мафия 🎲", 43.2195, 76.9150, 500],
        ["u-timur", "incident", "Отключили горячую воду в ЖК на Розыбакиева до 18:00", 43.2250, 76.8780, 90],
        ["u-arbat", "event", "Утренняя пробежка сообщества в Центральном парке, вс 8:00. Присоединяйтесь!", 43.2575, 76.9600, 700],
        ["u-aliya", "deal", "Бизнес-ланч −30% в кафе у Зеленого базара до 15:00", 43.2650, 76.9530, 50],
        ["u-dinara", "meetup", "Кто хочет поехать на Медеу кататься на коньках вечером?", 43.1570, 77.0590, 180],
        ["u-max", "talk", "Подскажите хорошего сантехника в Алмалинском районе", 43.2560, 76.9100, 240]
      ];
      const TPL = [
        ["incident", "Пробка на перекрестке, светофор не работает"], ["deal", "Скидка −20% в магазине у дома"],
        ["meetup", "Ищу компанию на прогулку с собакой"], ["talk", "Где вкусный плов рядом?"], ["ad", "Продам велосипед, почти новый"],
        ["event", "Мастер-класс по рисованию во дворе"], ["found", "Нашел ключи с брелоком у остановки"], ["lost", "Потерялся рыжий кот Барсик"],
        ["incident", "Яма на дороге, осторожно"], ["deal", "Свежая выпечка −50% после 20:00"],
        ["talk", "Кто знает хорошего стоматолога рядом?"], ["meetup", "Ищу партнера по теннису на выходные"], ["ad", "Отдам детские вещи 2–3 года даром"],
        ["event", "Субботник во дворе в субботу в 10:00"], ["found", "Найден паспорт у банкомата, передал охране"], ["lost", "Потеряла AirPods в белом кейсе"],
        ["incident", "Не работает уличное освещение во дворе"], ["deal", "Шиномонтаж −15% для жителей района"], ["talk", "Где можно сдать старую технику?"],
        ["meetup", "Кто на утреннюю пробежку в 7:00?"], ["ad", "Ищу репетитора по математике для 5 класса"], ["found", "Нашли щенка у школы, ищем хозяина"]
      ];
      let seedR = 7; const rnd = () => (seedR = (seedR * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 46; i++) {
        const t = TPL[i % TPL.length];
        P.push([U[i % U.length][0], t[0], t[1], CITY.lat + (rnd() - 0.5) * 0.11, CITY.lng + (rnd() - 0.5) * 0.15, Math.floor(rnd() * 1400) + 5]);
      }
      P.forEach((p, i) => {
        const id = "p-" + i;
        d.posts.push({ id, user_id: p[0], category: p[1], text: p[2], lat: p[3], lng: p[4], status: "active", created_at: ago(p[5]), updated_at: ago(p[5]) });
        if (p[1] === "event" || (p[1] === "meetup" && i < 14)) {
          const st = new Date(); st.setHours(19, 0, 0, 0); if (i > 6) st.setDate(st.getDate() + ((6 - st.getDay() + 7) % 7 || 7));
          d.events.push({ post_id: id, starts_at: st.toISOString(), capacity: p[1] === "meetup" ? 10 : 50 });
          U.slice(0, 3 + (i % 4)).forEach((u) => d.members.push({ post_id: id, user_id: u[0] }));
        }
        U.slice(0, (i * 3) % 7).forEach((u) => d.likes.push({ post_id: id, user_id: u[0] }));
      });
      // демо-медиа: галерея из 3 фото и видео
      ["1", "2", "3"].forEach((n, i) => d.media.push({ id: uid(), post_id: "p-4", url: `media/demo/${n}.jpg`, thumb: `media/demo/${n}.jpg`, type: "image", w: 1080, h: 1350 }));
      d.media.push({ id: uid(), post_id: "p-2", url: "media/onb-ru.mp4", poster: "media/onb-ru-2.jpg", thumb: "media/onb-ru-2.jpg", type: "video", w: 720, h: 1280, duration: 12 });
      shieldSeed(d, ago);
      const c0 = uid();
      d.comments.push({ id: c0, post_id: "p-4", user_id: "u-asel", text: "А до скольки работают фудтраки?", created_at: ago(60) });
      d.comments.push({ id: uid(), post_id: "p-4", user_id: "u-arbat", parent_id: c0, text: "До 22:00, приходите 🙂", created_at: ago(55) });
      d.comments.push({ id: uid(), post_id: "p-0", user_id: "u-aliya", text: "Я приду с другом, нас двое!", created_at: ago(8) });
      d.comments.push({ id: uid(), post_id: "p-1", user_id: "u-max", text: "Уже разъехались, движение свободное", created_at: ago(2) });
      d.comments.push({ id: uid(), post_id: "p-3", user_id: "u-asel", text: "Похож на собаку соседей с Байзакова, скинула им", created_at: ago(40) });
      return d;
    }

    // демо: видео "обрабатывается" и "проверяется" пару секунд, затем публикуется (настоящую обработку делает worker на сервере)
    function demoProcess(m) {
      setTimeout(() => { m.state = "pending_review"; emit("media", m); }, 1200);
      setTimeout(() => { m.state = "approved"; save(); emit("media", m); const p = db.posts.find((x) => x.id === m.post_id); if (p && p.status === "draft" && !db.media.some((x) => x.post_id === p.id && x.state !== "approved")) { p.status = "active"; p.created_at = nowISO(); save(); emit("post", shape(p)); } }, 3200);
    }
    // демо Shield: общие чаты, прошедшая встреча с отзывами, аккаунты для проверки входа и бана
    function shieldSeed(d, ago) {
      const city = { id: "chat-city", kind: "city", title: "Алматы — общий чат", district: null, post_id: null };
      d.chats.push(city);
      ["Алмалинский", "Бостандыкский", "Медеуский", "Ауэзовский", "Алатауский", "Наурызбайский", "Жетысуский", "Турксибский"].forEach((n) =>
        d.chats.push({ id: "chat-" + n, kind: "district", title: n + " район — чат района", district: n + " район", post_id: null }));
      const M = [["u-timur", "Б****, опять пробки на Абая", 14], ["u-max", "Там ремонт дороги, лучше объехать", 13], ["u-aliya", "Спасибо! А по Сатпаева свободно?", 9], ["u-dinara", "Да, по Сатпаева едем нормально 👍", 6]];
      M.forEach(([u, t, m], i) => d.chatMsgs.push({ id: "cm-" + i, chat_id: "chat-city", sender_id: u, text: t, mod_status: "ok", created_at: ago(m), reply_to: i === 3 ? "cm-2" : null }));
      d.reactions.push({ message_id: "cm-1", user_id: "u-erlan", emoji: "👍" }, { message_id: "cm-1", user_id: "u-asel", emoji: "👍" }, { message_id: "cm-3", user_id: "u-aliya", emoji: "❤️" });
      d.posts.forEach((p) => { if (p.category === "meetup" || p.category === "event") { const e = d.events.find((x) => x.post_id === p.id); if (e) { e.host_id = p.user_id; e.status = "scheduled"; if (p.category === "meetup") e.meet_cat = p.text.includes("футбол") ? "sport" : p.text.includes("коньк") ? "sport" : "walk"; } } });
      d.members.forEach((m) => { m.status = "going"; });
      // прошедшая встреча "CS2 — собираем команду": отзывы о Ерлане (организатор) и посещаемость
      d.posts.push({ id: "p-cs2", user_id: "u-erlan", category: "meetup", text: "CS2 — собираем команду на вечер в компьютерном клубе", lat: 43.2390, lng: 76.9050, status: "active", created_at: ago(60 * 30), updated_at: ago(60 * 30) });
      d.events.push({ post_id: "p-cs2", starts_at: ago(60 * 5), ends_at: ago(60 * 2), capacity: 10, host_id: "u-erlan", status: "scheduled", meet_cat: "games", chat_id: "chat-p-cs2" });
      d.chats.push({ id: "chat-p-cs2", kind: "meeting", title: "CS2 — собираем команду", post_id: "p-cs2" });
      ["u-dinara", "u-asel", "u-timur", "u-aliya"].forEach((u) => d.members.push({ post_id: "p-cs2", user_id: u, status: "going", host_mark: true, self_mark: true }));
      [["u-dinara", 5], ["u-asel", 5], ["u-timur", 4], ["u-aliya", 5]].forEach(([u, r]) => d.reviews.push({ id: uid(), meeting_id: "p-cs2", reviewer_id: u, target_id: "u-erlan", target_role: "host", rating: r, tags: ["punctual", "organized"], comment: null, status: "visible", created_at: ago(60) }));
      // еще две прошедшие встречи Ерлана — у него есть публичный балл
      ["p-old1", "p-old2"].forEach((id, i) => {
        d.posts.push({ id, user_id: "u-erlan", category: "meetup", text: i ? "Пробежка в парке Горького" : "Настолки во дворе", lat: 43.24, lng: 76.92, status: "closed", created_at: ago(60 * 24 * (10 + i)), updated_at: ago(60 * 24 * (10 + i)) });
        d.events.push({ post_id: id, starts_at: ago(60 * 24 * (9 + i)), ends_at: ago(60 * 24 * (9 + i) - 120), capacity: 8, host_id: "u-erlan", status: "scheduled", meet_cat: i ? "sport" : "games" });
        d.members.push({ post_id: id, user_id: "u-asel", status: "going", host_mark: true, self_mark: true });
      });
      // аккаунт для проверки входа с нового устройства (активен на "iPhone · Safari")
      d.users.push({ id: "u-almaty", email: "almaty@demo.near", pwh: "demo", nickname: "almatyuser", name: "AlmatyUser", avatar_url: null, district: "Бостандыкский", created_at: ago(60 * 24 * 40), accepted_rules_at: nowISO(), verified: true, demo_pw: "demo1234" });
      d.sessions.push({ id: "s-iphone", user_id: "u-almaty", install: "demo-iphone", device: "iPhone · Safari", status: "active", created_at: ago(600), last_seen: ago(5) });
      // аккаунт с действующим баном 30 дней (решение NS-00241)
      d.users.push({ id: "u-spam", email: "spam@demo.near", pwh: "demo", nickname: "spam.king", name: "Spam King", avatar_url: null, district: null, created_at: ago(60 * 24 * 5), accepted_rules_at: nowISO(), verified: true, demo_pw: "demo1234" });
      d.bans.push({ id: "b-241", decision_no: "NS-00241", user_id: "u-spam", kind: "ban", scope: "global", rule: "spam", reason: "Систематическая рассылка спама", starts_at: ago(60 * 9 + 27), expires_at: new Date(Date.now() + (29 * 86400 + 14 * 3600 + 32 * 60 + 8) * 1000).toISOString(), status: "active", moderator_id: "u-erlan", created_at: ago(60) });
    }
    function load() {
      try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { db = null; }
      if (!db || db.v !== 2) { db = seed(); save(); }
      ["sessions", "challenges", "bans", "appeals", "reviews", "chats", "chatMsgs", "reactions", "audit"].forEach((k) => { if (!db[k]) db[k] = []; });
      db.media = db.media.filter((m) => !String(m.url || "").startsWith("blob:"));
      ["friends", "blocks", "convs", "msgs", "reports"].forEach((k) => { if (!db[k]) db[k] = []; });
    }
    function save() {
      try { localStorage.setItem(KEY, JSON.stringify(db)); }
      catch (e) { throw new Error("Память демо-режима заполнена (фото занимают много места). Удалите старые публикации или подключите сервер Supabase."); }
    }
    async function hash(s) {
      try {
        const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("near:" + s));
        return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
      } catch (e) { return "plain:" + s; }
    }
    const me = () => db.users.find((u) => u.id === db.session) || null;
    const curSess = () => db.sessions.find((x) => x.id === db.sid) || null;
    const banOf = (uid) => db.bans.filter((b) => b.user_id === uid && b.status === "active" && (b.scope || "global") === "global" && b.kind !== "warning" && (!b.expires_at || b.expires_at > nowISO()))
      .sort((a, b) => (b.kind === "ban") - (a.kind === "ban") || (!b.expires_at) - (!a.expires_at) || String(b.expires_at).localeCompare(String(a.expires_at)))[0] || null;
    function accState(uid) {
      const b = uid && banOf(uid);
      if (!b) return { state: uid ? "active" : "guest", server_now: nowISO() };
      const ap = db.appeals.find((a) => a.ban_id === b.id);
      return { state: b.kind === "restricted" ? "restricted" : b.expires_at ? "banned_until" : "banned_permanent", ban_id: b.id, decision_no: b.decision_no, rule: b.rule,
        rule_title: (BAN_RULES[b.rule] || {}).title, reason: b.reason, starts_at: b.starts_at, expires_at: b.expires_at || null, server_now: nowISO(), appeal: ap ? ap.status : null };
    }
    // запись: актуальная сессия этого устройства и нет ограничений (как guard на сервере)
    const need = () => {
      const u = me(); if (!u) throw new Error("Войдите, чтобы сделать это");
      const cs = curSess();
      if (!cs || cs.status !== "active") { const e = new Error(cs && cs.status === "revoked" ? "Вы вышли из аккаунта: выполнен вход на другом устройстве" : "Подтвердите вход с этого устройства"); e.code = "NR401"; throw e; }
      const st = accState(u.id).state;
      if (st === "banned_until" || st === "banned_permanent") { const e = new Error("Аккаунт заблокирован"); e.code = "NR403"; throw e; }
      if (st === "restricted") throw new Error("Действие ограничено решением модератора");
      return u;
    };
    const prof = (u) => u && { id: u.id, email: u.email, nickname: u.nickname || null, meetings_pilot: true, name: u.name, avatar_url: u.avatar_url, district: u.district, instagram: u.instagram || null, is_admin: !!u.is_admin, is_mod: !!(u.is_admin || u.is_moderator), banned: !!u.banned,
      gender: u.gender || null, verified: !!u.verified, last_seen_at: u.last_seen_at || null, accepted_rules: !!u.accepted_rules_at, bio: u.bio || null, show_seen: u.show_seen !== false, provider: "email" };
    const blockedByMe = () => { const u = me(); return new Set(u ? db.blocks.filter((b) => b.blocker_id === u.id).map((b) => b.blocked_id) : []); };
    const isBlocked = (a, b) => db.blocks.some((x) => (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
    const friendRow = (a, b) => db.friends.find((f) => (f.requester_id === a && f.addressee_id === b) || (f.requester_id === b && f.addressee_id === a));
    const pubProfile = (x) => x && { id: x.id, nickname: x.nickname || null, name: x.name, avatar_url: x.avatar_url, district: x.district, instagram: x.instagram || null, created_at: x.created_at,
      gender: x.gender || null, verified: !!x.verified, last_seen_at: x.show_seen === false ? null : x.last_seen_at || null, banned: !!x.banned, bio: x.bio || null };
    function shapeMsg(m) { return { ...m }; }
    function demoWelcome(u) {
      // демо: заявка в друзья и прошедшая встреча, по которой можно оставить отзыв
      if (!db.friends.some((f) => f.addressee_id === u.id)) {
        db.friends.push({ requester_id: "u-erlan", addressee_id: u.id, status: "pending", created_at: nowISO() });
        db.notifs.push({ id: uid(), user_id: u.id, actor_id: "u-erlan", type: "friend_request", text: "хочет добавить вас в друзья", read: false, created_at: nowISO() });
        if (!db.members.some((m) => m.post_id === "p-cs2" && m.user_id === u.id)) db.members.push({ post_id: "p-cs2", user_id: u.id, status: "going", host_mark: true, self_mark: true });
        db.notifs.push({ id: uid(), user_id: u.id, actor_id: "u-erlan", type: "review", post_id: "p-cs2", text: "Встреча завершена. Оцените участников", read: false, created_at: nowISO() });
      }
    }
    function notify(to, type, post_id, text) {
      const u = me(); if (!u || to === u.id) return;
      db.notifs.push({ id: uid(), user_id: to, actor_id: u.id, type, post_id, text, read: false, created_at: nowISO() });
    }
    function shape(p) {
      const u = me(), a = db.users.find((x) => x.id === p.user_id);
      const ev = db.events.find((e) => e.post_id === p.id);
      return {
        id: p.id, user_id: p.user_id, category: p.category, text: p.text, lat: p.lat, lng: p.lng, status: p.status,
        created_at: p.created_at, updated_at: p.updated_at, is_sos: !!p.is_sos, exact: !!p.exact, expires_at: p.expires_at || null, resolved_at: p.resolved_at || null,
        author: a ? { id: a.id, name: a.name, nickname: a.nickname || null, avatar_url: a.avatar_url, verified: !!a.verified } : { id: p.user_id, name: "Пользователь", avatar_url: null },
        media: db.media.filter((m) => m.post_id === p.id && (m.state || "approved") === "approved" || (m.post_id === p.id && u && p.user_id === u.id))
          .map((m) => ({ id: m.id, url: m.url, type: m.type, mod_status: m.mod_status || "ok", state: m.state || "approved", error: m.error || null, thumb: m.thumb || null, poster: m.poster || null, w: m.w || null, h: m.h || null, duration: m.duration || null, edit: m.edit || null })),
        likes: db.likes.filter((l) => l.post_id === p.id).length,
        comments: db.comments.filter((c) => c.post_id === p.id).length,
        liked: !!u && db.likes.some((l) => l.post_id === p.id && l.user_id === u.id),
        saved: !!u && db.saved.some((l) => l.post_id === p.id && l.user_id === u.id),
        event: ev ? {
          starts_at: ev.starts_at, capacity: ev.capacity,
          members: db.members.filter((m) => m.post_id === p.id && (m.status || "going") === "going").length,
          joined: !!u && db.members.some((m) => m.post_id === p.id && m.user_id === u.id && (m.status || "going") === "going"),
          meet_cat: ev.meet_cat || null, ends_at: ev.ends_at || null, host_id: ev.host_id || p.user_id, cohost_id: ev.cohost_id || null, status: ev.status || "scheduled", chat_id: ev.chat_id || null
        } : null
      };
    }
    const emit = (t, d) => listeners.forEach((f) => { try { f(t, d); } catch (e) {} });

    return {
      mode: "local",
      async init() { load(); return prof(me()); },
      user: () => prof(me()),
      onAuth(cb) { listeners.push((t, d) => t === "auth" && cb(d)); },
      subscribe(cb) { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },

      async signUp({ nickname, email, password, district }) {
        email = (email || "").trim().toLowerCase();
        const nick = String(nickname || "").trim().replace(/^@/, "").toLowerCase();
        const chk = await this.nicknameAvailable(nick); if (!chk.ok) throw new Error(chk.reason);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Проверьте правильность email");
        if ((password || "").length < 8) throw new Error("Пароль должен быть не короче 8 символов");
        // существующую почту не раскрываем: ответ как при успешной регистрации, второй аккаунт не создается
        if (db.users.some((u) => u.email === email)) return { needsConfirm: true };
        const firstReal = !db.users.some((x) => x.pwh && x.pwh !== "demo");
        const u = { id: uid(), email, pwh: await hash(password), nickname: nick, name: nick, avatar_url: null, district: district || null, created_at: nowISO(), accepted_rules_at: nowISO(), is_admin: firstReal, gender: null, verified: false, last_seen_at: nowISO() };
        db.users.push(u); db.session = u.id; db.sid = null; demoWelcome(u); save();
        return { needsConfirm: false };
      },
      async signIn({ login, email, password }) {
        login = String(login || email || "").trim().toLowerCase().replace(/^@/, "");
        const u = db.users.find((x) => x.email === login || x.nickname === login);
        const ok = u && (u.pwh === "demo" ? password === u.demo_pw : u.pwh && u.pwh === (await hash(password || "")));
        if (!ok) throw new Error("Не удалось войти. Проверьте данные или восстановите доступ");
        db.session = u.id; db.sid = null; save(); return prof(u);
      },
      async nicknameAvailable(n) {
        const v = String(n || "").trim().replace(/^@/, "").normalize("NFKC").toLowerCase();
        if (!/^[a-z0-9_.]{3,20}$/.test(v) || /^[._]|[._]$|\.\./.test(v)) return { ok: false, reason: "Никнейм: 3–20 символов, латинские буквы, цифры, точка и _" };
        if (/^(admin|administrator|near|nearapp|support|moderator|modera|root|system|official|help|security)/.test(v)) return { ok: false, reason: "Этот никнейм зарезервирован" };
        if (clean(v, "nickname").verdict === "block") return { ok: false, reason: "Такой никнейм нельзя использовать" };
        if (db.users.some((u) => u.nickname === v)) return { ok: false, reason: "Никнейм уже занят" };
        return { ok: true, nickname: v };
      },
      /* ---------- Shield: сессия этого устройства ---------- */
      async sessionBegin() {
        const u = me(); if (!u) return { state: "guest" };
        const acc = accState(u.id);
        if (acc.state === "banned_until" || acc.state === "banned_permanent") return { state: "banned", account: acc };
        const inst = installId(), dev = deviceLabel();
        let cs = curSess();
        if (cs && cs.user_id === u.id && cs.status === "active") { cs.last_seen = nowISO(); save(); return { state: "active", account: acc }; }
        if (cs && cs.user_id === u.id && cs.status === "revoked") return { state: "revoked", reason: cs.reason };
        const act = db.sessions.find((x) => x.user_id === u.id && x.status === "active");
        if (!act || act.install === inst) {
          if (act) { act.status = "revoked"; act.reason = "same_device"; act.revoked_at = nowISO(); }
          cs = { id: uid(), user_id: u.id, install: inst, device: dev, status: "active", created_at: nowISO(), last_seen: nowISO() };
          db.sessions.push(cs); db.sid = cs.id; save(); emit("auth", prof(u)); return { state: "active", account: acc };
        }
        if (!cs || cs.user_id !== u.id) { cs = { id: uid(), user_id: u.id, install: inst, device: dev, status: "pending", created_at: nowISO(), last_seen: nowISO() }; db.sessions.push(cs); db.sid = cs.id; }
        let ch = db.challenges.find((c) => c.sid === cs.id && !c.done && c.expires_at > nowISO());
        if (!ch) { ch = { id: uid(), sid: cs.id, user_id: u.id, old: act.id, code: String(Math.floor(100000 + Math.random() * 900000)), attempts: 0, sends: 1, expires_at: new Date(Date.now() + 600e3).toISOString(), resend_at: new Date(Date.now() + 60e3).toISOString() }; db.challenges.push(ch); }
        save();
        return { state: "challenge", challenge_id: ch.id, expires_at: ch.expires_at, resend_at: ch.resend_at, attempts_left: 5 - ch.attempts, old_device: act.device, old_last_seen: act.last_seen, server_now: nowISO(), demo_code: ch.code };
      },
      async sessionConfirm(id, code) {
        const ch = db.challenges.find((c) => c.id === id && c.sid === db.sid);
        if (!ch || ch.done) return { ok: false, error: "Код больше не действует. Войдите заново", final: true };
        if (ch.expires_at <= nowISO()) return { ok: false, error: "Срок кода истек. Запросите новый код", expired: true };
        if (ch.attempts >= 5) { ch.done = true; save(); return { ok: false, error: "Слишком много попыток. Войдите заново", final: true }; }
        if (String(code).trim() !== ch.code) { ch.attempts++; save(); return { ok: false, error: "Неверный код", attempts_left: 5 - ch.attempts, final: ch.attempts >= 5 }; }
        const act = db.sessions.find((x) => x.user_id === ch.user_id && x.status === "active");
        if ((act && act.id) !== ch.old) { ch.done = true; save(); return { ok: false, error: "Вход уже выполнен на другом устройстве. Войдите заново", final: true }; }
        ch.done = true;
        if (act) { act.status = "revoked"; act.reason = "new_device"; act.revoked_at = nowISO(); }
        const cs = curSess(); cs.status = "active"; cs.last_seen = nowISO();
        db.audit.push({ id: db.audit.length + 1, actor_id: ch.user_id, action: "session_new_device", target_id: ch.user_id, details: { old: act && act.device }, created_at: nowISO() });
        save(); emit("auth", prof(me())); return { ok: true, state: "active" };
      },
      async sessionResend(id) {
        const ch = db.challenges.find((c) => c.id === id && !c.done); if (!ch) return { ok: false, error: "Войдите заново" };
        if (ch.resend_at > nowISO()) return { ok: false, error: "Повторно — через минуту", resend_at: ch.resend_at };
        if (ch.sends >= 3) return { ok: false, error: "Лимит писем исчерпан. Войдите заново позже" };
        ch.code = String(Math.floor(100000 + Math.random() * 900000)); ch.sends++; ch.resend_at = new Date(Date.now() + 60e3).toISOString(); ch.expires_at = new Date(Date.now() + 600e3).toISOString(); save();
        return { ok: true, resend_at: ch.resend_at, demo_code: ch.code };
      },
      async sessionCancel() { const cs = curSess(); if (cs && cs.status === "pending") { cs.status = "revoked"; cs.reason = "cancelled"; } db.challenges.forEach((c) => { if (c.sid === db.sid) c.done = true; }); db.session = null; db.sid = null; save(); emit("auth", null); },
      async sessionState() {
        const u = me(); if (!u) return { state: "guest", server_now: nowISO() };
        const cs = curSess();
        return { state: cs && cs.user_id === u.id ? cs.status : "none", reason: cs && cs.reason, account: accState(u.id), server_now: nowISO(), captcha: false, hold: false };
      },
      async sessionList() { const u = me(); if (!u) return []; return db.sessions.filter((x) => x.user_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 30)
        .map((x) => ({ device_label: x.device, status: x.status, created_at: x.created_at, last_seen: x.last_seen, revoked_at: x.revoked_at || null, revoke_reason: x.reason || null, current: x.id === db.sid })); },
      async accountState() { const u = me(); return accState(u && u.id); },
      async myDecisions() { const u = me(); if (!u) return []; return db.bans.filter((b) => b.user_id === u.id && (b.scope || "global") === "global").map((b) => { const a = db.appeals.find((x) => x.ban_id === b.id);
        return { id: b.id, decision_no: b.decision_no, kind: b.kind, rule: b.rule, rule_title: (BAN_RULES[b.rule] || {}).title, reason: b.reason, starts_at: b.starts_at, expires_at: b.expires_at || null,
          status: b.status === "revoked" ? "revoked" : b.expires_at && b.expires_at <= nowISO() ? "expired" : "active", appeal_status: a ? a.status : null, appeal_note: a ? a.note : null }; }); },
      async appealSubmit(banId, text) {
        const u = me(); if (!u) throw new Error("Войдите");
        const b = db.bans.find((x) => x.id === banId && x.user_id === u.id && x.status === "active"); if (!b) throw new Error("Решение не найдено");
        if (String(text || "").trim().length < 10) throw new Error("Опишите ситуацию: минимум 10 символов");
        let a = db.appeals.find((x) => x.ban_id === b.id);
        if (!a) { a = { id: uid(), ban_id: b.id, user_id: u.id, message: String(text).trim().slice(0, 1000), status: "pending", created_at: nowISO(), due_at: new Date(Date.now() + 72 * 3600e3).toISOString() }; db.appeals.push(a); save(); }
        return { id: a.id, status: a.status, due_at: a.due_at };
      },
      /* ---------- репутация и отзывы ---------- */
      async reputation(id) {
        const target = id || (me() || {}).id;
        const rv = db.reviews.filter((r) => r.target_id === target && r.status === "visible");
        const people = new Set(rv.map((r) => r.reviewer_id)).size;
        const avg = (l) => (l.length ? l.reduce((t, r) => t + r.rating, 0) / l.length : null);
        const hostR = rv.filter((r) => r.target_role === "host"), memR = rv.filter((r) => r.target_role === "participant");
        const ended = (e) => new Date(e.ends_at || new Date(e.starts_at).getTime() + 3 * 3600e3) < Date.now();
        const mine = db.members.filter((m) => m.user_id === target && m.status === "going").filter((m) => { const e = db.events.find((x) => x.post_id === m.post_id); const p = db.posts.find((x) => x.id === m.post_id); return e && p && p.category === "meetup" && e.status !== "cancelled" && ended(e); });
        const att = mine.map((m) => attendance(m.host_mark ?? null, m.self_mark ?? null));
        const committed = att.filter((x) => x === "attended" || x === "missed").length, attended = att.filter((x) => x === "attended").length;
        const hosted = db.events.filter((e) => e.host_id === target && e.status !== "cancelled" && ended(e) && (db.posts.find((p) => p.id === e.post_id) || {}).category === "meetup").length;
        const done = hosted + attended;
        const pen = db.bans.filter((b) => b.user_id === target && b.status === "active").reduce((t, b) => t + ({ warning: 5, restricted: 15, ban: 30 }[b.kind] || 0), 0);
        const thanks = new Set(db.likes.filter((l) => l.user_id !== target && db.posts.some((p) => p.id === l.post_id && p.user_id === target && ["lost", "found", "incident", "talk"].includes(p.category))).map((l) => l.user_id)).size;
        const a = db.users.find((x) => x.id === target); const months = a ? (Date.now() - new Date(a.created_at)) / 2592e6 : 0;
        const V = rv.length ? 25 * (avg(rv) - 1) : null, A = committed ? (100 * attended) / committed : null, S = Math.max(0, 100 - pen);
        const Uc = thanks ? Math.min(100, 40 + 10 * thanks) : null, H = months >= 1 ? Math.min(100, 50 + 10 * Math.floor(months)) : null;
        const score = people >= 3 && done >= 3 ? repFormula(V, A, S, Uc, H) : null;
        return { score, level: REP_LEVEL(score), review_count: rv.length, host_rating: avg(hostR) && +avg(hostR).toFixed(2), host_reviews: hostR.length, member_rating: avg(memR) && +avg(memR).toFixed(2), member_reviews: memR.length,
          attendance_pct: A == null ? null : Math.round(A), thanks, meetings_done: done, formula: "rep-1", components: target === (me() || {}).id ? { V: V && Math.round(V), A: A && Math.round(A), S, U: Uc, H } : null };
      },
      async userReviews(id) { return db.reviews.filter((r) => r.target_id === id && r.status === "visible").sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => { const w = db.users.find((x) => x.id === r.reviewer_id) || {}; const p = db.posts.find((x) => x.id === r.meeting_id) || {};
        return { ...r, reviewer: { id: w.id, nickname: w.nickname, avatar_url: w.avatar_url }, meeting_title: p.text }; }); },
      async reviewTargets(postId) {
        const u = me(); if (!u) return [];
        const e = db.events.find((x) => x.post_id === postId); if (!e || e.status === "cancelled") return [];
        const end = new Date(e.ends_at || new Date(e.starts_at).getTime() + 3 * 3600e3).getTime();
        if (!(end < Date.now() && end + 7 * 86400e3 > Date.now())) return [];
        const att = (uid2) => uid2 === e.host_id || uid2 === e.cohost_id || db.members.some((m) => m.post_id === postId && m.user_id === uid2 && m.status === "going" && attendance(m.host_mark ?? null, m.self_mark ?? null) === "attended");
        if (!att(u.id)) return [];
        const people = [[e.host_id, "host"], ...(e.cohost_id ? [[e.cohost_id, "host"]] : []), ...db.members.filter((m) => m.post_id === postId && m.status === "going").map((m) => [m.user_id, "participant"])];
        const seen = new Set();
        return people.filter(([x]) => x !== u.id && att(x) && !seen.has(x) && seen.add(x)).map(([x, role]) => { const w = db.users.find((y) => y.id === x) || {};
          return { user_id: x, nickname: w.nickname, avatar_url: w.avatar_url, role, done: db.reviews.some((r) => r.meeting_id === postId && r.reviewer_id === u.id && r.target_id === x) }; });
      },
      async reviewSubmit(postId, target, rating, tags, comment) {
        const u = need(); const t = (await this.reviewTargets(postId)).find((x) => x.user_id === target);
        if (!t) throw new Error("Отзыв могут оставить только подтвержденные участники в течение 7 дней после встречи");
        if (!(rating >= 1 && rating <= 5)) throw new Error("Поставьте оценку от 1 до 5");
        const ex = db.reviews.find((r) => r.meeting_id === postId && r.reviewer_id === u.id && r.target_id === target); if (ex) return { id: ex.id, repeat: true };
        const c = cleanOrThrow(String(comment || "").trim().slice(0, 500), "review");
        const r = { id: uid(), meeting_id: postId, reviewer_id: u.id, target_id: target, target_role: t.role, rating, tags: (tags || []).filter((x) => REVIEW_TAGS[x]), comment: c.text || null, status: c.verdict === "hold" ? "pending" : "visible", created_at: nowISO() };
        db.reviews.push(r); save(); return { id: r.id };
      },
      async reviewsPending() {
        const u = me(); if (!u) return [];
        const out = [];
        for (const e of db.events) { const p = db.posts.find((x) => x.id === e.post_id); if (!p || p.category !== "meetup") continue; const t = await this.reviewTargets(e.post_id); const left = t.filter((x) => !x.done).length; if (left) out.push({ post_id: e.post_id, title: p.text.slice(0, 80), ended_at: e.ends_at, left_count: left }); }
        return out;
      },
      /* ---------- встречи ---------- */
      async meetingInfo(postId) {
        const e = db.events.find((x) => x.post_id === postId); if (!e) return null; const u = me();
        const mem = db.members.filter((m) => m.post_id === postId).map((m) => { const w = db.users.find((x) => x.id === m.user_id) || {}; return { user_id: m.user_id, nickname: w.nickname, avatar_url: w.avatar_url, status: m.status || "going", attendance: attendance(m.host_mark ?? null, m.self_mark ?? null), host_mark: m.host_mark ?? null, self_mark: m.self_mark ?? null }; });
        const role = !u ? null : e.host_id === u.id ? "host" : e.cohost_id === u.id ? "cohost" : mem.some((m) => m.user_id === u.id && m.status === "going") ? "member" : null;
        const host = db.users.find((x) => x.id === e.host_id) || {};
        return { ...e, role, members: mem, host: { id: host.id, nickname: host.nickname, avatar_url: host.avatar_url } };
      },
      async meetingJoin(postId) {
        const u = need(); const e = db.events.find((x) => x.post_id === postId); if (!e) throw new Error("Встреча не найдена");
        if (e.status === "cancelled") throw new Error("Встреча отменена"); if (new Date(e.starts_at) < Date.now()) throw new Error("Встреча уже началась");
        let m = db.members.find((x) => x.post_id === postId && x.user_id === u.id);
        if (m && m.status === "excluded") throw new Error("Организатор исключил вас из этой встречи");
        const n = db.members.filter((x) => x.post_id === postId && (x.status || "going") === "going").length;
        if (e.capacity && n >= e.capacity && !(m && m.status === "going")) throw new Error("Мест нет");
        if (m) m.status = "going"; else db.members.push((m = { post_id: postId, user_id: u.id, status: "going" }));
        save(); return { ok: true, chat_id: e.chat_id || null };
      },
      async meetingLeave(postId) { const u = need(); const m = db.members.find((x) => x.post_id === postId && x.user_id === u.id); if (m) { m.status = "withdrawn"; m.withdrawn_at = nowISO(); } save(); },
      async meetingMark(postId, target, val) {
        const u = need(); const e = db.events.find((x) => x.post_id === postId); if (new Date(e.starts_at) > Date.now()) throw new Error("Отмечать можно после начала встречи");
        const m = db.members.find((x) => x.post_id === postId && x.user_id === target && x.status === "going"); if (!m) throw new Error("Участник не найден");
        if (target === u.id) m.self_mark = val; else if (u.id === e.host_id || u.id === e.cohost_id) m.host_mark = val; else throw new Error("Отмечать других может только организатор");
        save(); return attendance(m.host_mark ?? null, m.self_mark ?? null);
      },
      async meetingCancel(postId, reason) { const u = need(); const e = db.events.find((x) => x.post_id === postId); if (e.host_id !== u.id) throw new Error("Только организатор встречи"); e.status = "cancelled"; e.cancel_reason = reason || "Организатор отменил встречу"; db.members.filter((m) => m.post_id === postId && m.status === "going").forEach((m) => db.notifs.push({ id: uid(), user_id: m.user_id, actor_id: u.id, type: "meeting", post_id: postId, text: e.cancel_reason, read: false, created_at: nowISO() })); save(); },
      async meetingSetCohost(postId, target) { const u = need(); const e = db.events.find((x) => x.post_id === postId); if (e.host_id !== u.id) throw new Error("Только организатор встречи"); e.cohost_id = target || null; save(); },
      async meetingExclude(postId, target, reason) { const u = need(); const e = db.events.find((x) => x.post_id === postId); if (u.id !== e.host_id && u.id !== e.cohost_id) throw new Error("Только организатор встречи"); if (target === e.host_id) throw new Error("Нельзя исключить организатора"); const m = db.members.find((x) => x.post_id === postId && x.user_id === target); if (m) m.status = "excluded"; db.bans.push({ id: uid(), user_id: target, kind: "restricted", scope: "meeting", scope_id: postId, rule: "minor", reason: reason || "Исключен организатором встречи", status: "active", starts_at: nowISO(), created_at: nowISO() }); save(); },
      /* ---------- общие чаты ---------- */
      async chatList() {
        const u = me(); if (!u) return [];
        const blocked = blockedByMe();
        const mine = new Set(db.events.filter((e) => e.chat_id && (e.host_id === u.id || e.cohost_id === u.id || db.members.some((m) => m.post_id === e.post_id && m.user_id === u.id && m.status === "going"))).map((e) => e.chat_id));
        const dist = (u.district || "").replace(/ район$/, "");
        return db.chats.filter((c) => c.kind === "city" || mine.has(c.id) || (c.kind === "district" && c.title.startsWith(dist) && dist)).map((c) => {
          const ms = db.chatMsgs.filter((m) => m.chat_id === c.id && m.mod_status === "ok" && !blocked.has(m.sender_id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
          const last = ms[ms.length - 1]; const lw = last && db.users.find((x) => x.id === last.sender_id);
          const lr = (u.chatRead || {})[c.id] || "";
          return { id: c.id, kind: c.kind, title: c.title, district: c.district, post_id: c.post_id, last_message_at: last ? last.created_at : null, last_text: last ? last.text : null, last_nick: lw ? lw.nickname : null,
            unread: ms.filter((m) => m.sender_id !== u.id && m.created_at > lr).length, member: true, role: null };
        }).sort((a, b) => (b.kind === "city") - (a.kind === "city") || String(b.last_message_at).localeCompare(String(a.last_message_at)));
      },
      async chatPage(chatId, before) {
        const u = me(); const blocked = blockedByMe();
        return db.chatMsgs.filter((m) => m.chat_id === chatId && (m.mod_status === "ok" || (u && m.sender_id === u.id)) && !blocked.has(m.sender_id) && (!before || m.created_at < before))
          .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 40).map((m) => {
            const w = db.users.find((x) => x.id === m.sender_id) || {}, r = m.reply_to && db.chatMsgs.find((x) => x.id === m.reply_to), rw = r && db.users.find((x) => x.id === r.sender_id);
            const rs = db.reactions.filter((x) => x.message_id === m.id && !blocked.has(x.user_id)); const agg = {}; rs.forEach((x) => (agg[x.emoji] = (agg[x.emoji] || 0) + 1));
            return { id: m.id, chat_id: m.chat_id, sender_id: m.sender_id, nickname: w.nickname, avatar_url: w.avatar_url, text: m.text, mod_status: m.mod_status, created_at: m.created_at,
              reply_to: m.reply_to || null, reply_nick: rw ? rw.nickname : null, reply_text: r ? r.text.slice(0, 80) : null, reactions: agg, mine_reactions: u ? rs.filter((x) => x.user_id === u.id).map((x) => x.emoji) : [] };
          });
      },
      async chatSend(chatId, text, key, replyTo) {
        const u = need(); const c = db.chats.find((x) => x.id === chatId); if (!c) throw new Error("Чат не найден");
        if (key) { const ex = db.chatMsgs.find((m) => m.sender_id === u.id && m.client_key === key); if (ex) return ex; }
        const r = cleanOrThrow(String(text || "").trim().slice(0, 1000), "chat"); if (!r.text) throw new Error("Пустое сообщение");
        const recent = db.chatMsgs.filter((m) => m.sender_id === u.id && Date.now() - new Date(m.created_at) < 60e3);
        if (recent.length >= 10) throw new Error("Слишком часто. Попробуйте немного позже");
        if (recent.some((m) => m.raw === text.trim())) throw new Error("Такое же сообщение уже отправлено. Подождите минуту");
        const m = { id: uid(), chat_id: chatId, sender_id: u.id, text: r.text, raw: text.trim(), client_key: key || null, reply_to: replyTo || null, mod_status: r.verdict === "hold" ? "pending" : "ok", created_at: nowISO() };
        db.chatMsgs.push(m); (u.chatRead = u.chatRead || {})[chatId] = m.created_at; save(); emit("chatmsg", m); return m;
      },
      async chatRead(chatId) { const u = me(); if (!u) return; (u.chatRead = u.chatRead || {})[chatId] = nowISO(); save(); },
      async chatReact(msgId, emoji) { const u = need(); const i = db.reactions.findIndex((x) => x.message_id === msgId && x.user_id === u.id && x.emoji === emoji); if (i >= 0) { db.reactions.splice(i, 1); save(); return false; } db.reactions.push({ message_id: msgId, user_id: u.id, emoji }); save(); return true; },
      subscribeChat(chatId, cb) { const f = (t, d) => { if (t === "chatmsg" && d.chat_id === chatId) cb("insert", d); }; listeners.push(f); return () => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); }; },
      async chatRestrict() { need(); },
      /* ---------- медиа ---------- */
      async changeEmail(email) { const u = need(); email = String(email || "").trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Проверьте правильность почты"); if (db.users.some((x) => x.email === email)) return; u.email = email; save(); },
      async myReports() { const u = me(); return u ? db.reports.filter((r) => r.reporter_id === u.id).map((r) => ({ reason: r.reason, status: r.status, created_at: r.created_at })) : []; },
      async mediaRetry(id) { const m = db.media.find((x) => x.id === id); if (m) { m.state = "processing"; m.error = null; save(); demoProcess(m); } },
      async mediaView() {},
      async mediaSigned(url) { return url; },
      /* ---------- NEAR Shield: панель администратора (демо) ---------- */
      async staffRole() { const u = me(); return { admin: !!(u && u.is_admin), moderator: !!(u && (u.is_admin || u.is_moderator)), auditor: !!(u && u.is_admin), mfa_required: false, aal: "aal2" }; },
      async shieldOverview() { return { active_bans: db.bans.filter((b) => b.kind === "ban" && b.status === "active" && (!b.expires_at || b.expires_at > nowISO())).length, evasion: 1, appeals: db.appeals.filter((a) => ["pending", "in_review"].includes(a.status)).length, reports: db.reports.filter((r) => r.status === "open").length, queue: 2, overdue_appeals: 0 }; },
      async shieldFind(q) { q = String(q || "").toLowerCase().replace(/^@/, ""); return db.users.filter((u) => !q || (u.nickname || "").startsWith(q) || u.id === q).slice(0, 20).map((u) => ({ id: u.id, nickname: u.nickname, name: u.name, state: accState(u.id).state, risk: u.id === "u-spam" ? 87 : 0, created_at: u.created_at })); },
      async shieldUserCard(id) {
        const u = db.users.find((x) => x.id === id); if (!u) throw new Error("Пользователь не найден");
        const rep = await this.reputation(id);
        return { user: { id: u.id, nickname: u.nickname, name: u.name, created_at: u.created_at, verified: !!u.verified }, account: accState(id), reputation: rep,
          risk: id === "u-spam" ? 87 : 0, hold: false,
          risk_events: id === "u-spam" ? [{ type: "evasion", weight: 35, confirmed: false }, { type: "mass_reg", weight: 20, confirmed: false }, { type: "violation", weight: 20, confirmed: true }, { type: "suspicious", weight: 12, confirmed: false }] : [],
          reports: { total: id === "u-spam" ? 12 : db.reports.filter((r) => r.target_user === id).length, confirmed: id === "u-spam" ? 5 : 0, rejected: id === "u-spam" ? 4 : 0, open: id === "u-spam" ? 3 : 0 },
          links: id === "u-spam" ? [{ id: "l1", candidate: "u-max", nickname: "maksat", evidence: { match: "installation" }, status: "pending" }] : [],
          decisions: db.bans.filter((b) => b.user_id === id).map((b) => ({ id: b.id, no: b.decision_no, kind: b.kind, scope: b.scope || "global", rule: b.rule, reason: b.reason, starts_at: b.starts_at, expires_at: b.expires_at || null, status: b.status, moderator: (db.users.find((x) => x.id === b.moderator_id) || {}).nickname })),
          appeals: db.appeals.filter((a) => a.user_id === id).map((a) => ({ id: a.id, ban: a.ban_id, message: a.message, status: a.status, due_at: a.due_at })),
          sessions: db.sessions.filter((x) => x.user_id === id).slice(-5).reverse().map((x) => ({ device: x.device, status: x.status, at: x.created_at })), rules: BAN_RULES };
      },
      async shieldSanction(target, rule, kind, hours, reason) {
        const u = need(); if (!u.is_admin && !u.is_moderator) throw new Error("Только для модераторов");
        if (!BAN_RULES[rule]) throw new Error("Выберите правило из матрицы"); if (String(reason || "").trim().length < 5) throw new Error("Укажите причину решения");
        if (target === u.id) throw new Error("Нельзя выносить решение о себе");
        const no = "NS-" + String(241 + db.bans.length).padStart(5, "0");
        const b = { id: uid(), decision_no: no, user_id: target, kind, scope: "global", rule, reason: reason.trim(), starts_at: nowISO(), expires_at: kind === "warning" || hours == null ? null : new Date(Date.now() + hours * 3600e3).toISOString(), status: "active", moderator_id: u.id, created_at: nowISO() };
        db.bans.push(b); if (kind === "ban") db.sessions.forEach((x) => { if (x.user_id === target && x.status !== "revoked") { x.status = "revoked"; x.reason = "banned"; } });
        db.audit.push({ id: db.audit.length + 1, actor_id: u.id, action: "sanction", target_id: target, details: { no, rule, kind, hours, reason }, created_at: nowISO() });
        save(); return { id: b.id, decision_no: no, expires_at: b.expires_at };
      },
      async shieldRevoke(banId, reason) { const u = need(); const b = db.bans.find((x) => x.id === banId); if (!b) throw new Error("Решение не найдено"); if (String(reason || "").trim().length < 5) throw new Error("Укажите причину"); b.status = "revoked"; b.revoked_at = nowISO(); db.audit.push({ id: db.audit.length + 1, actor_id: u.id, action: "sanction_revoke", target_id: b.user_id, details: { no: b.decision_no, reason }, created_at: nowISO() }); save(); },
      async shieldExtend(banId, days, reason) { const u = need(); const b = db.bans.find((x) => x.id === banId); if (!b || !b.expires_at) throw new Error("Действующий срочный бан не найден"); if (days < 1 || days > 30) throw new Error("Продление — от 1 до 30 дней"); if (String(reason || "").trim().length < 10) throw new Error("Опишите доказательства обхода"); b.expires_at = new Date(Math.max(new Date(b.expires_at), Date.now() + days * 86400e3)).toISOString(); db.audit.push({ id: db.audit.length + 1, actor_id: u.id, action: "sanction_extend", target_id: b.user_id, details: { days, reason }, created_at: nowISO() }); save(); },
      async shieldLinkDecide() { return { ok: true }; },
      async riskDecide() {},
      async appealDecide(id, overturn, note) { const u = need(); const a = db.appeals.find((x) => x.id === id); if (!a) throw new Error("Апелляция не найдена"); const b = db.bans.find((x) => x.id === a.ban_id); if (b && b.moderator_id === u.id) throw new Error("Апелляцию рассматривает другой модератор"); a.status = overturn ? "overturned" : "upheld"; a.note = note; if (overturn && b) b.status = "revoked"; save(); },
      async shieldQueue() { return db.appeals.filter((a) => a.status === "pending").map((a) => ({ id: "q-" + a.id, content_type: "appeal", content_id: a.id, user_id: a.user_id, nickname: (db.users.find((x) => x.id === a.user_id) || {}).nickname, reason: "appeal", priority: 3, created_at: a.created_at, preview: a.message })); },
      async auditList() { return db.audit.slice().reverse(); },
      async mediaDecide() {},
      async signOut() { const cs = curSess(); if (cs && cs.status !== "revoked") { cs.status = "revoked"; cs.reason = "logout"; } db.session = null; db.sid = null; save(); emit("auth", null); },
      async resetPassword(email) {
        email = (email || "").trim().toLowerCase();
        if (!db.users.some((x) => x.email === email && x.pwh)) throw new Error("Аккаунт с таким email не найден на этом устройстве");
        return { localEmail: email };
      },
      async updatePassword(password, email) {
        if ((password || "").length < 6) throw new Error("Пароль должен быть не короче 6 символов");
        const u = email ? db.users.find((x) => x.email === email) : me();
        if (!u) throw new Error("Аккаунт не найден");
        u.pwh = await hash(password); db.session = u.id; save(); emit("auth", prof(u));
      },
      async signInWithGoogle() { throw new Error("Вход через Google работает, когда приложение подключено к серверу"); },
      async resendConfirm() { return {}; },
      pushAvailable: false,
      async pushSave() { throw new Error("Push-уведомления работают, когда приложение подключено к серверу"); },
      async pushRemove() {},
      async deleteAccount() {
        const u = need(), id = u.id;
        const myPosts = new Set(db.posts.filter((p) => p.user_id === id).map((p) => p.id));
        db.posts = db.posts.filter((p) => p.user_id !== id);
        ["media", "comments", "likes", "saved", "events", "members", "notifs"].forEach((k) => (db[k] = db[k].filter((x) => !myPosts.has(x.post_id) && x.user_id !== id && x.actor_id !== id)));
        const myConv = new Set((db.convs || []).filter((c) => c.user_a === id || c.user_b === id).map((c) => c.id));
        if (db.convs) db.convs = db.convs.filter((c) => !myConv.has(c.id));
        if (db.msgs) db.msgs = db.msgs.filter((m) => !myConv.has(m.conversation_id));
        if (db.friends) db.friends = db.friends.filter((f) => f.requester_id !== id && f.addressee_id !== id);
        if (db.blocks) db.blocks = db.blocks.filter((b) => b.blocker_id !== id && b.blocked_id !== id);
        if (db.reports) db.reports = db.reports.filter((r) => r.reporter_id !== id);
        db.users = db.users.filter((x) => x.id !== id); db.session = null; save(); emit("auth", null);
      },
      async touchSeen() { const u = me(); if (u && u.show_seen !== false) { u.last_seen_at = nowISO(); save(); } },
      async signOutAll() { return this.signOut(); },
      async updateProfile({ name, nickname, district, avatarFile, instagram, gender, acceptRules, bio, show_seen }) {
        const u = need();
        if (nickname !== undefined && String(nickname).trim().toLowerCase().replace(/^@/, "") !== u.nickname) { const r = await this.nicknameAvailable(nickname); if (!r.ok) throw new Error(r.reason); u.nickname = r.nickname; if (!u.name || u.name === "Пользователь") u.name = r.nickname; }
        if (gender !== undefined && !u.gender && ["m", "f"].includes(gender)) u.gender = gender;
        if (acceptRules && !u.accepted_rules_at) u.accepted_rules_at = nowISO();
        if (name !== undefined) { if (!name.trim()) throw new Error("Имя не может быть пустым"); u.name = mask(name.trim()); }
        if (instagram !== undefined) u.instagram = cleanInsta(instagram);
        if (district !== undefined) u.district = district;
        if (bio !== undefined) { if (String(bio).length > 160) throw new Error("Описание не длиннее 160 символов"); u.bio = mask(String(bio).trim()) || null; }
        if (show_seen !== undefined) { u.show_seen = !!show_seen; if (!show_seen) u.last_seen_at = null; }
        if (avatarFile) { validateFile(avatarFile); u.avatar_url = await blobToDataURL(await compressImage(avatarFile, 400, 0.8)); }
        save(); emit("auth", prof(u)); return prof(u);
      },

      async listPosts({ lat, lng, radius, bounds, category, limit = 300, period, friends } = {}) {
        const b = bounds || boundsAround(lat, lng, radius);
        const bl = blockedByMe(), u = me();
        const nowS = nowISO();
        let list = db.posts.filter((p) => !bl.has(p.user_id) && (p.status === "active" || p.status === "closed") && (!p.expires_at || p.expires_at > nowS) && p.lat >= b.s && p.lat <= b.n && p.lng >= b.w && p.lng <= b.e);
        if (category) list = list.filter((p) => (Array.isArray(category) ? category.includes(p.category) : p.category === category));
        if (radius) list = list.filter((p) => dist({ lat, lng }, p) <= radius);
        if (period) list = list.filter((p) => periodOk(p, period));
        if (friends) list = list.filter((p) => u && friendRow(u.id, p.user_id) && friendRow(u.id, p.user_id).status === "accepted");
        return list.sort(byNewest).slice(0, limit).map(shape);
      },
      // лента порциями: sort = new (курсор {ts, id}), near (курсор {d, id}), top (курсор {o})
      async feedPage({ lat, lng, radius, category, limit = 12, before, after, sort = "new", period, friends } = {}) {
        let list = await this.listPosts({ lat, lng, radius, category, limit: 100000, period, friends });
        limit = Math.min(limit, 12);
        if (sort === "near" || sort === "top") {
          const at = { lat, lng };
          list.forEach((p) => { p._d = dist(at, p); p._s = score(p, p._d); });
          if (sort === "near") {
            list.sort((a, b2) => a._d - b2._d || (a.id > b2.id ? 1 : -1));
            if (before) list = list.filter((p) => p._d > before.d || (p._d === before.d && p.id > before.id));
            const page = list.slice(0, limit), l2 = page[page.length - 1];
            await new Promise((r) => setTimeout(r, 120));
            return { posts: page, next: l2 ? { d: l2._d, id: l2.id } : before, done: list.length <= limit };
          }
          list.sort((a, b2) => b2._s - a._s || b2.created_at.localeCompare(a.created_at));
          const o = (before && before.o) || 0, page = list.slice(o, o + limit);
          await new Promise((r) => setTimeout(r, 120));
          return { posts: page, next: { o: o + page.length }, done: o + limit >= list.length };
        }
        if (before) list = list.filter((p) => olderThan(p, before));
        if (after) list = list.filter((p) => !olderThan(p, after) && !(p.created_at === after.ts && p.id === after.id));
        const page = after ? list : list.slice(0, limit);
        await new Promise((r) => setTimeout(r, 120)); // как по сети
        return { posts: page, next: page.length ? cursorOf(page[page.length - 1]) : before || null, done: after ? true : list.length <= limit };
      },
      async recentStats({ lat, lng, radius, category } = {}) {
        const since = new Date(Date.now() - 3600e3).toISOString();
        const list = (await this.listPosts({ lat, lng, radius, category, limit: 100000 })).filter((p) => p.created_at > since);
        const by = {}; list.forEach((p) => (by[p.category] = (by[p.category] || 0) + 1)); return by;
      },
      async getPost(id) { const p = db.posts.find((x) => x.id === id && x.status !== "deleted"); if (!p) throw new Error("Публикация удалена или не найдена"); return shape(p); },
      async createPost({ category, text, lat, lng, files = [], event, exact = false, is_sos = false, edits }, onProgress = () => {}) {
        const u = need();
        const cl = cleanOrThrow(String(text || ""), "post");
        if (!CATS[category]) throw new Error("Выберите тип публикации");
        if (!text || !text.trim()) throw new Error("Добавьте описание");
        if (lat == null || lng == null) throw new Error("Укажите место на карте");
        if (files.length > 5) throw new Error("Не больше 5 вложений в публикации");
        if (is_sos && db.posts.some((p) => p.user_id === u.id && p.is_sos && p.status === "active" && (!p.expires_at || p.expires_at > nowISO())))
          throw new Error("У вас уже есть активный SOS. Закройте его, чтобы отправить новый");
        if (!exact) ({ lat, lng } = snap(lat, lng));
        const id = uid(), t = nowISO();
        const media = [];
        for (let i = 0; i < files.length; i++) {
          const kind = validateFile(files[i]);
          if (kind === "video") {
            // демо: видео живет только в этой вкладке (после перезагрузки пропадет); на сервере его обработает worker
            const meta = await probeVideo(files[i]).catch(() => ({}));
            media.push({ id: uid(), post_id: id, url: URL.createObjectURL(files[i]), type: "video", state: "processing", w: meta.w || null, h: meta.h || null, duration: meta.duration || null, edit: (edits && edits[i]) || {} });
            continue;
          }
          onProgress(`Сжимаем фото ${i + 1} из ${files.length}...`, i / files.length);
          const full = await compressImage(files[i], 1080, 0.72, true);
          media.push({ id: uid(), post_id: id, url: await blobToDataURL(full.blob), thumb: await blobToDataURL(await compressImage(files[i], 360, 0.7)), w: full.w, h: full.h, type: "image" });
        }
        if (u.banned) throw new Error("Аккаунт заблокирован модератором");
        const ttl = is_sos ? 3 * 3600e3 : category === "incident" ? 86400e3 : 0;
        const waiting = media.some((m) => m.state === "processing") || cl.verdict === "hold";
        db.posts.push({ id, user_id: u.id, category, text: cl.text.trim().slice(0, 1000), lat, lng, status: waiting ? "draft" : "active", created_at: t, updated_at: t, is_sos: !!is_sos, exact: !!exact,
          expires_at: ttl ? new Date(Date.now() + ttl).toISOString() : null });
        db.media.push(...media);
        if (event && event.starts_at) {
          const ev = { post_id: id, starts_at: event.starts_at, ends_at: event.ends_at || null, capacity: event.capacity || null, host_id: u.id, status: "scheduled", meet_cat: category === "meetup" ? event.meet_cat || "other" : null };
          if (category === "meetup") { ev.chat_id = "chat-" + id; db.chats.push({ id: ev.chat_id, kind: "meeting", title: cl.text.slice(0, 60), post_id: id }); }
          db.events.push(ev);
        }
        try { save(); } catch (e) {
          db.posts = db.posts.filter((p) => p.id !== id); db.media = db.media.filter((m) => m.post_id !== id); db.events = db.events.filter((x) => x.post_id !== id);
          throw e;
        }
        media.filter((m) => m.state === "processing").forEach(demoProcess);
        const p = shape(db.posts.find((x) => x.id === id)); if (p.status === "active") emit("post", p); return p;
      },
      async updatePost(id, { text, category, status, event }) {
        const u = need(), p = db.posts.find((x) => x.id === id);
        if (!p || p.user_id !== u.id) throw new Error("Можно менять только свои публикации");
        if (text !== undefined) { if (!text.trim()) throw new Error("Описание не может быть пустым"); p.text = mask(text.trim().slice(0, 1000)); }
        if (category) p.category = category;
        if (status) {
          if (p.status === "hidden" && !u.is_admin) throw new Error("Публикация скрыта модератором");
          // SOS отменен: история остается, откликнувшиеся получают уведомление
          if (p.status === "active" && status === "closed" && p.is_sos) {
            new Set([...db.comments.filter((c) => c.post_id === id).map((c) => c.user_id), ...db.likes.filter((l) => l.post_id === id).map((l) => l.user_id)])
              .forEach((to) => { if (to !== u.id) notify(to, "sos_closed", id, "отменил(а) SOS: помощь больше не нужна"); });
          }
          if (status === "closed" && p.status !== "closed") p.resolved_at = nowISO();
          if (status === "active" && p.status === "closed") p.resolved_at = null;
          p.status = status;
        }
        if (event) {
          const ev = db.events.find((x) => x.post_id === id);
          if (ev) Object.assign(ev, event); else db.events.push({ post_id: id, ...event });
        }
        p.updated_at = nowISO(); save(); return shape(p);
      },
      async deletePost(id) {
        const u = need(), p = db.posts.find((x) => x.id === id);
        if (!p || p.user_id !== u.id) throw new Error("Можно удалять только свои публикации");
        db.posts = db.posts.filter((x) => x.id !== id);
        ["media", "comments", "likes", "saved", "events", "members", "notifs"].forEach((k) => (db[k] = db[k].filter((x) => x.post_id !== id)));
        save();
      },
      async toggleLike(id) {
        const u = need(), i = db.likes.findIndex((l) => l.post_id === id && l.user_id === u.id);
        if (i >= 0) db.likes.splice(i, 1);
        else { db.likes.push({ post_id: id, user_id: u.id }); const p = db.posts.find((x) => x.id === id); if (p) notify(p.user_id, "like", id, "оценил(а) вашу публикацию"); }
        save(); return { liked: i < 0, likes: db.likes.filter((l) => l.post_id === id).length };
      },
      async toggleSave(id) {
        const u = need(), i = db.saved.findIndex((l) => l.post_id === id && l.user_id === u.id);
        if (i >= 0) db.saved.splice(i, 1); else db.saved.push({ post_id: id, user_id: u.id, created_at: nowISO() });
        save(); return i < 0;
      },
      async listComments(id) {
        const bl = blockedByMe();
        return db.comments.filter((c) => c.post_id === id && !bl.has(c.user_id)).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((c) => {
          const a = db.users.find((x) => x.id === c.user_id);
          return { id: c.id, text: c.text, created_at: c.created_at, user_id: c.user_id, parent_id: c.parent_id || null, author: { id: c.user_id, name: a ? a.name : "Пользователь", avatar_url: a && a.avatar_url, verified: !!(a && a.verified) } };
        });
      },
      async addComment(id, text, parentId) {
        const u = need(); text = (text || "").trim();
        if (!text) throw new Error("Комментарий пустой");
        if (u.banned) throw new Error("Аккаунт заблокирован модератором");
        let par = parentId ? db.comments.find((c) => c.id === parentId && c.post_id === id) : null;
        if (parentId && !par) throw new Error("Комментарий для ответа не найден");
        if (par && par.parent_id) par = db.comments.find((c) => c.id === par.parent_id) || par;
        const row = { id: uid(), post_id: id, user_id: u.id, text: mask(text.slice(0, 500)), created_at: nowISO(), parent_id: par ? par.id : null };
        db.comments.push(row);
        const p = db.posts.find((x) => x.id === id); if (p) notify(p.user_id, "comment", id, "прокомментировал(а): " + text.slice(0, 60));
        if (par && p && par.user_id !== p.user_id) notify(par.user_id, "reply", id, "ответил(а) на ваш комментарий: " + text.slice(0, 60));
        save();
        return { ...row, author: { id: u.id, name: u.name, avatar_url: u.avatar_url, verified: !!u.verified } };
      },
      async deleteComment(cid) {
        const u = need(), c = db.comments.find((x) => x.id === cid);
        if (!c || c.user_id !== u.id) throw new Error("Можно удалять только свои комментарии");
        db.comments = db.comments.filter((x) => x.id !== cid && x.parent_id !== cid); save();
      },
      async toggleJoin(id) {
        const u = need(), ev = db.events.find((e) => e.post_id === id);
        if (!ev) throw new Error("Это не событие");
        const i = db.members.findIndex((m) => m.post_id === id && m.user_id === u.id);
        const cnt = db.members.filter((m) => m.post_id === id).length;
        if (i < 0 && ev.capacity && cnt >= ev.capacity) throw new Error("Мест больше нет");
        if (i >= 0) db.members.splice(i, 1);
        else { db.members.push({ post_id: id, user_id: u.id }); const p = db.posts.find((x) => x.id === id); if (p) notify(p.user_id, "join", id, "присоединился(ась) к вашему событию"); }
        save(); return { joined: i < 0, members: db.members.filter((m) => m.post_id === id).length };
      },
      async myPosts() { const u = need(); return db.posts.filter((p) => p.user_id === u.id && p.status !== "deleted").sort((a, b) => b.created_at.localeCompare(a.created_at)).map(shape); },
      async savedPosts() {
        const u = need();
        return db.saved.filter((s) => s.user_id === u.id).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
          .map((s) => db.posts.find((p) => p.id === s.post_id)).filter(Boolean).map(shape);
      },
      async stats() {
        const u = me(); if (!u) return { posts: 0, saved: 0, events: 0 };
        const mine = new Set(db.posts.filter((p) => p.user_id === u.id).map((p) => p.id));
        return { posts: mine.size, saved: db.saved.filter((s) => s.user_id === u.id).length, likes: db.likes.filter((l) => mine.has(l.post_id) && l.user_id !== u.id).length,
          events: db.members.filter((m) => m.user_id === u.id && (m.status || "going") === "going").length + db.events.filter((e) => e.host_id === u.id && (db.posts.find((p) => p.id === e.post_id) || {}).category === "meetup").length };
      },
      async notifications() {
        const u = me(); if (!u) return [];
        return db.notifs.filter((n) => n.user_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50).map((n) => {
          const a = db.users.find((x) => x.id === n.actor_id);
          return { ...n, actor: { id: n.actor_id, name: a ? a.name : (n.actor_id ? "Кто-то" : "NEAR"), avatar_url: a && a.avatar_url } };
        });
      },

      /* ----- профили, друзья, блокировки ----- */
      async getProfile(id) {
        const x = db.users.find((u) => u.id === id); if (!x) throw new Error("Пользователь не найден");
        const u = me(), f = u ? friendRow(u.id, id) : null;
        let friendship = "none";
        if (f) friendship = f.status === "accepted" ? "friends" : f.requester_id === (u && u.id) ? "requested" : "incoming";
        return { ...pubProfile(x), friendship, blocked: !!u && db.blocks.some((b) => b.blocker_id === u.id && b.blocked_id === id),
          posts: db.posts.filter((p) => p.user_id === id && p.status === "active").length,
          friends: db.friends.filter((f2) => f2.status === "accepted" && (f2.requester_id === id || f2.addressee_id === id)).length };
      },
      async userPosts(id) { return db.posts.filter((p) => p.user_id === id && (p.status === "active" || p.status === "closed")).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 30).map(shape); },
      async searchUsers(q) {
        const u = me(); q = (q || "").trim().toLowerCase(); if (q.length < 2) return [];
        const bl = blockedByMe();
        return db.users.filter((x) => (!u || x.id !== u.id) && !bl.has(x.id) && x.name.toLowerCase().includes(q)).slice(0, 20).map(pubProfile);
      },
      async friends() {
        const u = need();
        return db.friends.filter((f) => f.status === "accepted" && (f.requester_id === u.id || f.addressee_id === u.id))
          .map((f) => pubProfile(db.users.find((x) => x.id === (f.requester_id === u.id ? f.addressee_id : f.requester_id)))).filter(Boolean);
      },
      async friendRequests() {
        const u = need();
        const P = (id) => pubProfile(db.users.find((x) => x.id === id));
        return {
          incoming: db.friends.filter((f) => f.status === "pending" && f.addressee_id === u.id).map((f) => P(f.requester_id)).filter(Boolean),
          outgoing: db.friends.filter((f) => f.status === "pending" && f.requester_id === u.id).map((f) => P(f.addressee_id)).filter(Boolean)
        };
      },
      async sendFriendRequest(id) {
        const u = need(); if (id === u.id) throw new Error("Это вы 🙂");
        if (isBlocked(u.id, id)) throw new Error("Пользователь недоступен");
        if (friendRow(u.id, id)) throw new Error("Заявка уже есть");
        db.friends.push({ requester_id: u.id, addressee_id: id, status: "pending", created_at: nowISO() });
        notify(id, "friend_request", null, "хочет добавить вас в друзья");
        if (id.startsWith("u-")) setTimeout(() => { const f = friendRow(u.id, id); if (f && f.status === "pending") { f.status = "accepted"; db.notifs.push({ id: uid(), user_id: u.id, actor_id: id, type: "friend_accept", text: "принял(а) вашу заявку в друзья", read: false, created_at: nowISO() }); save(); emit("notif", {}); } }, 3000);
        save();
      },
      async acceptFriend(id) {
        const u = need(), f = db.friends.find((x) => x.requester_id === id && x.addressee_id === u.id && x.status === "pending");
        if (!f) throw new Error("Заявка не найдена");
        f.status = "accepted"; f.accepted_at = nowISO(); notify(id, "friend_accept", null, "принял(а) вашу заявку в друзья"); save();
      },
      async removeFriend(id) { const u = need(); db.friends = db.friends.filter((f) => !((f.requester_id === u.id && f.addressee_id === id) || (f.requester_id === id && f.addressee_id === u.id))); save(); },
      async block(id) {
        const u = need(); if (id === u.id) return;
        if (!db.blocks.some((b) => b.blocker_id === u.id && b.blocked_id === id)) db.blocks.push({ blocker_id: u.id, blocked_id: id, created_at: nowISO() });
        db.friends = db.friends.filter((f) => !((f.requester_id === u.id && f.addressee_id === id) || (f.requester_id === id && f.addressee_id === u.id)));
        save();
      },
      async unblock(id) { const u = need(); db.blocks = db.blocks.filter((b) => !(b.blocker_id === u.id && b.blocked_id === id)); save(); },
      async blockedList() { const u = need(); return db.blocks.filter((b) => b.blocker_id === u.id).map((b) => pubProfile(db.users.find((x) => x.id === b.blocked_id))).filter(Boolean); },
      blockedIds: async () => blockedByMe(),

      /* ----- сообщения ----- */
      async conversations() {
        const u = need(), bl = blockedByMe();
        return db.convs.filter((c) => c.user_a === u.id || c.user_b === u.id).map((c) => {
          const other = c.user_a === u.id ? c.user_b : c.user_a, o = db.users.find((x) => x.id === other);
          const ms = db.msgs.filter((m) => m.conversation_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
          const last = ms[ms.length - 1];
          return { id: c.id, other: pubProfile(o) || { id: other, name: "Удаленный аккаунт", deleted: true }, last: last ? shapeMsg(last) : null,
            status: c.status || "accepted", initiator: c.initiator || null, request: (c.status || "accepted") !== "accepted" && c.initiator !== u.id,
            unread: ms.filter((m) => m.sender_id !== u.id && !m.read_at).length, last_message_at: c.last_message_at,
            friend: !!(friendRow(u.id, other) && friendRow(u.id, other).status === "accepted"), blocked: bl.has(other) };
        }).filter((c) => c.last).sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
      },
      async openConversation(other) {
        const u = need(); if (other === u.id) throw new Error("Нельзя написать самому себе");
        if (isBlocked(u.id, other)) throw new Error("Пользователь недоступен");
        const a = u.id < other ? u.id : other, b = u.id < other ? other : u.id;
        let c = db.convs.find((x) => x.user_a === a && x.user_b === b);
        if (!c) {
          const fr = friendRow(u.id, other);
          c = { id: uid(), user_a: a, user_b: b, created_at: nowISO(), last_message_at: nowISO(), status: fr && fr.status === "accepted" ? "accepted" : "request", initiator: u.id };
          db.convs.push(c); save();
        }
        return c.id;
      },
      async conversationRespond(cid, accept) {
        const u = need(), c = db.convs.find((x) => x.id === cid);
        if (!c || c.initiator === u.id) throw new Error("Ответить на запрос может только получатель");
        c.status = accept ? "accepted" : "declined"; save(); return c.status;
      },
      subscribeConversation(cid, cb) { const f = (t, d) => { if (t === "message" && d && d.conversation_id === cid) cb("insert", d); }; listeners.push(f); return () => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); }; },
      async conversationInfo(cid) {
        const u = need(), c = db.convs.find((x) => x.id === cid); if (!c) throw new Error("Переписка не найдена");
        const other = c.user_a === u.id ? c.user_b : c.user_a, f = friendRow(u.id, other);
        return { id: cid, other: pubProfile(db.users.find((x) => x.id === other)) || { id: other, name: "Удаленный аккаунт", deleted: true }, friend: !!(f && f.status === "accepted"), blocked: isBlocked(u.id, other),
          status: c.status || "accepted", initiator: c.initiator || null };
      },
      async messages(cid, after) { need(); return db.msgs.filter((m) => m.conversation_id === cid && (!after || m.created_at > after)).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-200).map(shapeMsg); },
      async sendMessage(cid, { text, file, kind, duration, id }, onProgress = () => {}) {
        const u = need(), c = db.convs.find((x) => x.id === cid); if (!c) throw new Error("Переписка не найдена");
        if (id && db.msgs.some((x) => x.id === id)) { const e = new Error("Это уже сделано"); e.code = "23505"; throw e; }
        if (u.banned) throw new Error("Аккаунт заблокирован модератором");
        const other = c.user_a === u.id ? c.user_b : c.user_a;
        if (isBlocked(u.id, other)) throw new Error("Пользователь недоступен");
        const st = c.status || "accepted";
        if (st !== "accepted") {
          if (c.initiator === u.id) {
            if (st === "declined") throw new Error("Собеседник отклонил запрос");
            if (db.msgs.some((x) => x.conversation_id === cid && x.sender_id === u.id)) throw new Error("Дождитесь, пока собеседник примет запрос");
            if (file || /(https?:\/\/|www\.|t\.me\/|wa\.me\/|[a-z0-9-]+\.(com|ru|kz|net|org|me|io)\b)/i.test(text || "")) throw new Error("До принятия запроса нельзя отправлять файлы и ссылки");
          } else c.status = "accepted";
        }
        const m = { id: id || uid(), conversation_id: cid, sender_id: u.id, kind: "text", text: null, media_url: null, duration: duration || null, mod_status: "ok", read_at: null, created_at: nowISO() };
        if (file) {
          const k = kind || validateChatFile(file);
          if (k === "video") throw new Error("Видео в демо-режиме не отправляется. Подключите сервер Supabase.");
          onProgress("Отправляем...");
          m.kind = k; m.media_url = await blobToDataURL(k === "image" ? await compressImage(file, 1080, 0.72) : file);
          if (text) m.text = mask(text);
        } else {
          if (!text || !text.trim()) throw new Error("Пустое сообщение");
          m.text = mask(text.trim().slice(0, 2000));
        }
        db.msgs.push(m); c.last_message_at = m.created_at;
        try { save(); } catch (e) { db.msgs.pop(); throw e; }
        if (other.startsWith("u-") && (c.status || "accepted") === "accepted") setTimeout(() => {
          const r = ["Да, конечно 👍", "Спасибо, сейчас посмотрю", "Отлично, договорились!", "Хорошо, напишу позже", "😊"];
          const rep = { id: uid(), conversation_id: cid, sender_id: other, kind: "text", text: r[Math.floor(Math.random() * r.length)] + " (демо-ответ)", mod_status: "ok", read_at: null, created_at: nowISO() };
          db.msgs.push(rep); c.last_message_at = nowISO(); save(); emit("message", shapeMsg(rep));
        }, 2000);
        return shapeMsg(m);
      },
      async deleteMessage(id) { const u = need(); const m = db.msgs.find((x) => x.id === id); if (!m || m.sender_id !== u.id) throw new Error("Можно удалять только свои сообщения"); db.msgs = db.msgs.filter((x) => x.id !== id); save(); },
      async markRead(cid) { const u = me(); if (!u) return; db.msgs.forEach((m) => { if (m.conversation_id === cid && m.sender_id !== u.id && !m.read_at) m.read_at = nowISO(); }); save(); },
      async unreadMessages() {
        const u = me(); if (!u) return 0; const mine = new Set(db.convs.filter((c) => c.user_a === u.id || c.user_b === u.id).map((c) => c.id)); const bl = blockedByMe();
        return db.msgs.filter((m) => mine.has(m.conversation_id) && m.sender_id !== u.id && !m.read_at && !bl.has(m.sender_id)).length;
      },

      /* ----- жалобы и модерация ----- */
      reasons: REASONS,
      async report({ type, id, user_id, reason, details }) {
        const u = need();
        if (db.reports.some((r) => r.reporter_id === u.id && r.target_type === type && r.target_id === id)) throw new Error("Вы уже отправили жалобу на это");
        db.reports.push({ id: uid(), reporter_id: u.id, target_type: type, target_id: id, target_user: user_id || null, reason, details: (details || "").slice(0, 500) || null, status: "open", created_at: nowISO() });
        if (type === "post") {
          const n = new Set(db.reports.filter((r) => r.target_type === "post" && r.target_id === id && r.status === "open").map((r) => r.reporter_id)).size;
          const p = db.posts.find((x) => x.id === id);
          if (n >= 3 && p && p.status === "active") { p.status = "hidden"; db.notifs.push({ id: uid(), user_id: p.user_id, actor_id: null, type: "post_hidden", post_id: id, text: "Ваша публикация скрыта по жалобам и ждет проверки модератора", read: false, created_at: nowISO() }); }
        }
        save();
      },
      async reportsList() {
        const u = need(); if (!u.is_admin) throw new Error("Только для модераторов");
        return db.reports.filter((r) => r.status === "open").sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => {
          const rep2 = db.users.find((x) => x.id === r.reporter_id), tu = db.users.find((x) => x.id === r.target_user);
          let preview = "";
          if (r.target_type === "post") { const p = db.posts.find((x) => x.id === r.target_id); preview = p ? p.text : "(удалено)"; }
          if (r.target_type === "comment") { const c = db.comments.find((x) => x.id === r.target_id); preview = c ? c.text : "(удалено)"; }
          if (r.target_type === "message") { const m = db.msgs.find((x) => x.id === r.target_id); preview = m ? (m.text || "[" + m.kind + "]") : "(удалено)"; }
          if (r.target_type === "user") preview = tu ? tu.name : "";
          const cnt = db.reports.filter((x) => x.target_type === r.target_type && x.target_id === r.target_id && x.status === "open").length;
          return { ...r, reporter: { name: rep2 ? rep2.name : "?" }, target: { id: r.target_user, name: tu ? tu.name : "?", banned: !!(tu && tu.banned) }, preview, count: cnt };
        });
      },
      async modRecentPosts() {
        const u = need(); if (!u.is_admin) throw new Error("Только для модераторов");
        return db.posts.filter((p) => p.status !== "deleted").sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 60).map(shape);
      },
      async modAction(kind, id, action) {
        const u = need(); if (!u.is_admin) throw new Error("Только для модераторов");
        if (kind === "post") { const p = db.posts.find((x) => x.id === id); if (!p) return; if (action === "delete") p.status = "deleted"; else p.status = action === "hide" ? "hidden" : "active"; if (action === "hide") notify(p.user_id, "post_hidden", p.id, "скрыл(а) вашу публикацию по правилам сообщества"); }
        if (kind === "user") { const x = db.users.find((y) => y.id === id); if (x && !x.is_admin) x.banned = action === "ban"; }
        save();
      },
      async resolveReport(id, action) {
        const u = need(); if (!u.is_admin) throw new Error("Только для модераторов");
        const r = db.reports.find((x) => x.id === id); if (!r) return;
        const same = db.reports.filter((x) => x.target_type === r.target_type && x.target_id === r.target_id && x.status === "open");
        if (action === "hide" && r.target_type === "post") { const p = db.posts.find((x) => x.id === r.target_id); if (p) p.status = "hidden"; }
        if (action === "restore" && r.target_type === "post") { const p = db.posts.find((x) => x.id === r.target_id); if (p) p.status = "active"; }
        if (action === "delete") {
          if (r.target_type === "post") { db.posts = db.posts.filter((x) => x.id !== r.target_id); }
          if (r.target_type === "comment") db.comments = db.comments.filter((x) => x.id !== r.target_id);
          if (r.target_type === "message") db.msgs = db.msgs.filter((x) => x.id !== r.target_id);
        }
        if (action === "ban" && r.target_user) { const t = db.users.find((x) => x.id === r.target_user); if (t) t.banned = true; }
        same.forEach((x) => { x.status = action === "dismiss" ? "dismissed" : "resolved"; x.resolved_at = nowISO(); });
        save();
      },
      async modAct(kind, id, action) { if (kind === "report") return this.resolveReport(id, "dismiss"); return this.modAction(kind, id, action); },
      async appeal() { throw new Error("Апелляции работают, когда приложение подключено к серверу"); },
      async appealsList() { return []; },
      async modHistory() { return { reports: [], actions: [] }; },
      async kpi() { return null; },
      async placesList() { const u = me(); if (!u) return []; return (db.places || []).filter((x) => x.user_id === u.id); },
      async placeSave(pl) {
        const u = need(); db.places = db.places || [];
        const name = String(pl.name || "").trim().slice(0, 40); if (!name) throw new Error("Назовите место");
        const row = { name, lat: Math.round(pl.lat * 1000) / 1000, lng: Math.round(pl.lng * 1000) / 1000, radius: pl.radius || 1000, notify: !!pl.notify };
        if (pl.id) Object.assign(db.places.find((x) => x.id === pl.id && x.user_id === u.id) || {}, row);
        else { if (db.places.filter((x) => x.user_id === u.id).length >= 5) throw new Error("Не больше 5 избранных мест"); db.places.push({ id: uid(), user_id: u.id, created_at: nowISO(), ...row }); }
        save();
      },
      async placeDelete(id) { const u = need(); db.places = (db.places || []).filter((x) => !(x.id === id && x.user_id === u.id)); save(); },
      async sendFeedback(text) { if (String(text || "").trim().length < 3) throw new Error("Опишите проблему подробнее"); db.feedback = db.feedback || []; db.feedback.push({ text, t: nowISO() }); save(); },
      async feedbackList() { return (db.feedback || []).map((f, i) => ({ id: i, text: f.text, created_at: f.t, name: "Демо" })); },
      async logError() {}, async track() {}, async reauth() {},
      async openReportsCount() { const u = me(); return u && u.is_admin ? db.reports.filter((r) => r.status === "open").length : 0; },
      async markNotificationsRead() { const u = me(); if (!u) return; db.notifs.forEach((n) => { if (n.user_id === u.id) n.read = true; }); save(); },
      async unreadCount() { const u = me(); return u ? db.notifs.filter((n) => n.user_id === u.id && !n.read).length : 0; },
      resetDemo() { localStorage.removeItem(KEY); load(); emit("auth", null); }
    };
  }

  /* =====================================================
     SUPABASE (реальный сервер)
     ===================================================== */
  function SupabaseBackend() {
    let sb, profile = null, session = null, blockedSet = null;
    async function myBlocks() {
      if (!session) return new Set();
      if (!blockedSet) { const { data } = await sb.from("blocks").select("blocked_id").eq("blocker_id", session.user.id); blockedSet = new Set((data || []).map((x) => x.blocked_id)); }
      return blockedSet;
    }
    const PUB = "id,name,nickname,avatar_url,district,instagram,created_at,gender,verified,last_seen_at,banned,bio";
    // v11: ИИ-проверку запускает сама база (триггер ai_fire) — клиент ничего не вызывает
    async function moderate() {}
    const authCbs = [];
    const BUCKET = "post-media";
    const POST_SELECT = "id,user_id,category,text,lat,lng,status,created_at,updated_at,is_sos,exact,expires_at,resolved_at," +
      "author:profiles!posts_user_id_fkey(id,name,nickname,avatar_url,verified),post_media!post_media_post_id_fkey(id,url,type,position,mod_status,state,error,bucket,thumb_url,poster_url,w,h,duration,edit)," +
      "likes!likes_post_id_fkey(count),comments!comments_post_id_fkey(count)," +
      "events!events_post_id_fkey(starts_at,ends_at,capacity,meet_cat,host_id,cohost_id,status,chat_id),event_members!event_members_post_id_fkey(count)";
    const one = (x) => (Array.isArray(x) ? x[0] : x) || null;
    const cnt = (x) => (Array.isArray(x) && x[0] ? x[0].count : 0);

    async function loadProfile() {
      if (!session) { profile = null; return null; }
      let { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
      if (error) console.warn(error);
      if (!data && !error) { await sb.rpc("ensure_profile"); ({ data } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle()); }
      profile = { id: session.user.id, email: session.user.email, nickname: (data && data.nickname) || null, meetings_pilot: !!(data && (data.meetings_pilot || data.is_admin)), name: (data && data.name) || session.user.email.split("@")[0], avatar_url: data && data.avatar_url, district: (data && data.district) || "",
        instagram: data && data.instagram, is_admin: !!(data && data.is_admin), is_mod: !!(data && (data.is_admin || data.is_moderator)), banned: !!(data && data.banned),
        gender: (data && data.gender) || null, verified: !!(data && data.verified) || !!session.user.email_confirmed_at, last_seen_at: data && data.last_seen_at,
        accepted_rules: !!(data && data.accepted_rules_at), bio: (data && data.bio) || null, show_seen: data ? data.show_seen !== false : true, provider: (session.user.app_metadata && session.user.app_metadata.provider) || "email" };
      blockedSet = null;
      return profile;
    }
    function need() { if (!session) throw new Error("Войдите, чтобы сделать это"); return session.user; }

    async function enrich(rows) {
      const u = session && session.user;
      // файлы скрытых модератором публикаций лежат в приватном бакете: ссылка на 10 минут (видит автор и модератор)
      // и свои файлы "на проверке" из приватного staging — тоже по короткой ссылке, только автору
      const priv = {};
      rows.forEach((r) => (r.post_media || []).forEach((m) => ["url", "thumb_url", "poster_url"].forEach((k) => { if (m[k] && m[k].startsWith("private:")) (priv[m.bucket === "post-staging" ? "post-staging" : "post-quarantine"] ||= new Set()).add(m[k].slice(8)); })));
      for (const [bk, set] of Object.entries(priv)) {
        const { data: sg } = await sb.storage.from(bk).createSignedUrls([...set], 600);
        const map = new Map((sg || []).filter((x) => x && x.signedUrl).map((x) => [x.path, x.signedUrl]));
        rows.forEach((r) => (r.post_media || []).forEach((m) => ["url", "thumb_url", "poster_url"].forEach((k) => { if (m[k] && m[k].startsWith("private:") && map.has(m[k].slice(8))) m[k] = map.get(m[k].slice(8)); })));
      }
      rows.forEach((r) => (r.post_media || []).forEach((m) => ["url", "thumb_url", "poster_url"].forEach((k) => { if (m[k] && m[k].startsWith("private:")) m[k] = null; })));
      const ids = rows.map((r) => r.id);
      let liked = new Set(), saved = new Set(), joined = new Set();
      if (u && ids.length) {
        const [l, s, j] = await Promise.all([
          sb.from("likes").select("post_id").eq("user_id", u.id).in("post_id", ids),
          sb.from("saved_posts").select("post_id").eq("user_id", u.id).in("post_id", ids),
          sb.from("event_members").select("post_id").eq("user_id", u.id).in("post_id", ids)
        ]);
        (l.data || []).forEach((x) => liked.add(x.post_id));
        (s.data || []).forEach((x) => saved.add(x.post_id));
        (j.data || []).forEach((x) => joined.add(x.post_id));
      }
      return rows.map((r) => {
        const ev = one(r.events);
        return {
          id: r.id, user_id: r.user_id, category: r.category, text: r.text, lat: r.lat, lng: r.lng, status: r.status,
          created_at: r.created_at, updated_at: r.updated_at, is_sos: !!r.is_sos, exact: !!r.exact, expires_at: r.expires_at || null, resolved_at: r.resolved_at || null,
          author: one(r.author) || { id: r.user_id, name: "Пользователь", avatar_url: null },
          media: (r.post_media || []).sort((a, b) => (a.position || 0) - (b.position || 0)).map((m) => ({ id: m.id, state: m.state || "approved", error: m.error || null, edit: m.edit || null, url: m.url, type: m.type, mod_status: m.mod_status || "ok", thumb: m.thumb_url || null, poster: m.poster_url || null, w: m.w || null, h: m.h || null, duration: m.duration || null })),
          likes: cnt(r.likes), comments: cnt(r.comments), liked: liked.has(r.id), saved: saved.has(r.id),
          event: ev ? { starts_at: ev.starts_at, capacity: ev.capacity, members: cnt(r.event_members), joined: joined.has(r.id), meet_cat: ev.meet_cat || null, ends_at: ev.ends_at || null,
            host_id: ev.host_id || r.user_id, cohost_id: ev.cohost_id || null, status: ev.status || "scheduled", chat_id: ev.chat_id || null } : null
        };
      });
    }
    // загрузка с прогрессом (XHR) и двумя повторами при обрыве связи
    function xhrUpload(path, blob, contentType, onPct, bucket = BUCKET) {
      return new Promise((res, rej) => {
        const x = new XMLHttpRequest(); xhrNow = x;
        x.open("POST", `${CFG.SUPABASE_URL}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`);
        x.setRequestHeader("Authorization", "Bearer " + session.access_token);
        x.setRequestHeader("apikey", CFG.SUPABASE_ANON_KEY);
        x.setRequestHeader("Content-Type", contentType || "application/octet-stream");
        x.setRequestHeader("cache-control", "max-age=31536000");
        x.setRequestHeader("x-upsert", "false");
        x.upload.onprogress = (e) => { if (e.lengthComputable && onPct) onPct(e.loaded / e.total); };
        x.onload = () => { if (x.status >= 200 && x.status < 300) res(); else { let m = x.responseText; try { m = JSON.parse(m).message || m; } catch (e) {} const er = new Error(m || "Ошибка загрузки " + x.status); er.status = x.status; rej(er); } };
        x.onerror = () => { const er = new Error("Нет связи с сервером"); er.net = true; rej(er); };
        x.onabort = () => { const er = new Error("Загрузка отменена"); er.cancelled = true; rej(er); };
        x.send(blob);
      });
    }
    let xhrNow = null;
    async function uploadBlob(path, blob, contentType, onPct, bucket = BUCKET) {
      for (let attempt = 0; ; attempt++) {
        try {
          if (typeof XMLHttpRequest !== "undefined" && session) await xhrUpload(path, blob, contentType, onPct, bucket);
          else { const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType, upsert: true, cacheControl: "31536000" }); if (error) fail(error); }
          break;
        } catch (e) {
          if (e.cancelled) throw e;
          if (e.status === 409 && bucket === "post-staging") break;   // повтор той же загрузки — файл уже на месте
          if (attempt >= 2 || !(e.net || e.status >= 500)) throw new Error(ruError(e.message));
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      return bucket === BUCKET ? sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : "private:" + path;
    }
    const redirect = () => location.origin + location.pathname;
    // файлы переписки лежат в приватном бакете: показываем по временной ссылке (1 час)
    const signed = new Map();
    async function signChat(rows) {
      const now = Date.now();
      const need2 = [...new Set(rows.filter((m) => m && m.media_path).map((m) => m.media_path))].filter((p) => { const c = signed.get(p); return !c || c.exp < now + 120000; });
      if (need2.length) {
        const { data } = await sb.storage.from("chat-media").createSignedUrls(need2, 600);
        (data || []).forEach((d) => { if (d && d.signedUrl && d.path) signed.set(d.path, { url: d.signedUrl, exp: now + 600e3 }); });
      }
      rows.forEach((m) => { if (m && m.media_path) { const c = signed.get(m.media_path); m.media_url = c ? c.url : null; m.media_locked = !c; } });
      return rows;
    }

    return {
      mode: "supabase",
      async init() {
        // у каждого запроса свой x-request-id: по нему ошибку можно найти в логах сервера
        const fetchRid = (url, opt = {}) => { const h = new Headers(opt.headers || {}); lastReq = rid(); h.set("x-request-id", lastReq); return fetch(url, { ...opt, headers: h }); };
        sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }, global: { fetch: fetchRid } });
        const { data } = await sb.auth.getSession();
        session = data.session;
        await loadProfile();
        sb.auth.onAuthStateChange(async (event, s) => {
          session = s;
          if (event === "PASSWORD_RECOVERY") { authCbs.forEach((f) => f(profile, "recovery")); return; }
          if (["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"].includes(event)) { await loadProfile(); authCbs.forEach((f) => f(profile, event)); }
        });
        return profile;
      },
      user: () => profile,
      onAuth(cb) { authCbs.push(cb); },
      // CHAT-02: общий канал — новые публикации, уведомления и изменения списка переписок (без всех сообщений)
      subscribe(cb, onState) {
        if (this._ch) { sb.removeChannel(this._ch); this._ch = null; }
        const ch = sb.channel("near-live-" + (session ? session.user.id.slice(0, 8) : "guest"))
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "posts" }, (p) => { if (p.new.status === "active") cb("post", p.new); })
          .on("postgres_changes", { event: "UPDATE", schema: "public", table: "posts" }, (p) => { if (p.new.status === "active" && p.old && p.old.status === "draft") cb("post", p.new); });
        if (session) ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: "user_id=eq." + session.user.id }, (p) => cb("notif", p.new));
        if (session) ch.on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, (p) => cb("inbox", p.new));
        ch.subscribe((st) => onState && onState(st));
        this._ch = ch;
        return () => { sb.removeChannel(ch); if (this._ch === ch) this._ch = null; };
      },
      // подписка только на открытую переписку; onState — статус канала (SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED)
      subscribeConversation(cid, cb, onState) {
        const ch = sb.channel("conv-" + cid)
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: "conversation_id=eq." + cid }, (p) => cb("insert", p.new))
          .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: "conversation_id=eq." + cid }, (p) => cb("update", p.new))
          .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages", filter: "conversation_id=eq." + cid }, (p) => cb("delete", p.old));
        ch.subscribe((st) => onState && onState(st));
        return () => sb.removeChannel(ch);
      },
      unsubscribeAll() { try { sb.removeAllChannels(); } catch (e) {} this._ch = null; },
      async logError(e) { try { await sb.rpc("log_client_error", { p_kind: e.kind || "js", p_message: String(e.message || "").slice(0, 500), p_stack: String(e.stack || "").slice(0, 2000), p_corr: e.corr || lastReq, p_version: e.version || "", p_route: location.pathname + location.hash }); } catch (x) {} },
      async track(name, props, install) { try { await sb.rpc("track", { p_name: name, p_props: props || {}, p_install: install || null }); } catch (x) {} },
      // повторный вход перед удалением аккаунта (SEC-05)
      async reauth(password) {
        if (!session) throw new Error("Войдите, чтобы сделать это");
        if ((profile && profile.provider) === "google") return this.signInWithGoogle();
        const { data, error } = await sb.functions.invoke("shield-login", { body: { mode: "reauth", password } });
        if (error || !data || !data.ok) throw new Error("Не удалось подтвердить. Проверьте пароль");
      },

      async signUp({ nickname, email, password, district, captchaToken }) {
        const chk = await this.nicknameAvailable(nickname); if (!chk.ok) throw new Error(chk.reason);
        const { data, error } = await sb.auth.signUp({ email: (email || "").trim(), password,
          options: { data: { nickname: chk.nickname, accepted_rules: true, district: district || null }, emailRedirectTo: redirect(), captchaToken } });
        if (error) { if (/Database error/i.test(error.message)) throw new Error("Никнейм уже занят или недопустим. Выберите другой"); fail(error); }
        // существующая почта: Supabase не создает второй аккаунт; ответ одинаковый, наличие email не раскрывается
        return { needsConfirm: !data.session };
      },
      // вход по никнейму или почте через функцию shield-login (лимиты, CAPTCHA, одинаковая ошибка)
      async signIn({ login, email, password, captchaToken }) {
        const { data, error } = await sb.functions.invoke("shield-login", { body: { mode: "login", login: String(login || email || "").trim(), password, captcha: captchaToken } });
        if (error || !data || !data.access_token) {
          let msg = "Не удалось войти. Проверьте данные или восстановите доступ";
          try { const b = error && error.context && (await error.context.json()); if (b && b.error) msg = b.error; if (b && b.captcha_required) { const e = new Error(msg); e.captcha = true; throw e; } } catch (x) { if (x.captcha) throw x; }
          throw new Error(msg);
        }
        const { error: se } = await sb.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
        if (se) fail(se);
        const { data: d2 } = await sb.auth.getSession(); session = d2.session; return loadProfile();
      },
      async nicknameAvailable(n) { const { data, error } = await sb.rpc("nickname_available", { p: String(n || "") }); if (error) fail(error); return data; },
      /* ---------- Shield: сессия этого устройства ---------- */
      async sessionBegin() { if (!session) return { state: "guest" }; const { data, error } = await sb.rpc("session_begin", { p_installation: installId(), p_label: deviceLabel() }); if (error) fail(error); return data; },
      async sessionConfirm(id, code) { const { data, error } = await sb.rpc("session_confirm", { p_challenge: id, p_code: String(code) }); if (error) fail(error); return data; },
      async sessionResend(id) { const { data, error } = await sb.rpc("session_resend", { p_challenge: id }); if (error) fail(error); return data; },
      async sessionCancel() { try { await sb.rpc("session_cancel"); } catch (e) {} await sb.auth.signOut({ scope: "local" }).catch(() => {}); session = null; profile = null; },
      async sessionState() { const { data, error } = await sb.rpc("session_state"); if (error) fail(error); return data; },
      async sessionList() { const { data, error } = await sb.rpc("session_list"); if (error) fail(error); return data || []; },
      async accountState() { const { data, error } = await sb.rpc("account_state", {}); if (error) fail(error); return data; },
      async myDecisions() { const { data, error } = await sb.rpc("my_decisions"); if (error) fail(error); return data || []; },
      async appealSubmit(banId, text) { const { data, error } = await sb.rpc("appeal_submit", { p_ban: banId, p_message: text }); if (error) fail(error); return data; },
      /* ---------- репутация, отзывы, встречи ---------- */
      async reputation(id) { const { data, error } = await sb.rpc("reputation", { p_user: id || (session && session.user.id) }); if (error) fail(error); return data; },
      async userReviews(id) {
        const { data, error } = await sb.from("user_reviews").select("id,meeting_id,rating,tags,comment,target_role,created_at,reviewer:profiles!user_reviews_reviewer_id_fkey(id,nickname,avatar_url),meeting:posts!user_reviews_meeting_id_fkey(text)")
          .eq("target_id", id).eq("status", "visible").order("created_at", { ascending: false }).limit(50);
        if (error) fail(error); return (data || []).map((r) => ({ ...r, meeting_title: r.meeting && r.meeting.text }));
      },
      async reviewTargets(postId) { const { data, error } = await sb.rpc("review_targets", { p_post: postId }); if (error) fail(error); return (data || []).map((x) => ({ ...x })); },
      async reviewSubmit(postId, target, rating, tags, comment) { const { data, error } = await sb.rpc("review_submit", { p_post: postId, p_target: target, p_rating: rating, p_tags: tags || [], p_comment: comment || "" }); if (error) fail(error); return data; },
      async reviewsPending() { if (!session) return []; const { data, error } = await sb.rpc("reviews_pending"); if (error) return []; return data || []; },
      async meetingInfo(postId) {
        const [{ data: e }, { data: m }, { data: role }] = await Promise.all([
          sb.from("events").select("post_id,starts_at,ends_at,capacity,meet_cat,host_id,cohost_id,status,chat_id,cancel_reason,host:profiles!events_host_id_fkey(id,nickname,avatar_url)").eq("post_id", postId).maybeSingle(),
          sb.from("event_members").select("user_id,status,host_mark,self_mark,p:profiles!event_members_user_id_fkey(nickname,avatar_url)").eq("post_id", postId),
          session ? sb.rpc("meeting_role", { p_post: postId }) : Promise.resolve({ data: null })]);
        if (!e) return null;
        return { ...e, role, members: (m || []).map((x) => ({ user_id: x.user_id, nickname: x.p && x.p.nickname, avatar_url: x.p && x.p.avatar_url, status: x.status, host_mark: x.host_mark, self_mark: x.self_mark, attendance: attendance(x.host_mark, x.self_mark) })) };
      },
      async meetingJoin(postId) { const { data, error } = await sb.rpc("meeting_join", { p_post: postId }); if (error) fail(error); return data; },
      async meetingLeave(postId) { const { error } = await sb.rpc("meeting_leave", { p_post: postId }); if (error) fail(error); },
      async meetingMark(postId, target, val) { const { data, error } = await sb.rpc("meeting_mark", { p_post: postId, p_user: target, p_attended: val }); if (error) fail(error); return data; },
      async meetingCancel(postId, reason) { const { error } = await sb.rpc("meeting_cancel", { p_post: postId, p_reason: reason || "" }); if (error) fail(error); },
      async meetingSetCohost(postId, target) { const { error } = await sb.rpc("meeting_set_cohost", { p_post: postId, p_user: target }); if (error) fail(error); },
      async meetingExclude(postId, target, reason) { const { error } = await sb.rpc("meeting_exclude", { p_post: postId, p_user: target, p_reason: reason || "" }); if (error) fail(error); },
      /* ---------- общие чаты ---------- */
      async chatList() { if (!session) return []; const { data, error } = await sb.rpc("chat_list"); if (error) fail(error); return data || []; },
      async chatPage(chatId, before) { const { data, error } = await sb.rpc("chat_page", { p_chat: chatId, p_before: before || null, p_limit: 40 }); if (error) fail(error); return data || []; },
      async chatSend(chatId, text, key, replyTo) { const { data, error } = await sb.rpc("chat_send2", { p_chat: chatId, p_text: text, p_key: key, p_reply: replyTo || null }); if (error) fail(error); return data; },
      async chatRead(chatId) { if (session) await sb.rpc("chat_read", { p_chat: chatId }); },
      async chatReact(msgId, emoji) { const { data, error } = await sb.rpc("chat_react", { p_msg: msgId, p_emoji: emoji }); if (error) fail(error); return data; },
      async chatRestrict(chatId, target, hours) { const { error } = await sb.rpc("chat_restrict", { p_chat: chatId, p_user: target, p_hours: hours }); if (error) fail(error); },
      // Realtime только для открытого чата; права проверяет RLS на каждое событие (отозванная сессия перестает получать)
      subscribeChat(chatId, cb, onState) {
        const ch = sb.channel("chat-" + chatId).on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages", filter: "chat_id=eq." + chatId }, (p) => cb("insert", p.new));
        ch.subscribe((st) => onState && onState(st));
        return () => sb.removeChannel(ch);
      },
      /* ---------- медиа ---------- */
      async mediaRetry(id) { const { error } = await sb.rpc("media_retry", { p_media: id }); if (error) fail(error); },
      async changeEmail(email) { const { error } = await sb.auth.updateUser({ email: String(email || "").trim() }, { emailRedirectTo: redirect() }); if (error) fail(error); },
      async myReports() { if (!session) return []; const { data } = await sb.from("reports").select("reason,status,created_at").eq("reporter_id", session.user.id).order("created_at", { ascending: false }).limit(50); return data || []; },
      async mediaView(id, sec) { try { await sb.rpc("media_view", { p_media: id, p_seconds: sec }); } catch (e) {} },
      async mediaStats(postId) { const { data } = await sb.rpc("media_stats", { p_post: postId }); return data; },
      cancelUpload() { if (xhrNow) try { xhrNow.abort(); } catch (e) {} },
      /* ---------- NEAR Shield: панель ---------- */
      async staffRole() { if (!session) return null; const { data } = await sb.rpc("staff_role"); return data; },
      async mfaEnroll() { const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "NEAR Admin" }); if (error) fail(error); return data; },
      async mfaVerify(factorId, code) {
        const { data: ch, error: ce } = await sb.auth.mfa.challenge({ factorId }); if (ce) fail(ce);
        const { error } = await sb.auth.mfa.verify({ factorId, challengeId: ch.id, code: String(code) }); if (error) fail(error);
        const { data } = await sb.auth.getSession(); session = data.session;
      },
      async mfaFactors() { const { data } = await sb.auth.mfa.listFactors(); return (data && data.totp) || []; },
      async shieldOverview() { const { data, error } = await sb.rpc("shield_overview"); if (error) fail(error); return data; },
      async shieldFind(q) { const { data, error } = await sb.rpc("shield_find", { p_q: q || "" }); if (error) fail(error); return data || []; },
      async shieldUserCard(id) { const { data, error } = await sb.rpc("shield_user_card", { p_user: id }); if (error) fail(error); return data; },
      async shieldSanction(target, rule, kind, hours, reason, evidence) { const { data, error } = await sb.rpc("shield_sanction", { p_user: target, p_rule: rule, p_kind: kind, p_hours: hours, p_reason: reason, p_evidence: evidence || null, p_key: rid() }); if (error) fail(error); return data; },
      async shieldRevoke(banId, reason) { const { error } = await sb.rpc("shield_revoke", { p_ban: banId, p_reason: reason }); if (error) fail(error); },
      async shieldExtend(banId, days, reason) { const { error } = await sb.rpc("shield_extend", { p_ban: banId, p_days: days, p_reason: reason }); if (error) fail(error); },
      async shieldLinkDecide(id, confirm, note) { const { data, error } = await sb.rpc("shield_link_decide", { p_link: id, p_confirm: confirm, p_note: note }); if (error) fail(error); return data; },
      async riskDecide(id, clear, note) { const { error } = await sb.rpc("risk_decide", { p_user: id, p_clear: clear, p_note: note || "" }); if (error) fail(error); },
      async appealDecide(id, overturn, note) { await sb.rpc("appeal_take", { p_appeal: id }); const { error } = await sb.rpc("appeal_decide", { p_appeal: id, p_overturn: overturn, p_note: note }); if (error) fail(error); },
      async shieldQueue() { const { data, error } = await sb.rpc("shield_queue"); if (error) fail(error); return data || []; },
      async auditList(target) { const { data, error } = await sb.rpc("audit_list", { p_target: target || null }); if (error) fail(error); return data || []; },
      async mediaDecide(id, approve) { const { error } = await sb.rpc("media_decide", { p_media: id, p_approve: approve }); if (error) fail(error); },
      async signOut() {
        try { await sb.rpc("session_end"); } catch (e) {}
        // SEC-04: подписка push этого браузера отвязывается от аккаунта до выхода
        try { const r = await navigator.serviceWorker?.getRegistration(); const s2 = r && (await r.pushManager.getSubscription()); if (s2) await sb.rpc("push_unsubscribe", { p_endpoint: s2.endpoint }); } catch (e) {}
        this.unsubscribeAll(); await sb.auth.signOut(); session = null; profile = null;
      },
      async resetPassword(email, captchaToken) {
        const { error } = await sb.auth.resetPasswordForEmail((email || "").trim(), { redirectTo: redirect(), captchaToken });
        // AUTH-02: не раскрываем, есть ли такой аккаунт — ошибки "не найден" не показываем
        if (error && !/not found|no user/i.test(error.message || "")) fail(error); return {};
      },
      async updatePassword(password) {
        if ((password || "").length < 6) throw new Error("Пароль должен быть не короче 6 символов");
        const { error } = await sb.auth.updateUser({ password }); if (error) fail(error);
      },
      async signInWithGoogle() {
        const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirect(), queryParams: { prompt: "select_account" } } });
        if (error) fail(error);
      },
      async resendConfirm(email, captchaToken) {
        const { error } = await sb.auth.resend({ type: "signup", email: (email || "").trim(), options: { emailRedirectTo: redirect(), captchaToken } });
        if (error) fail(error); return {};
      },
      /* push-уведомления */
      pushAvailable: true,
      async pushSave({ endpoint, p256dh, auth, prefs, lat, lng }) {
        need();
        const { error } = await sb.rpc("push_subscribe", { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth, p_prefs: prefs || {}, p_lat: lat ?? null, p_lng: lng ?? null, p_ua: navigator.userAgent.slice(0, 200) });
        if (error) fail(error);
      },
      async pushRemove(endpoint) { if (session && endpoint) await sb.rpc("push_unsubscribe", { p_endpoint: endpoint }); },
      /* удаление аккаунта: функция delete-account стирает файлы и аккаунт (данные удаляются каскадом) */
      async deleteAccount() {
        need();
        const { data, error } = await sb.functions.invoke("delete-account", { body: { confirm: "DELETE" } });
        if (error) {
          let m = error.message, code = ""; try { const j = await error.context.json(); m = j.error || m; code = j.code || ""; } catch (e) {}
          if (/Failed to send|not found|404/i.test(m)) m = "Удаление пока недоступно: администратор еще не включил эту функцию на сервере";
          const er = new Error(m); er.code = code; throw er;
        }
        if (data && data.error) throw new Error(data.error);
        try { await sb.auth.signOut({ scope: "local" }); } catch (e) {}
        session = null; profile = null;
      },
      async touchSeen() { if (session) await sb.rpc("touch_seen"); },
      async signOutAll() {
        try { const r = await navigator.serviceWorker?.getRegistration(); const s2 = r && (await r.pushManager.getSubscription()); if (s2) await sb.rpc("push_unsubscribe", { p_endpoint: s2.endpoint }); } catch (e) {}
        this.unsubscribeAll(); await sb.auth.signOut({ scope: "global" }); session = null; profile = null;
      },
      async updateProfile({ name, nickname, district, avatarFile, instagram, gender, acceptRules, bio, show_seen }) {
        const u = need(), patch = { updated_at: nowISO() };
        if (nickname !== undefined && String(nickname).trim()) patch.nickname = String(nickname).trim().replace(/^@/, "");
        if (gender !== undefined && ["m", "f"].includes(gender)) patch.gender = gender;
        if (acceptRules) patch.accepted_rules_at = nowISO();
        if (instagram !== undefined) patch.instagram = cleanInsta(instagram);
        if (name !== undefined) { if (!name.trim()) throw new Error("Имя не может быть пустым"); patch.name = name.trim(); }
        if (district !== undefined) patch.district = district;
        if (bio !== undefined) { if (String(bio).length > 160) throw new Error("Описание не длиннее 160 символов"); patch.bio = String(bio).trim() || null; }
        if (show_seen !== undefined) patch.show_seen = !!show_seen;
        if (avatarFile) { validateFile(avatarFile); patch.avatar_url = await uploadBlob(`${u.id}/avatar-${Date.now()}.jpg`, await compressImage(avatarFile, 400, 0.8), "image/jpeg"); }
        const { error } = await sb.from("profiles").update(patch).eq("id", u.id); if (error) fail(error);
        return loadProfile();
      },

      // MAP-01: карта — сервер выбирает по рамке экрана или по радиусу, с теми же правилами, что лента
      async listPosts({ lat, lng, radius, bounds, category, limit = 300, period, friends, signal } = {}) {
        const cats = category ? (Array.isArray(category) ? category : [category]) : null;
        const b = bounds || { w: 0, s: 0, e: 0, n: 0 };
        const args = { p_w: b.w, p_s: b.s, p_e: b.e, p_n: b.n, p_cats: cats,
          p_lat: bounds ? null : lat, p_lng: bounds ? null : lng, p_radius: bounds ? null : Math.round(radius || 3000), p_limit: limit };
        let q = period || friends ? sb.rpc("map_posts2", { ...args, p_period: period || null, p_friends: !!friends }) : sb.rpc("map_posts", args);
        q = q.select(POST_SELECT); if (signal) q = q.abortSignal(signal);
        const { data, error } = await q;
        if (error) fail(error);
        return enrich(data || []);
      },
      // FEED-01: лента — серверная геовыборка (PostGIS), курсор {ts, id}, до 12 записей на страницу
      async feedPage({ lat, lng, radius, category, limit = 12, before, after, sort = "new", period, friends, signal } = {}) {
        const cats = category ? (Array.isArray(category) ? category : [category]) : null;
        const base = { p_lat: lat, p_lng: lng, p_radius: Math.round(radius), p_cats: cats };
        // UX-02: "Рядом", "Для вас", период и "Друзья" — функция feed_sorted (id по порядку), затем карточки одним запросом
        if (!after && (sort !== "new" || period || friends)) {
          const lim = Math.min(limit || 12, 12);
          let q = sb.rpc("feed_sorted", { ...base, p_sort: sort, p_period: period || null, p_friends: !!friends,
            p_after_ts: before && before.ts ? before.ts : null, p_after_dist: before && before.d != null ? before.d : null, p_after_id: before ? before.id || null : null,
            p_offset: before && before.o ? before.o : 0, p_limit: lim });
          if (signal) q = q.abortSignal(signal);
          const { data: ids, error } = await q; if (error) fail(error);
          const order = (ids || []).map((r) => r.post_id);
          let rows = [];
          if (order.length) { const r2 = await sb.from("posts").select(POST_SELECT).in("id", order); if (r2.error) fail(r2.error); rows = order.map((id) => (r2.data || []).find((x) => x.id === id)).filter(Boolean); }
          const l = (ids || [])[order.length - 1];
          const next = !l ? before || null : sort === "near" ? { d: l.sort_dist, id: l.post_id } : sort === "top" ? { o: ((before && before.o) || 0) + order.length } : { ts: l.sort_ts, id: l.post_id };
          return { posts: await enrich(rows), next, done: order.length < lim };
        }
        if (after) {
          // обновление: догружаем все новые страницы по возрастанию
          let out = [], cur = after;
          for (let i = 0; i < 10; i++) {
            const { data, error } = await sb.rpc("feed_new", { ...base, p_after_ts: cur.ts, p_after_id: cur.id, p_limit: 50 }).select(POST_SELECT);
            if (error) fail(error);
            const rows = data || []; out.push(...rows);
            if (rows.length < 50) break;
            cur = cursorOf(rows[rows.length - 1]);
          }
          out.sort(byNewest);
          return { posts: await enrich(out), next: null, done: true };
        }
        const lim = Math.min(limit || 12, 12);
        let q = sb.rpc("feed_page", { ...base, p_before_ts: before ? before.ts : null, p_before_id: before ? before.id : null, p_limit: lim }).select(POST_SELECT);
        if (signal) q = q.abortSignal(signal);
        const { data, error } = await q;
        if (error) fail(error);
        const rows = data || [];
        return { posts: await enrich(rows), next: rows.length ? cursorOf(rows[rows.length - 1]) : before || null, done: rows.length < lim };
      },
      // сколько публикаций появилось за час (для счетчиков)
      async recentStats({ lat, lng, radius, category } = {}) {
        const cats = category ? (Array.isArray(category) ? category : [category]) : null;
        const { data, error } = await sb.rpc("recent_stats", { p_lat: lat, p_lng: lng, p_radius: Math.round(radius), p_cats: cats });
        if (error) fail(error);
        const by = {}; (data || []).forEach((r) => (by[r.category] = Number(r.n))); return by;
      },
      async getPost(id) {
        const { data, error } = await sb.from("posts").select(POST_SELECT).eq("id", id).maybeSingle();
        if (error) fail(error); if (!data || data.status === "deleted") throw new Error("Публикация удалена или не найдена");
        return (await enrich([data]))[0];
      },
      // POST-01: публикация создается черновиком с ключом повтора; файлы догружаются, затем публикуется.
      // Повтор после обрыва с тем же clientKey продолжает с места остановки и не создает дубль.
      async createPost({ category, text, lat, lng, files = [], event, exact = false, is_sos = false, clientKey, edits }, onProgress = () => {}) {
        const u = need();
        if (!CATS[category]) throw new Error("Выберите тип публикации");
        if (!text || !text.trim()) throw new Error("Добавьте описание");
        if (lat == null || lng == null) throw new Error("Укажите место на карте");
        if (files.length > 5) throw new Error("Не больше 5 вложений в публикации");
        files.forEach(validateFile);
        const key = clientKey || rid() + rid();
        onProgress("Сохраняем публикацию...");
        let post = null;
        { const { data } = await sb.from("posts").select("id,status").eq("user_id", u.id).eq("client_key", key).maybeSingle(); post = data; }
        if (post && post.status !== "draft") return this.getPost(post.id); // уже опубликовано
        if (!post) {
          const { data, error } = await sb.from("posts").insert({ user_id: u.id, category, text: text.trim().slice(0, 1000), lat, lng, exact: !!exact, is_sos: !!is_sos, status: "draft", client_key: key }).select("id,status").single();
          if (error) {
            if (error.code === "23505") { const { data: d2 } = await sb.from("posts").select("id,status").eq("user_id", u.id).eq("client_key", key).maybeSingle(); post = d2; }
            if (!post) fail(error);
          } else post = data;
        }
        const { data: have } = await sb.from("post_media").select("position").eq("post_id", post.id);
        const done = new Set((have || []).map((m) => m.position));
        for (let i = 0; i < files.length; i++) {
          if (done.has(i)) continue;
          const f0 = files[i], isImg = validateFile(f0) === "image", lbl = `${isImg ? "фото" : "видео"} ${i + 1} из ${files.length}`;
          // ключ объекта детерминирован: повтор после обрыва не создает дубль
          const ext = isImg ? "jpg" : ((f0.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4");
          const key = `${u.id}/${post.id}/${i}-${post.id.slice(0, 8)}.${ext}`;
          const row = { post_id: post.id, user_id: u.id, type: isImg ? "image" : "video", position: i, path: key, url: "private:" + key, edit: (edits && edits[i]) || {} };
          const pr = (frac) => onProgress(`Загрузка ${lbl}: ${Math.round(frac * 100)}%`, (i + frac) / files.length);
          if (isImg) {
            onProgress(`Сжимаем ${lbl}...`, i / files.length);
            const full = await compressImage(f0, 1600, 0.82, true);
            await uploadBlob(key, full.blob, "image/jpeg", pr, "post-staging");
            row.w = full.w; row.h = full.h; row.size_bytes = full.blob.size;
          } else {
            // исходник загружается без изменений; обрезку, поворот и звук применяет сервер по параметрам редактора
            const meta = await probeVideo(f0).catch(() => ({}));
            await uploadBlob(key, f0, f0.type || "video/mp4", pr, "post-staging");
            row.w = meta.w || null; row.h = meta.h || null; row.duration = meta.duration ? Math.round(meta.duration * 10) / 10 : null; row.size_bytes = f0.size;
          }
          const { error: me } = await sb.from("post_media").insert(row);
          if (me) fail(me);
        }
        if (event && event.starts_at) {
          const { error: ee } = await sb.from("events").upsert({ post_id: post.id, starts_at: event.starts_at, ends_at: event.ends_at || null, capacity: event.capacity || null, meet_cat: category === "meetup" ? event.meet_cat || "other" : null });
          if (ee) fail(ee);
        }
        const { error: pe } = await sb.from("posts").update({ status: "active" }).eq("id", post.id);
        if (pe) fail(pe);
        return this.getPost(post.id);
      },
      // отмена черновика: строка и уже загруженные файлы удаляются
      async abandonDraft(clientKey) {
        if (!session || !clientKey) return;
        const { data } = await sb.from("posts").select("id,status").eq("user_id", session.user.id).eq("client_key", clientKey).maybeSingle();
        if (data && data.status === "draft") await this.deletePost(data.id).catch(() => {});
      },
      async updatePost(id, { text, category, status, event }) {
        need(); const patch = { updated_at: nowISO() };
        if (text !== undefined) { if (!text.trim()) throw new Error("Описание не может быть пустым"); patch.text = text.trim().slice(0, 1000); }
        if (category) patch.category = category;
        if (status) patch.status = status;
        const { error } = await sb.from("posts").update(patch).eq("id", id); if (error) fail(error);
        if (event) { const { error: e2 } = await sb.from("events").upsert({ post_id: id, ...event }); if (e2) fail(e2); }
        return this.getPost(id);
      },
      async deletePost(id) {
        need();
        const { data: media } = await sb.from("post_media").select("path").eq("post_id", id);
        const paths = (media || []).map((m) => m.path).filter(Boolean);
        if (paths.length) await sb.storage.from(BUCKET).remove(paths);
        const { error } = await sb.from("posts").delete().eq("id", id); if (error) fail(error);
      },
      async toggleLike(id) {
        const u = need();
        const { data: ex } = await sb.from("likes").select("post_id").eq("post_id", id).eq("user_id", u.id).maybeSingle();
        const { error } = ex ? await sb.from("likes").delete().eq("post_id", id).eq("user_id", u.id) : await sb.from("likes").insert({ post_id: id, user_id: u.id });
        if (error) fail(error);
        const { count } = await sb.from("likes").select("post_id", { count: "exact", head: true }).eq("post_id", id);
        return { liked: !ex, likes: count || 0 };
      },
      async toggleSave(id) {
        const u = need();
        const { data: ex } = await sb.from("saved_posts").select("post_id").eq("post_id", id).eq("user_id", u.id).maybeSingle();
        const { error } = ex ? await sb.from("saved_posts").delete().eq("post_id", id).eq("user_id", u.id) : await sb.from("saved_posts").insert({ post_id: id, user_id: u.id });
        if (error) fail(error); return !ex;
      },
      async listComments(id) {
        const { data, error } = await sb.from("comments").select("id,text,created_at,user_id,parent_id,author:profiles!comments_user_id_fkey(id,name,avatar_url,verified)").eq("post_id", id).order("created_at");
        if (error) fail(error);
        const bl = await myBlocks();
        return (data || []).filter((c) => !bl.has(c.user_id)).map((c) => ({ ...c, author: one(c.author) || { id: c.user_id, name: "Пользователь" } }));
      },
      async addComment(id, text, parentId) {
        const u = need(); text = (text || "").trim(); if (!text) throw new Error("Комментарий пустой");
        const { data, error } = await sb.from("comments").insert({ post_id: id, user_id: u.id, text: text.slice(0, 500), parent_id: parentId || null })
          .select("id,text,created_at,user_id,parent_id").single();
        if (error) fail(error);
        return { ...data, author: { id: u.id, name: profile ? profile.name : "Вы", avatar_url: profile && profile.avatar_url, verified: profile && profile.verified } };
      },
      async deleteComment(cid) { need(); const { error } = await sb.from("comments").delete().eq("id", cid); if (error) fail(error); },
      // POST-02: лимит мест проверяет сервер атомарно; клиент только показывает итог
      async toggleJoin(id) {
        const u = need();
        const { data: ex } = await sb.from("event_members").select("post_id").eq("post_id", id).eq("user_id", u.id).maybeSingle();
        const { error } = ex ? await sb.from("event_members").delete().eq("post_id", id).eq("user_id", u.id) : await sb.from("event_members").insert({ post_id: id, user_id: u.id });
        if (error) fail(error);
        const { count } = await sb.from("event_members").select("post_id", { count: "exact", head: true }).eq("post_id", id);
        return { joined: !ex, members: count || 0 };
      },
      async myPosts() {
        const u = need();
        const { data, error } = await sb.from("posts").select(POST_SELECT).eq("user_id", u.id).neq("status", "deleted").order("created_at", { ascending: false }).limit(100);
        if (error) fail(error); return enrich(data || []);
      },
      async savedPosts() {
        const u = need();
        const { data, error } = await sb.from("saved_posts").select("created_at,post:posts!saved_posts_post_id_fkey(" + POST_SELECT + ")").eq("user_id", u.id).order("created_at", { ascending: false }).limit(100);
        if (error) fail(error); return enrich((data || []).map((x) => one(x.post)).filter(Boolean));
      },
      async stats() {
        if (!session) return { posts: 0, saved: 0, events: 0 };
        const id = session.user.id, h = { count: "exact", head: true };
        const [a, b, c, d] = await Promise.all([
          sb.from("posts").select("id", h).eq("user_id", id),
          sb.from("saved_posts").select("post_id", h).eq("user_id", id),
          sb.from("event_members").select("post_id", h).eq("user_id", id).eq("status", "going"),
          sb.from("likes").select("post_id,posts!inner(user_id)", h).eq("posts.user_id", id).neq("user_id", id)
        ]);
        return { posts: a.count || 0, saved: b.count || 0, events: c.count || 0, likes: d.count || 0 };
      },
      async notifications() {
        if (!session) return [];
        const { data, error } = await sb.from("notifications").select("id,type,post_id,actor_id,text,read,created_at,actor:profiles!notifications_actor_fkey(id,name,avatar_url)")
          .eq("user_id", session.user.id).order("created_at", { ascending: false }).limit(50);
        if (error) fail(error); return (data || []).map((n) => ({ ...n, actor: one(n.actor) || { id: null, name: "NEAR" } }));
      },

      /* ----- профили, друзья, блокировки ----- */
      async getProfile(id) {
        const { data: x, error } = await sb.from("profiles").select(PUB).eq("id", id).maybeSingle();
        if (error) fail(error); if (!x) throw new Error("Пользователь не найден");
        let friendship = "none", blocked = false;
        if (session) {
          const me2 = session.user.id;
          const { data: f } = await sb.from("friendships").select("*").or(`and(requester_id.eq.${me2},addressee_id.eq.${id}),and(requester_id.eq.${id},addressee_id.eq.${me2})`).maybeSingle();
          if (f) friendship = f.status === "accepted" ? "friends" : f.requester_id === me2 ? "requested" : "incoming";
          blocked = (await myBlocks()).has(id);
        }
        const h = { count: "exact", head: true };
        const [pc, fa, fb] = await Promise.all([
          sb.from("posts").select("id", h).eq("user_id", id).eq("status", "active"),
          sb.from("friendships").select("requester_id", h).eq("requester_id", id).eq("status", "accepted"),
          sb.from("friendships").select("requester_id", h).eq("addressee_id", id).eq("status", "accepted")
        ]);
        return { ...x, friendship, blocked, posts: pc.count || 0, friends: (fa.count || 0) + (fb.count || 0) };
      },
      async userPosts(id) {
        const { data, error } = await sb.from("posts").select(POST_SELECT).eq("user_id", id).in("status", ["active", "closed"]).order("created_at", { ascending: false }).limit(30);
        if (error) fail(error); return enrich(data || []);
      },
      async searchUsers(q) {
        q = (q || "").trim(); if (q.length < 2) return [];
        const { data, error } = await sb.from("profiles").select(PUB).ilike("name", "%" + q.replace(/[%_]/g, "") + "%").limit(20);
        if (error) fail(error); const bl = await myBlocks();
        return (data || []).filter((x) => (!session || x.id !== session.user.id) && !bl.has(x.id));
      },
      async friends() {
        const u = need();
        const { data, error } = await sb.from("friendships").select("requester_id,addressee_id,a:profiles!friendships_requester_id_fkey(" + PUB + "),b:profiles!friendships_addressee_id_fkey(" + PUB + ")")
          .eq("status", "accepted").or(`requester_id.eq.${u.id},addressee_id.eq.${u.id}`);
        if (error) fail(error);
        return (data || []).map((f) => one(f.requester_id === u.id ? f.b : f.a)).filter(Boolean);
      },
      async friendRequests() {
        const u = need();
        const { data, error } = await sb.from("friendships").select("requester_id,addressee_id,a:profiles!friendships_requester_id_fkey(" + PUB + "),b:profiles!friendships_addressee_id_fkey(" + PUB + ")")
          .eq("status", "pending").or(`requester_id.eq.${u.id},addressee_id.eq.${u.id}`);
        if (error) fail(error);
        return { incoming: (data || []).filter((f) => f.addressee_id === u.id).map((f) => one(f.a)).filter(Boolean),
                 outgoing: (data || []).filter((f) => f.requester_id === u.id).map((f) => one(f.b)).filter(Boolean) };
      },
      async sendFriendRequest(id) {
        const u = need(); const { error } = await sb.from("friendships").insert({ requester_id: u.id, addressee_id: id });
        if (error) { if (/duplicate|unique/i.test(error.message)) throw new Error("Заявка уже есть"); fail(error); }
      },
      async acceptFriend(id) {
        const u = need(); const { error } = await sb.from("friendships").update({ status: "accepted", accepted_at: nowISO() }).eq("requester_id", id).eq("addressee_id", u.id);
        if (error) fail(error);
      },
      async removeFriend(id) {
        const u = need();
        const { error } = await sb.from("friendships").delete().or(`and(requester_id.eq.${u.id},addressee_id.eq.${id}),and(requester_id.eq.${id},addressee_id.eq.${u.id})`);
        if (error) fail(error);
      },
      async block(id) { const u = need(); const { error } = await sb.from("blocks").upsert({ blocker_id: u.id, blocked_id: id }); if (error) fail(error); blockedSet = null; },
      async unblock(id) { const u = need(); const { error } = await sb.from("blocks").delete().eq("blocker_id", u.id).eq("blocked_id", id); if (error) fail(error); blockedSet = null; },
      async blockedList() {
        const u = need(); const { data, error } = await sb.from("blocks").select("blocked:profiles!blocks_blocked_id_fkey(" + PUB + ")").eq("blocker_id", u.id);
        if (error) fail(error); return (data || []).map((x) => one(x.blocked)).filter(Boolean);
      },
      blockedIds: () => myBlocks(),

      /* ----- сообщения ----- */
      async conversations() {
        const u = need();
        const { data, error } = await sb.from("conversations").select("id,user_a,user_b,status,initiator,last_message_at,a:profiles!conversations_user_a_fkey(" + PUB + "),b:profiles!conversations_user_b_fkey(" + PUB + ")")
          .or(`user_a.eq.${u.id},user_b.eq.${u.id}`).order("last_message_at", { ascending: false }).limit(100);
        if (error) fail(error);
        const convs = data || []; if (!convs.length) return [];
        const ids = convs.map((c) => c.id);
        const [{ data: msgs }, { data: unread }, fr, bl] = await Promise.all([
          sb.from("messages").select("id,conversation_id,sender_id,kind,text,mod_status,created_at").in("conversation_id", ids).order("created_at", { ascending: false }).limit(400),
          sb.from("messages").select("conversation_id").in("conversation_id", ids).neq("sender_id", u.id).is("read_at", null),
          this.friends().catch(() => []), myBlocks()
        ]);
        const fset = new Set(fr.map((f) => f.id));
        return convs.map((c) => {
          const other = one(c.user_a === u.id ? c.b : c.a) || { id: c.user_a === u.id ? c.user_b : c.user_a, name: "Удаленный аккаунт", deleted: true };
          return { id: c.id, other, last: (msgs || []).find((m) => m.conversation_id === c.id) || null, last_message_at: c.last_message_at,
            status: c.status, initiator: c.initiator, request: c.status !== "accepted" && c.initiator !== u.id,
            unread: (unread || []).filter((m) => m.conversation_id === c.id).length, friend: fset.has(other.id), blocked: bl.has(other.id) };
        }).filter((c) => c.last);
      },
      async openConversation(other) {
        need(); const { data, error } = await sb.rpc("get_or_create_conversation", { other }); if (error) fail(error); return data;
      },
      async conversationInfo(cid) {
        const u = need();
        const { data: c, error } = await sb.from("conversations").select("id,user_a,user_b,status,initiator,orphaned_at").eq("id", cid).maybeSingle();
        if (error) fail(error); if (!c) throw new Error("Переписка не найдена");
        const other = c.user_a === u.id ? c.user_b : c.user_a;
        if (!other) return { id: cid, other: { id: null, name: "Удаленный аккаунт", deleted: true }, friend: false, blocked: false, status: c.status, initiator: c.initiator, orphaned_at: c.orphaned_at };
        const p = await this.getProfile(other);
        return { id: cid, other: p, friend: p.friendship === "friends", blocked: p.blocked, status: c.status, initiator: c.initiator };
      },
      async conversationRespond(cid, accept) {
        need(); const { data, error } = await sb.rpc("conversation_respond", { conv: cid, accept: !!accept }); if (error) fail(error); return data;
      },
      // after — догрузка пропущенного после переподключения
      async messages(cid, after) {
        need();
        let q = sb.from("messages").select("*").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(200);
        if (after) q = q.gt("created_at", after);
        const { data, error } = await q;
        if (error) fail(error); return signChat((data || []).reverse());
      },
      signChat: (rows) => signChat(rows),
      async sendMessage(cid, { text, file, kind, duration }, onProgress = () => {}) {
        const u = need(); const row = { conversation_id: cid, sender_id: u.id, kind: "text" };
        if (arguments[1] && arguments[1].id) row.id = arguments[1].id; // id задает клиент — повтор не создает дубль
        if (file) {
          const k = kind || validateChatFile(file);
          onProgress(k === "image" ? "Загружаем фото..." : k === "video" ? "Загружаем видео..." : "Отправляем голосовое...");
          const blob = k === "image" ? await compressImage(file) : file;
          const ext = k === "image" ? "jpg" : ((file.type.split("/")[1] || "bin").split(";")[0].replace("quicktime", "mov").replace("mpeg", "mp3"));
          const path = `${u.id}/${cid}/${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
          const { error: ue } = await sb.storage.from("chat-media").upload(path, blob, { contentType: k === "image" ? "image/jpeg" : (file.type || "application/octet-stream").split(";")[0], upsert: false });
          if (ue) fail(ue);
          row.kind = k; row.media_url = "private:" + path; row.media_path = path;
          if (duration) row.duration = Math.round(duration);
          if (text) row.text = text;
        } else {
          if (!text || !text.trim()) throw new Error("Пустое сообщение");
          row.text = text.trim().slice(0, 2000);
        }
        const { data, error } = await sb.from("messages").insert(row).select("*").single();
        if (error) fail(error);
        if (data.kind === "image" || data.kind === "text") moderate("messages", data.id);
        await signChat([data]);
        return data;
      },
      async deleteMessage(id) {
        need(); const { data: m } = await sb.from("messages").select("media_path").eq("id", id).maybeSingle();
        if (m && m.media_path) await sb.storage.from("chat-media").remove([m.media_path]);
        const { error } = await sb.from("messages").delete().eq("id", id); if (error) fail(error);
      },
      async markRead(cid) { if (session) await sb.rpc("mark_conversation_read", { conv: cid }); },
      async unreadMessages() {
        if (!session) return 0;
        const { data: convs } = await sb.from("conversations").select("id").or(`user_a.eq.${session.user.id},user_b.eq.${session.user.id}`);
        const ids = (convs || []).map((c) => c.id); if (!ids.length) return 0;
        const { count } = await sb.from("messages").select("id", { count: "exact", head: true }).in("conversation_id", ids).neq("sender_id", session.user.id).is("read_at", null);
        return count || 0;
      },

      /* ----- жалобы и модерация ----- */
      reasons: REASONS,
      async report({ type, id, user_id, reason, details }) {
        const u = need();
        const { error } = await sb.from("reports").insert({ reporter_id: u.id, target_type: type, target_id: id, target_user: user_id || null, reason, details: (details || "").slice(0, 500) || null });
        if (error) { if (/duplicate|unique/i.test(error.message)) throw new Error("Вы уже отправили жалобу на это"); fail(error); }
      },
      async reportsList() {
        if (!profile || !profile.is_mod) throw new Error("Только для модераторов");
        const { data, error } = await sb.from("reports").select("*,reporter:profiles!reports_reporter_id_fkey(name),target:profiles!reports_target_user_fkey(id,name,banned)").eq("status", "open").order("created_at", { ascending: false }).limit(200);
        // отчеты ИИ без автора жалобы
        (data || []).forEach((r) => { if (!r.reporter_id) r.reporter = { name: r.source === "ai" ? "Автопроверка ИИ" : "Система" }; });
        if (error) fail(error);
        const rows = data || [];
        const byType = (t) => rows.filter((r) => r.target_type === t).map((r) => r.target_id);
        const [ps, cs] = await Promise.all([
          byType("post").length ? sb.from("posts").select("id,text,status").in("id", byType("post")) : { data: [] },
          byType("comment").length ? sb.from("comments").select("id,text").in("id", byType("comment")) : { data: [] }
        ]);
        // личные сообщения — только материал жалобы, каждый просмотр пишется в журнал
        const ms = [];
        for (const r of rows.filter((x) => x.target_type === "message")) {
          if (ms.some((m) => m && m.id === r.target_id)) continue;
          const { data: m } = await sb.rpc("mod_report_content", { p_report: r.id }); if (m) ms.push(m);
        }
        const find = (arr, id) => (arr || []).find((x) => x && x.id === id);
        if (ms.length) await signChat(ms).catch(() => {});
        return rows.map((r) => {
          let preview = "";
          if (r.target_type === "post") { const p = find(ps.data, r.target_id); preview = p ? p.text : "(удалено)"; }
          if (r.target_type === "comment") { const c = find(cs.data, r.target_id); preview = c ? c.text : "(удалено)"; }
          if (r.target_type === "message") { const m = find(ms, r.target_id); preview = m ? (m.text || "[" + ({ image: "фото", video: "видео", audio: "голосовое" }[m.kind] || m.kind) + "]") : "(удалено)"; if (m && m.media_url) r.media = { url: m.media_url, kind: m.kind }; }
          if (r.target_type === "user") preview = (one(r.target) || {}).name || "";
          return { ...r, reporter: one(r.reporter) || { name: "?" }, target: one(r.target) || { name: "?" }, preview,
            count: rows.filter((x) => x.target_type === r.target_type && x.target_id === r.target_id).length };
        });
      },
      async modRecentPosts() {
        if (!profile || !profile.is_mod) throw new Error("Только для модераторов");
        const { data, error } = await sb.from("posts").select(POST_SELECT).neq("status", "deleted").order("created_at", { ascending: false }).limit(60);
        if (error) fail(error); return enrich(data || []);
      },
      async modAction(kind, id, action) {
        if (!profile || !profile.is_mod) throw new Error("Только для модераторов");
        return this.modAct(kind, id, action);
      },
      async resolveReport(id, action) {
        if (!profile || !profile.is_mod) throw new Error("Только для модераторов");
        const { data: r, error } = await sb.from("reports").select("*").eq("id", id).single(); if (error) fail(error);
        if (action === "dismiss") return this.modAct("report", id, "dismiss");
        if (action === "ban") return this.modAct("user", r.target_user, "ban");
        return this.modAct(r.target_type, r.target_id, action);
      },
      // SEC-08: все действия модератора — через сервер, с проверкой роли и журналом
      async modAct(kind, id, action, note) {
        const { error } = await sb.rpc("mod_act", { p_kind: kind, p_id: id, p_action: action, p_note: note || null }); if (error) fail(error);
      },
      async modHistory(type, id) { const { data, error } = await sb.rpc("mod_history", { p_type: type, p_id: id }); if (error) fail(error); return data || { reports: [], actions: [] }; },
      async appeal(type, id, text) {
        const u = need(); const { error } = await sb.from("appeals").insert({ user_id: u.id, target_type: type, target_id: id, text: String(text || "").trim().slice(0, 1000) });
        if (error) { if (error.code === "23505") throw new Error("Апелляция уже подана"); fail(error); }
      },
      async appealsList() {
        if (!profile || !profile.is_mod) return [];
        const { data, error } = await sb.from("appeals").select("*,author:profiles!appeals_user_id_fkey(id,name)").eq("status", "open").order("created_at").limit(100);
        if (error) fail(error); return (data || []).map((a) => ({ ...a, author: one(a.author) || { name: "?" } }));
      },
      /* ----- избранные места (приватные) и обратная связь ----- */
      async placesList() { if (!session) return []; const { data, error } = await sb.from("saved_places").select("*").order("created_at"); if (error) fail(error); return data || []; },
      async placeSave(pl) {
        const u = need(); const row = { name: String(pl.name || "").trim().slice(0, 40), lat: pl.lat, lng: pl.lng, radius: pl.radius || 1000, notify: !!pl.notify };
        if (!row.name) throw new Error("Назовите место");
        const { error } = pl.id ? await sb.from("saved_places").update(row).eq("id", pl.id) : await sb.from("saved_places").insert({ ...row, user_id: u.id });
        if (error) fail(error);
      },
      async placeDelete(id) { need(); const { error } = await sb.from("saved_places").delete().eq("id", id); if (error) fail(error); },
      async sendFeedback(text, version) { const { error } = await sb.rpc("send_feedback", { p_text: text, p_route: location.pathname + location.hash, p_version: version || "" }); if (error) fail(error); },
      async feedbackList() { const { data, error } = await sb.rpc("feedback_list"); if (error) fail(error); return data || []; },
      async kpi(days = 30) { const { data, error } = await sb.rpc("kpi_summary", { p_days: days }); if (error) fail(error); return data; },
      async openReportsCount() {
        if (!profile || !profile.is_mod) return 0;
        const { count } = await sb.from("reports").select("id", { count: "exact", head: true }).eq("status", "open"); return count || 0;
      },
      async markNotificationsRead() { if (session) await sb.from("notifications").update({ read: true }).eq("user_id", session.user.id).eq("read", false); },
      async unreadCount() {
        if (!session) return 0;
        const { count } = await sb.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", session.user.id).eq("read", false);
        return count || 0;
      }
    };
  }

  /* ---------- выбор режима ---------- */
  const hasSupabase = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  window.NEAR = {
    CATS, CITY, dist, boundsAround, compressImage, validateFile, probeVideo, validateChatFile, ruError, mask, hasBad, clean, cleanOrThrow, MEET_CATS, REVIEW_TAGS, BAN_RULES, deviceLabel, installId, REASONS, REASON_LABELS, stripVideoMeta, snap, rid,
    api: null,
    async start() {
      // demo — только локальные данные; staging/prod — только сервер, без тихого перехода в демо
      const env = CFG.ENV || (hasSupabase ? "prod" : "demo");
      if (env !== "demo") {
        if (!hasSupabase) throw new Error("Сервер не настроен (config.js). Обратитесь к администратору.");
        if (!window.supabase) throw new Error("Не удалось загрузить библиотеку Supabase. Проверьте интернет и обновите страницу.");
        this.api = SupabaseBackend();
      } else {
        this.api = LocalBackend();
      }
      this.env = env;
      return this.api.init();
    }
  };
})();
