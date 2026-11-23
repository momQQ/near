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
    const prof = (u) => u && { id: u.id, email: u.email, name: u.name, avatar_url: u.avatar_url, district: u.district };
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
        media: db.media.filter((m) => m.post_id === p.id).map((m) => ({ url: m.url, type: m.type })),
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
        const u = { id: uid(), email, pwh: await hash(password), name: (first + " " + (last || "")).trim(), avatar_url: null, district: "Бостандыкский", created_at: nowISO() };
        db.users.push(u); db.session = u.id; save(); emit("auth", prof(u));
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
      async updateProfile({ name, district, avatarFile }) {
        const u = need();
        if (name !== undefined) { if (!name.trim()) throw new Error("Имя не может быть пустым"); u.name = name.trim(); }
        if (district !== undefined) u.district = district;
        if (avatarFile) { validateFile(avatarFile); u.avatar_url = await blobToDataURL(await compressImage(avatarFile, 400, 0.8)); }
        save(); emit("auth", prof(u)); return prof(u);
      },

      async listPosts({ lat, lng, radius, bounds, category, limit = 300 } = {}) {
        const b = bounds || boundsAround(lat, lng, radius);
        let list = db.posts.filter((p) => p.status !== "deleted" && p.lat >= b.s && p.lat <= b.n && p.lng >= b.w && p.lng <= b.e);
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
        db.posts.push({ id, user_id: u.id, category, text: text.trim().slice(0, 1000), lat, lng, status: "active", created_at: t, updated_at: t });
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
        if (text !== undefined) { if (!text.trim()) throw new Error("Описание не может быть пустым"); p.text = text.trim().slice(0, 1000); }
        if (category) p.category = category;
        if (status) p.status = status;
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
        return db.comments.filter((c) => c.post_id === id).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((c) => {
          const a = db.users.find((x) => x.id === c.user_id);
          return { id: c.id, text: c.text, created_at: c.created_at, user_id: c.user_id, author: { name: a ? a.name : "Пользователь", avatar_url: a && a.avatar_url } };
        });
      },
      async addComment(id, text) {
        const u = need(); text = (text || "").trim();
        if (!text) throw new Error("Комментарий пустой");
        db.comments.push({ id: uid(), post_id: id, user_id: u.id, text: text.slice(0, 500), created_at: nowISO() });
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
          return { ...n, actor: { name: a ? a.name : "Кто-то", avatar_url: a && a.avatar_url } };
        });
      },
      async markNotificationsRead() { const u = me(); if (!u) return; db.notifs.forEach((n) => { if (n.user_id === u.id) n.read = true; }); save(); },
      async unreadCount() { const u = me(); return u ? db.notifs.filter((n) => n.user_id === u.id && !n.read).length : 0; },
      resetDemo() { localStorage.removeItem(KEY); load(); emit("auth", null); }
    };
  }

  /* =====================================================
     SUPABASE (реальный сервер)
     ===================================================== */
  function SupabaseBackend() {
    let sb, profile = null, session = null;
    const authCbs = [];
    const BUCKET = "post-media";
    const POST_SELECT = "id,user_id,category,text,lat,lng,status,created_at,updated_at," +
      "author:profiles!posts_user_id_fkey(id,name,avatar_url),post_media!post_media_post_id_fkey(url,type,position)," +
      "likes!likes_post_id_fkey(count),comments!comments_post_id_fkey(count)," +
      "events!events_post_id_fkey(starts_at,capacity),event_members!event_members_post_id_fkey(count)";
    const one = (x) => (Array.isArray(x) ? x[0] : x) || null;
    const cnt = (x) => (Array.isArray(x) && x[0] ? x[0].count : 0);

    async function loadProfile() {
      if (!session) { profile = null; return null; }
      const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
      if (error) console.warn(error);
      profile = { id: session.user.id, email: session.user.email, name: (data && data.name) || session.user.email.split("@")[0], avatar_url: data && data.avatar_url, district: (data && data.district) || "" };
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
          media: (r.post_media || []).sort((a, b) => (a.position || 0) - (b.position || 0)).map((m) => ({ url: m.url, type: m.type })),
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
        ch.subscribe();
      },

      async signUp({ first, last, email, password }) {
        if (!first) throw new Error("Укажите имя");
        const { data, error } = await sb.auth.signUp({ email: (email || "").trim(), password, options: { data: { name: (first + " " + (last || "")).trim() }, emailRedirectTo: redirect() } });
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
      async updateProfile({ name, district, avatarFile }) {
        const u = need(), patch = { updated_at: nowISO() };
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
        let rows = data || [];
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
            const { error: me } = await sb.from("post_media").insert({ post_id: post.id, user_id: u.id, url, path, type: isImg ? "image" : "video", position: i });
            if (me) fail(me);
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
        const { data, error } = await sb.from("comments").select("id,text,created_at,user_id,author:profiles!comments_user_id_fkey(name,avatar_url)").eq("post_id", id).order("created_at");
        if (error) fail(error);
        return (data || []).map((c) => ({ ...c, author: one(c.author) || { name: "Пользователь" } }));
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
        const { data, error } = await sb.from("notifications").select("id,type,post_id,text,read,created_at,actor:profiles!notifications_actor_fkey(name,avatar_url)")
          .eq("user_id", session.user.id).order("created_at", { ascending: false }).limit(50);
        if (error) fail(error); return (data || []).map((n) => ({ ...n, actor: one(n.actor) || { name: "Кто-то" } }));
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
    CATS, CITY, dist, boundsAround, compressImage, validateFile, ruError,
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
