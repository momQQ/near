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
    meetup:   { e: "⚽", n: "Ищу компанию", c: "#3da5ff", ttl: 24 },
    ad:       { e: "📢", n: "Объявление",   c: "#00b4a6", ttl: 24 * 7 },
    talk:     { e: "💬", n: "Обсуждение",   c: "#ff2e88", ttl: 24 * 3 }
  };

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
    if (isVid && f.size > (CFG.MAX_VIDEO_MB || 30) * 1048576) throw new Error(`Видео "${f.name}" больше ${CFG.MAX_VIDEO_MB || 30} МБ.`);
    return isImg ? "image" : "video";
  }

  /* фильтр грубых слов (такой же работает на сервере в schema.sql) */
  /* @clean:start — вставляется из src/lib/clean.js сборкой (node tools/build.mjs), не правьте здесь */
  /* =====================================================
     NEAR Clean v1 (ТЗ v14.4, раздел 05): маскирование мата.
     Первая буква сохраняется, каждая следующая графема слова → одна "*".
     Тот же алгоритм работает в базе: supabase/migrations/014_v14.sql (near_clean).
     Изменения — только парой (JS + SQL) и с прогоном supabase/tests/clean_cases.json.
     ===================================================== */
  const CLEAN_VERSION = "clean-1";
  const cp = (c) => c.codePointAt(0);
  const isZw = (k) => (k >= 0x200b && k <= 0x200d) || k === 0x2060 || k === 0xfeff || k === 0xad;
  const isMark = (k) => k >= 0x300 && k <= 0x36f;
  const isW = (k) => (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || (k >= 192 && k <= 591 && k !== 215 && k !== 247)
    || (k >= 0x400 && k <= 0x4ff) || isMark(k) || isZw(k) || k === 64 || k === 36;
  const isSep = (k) => k === 46 || k === 45 || k === 95 || k === 42 || k === 39 || k === 8217 || k === 96;
  const isCyr = (k) => k >= 0x400 && k <= 0x4ff;
  const isLat = (k) => (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || (k >= 192 && k <= 591);
  const mapChars = (s, m) => Array.from(s).map((c) => (m[c] !== undefined ? m[c] : c)).join("");
  const collapse = (s) => Array.from(s).filter((c, i, a) => i === 0 || c !== a[i - 1]).join("");
  // похожие латинские буквы и цифры внутри кириллического слова
  const HG = { a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", k: "к", m: "м", t: "т", h: "н", i: "и", u: "и", n: "п", r: "г", 0: "о", 3: "з", 4: "ч", 6: "б", "@": "а", $: "с" };
  const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s" };
  const TR2 = { shch: "щ", sch: "щ", sh: "ш", ch: "ч", zh: "ж", kh: "х", ts: "ц", ya: "я", yu: "ю", yo: "е", ye: "е", ja: "я", ju: "ю", jo: "е" };
  const TR1 = { a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", j: "й", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", x: "кс", z: "з" };
  function translit(s) {
    let out = "";
    for (let i = 0; i < s.length;) {
      let hit = null;
      for (const L of [4, 3, 2]) { const g = s.substr(i, L); if (g.length === L && TR2[g]) { hit = [TR2[g], L]; break; } }
      if (hit) { out += hit[0]; i += hit[1]; continue; }
      const c = s[i];
      if (c === "y") out += /[аеиоуыэюя]$/.test(out) ? "й" : "ы";
      else out += TR1[c] !== undefined ? TR1[c] : c;
      i++;
    }
    return collapse(out);
  }
  // словарь v1: ключ — нормализованное слово целиком (без пробелов), поэтому .* безопасно
  const PRE = "(вы|за|на|по|от|до|у|раз|рас|при|об|о|пере|под|недо|про|из|ис|без|бес|вз|съ|разъ|объ|подъ|отъ|изъ|въ|взъ)?";
  const RU_FULL = new RegExp("^(" + PRE + "(ху[йяеёию].*|пизд.*|еб[аулнышиоеё].*|бля[дт].*|бля|долбоеб.*|мудак.*|мудил.*|мудо[хз].*|мудач.*|гандон.*|пид[оа]р.*|шлюх.*|залуп.*)"
    + "|сук(а|и|е|у|ой|ою|ам|ами|ах|ин.*)|суч(к|ар|ий|ья|ье).*|котак.*|қотақ.*|сиг(ей|ейин|ем|у|ип).*|шешеңди.*)$");
  const RU_STRICT = new RegExp("^(" + PRE + "(хуй.*|хуя.*|хуе[втлн].*|хую.*|пизд.*|еба[лнт].*|ебл.*|ебу.*|еби.*|ебн.*|ебош.*|бля[дт].*|бля|долбоеб.*|мудак.*|мудил.*|гандон.*|пид[оа]р.*|шлюх.*|залуп.*)"
    + "|сук(а|и|е|у|ой|ам|ами|ах|ин.*))$");
  const EN = /^(mother|motha|mutha|holy)?(fuck.*|fuk.*|fck.*|phuck.*|shit.*|bitch.*|cunt.*|asshole.*|bullshit.*|dickhead.*|whore.*|slut.*)$/;
  const EXC = new Set(["shiitake", "shitake", "shiite", "shiites", "fukuoka", "fukushima", "hue", "hues", "huey", "hui", "ebay", "ebola", "ebony", "ebook", "ebooks", "suki", "sukiyaki", "scunthorpe"]);
  function badToken(tok) {
    let s = Array.from(tok.normalize("NFKC").toLowerCase()).filter((c) => { const k = cp(c); return !isZw(k) && !isMark(k) && !isSep(k); }).join("");
    if (!s) return false;
    if (EXC.has(s)) return false;
    if (Array.from(s).some((c) => isCyr(cp(c)))) {
      const k = collapse(mapChars(mapChars(s, HG), { "ё": "е", "і": "и" }));
      return RU_FULL.test(k);
    }
    if (!Array.from(s).some((c) => isLat(cp(c)))) return false; // только цифры
    const en = collapse(mapChars(s, LEET));
    if (EXC.has(en)) return false;
    if (EN.test(en)) return true;
    if (RU_STRICT.test(translit(en))) return true;
    const hg = collapse(mapChars(s, HG));
    return !Array.from(hg).some((c) => isLat(cp(c))) && RU_FULL.test(hg);
  }
  const maskTok = (chars) => chars.map((c, i) => { if (i === 0) return c; const k = cp(c); if (isMark(k)) return chars.slice(1, i).every((x) => isMark(cp(x))) ? c : ""; return isZw(k) ? "" : "*"; }).join("");
  // слова текста: буквы/цифры, внутри допускаются разделители (б.л.я, х-у-й)
  function tokens(ch) {
    const out = [], n = ch.length; let i = 0;
    while (i < n) {
      if (!isW(cp(ch[i]))) { i++; continue; }
      let j = i;
      for (;;) {
        while (j < n && isW(cp(ch[j]))) j++;
        if (j < n && isSep(cp(ch[j]))) { let k = j; while (k < n && isSep(cp(ch[k]))) k++; if (k < n && isW(cp(ch[k]))) { j = k; continue; } }
        break;
      }
      out.push([i, j]); i = j;
    }
    return out;
  }
  // возвращает { text, hits }: text — маскированный текст
  function cleanText(t) {
    if (t == null) return { text: t, hits: 0 };
    const ch = Array.from(String(t)), tk = tokens(ch), out = ch.slice(), done = new Set(); let hits = 0;
    // "х у й": три и больше одиночных букв через один пробел проверяются вместе
    for (let a = 0; a < tk.length;) {
      let b = a;
      while (b + 1 < tk.length && tk[b][1] - tk[b][0] === 1 && tk[b + 1][1] - tk[b + 1][0] === 1 && tk[b + 1][0] === tk[b][1] + 1 && ch[tk[b][1]] === " ") b++;
      if (b - a >= 2 && tk[a][1] - tk[a][0] === 1 && badToken(tk.slice(a, b + 1).map((x) => ch[x[0]]).join(""))) {
        for (let q = a + 1; q <= b; q++) out[tk[q][0]] = "*";
        for (let q = a; q <= b; q++) done.add(q); hits++; a = b + 1; continue;
      }
      a++;
    }
    tk.forEach(([i, j], q) => {
      if (done.has(q)) return;
      const w = ch.slice(i, j);
      if (badToken(w.join(""))) { hits++; const m = maskTok(w); out[i] = m; for (let x = i + 1; x < j; x++) out[x] = ""; }
    });
    return { text: out.join(""), hits };
  }
  // явные угрозы не маскируются, а не публикуются (решение — сервер; здесь подсказка до отправки)
  const THREAT = /(^|[^а-яa-z])(убью (тебя|вас|его|ее|тебе)|зарежу|пристрелю|задушу (тебя|вас)|урою|тебе конец|найду тебя и|сожгу (тебя|вас|твой|твою|ваш)|i will kill you|i'll kill you|kill you|өлтіремін)([^а-яa-z]|$)/;
  const isThreat = (t) => THREAT.test(String(t || "").toLowerCase().replace(/ё/g, "е"));
  const mask = (t) => (t == null ? t : cleanText(t).text);
  const hasBad = (t) => cleanText(String(t || "")).hits > 0;
  /* @clean:end */
  // никнейм: те же правила, что nick_problem в базе (окончательно проверяет сервер)
  const NICK_OK = /^[A-Za-z0-9_А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]+$/, NICK_LAT = /[A-Za-z]/, NICK_CYR = /[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/;
  function nickProblem(t) {
    const n = String(t || "").trim(), l = n.toLowerCase();
    if (n.length < 3 || n.length > 20) return "Никнейм: от 3 до 20 символов";
    if (!NICK_OK.test(n)) return "Никнейм: только буквы, цифры и _ (без пробелов и ссылок)";
    if (!NICK_LAT.test(n) && !NICK_CYR.test(n)) return "В никнейме нужна хотя бы одна буква";
    if (NICK_LAT.test(n) && NICK_CYR.test(n)) return "Никнейм: используйте одну раскладку — только латиницу или только кириллицу";
    if (hasBad(n) || hasBad(n.replace(/[_0-9]+/g, " "))) return "Никнейм содержит недопустимые слова. Выберите другой";
    if (/(near|admin|moder|support|official|offical|akimat|police|mvd|админ|модер|поддержк|официал|акимат|полици|мвд)/.test(l) || /^(112|101|102|103|104)/.test(l)) return "Такой никнейм похож на официальный аккаунт. Выберите другой";
    return "";
  }
  const nickNorm = (t) => mapChars(String(t || "").normalize("NFKC").toLowerCase(), { "а": "a", "е": "e", "ё": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "к": "k", "м": "m", "т": "t", "н": "h", "в": "b", "і": "i" });
  const cleanInsta = (v) => { v = String(v || "").trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/^@/, "").replace(/\/.*$/, ""); if (v && !/^[A-Za-z0-9._]{1,30}$/.test(v)) throw new Error("Ник Instagram: только латиница, цифры, точка и _"); return v || null; };
  function validateChatFile(f) {
    const t = f.type || "";
    if (/^image\//.test(t)) { if (f.size > (CFG.MAX_IMAGE_MB || 15) * 1048576) throw new Error("Фото слишком большое"); return "image"; }
    if (/^video\//.test(t)) { if (f.size > (CFG.MAX_VIDEO_MB || 30) * 1048576) throw new Error(`Видео больше ${CFG.MAX_VIDEO_MB || 30} МБ`); return "video"; }
    if (/^audio\//.test(t)) return "audio";
    throw new Error("Можно отправить фото, видео или голосовое");
  }
  const REASONS = { spam: "Спам или реклама", abuse: "Оскорбления, травля", fraud: "Мошенничество", nsfw: "Неприемлемые фото или видео", fake: "Ложная информация", danger: "Опасность, насилие", other: "Другое" };
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
    const err = new Error(msg); err.raw = e; err.code = code; err.hint = (e && e.hint) || ""; err.requestId = lastReq; throw err;
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
        ["u-erlan", "Ерлан_77"], ["u-dinara", "dinara_k"], ["u-asel", "Асель_М"], ["u-timur", "timur_almaty"],
        ["u-arman", "Kofe_Arman"], ["u-arbat", "ArbatLive"], ["u-aliya", "Әлия_02"], ["u-max", "maksat01"]
      ];
      const d = { v: 2, users: [], session: null, posts: [], media: [], comments: [], likes: [], saved: [], events: [], members: [], notifs: [] };
      const SEEN = { "u-erlan": 0, "u-dinara": 7, "u-asel": 95, "u-timur": 1500, "u-aliya": 2 };
      U.forEach(([id, name]) => d.users.push({ id, email: id + "@demo.near", pwh: null, name, nickname: name, avatar_url: null, district: "Бостандыкский", created_at: nowISO(),
        age_status: "adult", verified: id !== "u-max", last_seen_at: SEEN[id] != null ? new Date(Date.now() - SEEN[id] * 60000).toISOString() : null }));
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
      const c0 = uid();
      d.comments.push({ id: c0, post_id: "p-4", user_id: "u-asel", text: "А до скольки работают фудтраки?", created_at: ago(60) });
      d.comments.push({ id: uid(), post_id: "p-4", user_id: "u-arbat", parent_id: c0, text: "До 22:00, приходите 🙂", created_at: ago(55) });
      d.comments.push({ id: uid(), post_id: "p-0", user_id: "u-aliya", text: "Я приду с другом, нас двое!", created_at: ago(8) });
      d.comments.push({ id: uid(), post_id: "p-1", user_id: "u-max", text: "Уже разъехались, движение свободное", created_at: ago(2) });
      d.comments.push({ id: uid(), post_id: "p-3", user_id: "u-asel", text: "Похож на собаку соседей с Байзакова, скинула им", created_at: ago(40) });
      return d;
    }

    function load() {
      try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { db = null; }
      if (!db || (db.v !== 1 && db.v !== 2)) { db = seed(); save(); }
      if (db.v === 1) {
        // v14: демо-данные v12 → никнеймы; у своих аккаунтов (с паролем) никнейм выбирается при входе, имя и пол стираются
        const seedNick = Object.fromEntries(seed().users.map((x) => [x.id, x.nickname]));
        db.users.forEach((x) => { delete x.gender; if (seedNick[x.id]) { x.nickname = x.name = seedNick[x.id]; x.age_status = "adult"; } else if (!x.nickname) { x.name = "Новый пользователь"; x.nickname = null; } });
        db.v = 2; save();
      }
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
    const need = () => { const u = me(); if (!u) throw new Error("Войдите, чтобы сделать это"); return u; };
    const prof = (u) => u && { id: u.id, email: u.email, name: u.name, avatar_url: u.avatar_url, district: u.district, instagram: u.instagram || null, is_admin: !!u.is_admin, is_mod: !!(u.is_admin || u.is_moderator), banned: !!u.banned,
      nickname: u.nickname || null, verified: !!u.verified, last_seen_at: u.last_seen_at || null, accepted_rules: !!u.accepted_rules_at, bio: u.bio || null, show_seen: u.show_seen !== false, provider: "email",
      account: { age_status: u.age_status || "unknown", age_ok: u.age_status === "adult", phone_verified: !!u.phone_verified, media_ok: true,
        nickname_next_change: u.nick_at && Date.now() - new Date(u.nick_at) < 30 * 86400e3 ? new Date(new Date(u.nick_at).getTime() + 30 * 86400e3).toISOString() : null } };
    const blockedByMe = () => { const u = me(); return new Set(u ? db.blocks.filter((b) => b.blocker_id === u.id).map((b) => b.blocked_id) : []); };
    const isBlocked = (a, b) => db.blocks.some((x) => (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
    const friendRow = (a, b) => db.friends.find((f) => (f.requester_id === a && f.addressee_id === b) || (f.requester_id === b && f.addressee_id === a));
    const pubProfile = (x) => x && { id: x.id, name: x.name, avatar_url: x.avatar_url, district: x.district, instagram: x.instagram || null, created_at: x.created_at,
      verified: !!x.verified, last_seen_at: x.show_seen === false ? null : x.last_seen_at || null, banned: !!x.banned, bio: x.bio || null };
    // v14 / 08: дневные лимиты как на сервере (демо считает на этом телефоне)
    const DAY_LIMITS = { post: [3, 15], comment: [20, 100], chat_request: [3, 10] };
    function demoTake(u, action) {
      if (u.is_admin || u.is_moderator) return;
      const day = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10), k = u.id + "|" + action + "|" + day, lim = DAY_LIMITS[action][u.phone_verified ? 1 : 0];
      db.rate = db.rate || {};
      if ((db.rate[k] || 0) >= lim) {
        const left = Math.max(60, Math.ceil((Date.parse(day + "T00:00:00+05:00") + 86400e3 - Date.now()) / 1000));
        const e = new Error(`Лимит на сегодня исчерпан: ${lim} ${{ post: ["публикация", "публикации", "публикаций"], comment: ["комментарий", "комментария", "комментариев"], chat_request: ["новый запрос в чат", "новых запроса в чат", "новых запросов в чат"] }[action][lim % 10 === 1 && lim % 100 !== 11 ? 0 : lim % 10 >= 2 && lim % 10 <= 4 && (lim % 100 < 10 || lim % 100 >= 20) ? 1 : 2]}. Снова можно через ${left >= 3600 ? Math.floor(left / 3600) + " ч " + Math.floor((left % 3600) / 60) + " мин" : Math.ceil(left / 60) + " мин"}`);
        e.code = "NR429"; e.hint = "retry_after=" + left + ";action=" + action; throw e;
      }
      db.rate[k] = (db.rate[k] || 0) + 1;
    }
    const textKey = (t) => String(t || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-яәғқңөұүһі0-9]+/g, "");
    function demoCheckText(t) { if (isThreat(t)) { const e = new Error("Угрозы запрещены правилами NEAR. Текст не опубликован"); e.code = "NR422"; throw e; } }
    function shapeMsg(m) { return { ...m }; }
    function demoWelcome(u) {
      // демо: заявка в друзья и сообщение от незнакомца, чтобы было что проверить
      if (!db.friends.some((f) => f.addressee_id === u.id)) {
        db.friends.push({ requester_id: "u-erlan", addressee_id: u.id, status: "pending", created_at: nowISO() });
        db.notifs.push({ id: uid(), user_id: u.id, actor_id: "u-erlan", type: "friend_request", text: "хочет добавить вас в друзья", read: false, created_at: nowISO() });
        const a = u.id < "u-dinara" ? u.id : "u-dinara", b = u.id < "u-dinara" ? "u-dinara" : u.id, cid = uid();
        db.convs.push({ id: cid, user_a: a, user_b: b, created_at: nowISO(), last_message_at: nowISO(), status: "request", initiator: "u-dinara" });
        db.msgs.push({ id: uid(), conversation_id: cid, sender_id: "u-dinara", kind: "text", text: "Здравствуйте! Видела вашу публикацию рядом, можно вопрос?", mod_status: "ok", read_at: null, created_at: nowISO() });
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
        author: a ? { id: a.id, name: a.name, avatar_url: a.avatar_url, verified: !!a.verified } : { id: p.user_id, name: "Пользователь", avatar_url: null },
        media: db.media.filter((m) => m.post_id === p.id).map((m) => ({ url: m.url, type: m.type, mod_status: m.mod_status || "ok", thumb: m.thumb || null, poster: m.poster || null, w: m.w || null, h: m.h || null, duration: m.duration || null })),
        likes: db.likes.filter((l) => l.post_id === p.id).length,
        comments: db.comments.filter((c) => c.post_id === p.id).length,
        liked: !!u && db.likes.some((l) => l.post_id === p.id && l.user_id === u.id),
        saved: !!u && db.saved.some((l) => l.post_id === p.id && l.user_id === u.id),
        event: ev ? {
          starts_at: ev.starts_at, capacity: ev.capacity,
          members: db.members.filter((m) => m.post_id === p.id).length,
          joined: !!u && db.members.some((m) => m.post_id === p.id && m.user_id === u.id)
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
        email = (email || "").trim().toLowerCase(); nickname = String(nickname || "").trim();
        const np = nickProblem(nickname); if (np) throw new Error(np);
        if (db.users.some((x) => x.nickname && nickNorm(x.nickname) === nickNorm(nickname))) throw new Error("Этот никнейм уже занят. Попробуйте другой");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Проверьте правильность email");
        if ((password || "").length < 6) throw new Error("Пароль должен быть не короче 6 символов");
        if (db.users.some((u) => u.email === email)) throw new Error("Этот email уже зарегистрирован. Попробуйте войти.");
        const firstReal = !db.users.some((x) => x.pwh);
        const u = { id: uid(), email, pwh: await hash(password), name: nickname, nickname, nick_at: nowISO(), avatar_url: null, district: district || null, created_at: nowISO(), accepted_rules_at: nowISO(), is_admin: firstReal, age_status: "unknown", verified: false, last_seen_at: nowISO() };
        db.users.push(u); db.session = u.id; demoWelcome(u); save(); emit("auth", prof(u));
        return { needsConfirm: false };
      },
      async signIn({ email, password }) {
        email = (email || "").trim().toLowerCase();
        const u = db.users.find((x) => x.email === email);
        if (!u || !u.pwh || u.pwh !== (await hash(password || ""))) throw new Error("Неверная почта или пароль");
        db.session = u.id; save(); emit("auth", prof(u)); return prof(u);
      },
      async signOut() { db.session = null; save(); emit("auth", null); },
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
      async nicknameCheck(n) {
        const np = nickProblem(n); if (np) return { ok: false, error: np };
        const u = me(); if (db.users.some((x) => x !== u && x.nickname && nickNorm(x.nickname) === nickNorm(n))) return { ok: false, error: "Этот никнейм уже занят" };
        return { ok: true };
      },
      async setNickname(n) {
        const u = need(); n = String(n || "").trim();
        const np = nickProblem(n); if (np) throw new Error(np);
        const same = u.nickname && nickNorm(u.nickname) === nickNorm(n);
        if (u.nickname && !same && u.nick_at && Date.now() - new Date(u.nick_at) < 30 * 86400e3 && !u.is_admin) throw new Error(`Никнейм можно менять раз в 30 дней. Следующая смена через ${Math.ceil((new Date(u.nick_at).getTime() + 30 * 86400e3 - Date.now()) / 86400e3)} дн.`);
        if (db.users.some((x) => x !== u && x.nickname && nickNorm(x.nickname) === nickNorm(n))) throw new Error("Этот никнейм уже занят. Попробуйте другой");
        if (!same) u.nick_at = nowISO();
        u.nickname = u.name = n; delete u.gender; save(); emit("auth", prof(u)); return prof(u);
      },
      async updateProfile({ district, avatarFile, instagram, acceptRules, bio, show_seen }) {
        const u = need();
        if (acceptRules && !u.accepted_rules_at) u.accepted_rules_at = nowISO();
        if (instagram !== undefined) u.instagram = cleanInsta(instagram);
        if (district !== undefined) u.district = district;
        if (bio !== undefined) { if (String(bio).length > 160) throw new Error("Описание не длиннее 160 символов"); demoCheckText(bio); u.bio = mask(String(bio).trim()) || null; }
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
      async createPost({ category, text, lat, lng, files = [], event, exact = false, is_sos = false }, onProgress = () => {}) {
        const u = need();
        if (!CATS[category]) throw new Error("Выберите тип публикации");
        if (!text || !text.trim()) throw new Error("Добавьте описание");
        if (lat == null || lng == null) throw new Error("Укажите место на карте");
        if (files.length > 5) throw new Error("Не больше 5 вложений в публикации");
        if (is_sos && db.posts.some((p) => p.user_id === u.id && p.is_sos && p.status === "active" && (!p.expires_at || p.expires_at > nowISO())))
          throw new Error("У вас уже есть активный SOS. Закройте его, чтобы отправить новый");
        if (!u.nickname || !u.accepted_rules_at) { const e = new Error("Заполните профиль: никнейм и согласие с правилами"); e.code = "NR403"; throw e; }
        demoCheckText(text);
        if (!is_sos) {
          if (text.trim().length >= 10 && db.posts.some((p) => p.user_id === u.id && Date.now() - new Date(p.created_at) < 86400e3 && textKey(p.text) === textKey(mask(text.trim())))) throw new Error("Вы уже публиковали такой же текст сегодня");
          demoTake(u, "post");
        }
        if (!exact) ({ lat, lng } = snap(lat, lng));
        const id = uid(), t = nowISO();
        const media = [];
        for (let i = 0; i < files.length; i++) {
          const kind = validateFile(files[i]);
          if (kind === "video") throw new Error("Видео в демо-режиме не сохраняется. Подключите сервер Supabase или выберите фото.");
          onProgress(`Сжимаем фото ${i + 1} из ${files.length}...`, i / files.length);
          const full = await compressImage(files[i], 1080, 0.72, true);
          media.push({ id: uid(), post_id: id, url: await blobToDataURL(full.blob), thumb: await blobToDataURL(await compressImage(files[i], 360, 0.7)), w: full.w, h: full.h, type: "image" });
        }
        if (u.banned) throw new Error("Аккаунт заблокирован модератором");
        const ttl = is_sos ? 3 * 3600e3 : category === "incident" ? 86400e3 : 0;
        db.posts.push({ id, user_id: u.id, category, text: mask(text.trim().slice(0, 1000)), lat, lng, status: "active", created_at: t, updated_at: t, is_sos: !!is_sos, exact: !!exact,
          expires_at: ttl ? new Date(Date.now() + ttl).toISOString() : null });
        db.media.push(...media);
        if (event && event.starts_at) db.events.push({ post_id: id, starts_at: event.starts_at, capacity: event.capacity || null });
        try { save(); } catch (e) {
          db.posts = db.posts.filter((p) => p.id !== id); db.media = db.media.filter((m) => m.post_id !== id); db.events = db.events.filter((x) => x.post_id !== id);
          throw e;
        }
        const p = shape(db.posts.find((x) => x.id === id)); emit("post", p); return p;
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
        demoCheckText(text);
        if (text.length >= 10 && db.comments.some((c) => c.user_id === u.id && Date.now() - new Date(c.created_at) < 600e3 && textKey(c.text) === textKey(mask(text)))) throw new Error("Такой же комментарий вы уже отправляли. Напишите по-другому");
        demoTake(u, "comment");
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
        return { posts: db.posts.filter((p) => p.user_id === u.id).length, saved: db.saved.filter((s) => s.user_id === u.id).length, events: db.members.filter((m) => m.user_id === u.id).length };
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
          const fr = friendRow(u.id, other), isFr = fr && fr.status === "accepted", o = db.users.find((x) => x.id === other);
          if (!isFr && !(u.age_status === "adult" && o && o.age_status === "adult")) { const e = new Error("Личные сообщения незнакомым пока недоступны. Добавьте человека в друзья — после принятия заявки можно писать"); e.code = "NR403"; e.hint = "age_gate"; throw e; }
          if (!isFr) demoTake(u, "chat_request");
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
    const PUB = "id,name,nickname,avatar_url,district,instagram,created_at,verified,last_seen_at,banned,bio";
    // v11: ИИ-проверку запускает сама база (триггер ai_fire) — клиент ничего не вызывает
    async function moderate() {}
    const authCbs = [];
    const BUCKET = "post-media";
    const POST_SELECT = "id,user_id,category,text,lat,lng,status,created_at,updated_at,is_sos,exact,expires_at,resolved_at," +
      "author:profiles!posts_user_id_fkey(id,name,avatar_url,verified),post_media!post_media_post_id_fkey(url,type,position,mod_status,thumb_url,poster_url,w,h,duration)," +
      "likes!likes_post_id_fkey(count),comments!comments_post_id_fkey(count)," +
      "events!events_post_id_fkey(starts_at,capacity),event_members!event_members_post_id_fkey(count)";
    const one = (x) => (Array.isArray(x) ? x[0] : x) || null;
    const cnt = (x) => (Array.isArray(x) && x[0] ? x[0].count : 0);

    async function loadProfile() {
      if (!session) { profile = null; return null; }
      let { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
      if (error) console.warn(error);
      if (!data && !error) { await sb.rpc("ensure_profile"); ({ data } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle()); }
      // v14: приватный статус аккаунта (возрастной допуск, телефон, срок смены ника, доступность файлов)
      let account = null; try { const r = await sb.rpc("my_account"); account = r.data || null; } catch (e) {}
      profile = { id: session.user.id, email: session.user.email, name: (data && (data.nickname || data.name)) || "Новый пользователь", account, avatar_url: data && data.avatar_url, district: (data && data.district) || "",
        instagram: data && data.instagram, is_admin: !!(data && data.is_admin), is_mod: !!(data && (data.is_admin || data.is_moderator)), banned: !!(data && data.banned),
        nickname: (data && data.nickname) || null, verified: !!(data && data.verified) || !!session.user.email_confirmed_at, last_seen_at: data && data.last_seen_at,
        accepted_rules: !!(data && data.accepted_rules_at), bio: (data && data.bio) || null, show_seen: data ? data.show_seen !== false : true, provider: (session.user.app_metadata && session.user.app_metadata.provider) || "email" };
      blockedSet = null;
      return profile;
    }
    function need() { if (!session) throw new Error("Войдите, чтобы сделать это"); return session.user; }

    async function enrich(rows) {
      const u = session && session.user;
      // файлы скрытых модератором публикаций лежат в приватном бакете: ссылка на 10 минут (видит автор и модератор)
      const priv = [];
      rows.forEach((r) => (r.post_media || []).forEach((m) => ["url", "thumb_url", "poster_url"].forEach((k) => { if (m[k] && m[k].startsWith("private:")) priv.push(m[k].slice(8)); })));
      if (priv.length) {
        const { data: sg } = await sb.storage.from("post-quarantine").createSignedUrls([...new Set(priv)], 600);
        const map = new Map((sg || []).filter((x) => x && x.signedUrl).map((x) => [x.path, x.signedUrl]));
        rows.forEach((r) => (r.post_media || []).forEach((m) => ["url", "thumb_url", "poster_url"].forEach((k) => { if (m[k] && m[k].startsWith("private:")) m[k] = map.get(m[k].slice(8)) || null; })));
      }
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
          media: (r.post_media || []).sort((a, b) => (a.position || 0) - (b.position || 0)).map((m) => ({ url: m.url, type: m.type, mod_status: m.mod_status || "ok", thumb: m.thumb_url || null, poster: m.poster_url || null, w: m.w || null, h: m.h || null, duration: m.duration || null })),
          likes: cnt(r.likes), comments: cnt(r.comments), liked: liked.has(r.id), saved: saved.has(r.id),
          event: ev ? { starts_at: ev.starts_at, capacity: ev.capacity, members: cnt(r.event_members), joined: joined.has(r.id) } : null
        };
      });
    }
    // загрузка с прогрессом (XHR) и двумя повторами при обрыве связи
    function xhrUpload(path, blob, contentType, onPct) {
      return new Promise((res, rej) => {
        const x = new XMLHttpRequest();
        x.open("POST", `${CFG.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`);
        x.setRequestHeader("Authorization", "Bearer " + session.access_token);
        x.setRequestHeader("apikey", CFG.SUPABASE_ANON_KEY);
        x.setRequestHeader("Content-Type", contentType || "application/octet-stream");
        x.setRequestHeader("cache-control", "max-age=31536000");
        x.setRequestHeader("x-upsert", "false");
        x.upload.onprogress = (e) => { if (e.lengthComputable && onPct) onPct(e.loaded / e.total); };
        x.onload = () => { if (x.status >= 200 && x.status < 300) res(); else { let m = x.responseText; try { m = JSON.parse(m).message || m; } catch (e) {} const er = new Error(m || "Ошибка загрузки " + x.status); er.status = x.status; rej(er); } };
        x.onerror = () => { const er = new Error("Нет связи с сервером"); er.net = true; rej(er); };
        x.send(blob);
      });
    }
    async function uploadBlob(path, blob, contentType, onPct) {
      for (let attempt = 0; ; attempt++) {
        try {
          if (typeof XMLHttpRequest !== "undefined" && session) await xhrUpload(path, blob, contentType, onPct);
          else { const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType, upsert: false, cacheControl: "31536000" }); if (error) fail(error); }
          break;
        } catch (e) {
          if (attempt >= 2 || !(e.net || e.status >= 500)) throw new Error(ruError(e.message));
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
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
        const { error } = await sb.auth.signInWithPassword({ email: session.user.email, password });
        if (error) fail(error);
      },

      async signUp({ nickname, email, password, district, captchaToken }) {
        nickname = String(nickname || "").trim();
        const np = nickProblem(nickname); if (np) throw new Error(np);
        // v14: в метаданные уходит только никнейм (имя, фамилия и пол не собираются)
        const { data, error } = await sb.auth.signUp({ email: (email || "").trim(), password, options: { data: { nickname, accepted_rules: true, district: district || null }, emailRedirectTo: redirect(), captchaToken } });
        if (error) fail(error);
        if (data.user && data.user.identities && data.user.identities.length === 0) throw new Error("Этот email уже зарегистрирован. Попробуйте войти.");
        return { needsConfirm: !data.session };
      },
      async signIn({ email, password, captchaToken }) {
        const { error } = await sb.auth.signInWithPassword({ email: (email || "").trim(), password, options: { captchaToken } });
        if (error) fail(error);
        const { data } = await sb.auth.getSession(); session = data.session; return loadProfile();
      },
      async signOut() {
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
      async nicknameCheck(n) {
        const np = nickProblem(n); if (np) return { ok: false, error: np };
        const { data, error } = await sb.rpc("nickname_check", { p_nick: String(n).trim() }); if (error) return { ok: true };
        return data || { ok: true };
      },
      async setNickname(n) {
        need(); const np = nickProblem(n); if (np) throw new Error(np);
        const { error } = await sb.rpc("set_nickname", { p_nick: String(n).trim() }); if (error) fail(error);
        return loadProfile();
      },
      async updateProfile({ district, avatarFile, instagram, acceptRules, bio, show_seen }) {
        const u = need(), patch = { updated_at: nowISO() };
        if (acceptRules) patch.accepted_rules_at = nowISO();
        if (instagram !== undefined) patch.instagram = cleanInsta(instagram);
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
            p_offset: 0, p_limit: lim, p_after_score: before && before.s != null ? before.s : null, p_snapshot: before && before.snap ? before.snap : null });
          if (signal) q = q.abortSignal(signal);
          const { data: ids, error } = await q; if (error) fail(error);
          const order = (ids || []).map((r) => r.post_id);
          let rows = [];
          if (order.length) { const r2 = await sb.from("posts").select(POST_SELECT).in("id", order); if (r2.error) fail(r2.error); rows = order.map((id) => (r2.data || []).find((x) => x.id === id)).filter(Boolean); }
          const l = (ids || [])[order.length - 1];
          // "Для вас": курсор (балл, id) и время снимка — следующие страницы считаются на тот же момент
          const next = !l ? before || null : sort === "near" ? { d: l.sort_dist, id: l.post_id } : sort === "top" ? { s: l.sort_score, id: l.post_id, snap: l.snapshot } : { ts: l.sort_ts, id: l.post_id };
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
      async createPost({ category, text, lat, lng, files = [], event, exact = false, is_sos = false, clientKey }, onProgress = () => {}) {
        const u = need();
        if (!CATS[category]) throw new Error("Выберите тип публикации");
        if (!text || !text.trim()) throw new Error("Добавьте описание");
        if (lat == null || lng == null) throw new Error("Укажите место на карте");
        if (files.length > 5) throw new Error("Не больше 5 вложений в публикации");
        files.forEach(validateFile);
        if (files.length && profile && profile.account && profile.account.media_ok === false) throw new Error("Фото и видео временно недоступны: на сервере не включена проверка файлов. Опубликуйте текст без файлов");
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
          const base = `${u.id}/${post.id}/${i}-${Date.now()}`, row = { post_id: post.id, user_id: u.id, type: isImg ? "image" : "video", position: i };
          const pr = (frac) => onProgress(`Загружаем ${lbl}... ${Math.round(frac * 100)}%`, (i + frac) / files.length);
          if (isImg) {
            onProgress(`Сжимаем ${lbl}...`, i / files.length);
            // перекодирование через canvas убирает EXIF (в том числе GPS)
            const full = await compressImage(f0, 1600, 0.82, true), th = await compressImage(f0, 480, 0.75);
            row.url = await uploadBlob(base + ".jpg", full.blob, "image/jpeg", (x) => pr(x * 0.85));
            row.thumb_url = await uploadBlob(base + "-t.jpg", th, "image/jpeg", (x) => pr(0.85 + x * 0.15));
            row.w = full.w; row.h = full.h; row.path = base + ".jpg";
          } else {
            onProgress(`Проверяем ${lbl}...`, i / files.length);
            const meta = await probeVideo(f0), f = await stripVideoMeta(f0), ext = ((f0.name.split(".").pop() || "mp4").toLowerCase());
            if (meta.poster) { const pu = await uploadBlob(base + "-p.jpg", meta.poster, "image/jpeg"); row.poster_url = pu; row.thumb_url = pu; }
            row.url = await uploadBlob(base + "." + ext, f, f0.type || "video/mp4", pr);
            row.w = meta.w; row.h = meta.h; row.duration = Math.round(meta.duration * 10) / 10; row.path = base + "." + ext;
          }
          const { data: pm, error: me } = await sb.from("post_media").insert(row).select("id").single();
          if (me) { await sb.storage.from(BUCKET).remove([row.path, base + "-t.jpg", base + "-p.jpg"]).catch(() => {}); fail(me); }
          if (isImg) moderate("post_media", pm.id);
        }
        if (event && event.starts_at) {
          const { error: ee } = await sb.from("events").upsert({ post_id: post.id, starts_at: event.starts_at, capacity: event.capacity || null });
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
        const { data, error } = await sb.from("comments").insert({ post_id: id, user_id: u.id, text: text.slice(0, 500), parent_id: parentId || null, client_key: rid() + rid() })
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
        const [a, b, c] = await Promise.all([
          sb.from("posts").select("id", h).eq("user_id", id),
          sb.from("saved_posts").select("post_id", h).eq("user_id", id),
          sb.from("event_members").select("post_id", h).eq("user_id", id)
        ]);
        return { posts: a.count || 0, saved: b.count || 0, events: c.count || 0 };
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
    CATS, CITY, dist, boundsAround, compressImage, validateFile, probeVideo, validateChatFile, ruError, mask, hasBad, cleanText, isThreat, nickProblem, CLEAN_VERSION, REASONS, REASON_LABELS, stripVideoMeta, snap, rid,
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
