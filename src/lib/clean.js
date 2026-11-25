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
