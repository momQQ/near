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
    help:     { e: "🤝", n: "Помощь",       c: "#2bd47d", ttl: 24 * 7 },
    meetup:   { e: "🤝", n: "Встреча", c: "#A54EE7", ttl: 24 },
    ad:       { e: "📢", n: "Объявление",   c: "#00b4a6", ttl: 24 * 7 },
    talk:     { e: "💬", n: "Обсуждение",   c: "#ff2e88", ttl: 24 * 3 }
  };

  // интересы профиля (совпадают с проверкой в базе: profiles_interests_chk)
  const INTERESTS = [["games", "🎮 Компьютерные игры"], ["cinema", "🎬 Кино"], ["board", "🎲 Настольные игры"], ["sport", "⚽ Спорт"], ["cafe", "☕ Кафе"], ["walks", "🚶 Прогулки"],
    ["mountains", "⛰️ Горы"], ["study", "📚 Обучение"], ["pets", "🐾 Животные"], ["music", "🎵 Музыка"], ["kids", "🧒 Дети"], ["volunteer", "🤲 Волонтерство"], ["other", "✨ Другое"]];

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
      // v14.2 (ТЗ 58): WebP, если браузер умеет (иначе JPEG); цель — до 500 КБ: качество снижается ступенями
      const enc = (type, q) => new Promise((res) => c.toBlob(res, type, q));
      let blob = await enc("image/webp", quality);
      if (!blob || blob.type !== "image/webp") blob = await enc("image/jpeg", quality);
      for (let q = quality - 0.1; blob.size > 500 * 1024 && q >= 0.5; q -= 0.1) blob = await enc(blob.type, q);
      const ext = blob.type === "image/webp" ? "webp" : "jpg";
      return withDims ? { blob, w, h, ext } : blob;
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
        if (v.duration > (CFG.MAX_VIDEO_SEC || 180)) return fin(rej, new Error(`Видео длиннее ${CFG.MAX_VIDEO_SEC || 30} секунд. Обрежьте его и попробуйте снова`));
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
  const THREAT = /(^|[^а-яa-z])(убью (тебя|вас|его|ее|тебе)|(тебя|вас|его|ее) (убью|прибью|зарежу)|зарежу|пристрелю|задушу (тебя|вас)|урою|тебе конец|найду тебя и|найду,? где (ты )?живешь|приду за тобой|сожгу (тебя|вас|твой|твою|ваш)|i will kill you|i'll kill you|kill you|өлтіремін)([^а-яa-z]|$)/;
  const isThreat = (t) => THREAT.test(String(t || "").toLowerCase().replace(/ё/g, "е"));
  const mask = (t) => (t == null ? t : cleanText(t).text);
  const hasBad = (t) => cleanText(String(t || "")).hits > 0;
  // 45/60/07: опасное блокируется независимо от маскирования; сомнительное — публикуется и уходит модератору.
  // Те же правила, что near_block_reason / near_flag_reason в базе. Без lookbehind: старые Safari его не понимают.
  const normT = (t) => String(t || "").toLowerCase().replace(/ё/g, "е");
  const RX_SEX = /(интим[ -]?(услуг|за деньг|встреч)|эскорт|секс за деньг|секс[ -]?услуг|досуг для (мужчин|джентльмен)|нюдс|nudes|onlyfans|скинь (фото|нюдс) без одежды|sex for money)/;
  const RX_SCAM = /(скинь|пришли|назови|сообщи|продиктуй|отправь)(те)? (мне |нам )?(код из смс|код|смс|cvv|cvc|пин-?код|номер карты|данные карты)([^а-яa-z]|$)/g;
  const RX_SHORT = /(bit\.ly|clck\.ru|tinyurl\.com|cutt\.ly|goo\.su|t\.ly|is\.gd|rb\.gy|shorturl\.at|ow\.ly|u\.to|vk\.cc)\//;
  const RX_PREPAY = /(предоплат|переведи(те)? (на |деньги)|перевод(ом)? на (карту|каспи|kaspi))/g;
  // совпадение, перед которым нет указанного слова ("не скиньте", "без предоплаты")
  function hitNotAfter(rx, s, word) { rx.lastIndex = 0; let m; while ((m = rx.exec(s))) { if (!s.slice(0, m.index).endsWith(word)) return true; if (m[0] === "") rx.lastIndex++; } return false; }
  function nearBlockReason(t) {
    const s = normT(t); if (!s) return null;
    if (isThreat(t)) return "threat";
    if (RX_SEX.test(s)) return "sexual";
    if (hitNotAfter(RX_SCAM, s, "не ")) return "scam";
    if (RX_SHORT.test(s)) return "shortlink";
    return null;
  }
  const nearFlagReason = (t) => (hitNotAfter(RX_PREPAY, normT(t), "без ") ? "prepay" : null);
  const BLOCK_MSG = { threat: "Угрозы запрещены правилами NEAR. Текст не опубликован", sexual: "Интимные услуги и откровенные предложения запрещены. NEAR — не сервис знакомств",
    scam: "Нельзя просить коды из SMS и данные карт. NEAR никогда не просит SMS-коды", shortlink: "Сокращенные ссылки запрещены: укажите полный адрес сайта" };
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
  const httpsUrl = (u) => (/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[^\s<>"]*)?$/i.test(u || "") && String(u).length <= 300 && !nearBlockReason(u + " ") ? u : null);
  function postMetaClean(cat, m) {
    m = { ...(m || {}) }; const o = {};
    for (const [k, L] of [["title", 80], ["organizer", 60], ["org", 60], ["conditions", 300], ["price_text", 60]]) {
      const t = String(m[k] || "").trim(); if (!t) { delete m[k]; continue; }
      const r = nearBlockReason(t); if (r) { const e = new Error(BLOCK_MSG[r]); e.code = "NR422"; throw e; }
      m[k] = mask(t.slice(0, L));
    }
    if (cat === "incident") { if (["dtp", "water", "power", "gas", "heat", "road", "other"].includes(m.itype)) o.itype = m.itype; if ([1, 3, 6, 12, 24].includes(+m.ttl_h)) o.ttl_h = +m.ttl_h; }
    else if (cat === "event") {
      if (m.title) { if (m.title.length < 5) throw new Error("Название события: от 5 до 80 символов"); o.title = m.title; }
      if (m.organizer) o.organizer = m.organizer;
      if (/^\d{1,7}$/.test(String(m.price_kzt ?? ""))) o.price_kzt = +m.price_kzt; else if (m.price_kzt === "free") o.price_kzt = 0;
      if (httpsUrl(m.source_url)) o.source_url = m.source_url;
    } else if (cat === "deal") {
      if (m.org) o.org = m.org; if (m.price_text) o.price_text = m.price_text;
      if (m.until) { const d = new Date(m.until); if (isNaN(d) || d <= Date.now() || d > Date.now() + 14 * 86400e3) throw new Error("Срок акции: от сегодня до 14 дней"); o.until = d.toISOString(); }
      if (httpsUrl(m.url)) o.url = m.url;
    } else if (cat === "help") o.hkind = m.hkind === "offer" ? "offer" : "need";
    else if (cat === "ad" && m.price_text) o.price_text = m.price_text;
    return o;
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
     SUPABASE (реальный сервер)
     ===================================================== */
  function SupabaseBackend() {
    let sb, profile = null, session = null, blockedSet = null;
    async function myBlocks() {
      if (!session) return new Set();
      if (!blockedSet) { const { data } = await sb.from("blocks").select("blocked_id").eq("blocker_id", session.user.id); blockedSet = new Set((data || []).map((x) => x.blocked_id)); }
      return blockedSet;
    }
    // v14.2: Instagram не читается напрямую (только profile_instagram по настройке владельца)
    const PUB = "id,name,nickname,avatar_url,district,created_at,verified,last_seen_at,banned,bio,interests";
    const OWN = PUB + ",is_admin,is_moderator,accepted_rules_at,show_seen";
    // v11: ИИ-проверку запускает сама база (триггер ai_fire) — клиент ничего не вызывает
    async function moderate() {}
    const authCbs = [];
    const BUCKET = "post-media";
    // v14.2: счетчики — колонки posts (без подсчета на каждый запрос); meta — поля форм; official/source — NEAR City
    const POST_SELECT = "id,user_id,category,text,lat,lng,status,created_at,updated_at,is_sos,exact,expires_at,resolved_at,meta,official,source_name,source_url,verified_at,likes_count,comments_count," +
      "author:profiles!posts_user_id_fkey(id,name,avatar_url,verified),post_media!post_media_post_id_fkey(url,type,position,mod_status,thumb_url,poster_url,w,h,duration,bucket)," +
      "events!events_post_id_fkey(starts_at,capacity),event_members!event_members_post_id_fkey(count)";
    const one = (x) => (Array.isArray(x) ? x[0] : x) || null;
    const cnt = (x) => (Array.isArray(x) && x[0] ? x[0].count : 0);

    async function loadProfile() {
      if (!session) { profile = null; return null; }
      let { data, error } = await sb.from("profiles").select(OWN).eq("id", session.user.id).maybeSingle();
      if (error) console.warn(error);
      if (!data && !error) { await sb.rpc("ensure_profile"); ({ data } = await sb.from("profiles").select(OWN).eq("id", session.user.id).maybeSingle()); }
      // v14: приватный статус аккаунта (возрастной допуск, телефон, срок смены ника, доступность файлов)
      let account = null; try { const r = await sb.rpc("my_account"); account = r.data || null; } catch (e) {}
      profile = { id: session.user.id, email: session.user.email, name: (data && (data.nickname || data.name)) || "Новый пользователь", account, avatar_url: data && data.avatar_url, district: (data && data.district) || "",
        instagram: account && account.instagram, instagram_public: !!(account && account.instagram_public), interests: (data && data.interests) || [], is_admin: !!(data && data.is_admin), is_mod: !!(data && (data.is_admin || data.is_moderator)), banned: !!(data && data.banned),
        nickname: (data && data.nickname) || null, verified: !!(data && data.verified) || !!session.user.email_confirmed_at, last_seen_at: data && data.last_seen_at,
        accepted_rules: !!(data && data.accepted_rules_at), bio: (data && data.bio) || null, show_seen: data ? data.show_seen !== false : true, provider: (session.user.app_metadata && session.user.app_metadata.provider) || "email" };
      blockedSet = null;
      return profile;
    }
    function need() { if (!session) throw new Error("Войдите, чтобы сделать это"); return session.user; }

    async function enrich(rows) {
      const u = session && session.user;
      // файлы скрытых модератором публикаций лежат в приватном бакете: ссылка на 10 минут (видит автор и модератор)
      // v14.2: файлы публикаций приватные (post-private), скрытые — в карантине; короткая подписанная ссылка по бакету
      const priv = {};
      rows.forEach((r) => (r.post_media || []).forEach((m) => ["url", "thumb_url", "poster_url"].forEach((k) => {
        if (m[k] && m[k].startsWith("private:")) { const b = m.bucket === "post-private" ? "post-private" : "post-quarantine"; (priv[b] = priv[b] || new Set()).add(m[k].slice(8)); }
      })));
      const signed = new Map();
      await Promise.all(Object.entries(priv).map(async ([b, set]) => {
        const { data: sg } = await sb.storage.from(b).createSignedUrls([...set], 900);
        (sg || []).forEach((x) => { if (x && x.signedUrl) signed.set(b + ":" + x.path, x.signedUrl); });
      }));
      rows.forEach((r) => (r.post_media || []).forEach((m) => ["url", "thumb_url", "poster_url"].forEach((k) => {
        if (m[k] && m[k].startsWith("private:")) m[k] = signed.get((m.bucket === "post-private" ? "post-private" : "post-quarantine") + ":" + m[k].slice(8)) || null;
      })));
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
          meta: r.meta || {}, official: !!r.official, source_name: r.source_name || null, source_url: r.source_url || null, verified_at: r.verified_at || null,
          author: one(r.author) || { id: r.user_id, name: "Пользователь", avatar_url: null },
          media: (r.post_media || []).sort((a, b) => (a.position || 0) - (b.position || 0)).map((m) => ({ url: m.url, type: m.type, mod_status: m.mod_status || "ok", thumb: m.thumb_url || null, poster: m.poster_url || null, w: m.w || null, h: m.h || null, duration: m.duration || null })),
          likes: r.likes_count != null ? r.likes_count : cnt(r.likes), comments: r.comments_count != null ? r.comments_count : cnt(r.comments), liked: liked.has(r.id), saved: saved.has(r.id),
          event: ev ? { starts_at: ev.starts_at, capacity: ev.capacity, members: cnt(r.event_members), joined: joined.has(r.id) } : null
        };
      });
    }
    // загрузка с прогрессом (XHR) и двумя повторами при обрыве связи
    function xhrUpload(path, blob, contentType, onPct, bucket) {
      return new Promise((res, rej) => {
        const x = new XMLHttpRequest();
        x.open("POST", `${CFG.SUPABASE_URL}/storage/v1/object/${bucket || BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`);
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
    // v14.2: файлы публикаций — в приватный post-private (возвращается "private:путь"), аватары — в публичный avatars
    async function uploadBlob(path, blob, contentType, onPct, bucket = "post-private") {
      for (let attempt = 0; ; attempt++) {
        try {
          if (typeof XMLHttpRequest !== "undefined" && session) await xhrUpload(path, blob, contentType, onPct, bucket);
          else { const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType, upsert: false, cacheControl: "31536000" }); if (error) fail(error); }
          break;
        } catch (e) {
          if (attempt >= 2 || !(e.net || e.status >= 500)) throw new Error(ruError(e.message));
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      return bucket === "post-private" ? "private:" + path : sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
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
      /* v14.8: личные сообщения отключены — старые методы удалены */
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
        if (nickname) { const np = nickProblem(nickname); if (np) throw new Error(np); }
        // ТЗ 38: в метаданные — только согласие с правилами (никнейм выбирается после подтверждения почты)
        const { data, error } = await sb.auth.signUp({ email: (email || "").trim(), password, options: { data: { nickname: nickname || undefined, accepted_rules: true, district: district || null }, emailRedirectTo: redirect(), captchaToken } });
        // ТЗ 38/59: одинаковый ответ для нового и существующего email (не раскрываем, есть ли аккаунт)
        if (error) { if (/already registered|already been registered|user_already_exists/i.test(error.message || "") || error.code === "user_already_exists") return { needsConfirm: true, neutral: true }; fail(error); }
        if (data.user && data.user.identities && data.user.identities.length === 0) return { needsConfirm: true, neutral: true };
        return { needsConfirm: !data.session };
      },
      // v14.8 (ТЗ 03): вход по нику или email. Ник превращается в email только на сервере (Edge Function login)
      async signIn({ login, email, password, captchaToken }) {
        login = String(login || email || "").trim();
        if (!login || !password) throw new Error("Заполните ник или email и пароль");
        if (login.includes("@") && CFG.LOGIN_FN === false) {
          const { error } = await sb.auth.signInWithPassword({ email: login, password, options: { captchaToken } });
          if (error) fail(error);
        } else {
          let r;
          try { r = await fetch(CFG.SUPABASE_URL.replace(/\/$/, "") + "/functions/v1/login", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY, Authorization: "Bearer " + CFG.SUPABASE_ANON_KEY }, body: JSON.stringify({ login, password, captcha_token: captchaToken || undefined }) }); }
          catch (e) { throw new Error("Нет связи с сервером. Проверьте интернет"); }
          const j = await r.json().catch(() => ({}));
          if (r.status === 404) {
            // функция login еще не развернута: вход по email напрямую
            if (!login.includes("@")) throw new Error("Вход по нику пока не включен. Войдите по email");
            const { error } = await sb.auth.signInWithPassword({ email: login, password, options: { captchaToken } }); if (error) fail(error);
          } else if (!r.ok) { const e = new Error(j.message || "Неверный ник, email или пароль"); e.code = j.error === "pending_email" ? "email_not_confirmed" : j.error || ""; e.retryAfter = j.retry_after; throw e; }
          else { const { error } = await sb.auth.setSession({ access_token: j.access_token, refresh_token: j.refresh_token }); if (error) fail(error); }
        }
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
      async account() { if (!session) return null; const { data } = await sb.rpc("my_account"); if (profile) profile.account = data || profile.account; return data; },
      /* v14.2: второй фактор (TOTP) для модераторов и администратора */
      async mfaState() {
        const { data: a } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
        const { data: f } = await sb.auth.mfa.listFactors();
        const totp = ((f && f.totp) || []).find((x) => x.status === "verified") || null;
        return { level: a && a.currentLevel, next: a && a.nextLevel, factorId: totp && totp.id };
      },
      async mfaEnroll() {
        const { data: f } = await sb.auth.mfa.listFactors();
        for (const x of ((f && f.all) || []).filter((y) => y.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: x.id }).catch(() => {});
        const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "NEAR " + new Date().toISOString().slice(0, 10) });
        if (error) fail(error); return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
      },
      async mfaVerify(factorId, code) {
        const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: String(code || "").replace(/\D/g, "") });
        if (error) throw new Error(/invalid|expired/i.test(error.message || "") ? "Неверный или устаревший код. Введите новый из приложения" : ruError(error.message));
        await loadProfile(); return true;
      },
      async modMediaQueue() {
        const { data, error } = await sb.rpc("mod_media_queue"); if (error) fail(error);
        const list = data || [], paths = list.filter((m) => m.bucket === "post-private").map((m) => m.path);
        if (paths.length) { const { data: sg } = await sb.storage.from("post-private").createSignedUrls(paths, 600); const mp = new Map((sg || []).map((x) => [x.path, x.signedUrl])); list.forEach((m) => (m.url = mp.get(m.path) || null)); }
        return list;
      },
      async modMedia(id, approve, note) { const { error } = await sb.rpc("mod_media", { p_id: id, p_approve: !!approve, p_note: note || null }); if (error) fail(error); },
      async modRestrict(userId, scope, days, reason) { const { error } = await sb.rpc("mod_restrict", { p_user: userId, p_scope: scope, p_days: days, p_reason: reason }); if (error) fail(error); },
      async modUnrestrict(id, note) { const { error } = await sb.rpc("mod_unrestrict", { p_id: id, p_note: note || null }); if (error) fail(error); },
      async sanctions(userId) { const { data, error } = await sb.from("user_sanctions").select("*").eq("user_id", userId || (session && session.user.id)).is("revoked_at", null).order("created_at", { ascending: false }); if (error) fail(error); return data || []; },
      async cityUpsert(item) { const { data, error } = await sb.rpc("city_upsert", { p: item }); if (error) fail(error); return data; },
      async cityList() { const { data, error } = await sb.from("posts").select(POST_SELECT).eq("official", true).order("verified_at", { ascending: false }).limit(50); if (error) fail(error); return enrich(data || []); },
      /* ---------- v14.8: общие комнаты (город, районы, темы, встречи) ---------- */
      async roomsList(tab = "near", q = null) { const { data, error } = await sb.rpc("rooms_list", { p_tab: tab, p_q: q || null }); if (error) fail(error); return data || []; },
      async room(id) { const { data, error } = await sb.from("rooms").select("*").eq("id", id).maybeSingle(); if (error) fail(error); return data; },
      async roomFeed(id, before) {
        const { data, error } = await sb.rpc("room_feed", { p_room: id, p_before: before ? before.created_at : null, p_before_id: before ? before.id : null, p_limit: 40 });
        if (error) fail(error);
        const ids = [...new Set((data || []).map((m) => m.sender_id).filter(Boolean))];
        const who = ids.length ? (await sb.from("profiles").select("id,nickname,avatar_url,verified").in("id", ids)).data || [] : [];
        const by = Object.fromEntries(who.map((u) => [u.id, u]));
        return (data || []).map((m) => ({ ...m, author: m.sender_id ? by[m.sender_id] || { nickname: "удаленный аккаунт" } : null })).reverse();
      },
      async joinRoom(id) { need(); const { error } = await sb.rpc("join_room", { p_room: id }); if (error) fail(error); },
      async leaveRoom(id) { need(); const { error } = await sb.rpc("leave_room", { p_room: id }); if (error) fail(error); },
      async roomSettings(id, o = {}) { if (!session) return; await sb.rpc("room_settings", { p_room: id, p_notify: o.notify || null, p_read: !!o.read, p_active: o.active ?? null }); },
      async sendMessage(room, body, clientId, replyTo, action) {
        need();
        const { data, error } = await sb.rpc("send_message", { p_room: room, p_body: body, p_client_id: clientId, p_reply_to: replyTo || null, p_kind: action ? "action" : "text", p_action: action || null });
        if (error) fail(error); return data;
      },
      async hideMessage(id, reason) { const { error } = await sb.rpc("room_hide_message", { p_msg: id, p_reason: reason || "" }); if (error) fail(error); },
      async setMute(room, uid, minutes, reason) { const { error } = await sb.rpc("set_mute", { p_room: room, p_user: uid, p_minutes: minutes, p_reason: reason || null }); if (error) fail(error); },
      subscribeRoom(id, cb, onState) {
        const ch = sb.channel("room-" + id)
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_messages", filter: "room_id=eq." + id }, (p) => cb("insert", p.new))
          .on("postgres_changes", { event: "UPDATE", schema: "public", table: "room_messages", filter: "room_id=eq." + id }, (p) => cb("update", p.new));
        ch.subscribe((st) => onState && onState(st));
        return () => sb.removeChannel(ch);
      },
      /* ---------- v14.8: встречи ---------- */
      async meetingsNear(o) {
        const { data, error } = await sb.rpc("meetings_near", { p_lat: o.lat, p_lng: o.lng, p_radius: o.radius || 10000, p_cats: o.cats && o.cats.length ? o.cats : null,
          p_from: o.from || null, p_to: o.to || null, p_free_only: !!o.free, p_max_price: o.maxPrice ?? null, p_limit: 30 });
        if (error) fail(error); return data || [];
      },
      async meeting(id) { const { data, error } = await sb.rpc("meeting_get", { p_meeting: id }); if (error) fail(error); return data; },
      async myMeetings() { need(); const { data, error } = await sb.rpc("my_meetings"); if (error) fail(error); return data || []; },
      async createMeeting(p) { need(); const { data, error } = await sb.rpc("create_meeting", { p }); if (error) fail(error); return data; },
      async meetAct(fn, args) {
        need();
        const ALLOWED = ["request_join", "decide_request", "remove_member", "leave_meeting", "set_cohost", "transfer_host", "update_meeting", "close_recruiting", "cancel_meeting", "finish_meeting", "request_checkin", "answer_checkin", "mark_attended", "confirm_attendance", "submit_review"];
        if (!ALLOWED.includes(fn)) throw new Error("Неизвестное действие");
        const { data, error } = await sb.rpc(fn, args); if (error) fail(error); return data;
      },
      async meetAudit(id) { const { data, error } = await sb.from("meeting_audit").select("action,reason,created_at,target_id").eq("meeting_id", id).order("created_at", { ascending: false }).limit(100); if (error) fail(error); return data || []; },
      async profilePublic(id) { const { data, error } = await sb.rpc("profile_public", { u: id }); if (error) fail(error); return data; },
      async setNotifyLevel(l) { need(); const { error } = await sb.rpc("set_notify_level", { p_level: l }); if (error) fail(error); if (profile) profile.account = { ...(profile.account || {}), notify_level: l }; },
      // ТЗ 56: задержка API из текущей сети (10 запросов): медиана и p95
      async ping(n = 10) {
        const t = [];
        for (let i = 0; i < n; i++) { const t0 = performance.now(); const { error } = await sb.rpc("ping"); if (error) fail(error); t.push(performance.now() - t0); }
        t.sort((a, b) => a - b); return { p50: Math.round(t[Math.floor(n / 2)]), p95: Math.round(t[Math.min(n - 1, Math.ceil(n * 0.95) - 1)]), n };
      },
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
      async updateProfile({ district, avatarFile, instagram, instagram_public, interests, acceptRules, bio, show_seen }) {
        const u = need(), patch = { updated_at: nowISO() };
        if (acceptRules) patch.accepted_rules_at = nowISO();
        if (instagram !== undefined) patch.instagram = cleanInsta(instagram);
        if (instagram_public !== undefined) patch.instagram_public = !!instagram_public;
        if (interests !== undefined) patch.interests = (interests || []).filter((k) => INTERESTS.some((x) => x[0] === k)).slice(0, 5);
        if (district !== undefined) patch.district = district;
        if (bio !== undefined) { if (String(bio).length > 160) throw new Error("Описание не длиннее 160 символов"); patch.bio = String(bio).trim() || null; }
        if (show_seen !== undefined) patch.show_seen = !!show_seen;
        if (avatarFile) { validateFile(avatarFile); const av = await compressImage(avatarFile, 400, 0.8, true); patch.avatar_url = await uploadBlob(`${u.id}/avatar-${Date.now()}.${av.ext}`, av.blob, av.blob.type, null, "avatars"); }
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
      // v14.2 (ТЗ 46/57): карта — только id, точка, категория, заголовок, статус, время; признак неполной выдачи
      async mapPoints({ lat, lng, radius, bounds, category, limit = 400, period, friends, signal } = {}) {
        const cats = category ? (Array.isArray(category) ? category : [category]) : null;
        const b = bounds || { w: 0, s: 0, e: 0, n: 0 };
        let q = sb.rpc("map_v14", { p_w: b.w, p_s: b.s, p_e: b.e, p_n: b.n, p_cats: cats, p_lat: bounds ? null : lat, p_lng: bounds ? null : lng,
          p_radius: bounds ? null : Math.round(radius || 3000), p_period: period || null, p_friends: !!friends, p_limit: limit });
        if (signal) q = q.abortSignal(signal);
        const { data, error } = await q;
        if (error) { if (/map_v14/.test(error.message || "")) return { items: await this.listPosts({ lat, lng, radius, bounds, category, limit, period, friends, signal }), truncated: false }; fail(error); }
        return { truncated: !!(data && data.truncated), items: ((data && data.items) || []).map((x) => ({ id: x.id, lat: x.lat, lng: x.lng, category: x.category, status: x.status, created_at: x.created_at,
          is_sos: !!x.is_sos, official: !!x.official, text: x.title || "", likes: x.likes_count || 0, comments: x.comments_count || 0, media: [], author: { name: "" },
          expires_at: x.expires_at || null, event: x.starts_at ? { starts_at: x.starts_at } : null, _light: true })) };
      },
      // FEED-01: лента — серверная геовыборка (PostGIS), курсор {ts, id}, до 12 записей на страницу
      async feedPage({ lat, lng, radius, category, limit = 12, before, after, sort = "new", period, friends, signal } = {}) {
        const cats = category ? (Array.isArray(category) ? category : [category]) : null;
        const base = { p_lat: lat, p_lng: lng, p_radius: Math.round(radius), p_cats: cats };
        // UX-02: "Рядом", "Для вас", период и "Друзья" — функция feed_sorted (id по порядку), затем карточки одним запросом
        // v14.2 (ТЗ 57): один запрос — feed_v14 отдает строки posts с автором, файлами и счетчиками; курсор = id + время снимка
        if (!after && this.feedV14 !== false) {
          const lim = Math.min(limit || 15, 20);
          const snap = (before && before.snap) || new Date(Date.now() - 5000).toISOString();
          let q = sb.rpc("feed_v14", { ...base, p_sort: sort, p_period: period || null, p_friends: !!friends, p_after_id: before ? before.id || null : null, p_snapshot: snap, p_limit: lim }).select(POST_SELECT);
          if (signal) q = q.abortSignal(signal);
          const { data, error } = await q;
          if (error) { if (/feed_v14/.test(error.message || "") && /find|exist/i.test(error.message || "")) this.feedV14 = false; else fail(error); }
          else {
            const rows = data || [], l = rows[rows.length - 1];
            return { posts: await enrich(rows), next: l ? { id: l.id, ts: l.created_at, snap } : before || null, done: rows.length < lim };
          }
        }
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
      // v14.8: обложка встречи 16:9, до 500 КБ, через ту же проверку файлов (закрытое хранилище)
      async attachCover(postId, file) {
        const u = need(); if (validateFile(file) !== "image") throw new Error("Обложка — только фото");
        const full = await compressImage(file, 1280, 0.8, true), base = `${u.id}/${postId}/cover-${Date.now()}`;
        const url = await uploadBlob(base + "." + full.ext, full.blob, full.blob.type);
        const { data: pm, error } = await sb.from("post_media").insert({ post_id: postId, user_id: u.id, type: "image", position: 0, url, thumb_url: url, w: full.w, h: full.h, path: base + "." + full.ext }).select("id").single();
        if (error) fail(error); moderate("post_media", pm.id);
      },
      async profileLite(id) { const { data } = await sb.from("profiles").select("id,nickname,avatar_url,verified").eq("id", id).maybeSingle(); return data; },
      async createPost({ category, text, lat, lng, files = [], event, exact = false, is_sos = false, clientKey, meta }, onProgress = () => {}) {
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
          const { data, error } = await sb.from("posts").insert({ user_id: u.id, category, text: text.trim().slice(0, 1000), lat, lng, exact: !!exact, is_sos: !!is_sos, status: "draft", client_key: key, meta: meta || {} }).select("id,status").single();
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
            const full = await compressImage(f0, 1600, 0.82, true), th = await compressImage(f0, 480, 0.75, true);
            row.url = await uploadBlob(base + "." + full.ext, full.blob, full.blob.type, (x) => pr(x * 0.85));
            row.thumb_url = await uploadBlob(base + "-t." + th.ext, th.blob, th.blob.type, (x) => pr(0.85 + x * 0.15));
            row.w = full.w; row.h = full.h; row.path = base + "." + full.ext;
          } else {
            onProgress(`Проверяем ${lbl}...`, i / files.length);
            const meta = await probeVideo(f0), f = await stripVideoMeta(f0), ext = ((f0.name.split(".").pop() || "mp4").toLowerCase());
            if (meta.poster) { const pu = await uploadBlob(base + "-p.jpg", meta.poster, "image/jpeg"); row.poster_url = pu; row.thumb_url = pu; }
            row.url = await uploadBlob(base + "." + ext, f, f0.type || "video/mp4", pr);
            row.w = meta.w; row.h = meta.h; row.duration = Math.round(meta.duration * 10) / 10; row.path = base + "." + ext;
          }
          const { data: pm, error: me } = await sb.from("post_media").insert(row).select("id").single();
          if (me) { await sb.storage.from("post-private").remove([row.path, base + "-t.jpg", base + "-t.webp", base + "-p.jpg"]).catch(() => {}); fail(me); }
          if (isImg) moderate("post_media", pm.id);
        }
        if (event && event.starts_at) {
          const { error: ee } = await sb.from("events").upsert({ post_id: post.id, starts_at: event.starts_at, ends_at: event.ends_at || null, capacity: event.capacity || null });
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
      async updatePost(id, { text, category, status, event, meta }) {
        need(); const patch = { updated_at: nowISO() };
        if (meta !== undefined) patch.meta = meta || {};
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
        let instagram = null; try { const r = await sb.rpc("profile_instagram", { p_user: id }); instagram = r.data || null; } catch (e) {}
        return { ...x, instagram, friendship, blocked, posts: pc.count || 0, friends: (fa.count || 0) + (fb.count || 0) };
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
      /* v14.8: личные сообщения отключены — старые методы удалены */
      async block(id) { const u = need(); const { error } = await sb.from("blocks").upsert({ blocker_id: u.id, blocked_id: id }); if (error) fail(error); blockedSet = null; },
      async unblock(id) { const u = need(); const { error } = await sb.from("blocks").delete().eq("blocker_id", u.id).eq("blocked_id", id); if (error) fail(error); blockedSet = null; },
      async blockedList() {
        const u = need(); const { data, error } = await sb.from("blocks").select("blocked:profiles!blocks_blocked_id_fkey(" + PUB + ")").eq("blocker_id", u.id);
        if (error) fail(error); return (data || []).map((x) => one(x.blocked)).filter(Boolean);
      },
      blockedIds: () => myBlocks(),

      /* ----- сообщения ----- */
      /* v14.8: личные сообщения отключены — старые методы удалены */
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
    CATS, CITY, dist, boundsAround, compressImage, validateFile, probeVideo, validateChatFile, ruError, mask, hasBad, cleanText, isThreat, nickProblem, CLEAN_VERSION,
    nearBlockReason, nearFlagReason, BLOCK_MSG, postMetaClean, httpsUrl, INTERESTS, REASONS, REASON_LABELS, stripVideoMeta, snap, rid,
    api: null,
    async start() {
      // demo — только локальные данные; staging/prod — только сервер, без тихого перехода в демо
      const env = CFG.ENV || (hasSupabase ? "prod" : "demo");
      if (env !== "demo") {
        if (!hasSupabase) throw new Error("Сервер не настроен (config.js). Обратитесь к администратору.");
        if (!window.supabase) throw new Error("Не удалось загрузить библиотеку Supabase. Проверьте интернет и обновите страницу.");
        this.api = SupabaseBackend();
      } else {
        // демо-данные — отдельным файлом, только в демо-режиме
        if (!window.NEAR_DEMO) await new Promise((ok, no) => { const sc = document.createElement("script"); sc.src = document.querySelector('script[src*="data.min.js"]') ? "js/demo.min.js" : "js/demo.js"; sc.onload = ok; sc.onerror = () => no(new Error("Не удалось загрузить демо-данные")); document.head.appendChild(sc); });
        this.api = window.NEAR_DEMO({ BLOCK_MSG, CATS, CITY, INTERESTS, REASONS, blobToDataURL, boundsAround, byNewest, cleanInsta, compressImage, cursorOf, dist, httpsUrl, mask, nearBlockReason, nickNorm, nickProblem, nowISO, olderThan, periodOk, postMetaClean, score, snap, uid, validateChatFile, validateFile });
      }
      this.env = env;
      return this.api.init();
    }
  };
})();
