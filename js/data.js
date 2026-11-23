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
    ad:       { e: "📢", n: "Обьявление",   c: "#00b4a6", ttl: 24 * 7 },
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
  async function compressImage(file, maxSide = 1600, quality = 0.82) {
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
      return await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

  function validateFile(f) {
    const isImg = /^image\//.test(f.type), isVid = /^video\//.test(f.type);
    if (!isImg && !isVid) throw new Error(`Файл "${f.name}" не поддерживается. Можно фото (JPG, PNG, WEBP) или видео (MP4, MOV).`);
    if (isImg && f.size > (CFG.MAX_IMAGE_MB || 15) * 1048576) throw new Error(`Фото "${f.name}" больше ${CFG.MAX_IMAGE_MB || 15} МБ.`);
    if (isVid && f.size > (CFG.MAX_VIDEO_MB || 30) * 1048576) throw new Error(`Видео "${f.name}" больше ${CFG.MAX_VIDEO_MB || 30} МБ.`);
    return isImg ? "image" : "video";
  }

  /* фильтр грубых слов (такой же работает на сервере в schema.sql) */
  const BAD = /[а-яёa-z]*(хуй|хуе|хуё|хуя|пизд|ебан|ебат|ебал|еблан|ёбан|выеб|заеб|уеб|бляд|блят|сука|суки|сучк|мудак|мудил|гандон|пидор|пидар|шлюх|долбоеб|залуп|қотақ|сігей|сигей|шешеңді)[а-яёa-zқңғүұөһі]*/giu;
  const mask = (t) => (t == null ? t : String(t).replace(BAD, "***"));
  const hasBad = (t) => { BAD.lastIndex = 0; const r = BAD.test(String(t || "")); BAD.lastIndex = 0; return r; };
  const cleanInsta = (v) => { v = String(v || "").trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/^@/, "").replace(/\/.*$/, ""); if (v && !/^[A-Za-z0-9._]{1,30}$/.test(v)) throw new Error("Ник Instagram: только латиница, цифры, точка и _"); return v || null; };
  function validateChatFile(f) {
    const t = f.type || "";
    if (/^image\//.test(t)) { if (f.size > (CFG.MAX_IMAGE_MB || 15) * 1048576) throw new Error("Фото слишком большое"); return "image"; }
    if (/^video\//.test(t)) { if (f.size > (CFG.MAX_VIDEO_MB || 30) * 1048576) throw new Error(`Видео больше ${CFG.MAX_VIDEO_MB || 30} МБ`); return "video"; }
    if (/^audio\//.test(t)) return "audio";
    throw new Error("Можно отправить фото, видео или голосовое");
  }
  const REASONS = { spam: "Спам или реклама", abuse: "Оскорбления, травля", fraud: "Мошенничество", nsfw: "Неприемлемые фото или видео", fake: "Ложная информация", danger: "Опасность, насилие", other: "Другое" };

  function ruError(e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e);
    const map = [
      [/Invalid login credentials/i, "Неверная почта или пароль"],
      [/Email not confirmed/i, "Почта не подтверждена. Откройте письмо от NEAR и перейдите по ссылке."],
      [/already registered|already been registered/i, "Этот email уже зарегистрирован. Попробуйте войти."],
      [/at least 6/i, "Пароль должен быть не короче 6 символов"],
      [/valid email|invalid format|Unable to validate email/i, "Проверьте правильность email"],
      [/security purposes|rate limit|too many/i, "Слишком много попыток. Подождите минуту и попробуйте снова."],
      [/Failed to fetch|NetworkError|Load failed/i, "Нет связи с сервером. Проверьте интернет."],
      [/JWT|not authenticated|session/i, "Сессия истекла. Войдите снова."],
      [/row-level security/i, "Нет прав на это действие"],
      [/Payload too large|exceeded the maximum/i, "Файл слишком большой"]
    ];
    for (const [re, t] of map) if (re.test(m)) return t;
    return m;
  }
  const fail = (e) => { const err = new Error(ruError(e)); err.raw = e; throw err; };

  /* =====================================================
     ЛОКАЛЬНЫЙ ДЕМО-РЕЖИМ
     ===================================================== */
  function LocalBackend() {
    const KEY = "near_db_v1";
    let db;
    const listeners = [];

    function seed() {
      const U = [
        ["u-erlan", "Ерлан"], ["u-dinara", "Динара"], ["u-asel", "Асель"], ["u-timur", "Тимур"],
        ["u-arman", "Кофейня \"Арман\""], ["u-arbat", "Арбат Live"], ["u-aliya", "Алия"], ["u-max", "Максат"]
      ];
      const d = { v: 1, users: [], session: null, posts: [], media: [], comments: [], likes: [], saved: [], events: [], members: [], notifs: [] };
      U.forEach(([id, name]) => d.users.push({ id, email: id + "@demo.near", pwh: null, name, avatar_url: null, district: "Бостандыкский", created_at: nowISO() }));
      const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
      const P = [
        ["u-erlan", "meetup", "Ищем 4 игроков на футбол 5×5 сегодня в 19:00. Уровень любой, мяч есть 🙂", 43.1885, 76.8835, 12],
        ["u-timur", "incident", "ДТП на Аль-Фараби возле Есентая, две машины, правый ряд перекрыт. Лучше обьехать.", 43.2183, 76.9278, 4],
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
      d.comments.push({ id: uid(), post_id: "p-0", user_id: "u-aliya", text: "Я приду с другом, нас двое!", created_at: ago(8) });
      d.comments.push({ id: uid(), post_id: "p-1", user_id: "u-max", text: "Уже разьехались, движение свободное", created_at: ago(2) });
      d.comments.push({ id: uid(), post_id: "p-3", user_id: "u-asel", text: "Похож на собаку соседей с Байзакова, скинула им", created_at: ago(40) });
      return d;
    }

    function load() {
      try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { db = null; }
      if (!db || db.v !== 1) { db = seed(); save(); }
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
    const prof = (u) => u && { id: u.id, email: u.email, name: u.name, avatar_url: u.avatar_url, district: u.district, instagram: u.instagram || null, is_admin: !!u.is_admin, banned: !!u.banned };
    const blockedByMe = () => { const u = me(); return new Set(u ? db.blocks.filter((b) => b.blocker_id === u.id).map((b) => b.blocked_id) : []); };
    const isBlocked = (a, b) => db.blocks.some((x) => (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
    const friendRow = (a, b) => db.friends.find((f) => (f.requester_id === a && f.addressee_id === b) || (f.requester_id === b && f.addressee_id === a));
    const pubProfile = (x) => x && { id: x.id, name: x.name, avatar_url: x.avatar_url, district: x.district, instagram: x.instagram || null, created_at: x.created_at };
    function shapeMsg(m) { return { ...m }; }
    function demoWelcome(u) {
      // демо: заявка в друзья и сообщение от незнакомца, чтобы было что проверить
      if (!db.friends.some((f) => f.addressee_id === u.id)) {
        db.friends.push({ requester_id: "u-erlan", addressee_id: u.id, status: "pending", created_at: nowISO() });
        db.notifs.push({ id: uid(), user_id: u.id, actor_id: "u-erlan", type: "friend_request", text: "хочет добавить вас в друзья", read: false, created_at: nowISO() });
        const a = u.id < "u-dinara" ? u.id : "u-dinara", b = u.id < "u-dinara" ? "u-dinara" : u.id, cid = uid();
        db.convs.push({ id: cid, user_a: a, user_b: b, created_at: nowISO(), last_message_at: nowISO() });
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
        created_at: p.created_at, updated_at: p.updated_at,
        author: a ? { id: a.id, name: a.name, avatar_url: a.avatar_url } : { id: p.user_id, name: "Пользователь", avatar_url: null },
        media: db.media.filter((m) => m.post_id === p.id).map((m) => ({ url: m.url, type: m.type, mod_status: m.mod_status || "ok" })),
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
      subscribe(cb) { listeners.push(cb); },

      async signUp({ first, last, email, password }) {
        email = (email || "").trim().toLowerCase();
        if (!first) throw new Error("Укажите имя");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Проверьте правильность email");
        if ((password || "").length < 6) throw new Error("Пароль должен быть не короче 6 символов");
        if (db.users.some((u) => u.email === email)) throw new Error("Этот email уже зарегистрирован. Попробуйте войти.");
        const firstReal = !db.users.some((x) => x.pwh);
        const u = { id: uid(), email, pwh: await hash(password), name: mask((first + " " + (last || "")).trim()), avatar_url: null, district: "Бостандыкский", created_at: nowISO(), accepted_rules_at: nowISO(), is_admin: firstReal };
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
      async updateProfile({ name, district, avatarFile, instagram }) {
        const u = need();
        if (name !== undefined) { if (!name.trim()) throw new Error("Имя не может быть пустым"); u.name = mask(name.trim()); }
        if (instagram !== undefined) u.instagram = cleanInsta(instagram);
        if (district !== undefined) u.district = district;
        if (avatarFile) { validateFile(avatarFile); u.avatar_url = await blobToDataURL(await compressImage(avatarFile, 400, 0.8)); }
        save(); emit("auth", prof(u)); return prof(u);
      },

      async listPosts({ lat, lng, radius, bounds, category, limit = 300 } = {}) {
        const b = bounds || boundsAround(lat, lng, radius);
        const bl = blockedByMe(), cu = me();
        let list = db.posts.filter((p) => !bl.has(p.user_id) && (p.status === "active" || p.status === "closed" || (cu && (p.user_id === cu.id || cu.is_admin))) && p.lat >= b.s && p.lat <= b.n && p.lng >= b.w && p.lng <= b.e);
        if (category) list = list.filter((p) => (Array.isArray(category) ? category.includes(p.category) : p.category === category));
        if (radius) list = list.filter((p) => dist({ lat, lng }, p) <= radius);
        return list.sort((a, b2) => b2.created_at.localeCompare(a.created_at)).slice(0, limit).map(shape);
      },
      async getPost(id) { const p = db.posts.find((x) => x.id === id && x.status !== "deleted"); if (!p) throw new Error("Публикация удалена или не найдена"); return shape(p); },
      async createPost({ category, text, lat, lng, files = [], event }, onProgress = () => {}) {
        const u = need();
        if (!CATS[category]) throw new Error("Выберите тип публикации");
        if (!text || !text.trim()) throw new Error("Добавьте описание");
        if (lat == null || lng == null) throw new Error("Укажите место на карте");
        const id = uid(), t = nowISO();
        const media = [];
        for (let i = 0; i < files.length; i++) {
          const kind = validateFile(files[i]);
          if (kind === "video") throw new Error("Видео в демо-режиме не сохраняется. Подключите сервер Supabase или выберите фото.");
          onProgress(`Сжимаем фото ${i + 1} из ${files.length}...`);
          media.push({ id: uid(), post_id: id, url: await blobToDataURL(await compressImage(files[i], 1080, 0.72)), type: "image" });
        }
        if (u.banned) throw new Error("Аккаунт заблокирован модератором");
        db.posts.push({ id, user_id: u.id, category, text: mask(text.trim().slice(0, 1000)), lat, lng, status: "active", created_at: t, updated_at: t });
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
        if (status) { if (p.status === "hidden" && !u.is_admin) throw new Error("Публикация скрыта модератором"); p.status = status; }
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
          return { id: c.id, text: c.text, created_at: c.created_at, user_id: c.user_id, author: { id: c.user_id, name: a ? a.name : "Пользователь", avatar_url: a && a.avatar_url } };
        });
      },
      async addComment(id, text) {
        const u = need(); text = (text || "").trim();
        if (!text) throw new Error("Комментарий пустой");
        if (u.banned) throw new Error("Аккаунт заблокирован модератором");
        db.comments.push({ id: uid(), post_id: id, user_id: u.id, text: mask(text.slice(0, 500)), created_at: nowISO() });
        const p = db.posts.find((x) => x.id === id); if (p) notify(p.user_id, "comment", id, "прокомментировал(а): " + text.slice(0, 60));
        save();
      },
      async deleteComment(cid) {
        const u = need(), c = db.comments.find((x) => x.id === cid);
        if (!c || c.user_id !== u.id) throw new Error("Можно удалять только свои комментарии");
        db.comments = db.comments.filter((x) => x.id !== cid); save();
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
          return { id: c.id, other: pubProfile(o) || { id: other, name: "Пользователь" }, last: last ? shapeMsg(last) : null,
            unread: ms.filter((m) => m.sender_id !== u.id && !m.read_at).length, last_message_at: c.last_message_at,
            friend: !!(friendRow(u.id, other) && friendRow(u.id, other).status === "accepted"), blocked: bl.has(other) };
        }).filter((c) => c.last).sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
      },
      async openConversation(other) {
        const u = need(); if (other === u.id) throw new Error("Нельзя написать самому себе");
        if (isBlocked(u.id, other)) throw new Error("Пользователь недоступен");
        const a = u.id < other ? u.id : other, b = u.id < other ? other : u.id;
        let c = db.convs.find((x) => x.user_a === a && x.user_b === b);
        if (!c) { c = { id: uid(), user_a: a, user_b: b, created_at: nowISO(), last_message_at: nowISO() }; db.convs.push(c); save(); }
        return c.id;
      },
      async conversationInfo(cid) {
        const u = need(), c = db.convs.find((x) => x.id === cid); if (!c) throw new Error("Переписка не найдена");
        const other = c.user_a === u.id ? c.user_b : c.user_a, f = friendRow(u.id, other);
        return { id: cid, other: pubProfile(db.users.find((x) => x.id === other)) || { id: other, name: "Пользователь" }, friend: !!(f && f.status === "accepted"), blocked: isBlocked(u.id, other) };
      },
      async messages(cid) { need(); return db.msgs.filter((m) => m.conversation_id === cid).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-200).map(shapeMsg); },
      async sendMessage(cid, { text, file, kind, duration }, onProgress = () => {}) {
        const u = need(), c = db.convs.find((x) => x.id === cid); if (!c) throw new Error("Переписка не найдена");
        if (u.banned) throw new Error("Аккаунт заблокирован модератором");
        const other = c.user_a === u.id ? c.user_b : c.user_a;
        if (isBlocked(u.id, other)) throw new Error("Пользователь недоступен");
        const m = { id: uid(), conversation_id: cid, sender_id: u.id, kind: "text", text: null, media_url: null, duration: duration || null, mod_status: "ok", read_at: null, created_at: nowISO() };
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
        if (other.startsWith("u-")) setTimeout(() => {
          const r = ["Да, конечно 👍", "Спасибо, сейчас посмотрю", "Отлично, договорились!", "Хорошо, напишу позже", "😊"];
          db.msgs.push({ id: uid(), conversation_id: cid, sender_id: other, kind: "text", text: r[Math.floor(Math.random() * r.length)] + " (демо-ответ)", mod_status: "ok", read_at: null, created_at: nowISO() });
          c.last_message_at = nowISO(); save(); emit("message", { conversation_id: cid });
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
    const PUB = "id,name,avatar_url,district,instagram,created_at";
    async function moderate(table, id) {
      if (!CFG.AI_MODERATION) return;
      try { await sb.functions.invoke("moderate", { body: { table, id } }); } catch (e) { console.warn("moderation", e); }
    }
    const authCbs = [];
    const BUCKET = "post-media";
    const POST_SELECT = "id,user_id,category,text,lat,lng,status,created_at,updated_at," +
      "author:profiles!posts_user_id_fkey(id,name,avatar_url),post_media!post_media_post_id_fkey(url,type,position,mod_status)," +
      "likes!likes_post_id_fkey(count),comments!comments_post_id_fkey(count)," +
      "events!events_post_id_fkey(starts_at,capacity),event_members!event_members_post_id_fkey(count)";
    const one = (x) => (Array.isArray(x) ? x[0] : x) || null;
    const cnt = (x) => (Array.isArray(x) && x[0] ? x[0].count : 0);

    async function loadProfile() {
      if (!session) { profile = null; return null; }
      const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
      if (error) console.warn(error);
      profile = { id: session.user.id, email: session.user.email, name: (data && data.name) || session.user.email.split("@")[0], avatar_url: data && data.avatar_url, district: (data && data.district) || "",
        instagram: data && data.instagram, is_admin: !!(data && data.is_admin), banned: !!(data && data.banned) };
      blockedSet = null;
      return profile;
    }
    function need() { if (!session) throw new Error("Войдите, чтобы сделать это"); return session.user; }

    async function enrich(rows) {
      const u = session && session.user;
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
          created_at: r.created_at, updated_at: r.updated_at,
          author: one(r.author) || { id: r.user_id, name: "Пользователь", avatar_url: null },
          media: (r.post_media || []).sort((a, b) => (a.position || 0) - (b.position || 0)).map((m) => ({ url: m.url, type: m.type, mod_status: m.mod_status || "ok" })),
          likes: cnt(r.likes), comments: cnt(r.comments), liked: liked.has(r.id), saved: saved.has(r.id),
          event: ev ? { starts_at: ev.starts_at, capacity: ev.capacity, members: cnt(r.event_members), joined: joined.has(r.id) } : null
        };
      });
    }
    async function uploadBlob(path, blob, contentType) {
      const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType, upsert: false, cacheControl: "31536000" });
      if (error) fail(error);
      return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    }
    const redirect = () => location.origin + location.pathname;

    return {
      mode: "supabase",
      async init() {
        sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
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
      subscribe(cb) {
        const ch = sb.channel("near-live")
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "posts" }, (p) => cb("post", p.new));
        if (session) ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: "user_id=eq." + session.user.id }, (p) => cb("notif", p.new));
        if (session) ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => { if (p.new.sender_id !== session.user.id) cb("message", p.new); });
        if (session) ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (p) => cb("message_update", p.new));
        ch.subscribe();
      },

      async signUp({ first, last, email, password }) {
        if (!first) throw new Error("Укажите имя");
        const { data, error } = await sb.auth.signUp({ email: (email || "").trim(), password, options: { data: { name: mask((first + " " + (last || "")).trim()), accepted_rules: true }, emailRedirectTo: redirect() } });
        if (error) fail(error);
        if (data.user && data.user.identities && data.user.identities.length === 0) throw new Error("Этот email уже зарегистрирован. Попробуйте войти.");
        return { needsConfirm: !data.session };
      },
      async signIn({ email, password }) {
        const { error } = await sb.auth.signInWithPassword({ email: (email || "").trim(), password });
        if (error) fail(error);
        const { data } = await sb.auth.getSession(); session = data.session; return loadProfile();
      },
      async signOut() { await sb.auth.signOut(); session = null; profile = null; },
      async resetPassword(email) {
        const { error } = await sb.auth.resetPasswordForEmail((email || "").trim(), { redirectTo: redirect() });
        if (error) fail(error); return {};
      },
      async updatePassword(password) {
        if ((password || "").length < 6) throw new Error("Пароль должен быть не короче 6 символов");
        const { error } = await sb.auth.updateUser({ password }); if (error) fail(error);
      },
      async updateProfile({ name, district, avatarFile, instagram }) {
        const u = need(), patch = { updated_at: nowISO() };
        if (instagram !== undefined) patch.instagram = cleanInsta(instagram);
        if (name !== undefined) { if (!name.trim()) throw new Error("Имя не может быть пустым"); patch.name = name.trim(); }
        if (district !== undefined) patch.district = district;
        if (avatarFile) { validateFile(avatarFile); patch.avatar_url = await uploadBlob(`${u.id}/avatar-${Date.now()}.jpg`, await compressImage(avatarFile, 400, 0.8), "image/jpeg"); }
        const { error } = await sb.from("profiles").upsert({ id: u.id, ...patch }); if (error) fail(error);
        return loadProfile();
      },

      async listPosts({ lat, lng, radius, bounds, category, limit = 300 } = {}) {
        const b = bounds || boundsAround(lat, lng, radius);
        let q = sb.from("posts").select(POST_SELECT).neq("status", "deleted")
          .gte("lat", b.s).lte("lat", b.n).gte("lng", b.w).lte("lng", b.e)
          .order("created_at", { ascending: false }).limit(limit);
        if (category) q = Array.isArray(category) ? q.in("category", category) : q.eq("category", category);
        const { data, error } = await q; if (error) fail(error);
        const bl = await myBlocks();
        let rows = (data || []).filter((p) => !bl.has(p.user_id));
        if (radius) rows = rows.filter((p) => dist({ lat, lng }, p) <= radius);
        return enrich(rows);
      },
      async getPost(id) {
        const { data, error } = await sb.from("posts").select(POST_SELECT).eq("id", id).maybeSingle();
        if (error) fail(error); if (!data || data.status === "deleted") throw new Error("Публикация удалена или не найдена");
        return (await enrich([data]))[0];
      },
      async createPost({ category, text, lat, lng, files = [], event }, onProgress = () => {}) {
        const u = need();
        if (!CATS[category]) throw new Error("Выберите тип публикации");
        if (!text || !text.trim()) throw new Error("Добавьте описание");
        if (lat == null || lng == null) throw new Error("Укажите место на карте");
        files.forEach(validateFile);
        onProgress("Сохраняем публикацию...");
        const { data: post, error } = await sb.from("posts").insert({ user_id: u.id, category, text: text.trim().slice(0, 1000), lat, lng }).select("id").single();
        if (error) fail(error);
        try {
          for (let i = 0; i < files.length; i++) {
            const f = files[i], isImg = /^image\//.test(f.type);
            onProgress(`Загружаем ${isImg ? "фото" : "видео"} ${i + 1} из ${files.length}...`);
            const blob = isImg ? await compressImage(f) : f;
            const ext = isImg ? "jpg" : ((f.name.split(".").pop() || "mp4").toLowerCase());
            const path = `${u.id}/${post.id}/${i}-${Date.now()}.${ext}`;
            const url = await uploadBlob(path, blob, isImg ? "image/jpeg" : f.type);
            const { data: pm, error: me } = await sb.from("post_media").insert({ post_id: post.id, user_id: u.id, url, path, type: isImg ? "image" : "video", position: i }).select("id").single();
            if (me) fail(me);
            if (isImg) moderate("post_media", pm.id);
          }
          if (event && event.starts_at) {
            const { error: ee } = await sb.from("events").insert({ post_id: post.id, starts_at: event.starts_at, capacity: event.capacity || null });
            if (ee) fail(ee);
          }
        } catch (e) {
          await this.deletePost(post.id).catch(() => {});
          throw e;
        }
        return this.getPost(post.id);
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
        const { data, error } = await sb.from("comments").select("id,text,created_at,user_id,author:profiles!comments_user_id_fkey(id,name,avatar_url)").eq("post_id", id).order("created_at");
        if (error) fail(error);
        const bl = await myBlocks();
        return (data || []).filter((c) => !bl.has(c.user_id)).map((c) => ({ ...c, author: one(c.author) || { id: c.user_id, name: "Пользователь" } }));
      },
      async addComment(id, text) {
        const u = need(); text = (text || "").trim(); if (!text) throw new Error("Комментарий пустой");
        const { error } = await sb.from("comments").insert({ post_id: id, user_id: u.id, text: text.slice(0, 500) }); if (error) fail(error);
      },
      async deleteComment(cid) { need(); const { error } = await sb.from("comments").delete().eq("id", cid); if (error) fail(error); },
      async toggleJoin(id) {
        const u = need();
        const { data: ev } = await sb.from("events").select("capacity").eq("post_id", id).maybeSingle();
        if (!ev) throw new Error("Это не событие");
        const { data: ex } = await sb.from("event_members").select("post_id").eq("post_id", id).eq("user_id", u.id).maybeSingle();
        const { count: before } = await sb.from("event_members").select("post_id", { count: "exact", head: true }).eq("post_id", id);
        if (!ex && ev.capacity && before >= ev.capacity) throw new Error("Мест больше нет");
        const { error } = ex ? await sb.from("event_members").delete().eq("post_id", id).eq("user_id", u.id) : await sb.from("event_members").insert({ post_id: id, user_id: u.id });
        if (error) fail(error);
        return { joined: !ex, members: (before || 0) + (ex ? -1 : 1) };
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
        const { data, error } = await sb.from("conversations").select("id,user_a,user_b,last_message_at,a:profiles!conversations_user_a_fkey(" + PUB + "),b:profiles!conversations_user_b_fkey(" + PUB + ")")
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
          const other = one(c.user_a === u.id ? c.b : c.a) || { id: c.user_a === u.id ? c.user_b : c.user_a, name: "Пользователь" };
          return { id: c.id, other, last: (msgs || []).find((m) => m.conversation_id === c.id) || null, last_message_at: c.last_message_at,
            unread: (unread || []).filter((m) => m.conversation_id === c.id).length, friend: fset.has(other.id), blocked: bl.has(other.id) };
        }).filter((c) => c.last);
      },
      async openConversation(other) {
        need(); const { data, error } = await sb.rpc("get_or_create_conversation", { other }); if (error) fail(error); return data;
      },
      async conversationInfo(cid) {
        const u = need();
        const { data: c, error } = await sb.from("conversations").select("id,user_a,user_b").eq("id", cid).maybeSingle();
        if (error) fail(error); if (!c) throw new Error("Переписка не найдена");
        const other = c.user_a === u.id ? c.user_b : c.user_a;
        const p = await this.getProfile(other);
        return { id: cid, other: p, friend: p.friendship === "friends", blocked: p.blocked };
      },
      async messages(cid) {
        need();
        const { data, error } = await sb.from("messages").select("*").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(200);
        if (error) fail(error); return (data || []).reverse();
      },
      async sendMessage(cid, { text, file, kind, duration }, onProgress = () => {}) {
        const u = need(); const row = { conversation_id: cid, sender_id: u.id, kind: "text" };
        if (file) {
          const k = kind || validateChatFile(file);
          onProgress(k === "image" ? "Загружаем фото..." : k === "video" ? "Загружаем видео..." : "Отправляем голосовое...");
          const blob = k === "image" ? await compressImage(file) : file;
          const ext = k === "image" ? "jpg" : ((file.type.split("/")[1] || "bin").split(";")[0].replace("quicktime", "mov").replace("mpeg", "mp3"));
          const path = `${u.id}/${cid}/${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
          const { error: ue } = await sb.storage.from("chat-media").upload(path, blob, { contentType: k === "image" ? "image/jpeg" : (file.type || "application/octet-stream").split(";")[0], upsert: false });
          if (ue) fail(ue);
          row.kind = k; row.media_url = sb.storage.from("chat-media").getPublicUrl(path).data.publicUrl; row.media_path = path;
          if (duration) row.duration = Math.round(duration);
          if (text) row.text = text;
        } else {
          if (!text || !text.trim()) throw new Error("Пустое сообщение");
          row.text = text.trim().slice(0, 2000);
        }
        const { data, error } = await sb.from("messages").insert(row).select("*").single();
        if (error) fail(error);
        if (data.kind === "image" || data.kind === "text") moderate("messages", data.id);
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
        if (!profile || !profile.is_admin) throw new Error("Только для модераторов");
        const { data, error } = await sb.from("reports").select("*,reporter:profiles!reports_reporter_id_fkey(name),target:profiles!reports_target_user_fkey(id,name,banned)").eq("status", "open").order("created_at", { ascending: false }).limit(200);
        if (error) fail(error);
        const rows = data || [];
        const byType = (t) => rows.filter((r) => r.target_type === t).map((r) => r.target_id);
        const [ps, cs, ms] = await Promise.all([
          byType("post").length ? sb.from("posts").select("id,text,status").in("id", byType("post")) : { data: [] },
          byType("comment").length ? sb.from("comments").select("id,text").in("id", byType("comment")) : { data: [] },
          byType("message").length ? sb.from("messages").select("id,text,kind,media_url").in("id", byType("message")) : { data: [] }
        ]);
        const find = (arr, id) => (arr || []).find((x) => x.id === id);
        return rows.map((r) => {
          let preview = "";
          if (r.target_type === "post") { const p = find(ps.data, r.target_id); preview = p ? p.text : "(удалено)"; }
          if (r.target_type === "comment") { const c = find(cs.data, r.target_id); preview = c ? c.text : "(удалено)"; }
          if (r.target_type === "message") { const m = find(ms.data, r.target_id); preview = m ? (m.text || "[" + m.kind + "] " + (m.media_url || "")) : "(удалено)"; }
          if (r.target_type === "user") preview = (one(r.target) || {}).name || "";
          return { ...r, reporter: one(r.reporter) || { name: "?" }, target: one(r.target) || { name: "?" }, preview,
            count: rows.filter((x) => x.target_type === r.target_type && x.target_id === r.target_id).length };
        });
      },
      async resolveReport(id, action) {
        if (!profile || !profile.is_admin) throw new Error("Только для модераторов");
        const { data: r, error } = await sb.from("reports").select("*").eq("id", id).single(); if (error) fail(error);
        if (r.target_type === "post" && (action === "hide" || action === "restore")) { const { error: e } = await sb.from("posts").update({ status: action === "hide" ? "hidden" : "active" }).eq("id", r.target_id); if (e) fail(e); }
        if (action === "delete") {
          const tbl = { post: "posts", comment: "comments", message: "messages" }[r.target_type];
          if (tbl) { const { error: e } = await sb.from(tbl).delete().eq("id", r.target_id); if (e) fail(e); }
        }
        if (action === "ban" && r.target_user) { const { error: e } = await sb.from("profiles").update({ banned: true }).eq("id", r.target_user); if (e) fail(e); }
        const { error: e2 } = await sb.from("reports").update({ status: action === "dismiss" ? "dismissed" : "resolved", resolved_at: nowISO() })
          .eq("target_type", r.target_type).eq("target_id", r.target_id).eq("status", "open");
        if (e2) fail(e2);
      },
      async openReportsCount() {
        if (!profile || !profile.is_admin) return 0;
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
    CATS, CITY, dist, boundsAround, compressImage, validateFile, validateChatFile, ruError, mask, hasBad, REASONS,
    api: null,
    async start() {
      if (hasSupabase) {
        if (!window.supabase) throw new Error("Не удалось загрузить библиотеку Supabase. Проверьте интернет.");
        this.api = SupabaseBackend();
      } else {
        this.api = LocalBackend();
      }
      return this.api.init();
    }
  };
})();
