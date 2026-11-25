/* NEAR: демо-режим (ENV: "demo"). Загружается только в демо — в рабочую сборку не входит (ТЗ v14.8, раздел 13). */
(function () {
  "use strict";
  window.NEAR_DEMO = function (H) {
    const { BLOCK_MSG, CATS, CITY, INTERESTS, REASONS, blobToDataURL, boundsAround, byNewest, cleanInsta, compressImage, cursorOf, dist, httpsUrl, mask, nearBlockReason, nickNorm, nickProblem, nowISO, olderThan, periodOk, postMetaClean, score, snap, uid, validateChatFile, validateFile } = H;
    const CFG = window.NEAR_CONFIG || {};
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
          ["u-erlan", "talk", "Кто знает, где в Бостандыкском районе можно поиграть в футбол вечером? Встречу 5×5 уже создал в разделе Встречи", 43.1885, 76.8835, 12],
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
        nickname: u.nickname || null, interests: u.interests || [], verified: !!u.verified, last_seen_at: u.last_seen_at || null, accepted_rules: !!u.accepted_rules_at, bio: u.bio || null, show_seen: u.show_seen !== false, provider: "email",
        account: { age_status: u.age_status || "unknown", age_ok: u.age_status === "adult", phone_verified: !!u.phone_verified, media_ok: true, mod_role: !!(u.is_admin || u.is_moderator), mfa_ok: true,
          state: u.banned ? "suspended" : !u.nickname || !u.accepted_rules_at ? "profile_incomplete" : "active",
          can: { post: !u.banned, comment: !u.banned, chat: !u.banned, meet: !u.banned && u.age_status === "adult", report: true }, meet_ok: u.age_status === "adult", notify_level: u.notify_level || "important",
          limits: demoLimits(u), instagram: u.instagram || null, instagram_public: !!u.instagram_public,
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
      function demoSanction(u, scope) {
        const x = (db.sanctions || []).find((y) => y.user_id === u.id && !y.revoked_at && (!y.until || y.until > nowISO()) && (y.scope === scope || y.scope === "all"));
        if (x) { const e = new Error("Действие ограничено модератором" + (x.until ? " до " + new Date(x.until).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "") + ". Причина: " + x.reason); e.code = "NR403"; e.hint = "restricted"; throw e; }
      }
      function demoLimits(u) {
        const day = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10), o = {};
        const left = Math.max(60, Math.ceil((Date.parse(day + "T00:00:00+05:00") + 86400e3 - Date.now()) / 1000));
        for (const a of ["post", "comment", "chat_request"]) { const lim = DAY_LIMITS[a][u.phone_verified ? 1 : 0], used = ((db && db.rate) || {})[u.id + "|" + a + "|" + day] || 0; o[a] = { used, limit: lim, retry_after: !u.is_admin && !u.is_moderator && used >= lim ? left : null }; }
        return o;
      }
      const textKey = (t) => String(t || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-яәғқңөұүһі0-9]+/g, "");
      function demoCheckText(t) { const r = nearBlockReason(t); if (r) { const e = new Error(BLOCK_MSG[r]); e.code = "NR422"; e.hint = r; throw e; } }
      function shapeMsg(m) { return { ...m }; }
      // v14.8: личных сообщений и друзей нет; новичка встречает городской чат
      function demoWelcome(u) { ensureV3(); const r = db.rooms.find((x) => x.type === "city"); if (r && !db.rmembers.some((m) => m.room_id === r.id && m.user_id === u.id)) db.rmembers.push({ room_id: r.id, user_id: u.id, role: "member", status: "active", notify: "mentions", last_read_at: nowISO() }); }
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
          meta: p.meta || {}, official: !!p.official, source_name: p.source_name || null, source_url: p.source_url || null, verified_at: p.verified_at || null,
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

      /* ---------- v14.8: комнаты и встречи в демо (та же логика, что на сервере, упрощенно) ---------- */
      const ago2 = (min) => new Date(Date.now() - min * 60000).toISOString(), inH = (h) => new Date(Date.now() + h * 3600e3).toISOString();
      const GREET = { games: "Всем привет! Напишите, кто на какой позиции играет.", cinema: "Обсудим покупку билетов и места в зале. Каждый покупает билет сам.", board: "Новичкам объясним правила.", sport: "Напишите позицию и подтвердите участие.", cafe: "Обсудим время и бронирование столика.", walk: "Маршрут и время закреплены в чате.", mountains: "Проверьте снаряжение, прогноз и маршрут. Подтвердите готовность.", study: "Подготовьте материалы. Распределим задания заранее.", other: "Обсудим организацию и необходимые материалы." };
      function pinOf(cat, d, st, en, cap) {
        const hrs = Math.round((new Date(en) - new Date(st)) / 360e3) / 10;
        return ({ games: [d.game, d.mode, d.level || "любой уровень"], cinema: ["Кино", "сеанс " + (d.session || new Date(st).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }))], board: [d.game || "Настольные игры", cap + " участников", d.duration || hrs + " ч"],
          sport: [d.sport || "Спорт", d.format, Math.round(hrs * 60) + " минут"], cafe: [(d.goal || "Кофе"), "каждый платит за себя"], walk: [d.distance, d.pace || "спокойный темп"], mountains: [d.distance, d.difficulty || "сложность уточняется"],
          study: [d.topic || "Обучение", d.format, d.duration], other: [d.goal || "Совместное мероприятие"] }[cat] || []).filter(Boolean).join(" • ");
      }
      function ensureV3() {
        if (db.rooms) return;
        db.rooms = []; db.rmembers = []; db.rmsgs = []; db.meets = []; db.mmembers = []; db.checkins = []; db.reviews = []; db.audit = [];
        const room = (o) => { const r = { id: uid(), status: "active", is_public: true, created_at: nowISO(), members_count: 0, ...o }; db.rooms.push(r); return r; };
        const city = room({ type: "city", title: "Алматы — общий чат", about: "Городские вопросы", rules: "Уважайте соседей. Без рекламы, сборов денег и личных данных. Мат скрывается, угрозы и скам удаляются.", pinned: "Правила: уважение, без личных данных и сборов денег" });
        ["Алатауский", "Алмалинский", "Ауэзовский", "Бостандыкский", "Жетысуский", "Медеуский", "Наурызбайский", "Турксибский"].forEach((d) => room({ type: "district", title: d + " район", about: "Новости соседей", rules: "Только о районе. Уважайте соседей." }));
        const topic = room({ type: "topic", title: "Горы и походы", about: "Тематическое сообщество", rules: "Маршруты, снаряжение, погода. Безопасность прежде всего." });
        const bost = db.rooms.find((r) => r.title.startsWith("Бостандык"));
        const say = (r, u, t, min, meta) => db.rmsgs.push({ id: uid(), room_id: r.id, sender_id: u, kind: u ? "text" : "system", body_masked: mask(t), meta: meta || {}, status: "ok", created_at: ago2(min) });
        ["u-erlan", "u-dinara", "u-asel", "u-timur", "u-aliya"].forEach((u) => db.rmembers.push({ room_id: city.id, user_id: u, role: "member", status: "active", notify: "mentions", last_read_at: nowISO() }));
        ["u-asel", "u-dinara"].forEach((u) => db.rmembers.push({ room_id: bost.id, user_id: u, role: "member", status: "active", notify: "mentions", last_read_at: nowISO() }));
        say(city, "u-timur", "Кто знает, Аль-Фараби уже открыли после ремонта?", 50); say(city, "u-asel", "Да, с утра движение свободное", 44); say(city, "u-erlan", "Сегодня в 19:00 футбол 5×5 у Есентая, ищем людей — встреча в разделе Встречи", 20);
        say(bost, "u-dinara", "Во дворе на Сатпаева нашли корги, ищем хозяина", 70); say(topic, "u-aliya", "На Кок-Жайляу сейчас грязно, берите треккинговую обувь", 300);
        const meet = (host, cat, title, desc, lat, lng, st, hrs, cap, price, place, details, members) => {
          const id = "m-" + uid().slice(0, 8), en = new Date(new Date(st).getTime() + hrs * 3600e3).toISOString(), r = room({ type: "meeting", title, is_public: false, meeting_id: id, pinned: pinOf(cat, details, st, en, cap) });
          db.posts.push({ id, user_id: host, category: "meetup", text: desc, lat, lng, status: "active", created_at: ago2(90), updated_at: ago2(90), exact: true, meta: { title, mcat: cat } });
          db.meets.push({ id, host_id: host, category: cat, title, details, pin: r.pinned, place_name: place, starts_at: st, ends_at: en, capacity: cap, price_kzt: price, rules: "Каждый платит за себя", status: "open", room_id: r.id });
          [host, ...members].forEach((u, i) => { db.mmembers.push({ meeting_id: id, user_id: u, role: i ? "member" : "host", status: "accepted", created_at: ago2(80) }); db.rmembers.push({ room_id: r.id, user_id: u, role: i ? "member" : "host", status: "active", notify: "all", last_read_at: nowISO() }); });
          say(r, null, GREET[cat], 85, { tpl: "greet." + cat }); members.forEach((u, i) => say(r, null, "@" + db.users.find((x) => x.id === u).nickname + " присоединился", 70 - i, { tpl: "joined" }));
          return id;
        };
        meet("u-timur", "games", "CS2 — собираем команду", "Играем 5×5 в клубе, любой уровень. Бронь на 3 часа", 43.2380, 76.9100, inH(3), 3, 5, 1500, "Компьютерный клуб Arena, Абая 10", { game: "CS2", mode: "5×5", club: "Arena", booking: "ПК забронированы" }, ["u-arman", "u-aliya"]);
        meet("u-erlan", "sport", "Футбол 5×5 у Есентая", "Ищем 4 игроков, мяч есть. Уровень любой", 43.1885, 76.8835, inH(6), 1.5, 10, 0, "Мини-поле у Есентай парка", { sport: "Футбол", format: "5×5", inventory: "мяч есть" }, ["u-max", "u-asel", "u-dinara"]);
        meet("u-aliya", "mountains", "Кок-Жайляу, спокойный темп", "Идем по тропе от Просвещенца, возвращаемся до 17:00", 43.1500, 77.0200, inH(44), 7, 8, null, "Остановка Просвещенец", { route: "Кок-Жайляу", difficulty: "средняя сложность", distance: "8 км", return_time: "до 17:00" }, ["u-asel"]);
        meet("u-arman", "cinema", "Кино в субботу вечером", "Идем на новый фильм, каждый покупает билет сам", 43.2189, 76.9277, inH(52), 3, 6, 2500, "Kinopark, Есентай Молл", { film: "Премьера недели", cinema: "Kinopark", session: "19:30", format: "IMAX" }, []);
        save();
      }
      const R_ = () => { ensureV3(); return db; };
      const roomOf = (id) => R_().rooms.find((r) => r.id === id);
      const rmem = (rid, uid2) => db.rmembers.find((m) => m.room_id === rid && m.user_id === uid2);
      const mmem = (mid, uid2) => db.mmembers.find((m) => m.meeting_id === mid && m.user_id === uid2);
      const mrole = (mid, uid2) => { const x = mmem(mid, uid2); return x && x.status === "accepted" ? x.role : null; };
      const accN = (mid) => db.mmembers.filter((m) => m.meeting_id === mid && m.status === "accepted").length;
      const err = (code, msg, hint) => { const e = new Error(msg); e.code = code; e.hint = hint || ""; return e; };
      const sysMsg = (rid, t, meta) => { const m = { id: uid(), room_id: rid, sender_id: null, kind: "system", body_masked: t, meta: meta || {}, status: "ok", created_at: nowISO() }; db.rmsgs.push(m); emit("room_message", m); };
      const audit = (mid, action, target, reason) => db.audit.push({ meeting_id: mid, actor_id: (me() || {}).id, action, target_id: target || null, reason: reason || null, created_at: nowISO() });
      function ratingOf(u2) {
        const rv = db.reviews.filter((r) => r.target_id === u2 && (db.reviews.some((x) => x.meeting_id === r.meeting_id && x.reviewer_id === u2 && x.target_id === r.reviewer_id)));
        const part = (role) => { const l = rv.filter((r) => r.target_role === role); return { avg: l.length ? Math.round((l.reduce((a, r) => a + r.stars, 0) / l.length) * 10) / 10 : null, count: l.length }; };
        const meetings = db.mmembers.filter((m) => m.user_id === u2 && (m.attended === "confirmed" || (m.role === "host" && m.status === "accepted")) && (db.meets.find((x) => x.id === m.meeting_id) || {}).ends_at < nowISO()).length;
        const enough = meetings >= 5 && new Set(rv.map((r) => r.reviewer_id)).size >= 3;
        return { host: part("host"), member: part("member"), meetings, enough, score: enough ? 90 : null };
      }
      const demoV3 = {
        async roomsList(tab = "near", q = null) {
          const u = me(); R_();
          return db.rooms.filter((r) => r.status !== "closed").filter((r) => {
            const m = u && rmem(r.id, u.id), joined = m && m.status === "active";
            if (tab === "near") return r.type !== "meeting" && r.is_public; if (tab === "meet") return r.type === "meeting" && joined; return joined;
          }).filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase())).map((r) => {
            const m = u && rmem(r.id, u.id), msgs = db.rmsgs.filter((x) => x.room_id === r.id && x.status === "ok"), last = msgs[msgs.length - 1];
            return { ...r, last: last ? last.created_at : null, preview: last ? last.body_masked.slice(0, 80) : null, joined: !!(m && m.status === "active"), role: m && m.role,
              unread: m && m.status === "active" ? msgs.filter((x) => x.created_at > m.last_read_at && x.sender_id !== u.id).length : 0,
              members_count: db.rmembers.filter((x) => x.room_id === r.id && x.status === "active").length };
          }).sort((a, b) => ({ city: 0, district: 1, meeting: 2, topic: 3 }[a.type] - { city: 0, district: 1, meeting: 2, topic: 3 }[b.type]) || String(b.last || "").localeCompare(String(a.last || "")));
        },
        async room(id) {
          const r = roomOf(id), u = me(); if (!r) return null;
          if (r.type === "meeting" && !(u && rmem(r.id, u.id) && rmem(r.id, u.id).status === "active")) return null;
          return { ...r, members_count: db.rmembers.filter((x) => x.room_id === r.id && x.status === "active").length };
        },
        async roomFeed(id, before) {
          const r = roomOf(id), u = me(); if (!r) return [];
          if (r.type === "meeting" && !(u && rmem(id, u.id) && rmem(id, u.id).status === "active")) return [];
          const bl = blockedByMe();
          return db.rmsgs.filter((m) => m.room_id === id && (m.status === "ok" || (u && m.sender_id === u.id)) && !bl.has(m.sender_id) && (!before || m.created_at < before.created_at)).slice(-40)
            .map((m) => { const a = m.sender_id && db.users.find((x) => x.id === m.sender_id); return { ...m, author: a ? { id: a.id, nickname: a.nickname || a.name, avatar_url: a.avatar_url } : null }; });
        },
        async joinRoom(id) {
          const u = need(), r = roomOf(id); if (r.type === "meeting") throw err("NR403", "Чат встречи открывается после принятия заявки");
          const m = rmem(id, u.id); if (m) m.status = "active"; else db.rmembers.push({ room_id: id, user_id: u.id, role: "member", status: "active", notify: "mentions", last_read_at: nowISO() }); save();
        },
        async leaveRoom(id) { const u = need(), m = rmem(id, u.id); if (roomOf(id).type === "meeting") throw err("NR409", "Чтобы выйти из чата встречи, отмените участие во встрече"); if (m) m.status = "left"; save(); },
        async roomSettings(id, o = {}) { const u = me(); if (!u) return; const m = rmem(id, u.id); if (!m) return; if (o.notify) m.notify = o.notify; if (o.read) m.last_read_at = nowISO(); save(); },
        async sendMessage(rid, body, clientId, replyTo, action) {
          const u = need(), r = roomOf(rid), m = rmem(rid, u.id);
          const dup = db.rmsgs.find((x) => x.room_id === rid && x.sender_id === u.id && x.client_id === clientId); if (dup) return { id: dup.id, created_at: dup.created_at, duplicate: true };
          if (!m || m.status !== "active") throw err("NR403", r.type === "meeting" ? "Писать могут только участники встречи" : "Вступите в комнату, чтобы писать", "not_member");
          if (m.muted_until && m.muted_until > nowISO()) throw err("NR403", "Вам временно нельзя писать в этой комнате", "muted");
          demoSanction(u, "chat"); demoCheckText(body);
          const recent = db.rmsgs.filter((x) => x.sender_id === u.id && Date.now() - new Date(x.created_at) < 10e3).length; if (recent >= 5) throw err("NR429", "Слишком часто. Подождите немного", "retry_after=10");
          const all = /(^|\s)@all(?![\wа-я])/i.test(body);
          if (all && !["host", "cohost", "moderator"].includes(m.role)) throw err("NR403", "@all доступен только организатору и модераторам", "mention_all");
          if (all && db.rmsgs.some((x) => x.room_id === rid && x.meta && x.meta.all && Date.now() - new Date(x.created_at) < 300e3)) throw err("NR429", "@all можно использовать раз в 5 минут", "retry_after=300");
          const msg = { id: uid(), room_id: rid, sender_id: u.id, kind: action ? "action" : "text", body_masked: mask(body), client_id: clientId, reply_to: replyTo || null, meta: { ...(action ? { action } : {}), ...(all ? { all: true } : {}) }, status: "ok", created_at: nowISO() };
          db.rmsgs.push(msg); m.last_read_at = msg.created_at; save(); return { id: msg.id, created_at: msg.created_at };
        },
        async hideMessage(id) { const m = db.rmsgs.find((x) => x.id === id); if (m) { m.status = "hidden"; save(); } },
        async setMute(rid, u2, minutes) { const u = need(), mine = rmem(rid, u.id); if (!mine || !["host", "cohost", "moderator"].includes(mine.role)) throw err("NR403", "Мутить может организатор или модератор"); const t = rmem(rid, u2); if (t) t.muted_until = minutes ? new Date(Date.now() + minutes * 60e3).toISOString() : null; save(); },
        subscribeRoom(id, cb) { const f = (t, d) => { if (t === "room_message" && d && d.room_id === id) cb("insert", d); }; listeners.push(f); return () => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); }; },
        async profileLite(id) { const a = db.users.find((x) => x.id === id); return a && { id: a.id, nickname: a.nickname || a.name, avatar_url: a.avatar_url }; },
        async meetingsNear(o) {
          R_(); const u = me();
          return db.meets.filter((m) => m.status === "open" && m.starts_at > nowISO()).map((m) => { const p = db.posts.find((x) => x.id === m.id) || {}; return { ...m, lat: p.lat, lng: p.lng, accepted: accN(m.id), dist: Math.round(dist(o, p)), my_status: u ? (mrole(m.id, u.id) === "host" ? "host" : (mmem(m.id, u.id) || {}).status) : null }; })
            .filter((m) => m.dist <= (o.radius || 10000) && (!o.cats || !o.cats.length || o.cats.includes(m.category)) && (!o.from || m.starts_at >= o.from) && (!o.to || m.starts_at < o.to) && (!o.free || m.accepted < m.capacity) && (o.maxPrice == null || (m.price_kzt || 0) <= o.maxPrice))
            .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
        },
        async meeting(id) {
          R_(); const m = db.meets.find((x) => x.id === id); if (!m) return null; const u = me(), role = u && mrole(id, u.id), mm = u && mmem(id, u.id), host = db.users.find((x) => x.id === m.host_id);
          const ck = db.checkins.find((c) => c.meeting_id === id && !c.closed_at);
          const status = m.status === "cancelled" || m.status === "finished" ? m.status : m.ends_at < nowISO() ? "finished" : m.starts_at <= nowISO() ? "live" : m.status;
          const pub = (x) => { const a = db.users.find((y) => y.id === x.user_id) || {}; return { id: a.id, nickname: a.nickname || a.name, avatar_url: a.avatar_url, role: x.role, status: x.status, note: x.note, attended: x.attended, rating: ratingOf(a.id), muted_until: (rmem(m.room_id, a.id) || {}).muted_until }; };
          return { ...m, status, accepted: accN(id), room_id: role ? m.room_id : null, my_status: mm && mm.status, my_role: role, my_attended: mm && mm.attended,
            host: host && { id: host.id, nickname: host.nickname || host.name, avatar_url: host.avatar_url, verified: host.verified, rating: ratingOf(host.id) },
            members: role ? db.mmembers.filter((x) => x.meeting_id === id && x.status === "accepted").map(pub) : null,
            requests: role === "host" || role === "cohost" ? db.mmembers.filter((x) => x.meeting_id === id && (x.status === "requested" || x.status === "waitlist")).map(pub) : null,
            checkin: role && ck ? { id: ck.id, created_at: ck.created_at, answers: ck.answers } : null };
        },
        async myMeetings() { const u = need(); R_(); return db.mmembers.filter((x) => x.user_id === u.id && x.status !== "declined").map((x) => { const m = db.meets.find((y) => y.id === x.meeting_id) || {}; return { ...m, my_status: x.status, my_role: x.role, review_due: x.status === "accepted" && m.ends_at < nowISO() && Date.now() - new Date(m.ends_at) < 7 * 86400e3 }; }); },
        async createMeeting(p) {
          const u = need(); R_();
          if (u.age_status !== "adult") throw err("NR403", "Встречи пока доступны только после проверки возраста", "meet_age");
          const dup = db.posts.find((x) => x.client_key === p.client_key && x.user_id === u.id); if (dup) return dup.id;
          demoCheckText(p.title + " " + p.description + " " + (p.rules || ""));
          const id = "m-" + uid().slice(0, 8), r = { id: uid(), type: "meeting", title: mask(p.title), is_public: false, meeting_id: id, status: "active", pinned: pinOf(p.category, p.details || {}, p.starts_at, p.ends_at, p.capacity), rules: p.rules, created_at: nowISO() };
          db.rooms.push(r);
          db.posts.push({ id, user_id: u.id, category: "meetup", text: mask(p.description), lat: p.lat, lng: p.lng, status: "active", created_at: nowISO(), updated_at: nowISO(), exact: true, client_key: p.client_key, meta: { title: mask(p.title), mcat: p.category } });
          db.meets.push({ id, host_id: u.id, category: p.category, title: mask(p.title), details: p.details || {}, pin: r.pinned, place_name: p.place_name, starts_at: p.starts_at, ends_at: p.ends_at, capacity: p.capacity, price_kzt: p.price_kzt, rules: p.rules, status: "open", room_id: r.id });
          db.mmembers.push({ meeting_id: id, user_id: u.id, role: "host", status: "accepted", created_at: nowISO() });
          db.rmembers.push({ room_id: r.id, user_id: u.id, role: "host", status: "active", notify: "all", last_read_at: nowISO() });
          sysMsg(r.id, GREET[p.category], { tpl: "greet." + p.category }); if (p.category === "mountains") sysMsg(r.id, "Горы — это риск. Проверьте прогноз погоды, снаряжение и время возврата. В экстренной ситуации звоните 112.");
          audit(id, "create"); save(); return id;
        },
        async meetAct(fn, a) {
          const u = need(); R_(); const mid = a.p_meeting, m = mid && db.meets.find((x) => x.id === mid), role = m && mrole(mid, u.id);
          const host = () => { if (role !== "host" && role !== "cohost") throw err("NR403", "Только организатор"); };
          if (fn === "request_join") {
            if (u.age_status !== "adult") throw err("NR403", "Встречи пока доступны только после проверки возраста", "meet_age");
            const cur = mmem(mid, u.id); if (cur && cur.status === "removed") throw err("NR403", "Организатор исключил вас из этой встречи");
            const st = accN(mid) >= m.capacity ? "waitlist" : "requested"; if (cur) Object.assign(cur, { status: st, note: a.p_note }); else db.mmembers.push({ meeting_id: mid, user_id: u.id, role: "member", status: st, note: a.p_note, created_at: nowISO() }); save(); return st;
          }
          if (fn === "decide_request") {
            host(); const x = mmem(mid, a.p_user);
            if (!a.p_accept) { x.status = "declined"; audit(mid, "decline", a.p_user); save(); return "declined"; }
            if (accN(mid) >= m.capacity) throw err("NR409", "Свободных мест нет", "full");
            x.status = "accepted"; const rm = rmem(m.room_id, a.p_user); if (rm) rm.status = "active"; else db.rmembers.push({ room_id: m.room_id, user_id: a.p_user, role: "member", status: "active", notify: "all", last_read_at: nowISO() });
            sysMsg(m.room_id, "@" + (db.users.find((y) => y.id === a.p_user) || {}).nickname + " присоединился", { tpl: "joined" }); audit(mid, "accept", a.p_user); save(); return "accepted";
          }
          if (fn === "remove_member") { host(); const x = mmem(mid, a.p_user); x.status = "removed"; x.reason = a.p_reason; const rm = rmem(m.room_id, a.p_user); if (rm) rm.status = "removed"; db.mmembers.filter((y) => y.meeting_id === mid && y.status === "waitlist").forEach((y) => (y.status = "requested")); sysMsg(m.room_id, "Участник исключен организатором"); audit(mid, "remove", a.p_user, a.p_reason); save(); return; }
          if (fn === "leave_meeting") { const x = mmem(mid, u.id); if (role === "host") throw err("NR409", "Организатор не может выйти: передайте роль или отмените встречу"); if (x.status !== "accepted") { db.mmembers = db.mmembers.filter((y) => y !== x); save(); return "withdrawn"; } x.status = new Date(m.starts_at) - Date.now() >= 2 * 3600e3 ? "left" : "left_late"; const rm = rmem(m.room_id, u.id); if (rm) rm.status = "left"; sysMsg(m.room_id, "Участник отказался от участия"); audit(mid, x.status, u.id); save(); return x.status; }
          if (fn === "set_cohost") { if (role !== "host") throw err("NR403", "Только Host"); const x = mmem(mid, a.p_user); x.role = a.p_on ? "cohost" : "member"; rmem(m.room_id, a.p_user).role = x.role; audit(mid, a.p_on ? "cohost_on" : "cohost_off", a.p_user); save(); return; }
          if (fn === "transfer_host") { if (role !== "host") throw err("NR403", "Только Host"); mmem(mid, u.id).role = "cohost"; mmem(mid, a.p_user).role = "host"; m.host_id = a.p_user; rmem(m.room_id, u.id).role = "cohost"; rmem(m.room_id, a.p_user).role = "host"; audit(mid, "transfer_host", a.p_user); save(); return; }
          if (fn === "update_meeting") { host(); const p = a.p; const moved = (p.starts_at && p.starts_at !== m.starts_at) || (p.ends_at && p.ends_at !== m.ends_at); Object.assign(m, { place_name: p.place_name ?? m.place_name, starts_at: p.starts_at || m.starts_at, ends_at: p.ends_at || m.ends_at, capacity: p.capacity || m.capacity }); if (moved) { db.checkins.filter((c) => c.meeting_id === mid && !c.closed_at).forEach((c) => (c.closed_at = nowISO())); sysMsg(m.room_id, "Организатор изменил место или время встречи", { tpl: "moved" }); } audit(mid, "update"); save(); return; }
          if (fn === "close_recruiting") { host(); m.status = a.p_closed ? "closed" : "open"; audit(mid, a.p_closed ? "close" : "reopen"); save(); return; }
          if (fn === "cancel_meeting") { if (role !== "host") throw err("NR403", "Отменить может Host"); m.status = "cancelled"; m.cancel_reason = a.p_reason; sysMsg(m.room_id, "Встреча отменена. Причина: " + a.p_reason); audit(mid, "cancel", null, a.p_reason); save(); return; }
          if (fn === "finish_meeting") { host(); m.status = "finished"; if (m.ends_at > nowISO()) m.ends_at = nowISO(); sysMsg(m.room_id, "Встреча завершена. Отметьте посещение и оцените участников в течение 7 дней"); audit(mid, "finish"); save(); return; }
          if (fn === "request_checkin") { host(); db.checkins.filter((c) => c.meeting_id === mid && !c.closed_at).forEach((c) => (c.closed_at = nowISO())); const c = { id: uid(), meeting_id: mid, created_at: nowISO(), answers: { [u.id]: "ready" } }; db.checkins.push(c); const msg = { id: uid(), room_id: m.room_id, sender_id: u.id, kind: "checkin", body_masked: "@all • Подтвердите готовность", meta: { all: true, checkin_id: c.id }, status: "ok", created_at: nowISO() }; db.rmsgs.push(msg); save(); emit("room_message", msg); return c.id; }
          if (fn === "answer_checkin") { const c = db.checkins.find((x) => x.id === a.p_checkin); if (!c || c.closed_at) throw err("NR409", "Запрос закрыт: время встречи изменилось"); c.answers[u.id] = a.p_answer; save(); return; }
          if (fn === "mark_attended") { const x = mmem(mid, u.id); x.attended = x.attended === "noshow" ? "disputed" : x.attended || "claimed"; save(); return; }
          if (fn === "confirm_attendance") { if (m.host_id !== u.id) throw err("NR403", "Подтверждает Host"); const x = mmem(mid, a.p_user); x.attended = a.p_came ? "confirmed" : x.attended === "claimed" ? "disputed" : "noshow"; audit(mid, a.p_came ? "attend_yes" : "attend_no", a.p_user); save(); return; }
          if (fn === "submit_review") {
            if (a.p_target === u.id) throw err("NR422", "Себя оценить нельзя");
            if (db.reviews.some((r) => r.meeting_id === mid && r.reviewer_id === u.id && r.target_id === a.p_target)) throw err("NR409", "Вы уже оценили этого участника");
            const ok = (x) => { const y = mmem(mid, x); return y && (y.attended === "confirmed" || (y.role === "host" && y.status === "accepted")); };
            if (!ok(u.id) || !ok(a.p_target)) throw err("NR403", "Отзывы оставляют только подтвержденные участники");
            db.reviews.push({ meeting_id: mid, reviewer_id: u.id, target_id: a.p_target, target_role: a.p_target === m.host_id ? "host" : "member", stars: a.p_stars, comment: a.p_comment && mask(a.p_comment), created_at: nowISO() }); save(); return;
          }
          throw new Error("Неизвестное действие");
        },
        async meetAudit(id) { R_(); return db.audit.filter((x) => x.meeting_id === id).slice().reverse(); },
        async attachCover() {},
        async profilePublic(id) {
          const a = db.users.find((x) => x.id === id); if (!a) return null; R_();
          return { id: a.id, nickname: a.nickname || a.name, avatar_url: a.avatar_url, verified: !!a.verified, bio: a.bio || null, district: a.district, interests: a.interests || [], instagram: a.instagram_public ? a.instagram : null,
            likes: db.likes.filter((l) => (db.posts.find((p) => p.id === l.post_id) || {}).user_id === id && l.user_id !== id).length,
            posts: db.posts.filter((p) => p.user_id === id && p.category !== "meetup" && p.status !== "deleted").length,
            meetings: ratingOf(id).meetings, rating: ratingOf(id), blocked: blockedByMe().has(id) };
        },
        async setNotifyLevel(l) { const u = need(); u.notify_level = l; save(); }
      };

      return Object.assign({
        mode: "local",
        async init() { load(); return prof(me()); },
        user: () => prof(me()),
        onAuth(cb) { listeners.push((t, d) => t === "auth" && cb(d)); },
        subscribe(cb) { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },

        async signUp({ nickname, email, password, district }) {
          email = (email || "").trim().toLowerCase(); nickname = String(nickname || "").trim();
          // ТЗ 38: никнейм выбирается после подтверждения почты (здесь — необязателен)
          if (nickname) { const np = nickProblem(nickname); if (np) throw new Error(np); if (db.users.some((x) => x.nickname && nickNorm(x.nickname) === nickNorm(nickname))) throw new Error("Этот никнейм уже занят. Попробуйте другой"); }
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Проверьте правильность email");
          if ((password || "").length < 6) throw new Error("Пароль должен быть не короче 6 символов");
          if (db.users.some((u) => u.email === email)) return { needsConfirm: true, neutral: true, demoEmail: email }; // ТЗ 38: не раскрываем, есть ли аккаунт
          const firstReal = !db.users.some((x) => x.pwh);
          const u = { id: uid(), email, pwh: await hash(password), name: nickname || "Новый пользователь", nickname: nickname || null, nick_at: nickname ? nowISO() : null, avatar_url: null, district: district || null, created_at: nowISO(), accepted_rules_at: nowISO(), is_admin: firstReal, age_status: firstReal ? "adult" : "unknown", verified: false, last_seen_at: nowISO() };
          db.users.push(u); db.session = u.id; demoWelcome(u); save(); emit("auth", prof(u));
          return { needsConfirm: false };
        },
        async signIn({ login, email, password }) {
          login = String(login || email || "").trim().replace(/^@/, "");
          const u = login.includes("@") ? db.users.find((x) => x.email === login.toLowerCase()) : db.users.find((x) => x.nickname && nickNorm(x.nickname) === nickNorm(login));
          if (!u || !u.pwh || u.pwh !== (await hash(password || ""))) throw new Error("Неверный ник, email или пароль");
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
        async account() { const u = me(); return u ? prof(u).account : null; },
        async mfaState() { return { level: "aal2", next: "aal2", factorId: "demo" }; },
        async mfaEnroll() { throw new Error("Двухэтапная защита работает, когда приложение подключено к серверу"); },
        async mfaVerify() { return true; },
        async modMediaQueue() { return []; },
        async modMedia() {},
        async modRestrict(userId, scope, days, reason) {
          const u = need(); if (!(u.is_admin || u.is_moderator)) throw new Error("Только для модераторов");
          if (!reason || reason.trim().length < 3) throw new Error("Укажите причину");
          (db.sanctions = db.sanctions || []).push({ id: uid(), user_id: userId, scope, until: days ? new Date(Date.now() + days * 86400e3).toISOString() : null, reason: reason.trim(), created_at: nowISO() });
          notify(userId, "sanction", null, "Ограничение: " + reason.trim()); save();
        },
        async modUnrestrict(id) { const sx = (db.sanctions || []).find((x) => x.id === id); if (sx) { sx.revoked_at = nowISO(); save(); } },
        async sanctions(userId) { const u = me(); return (db.sanctions || []).filter((x) => x.user_id === (userId || (u && u.id)) && !x.revoked_at && (!x.until || x.until > nowISO())); },
        async cityUpsert(item) {
          const u = need(); if (!(u.is_admin || u.is_moderator)) throw new Error("Только для редакторов NEAR City");
          if (!item.source_name || item.source_name.trim().length < 2) throw new Error("Укажите источник");
          if (!item.text || item.text.trim().length < 5) throw new Error("Добавьте описание");
          const sid = item.source_id || "manual:" + item.source_name + ":" + item.text.slice(0, 40);
          let p = db.posts.find((x) => x.source_id === sid), t = nowISO();
          const fields = { category: item.category || "incident", text: mask(item.text.trim().slice(0, 1000)), lat: +item.lat, lng: +item.lng, meta: { title: item.title || undefined, itype: item.itype || undefined },
            official: true, source_name: item.source_name.trim(), source_url: httpsUrl(item.source_url), source_id: sid, verified_at: t, status: item.status === "closed" ? "closed" : "active", updated_at: t };
          if (p) Object.assign(p, fields); else { p = { id: uid(), user_id: u.id, created_at: t, exact: true, ...fields, expires_at: item.expires_at || null }; db.posts.push(p); }
          save(); return p.id;
        },
        async cityList() { return db.posts.filter((p) => p.official).sort((a, b) => (b.verified_at || "").localeCompare(a.verified_at || "")).map(shape); },
        async ping() { return { p50: 0, p95: 0, n: 0, demo: true }; },
        async mapPoints(args) { return { items: await this.listPosts(args), truncated: false }; },
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
        async updateProfile({ district, avatarFile, instagram, instagram_public, interests, acceptRules, bio, show_seen }) {
          const u = need();
          if (instagram_public !== undefined) u.instagram_public = !!instagram_public;
          if (interests !== undefined) u.interests = (interests || []).filter((k) => INTERESTS.some((x) => x[0] === k)).slice(0, 5);
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
        async createPost({ category, text, lat, lng, files = [], event, exact = false, is_sos = false, meta }, onProgress = () => {}) {
          const u = need(); meta = postMetaClean(category, meta);
          if (!CATS[category]) throw new Error("Выберите тип публикации");
          if (!text || !text.trim()) throw new Error("Добавьте описание");
          if (lat == null || lng == null) throw new Error("Укажите место на карте");
          if (files.length > 5) throw new Error("Не больше 5 вложений в публикации");
          if (is_sos && db.posts.some((p) => p.user_id === u.id && p.is_sos && p.status === "active" && (!p.expires_at || p.expires_at > nowISO())))
            throw new Error("У вас уже есть активный SOS. Закройте его, чтобы отправить новый");
          if (!u.nickname || !u.accepted_rules_at) { const e = new Error("Заполните профиль: никнейм и согласие с правилами"); e.code = "NR403"; throw e; }
          demoSanction(u, "post"); demoCheckText(text);
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
          let ttl = is_sos ? 3 * 3600e3 : category === "incident" ? (meta.ttl_h || 24) * 3600e3 : category === "help" ? 7 * 86400e3 : 0;
          if (category === "deal" && meta.until) ttl = new Date(meta.until) - Date.now();
          db.posts.push({ id, user_id: u.id, category, text: mask(text.trim().slice(0, 1000)), lat, lng, status: "active", created_at: t, updated_at: t, is_sos: !!is_sos, exact: !!exact, meta,
            expires_at: ttl ? new Date(Date.now() + ttl).toISOString() : null });
          db.media.push(...media);
          if (event && event.starts_at) db.events.push({ post_id: id, starts_at: event.starts_at, capacity: event.capacity || null });
          try { save(); } catch (e) {
            db.posts = db.posts.filter((p) => p.id !== id); db.media = db.media.filter((m) => m.post_id !== id); db.events = db.events.filter((x) => x.post_id !== id);
            throw e;
          }
          const p = shape(db.posts.find((x) => x.id === id)); emit("post", p); return p;
        },
        async updatePost(id, { text, category, status, event, meta }) {
          const u = need(), p = db.posts.find((x) => x.id === id);
          if (!p || p.user_id !== u.id) throw new Error("Можно менять только свои публикации");
          if (text !== undefined) { if (!text.trim()) throw new Error("Описание не может быть пустым"); demoCheckText(text); p.text = mask(text.trim().slice(0, 1000)); }
          if (meta !== undefined) p.meta = postMetaClean(category || p.category, meta);
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
          demoSanction(u, "comment"); demoCheckText(text);
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
          return { ...pubProfile(x), instagram: x.instagram && (x.instagram_public || (u && u.id === x.id)) ? x.instagram : null, friendship, blocked: !!u && db.blocks.some((b) => b.blocker_id === u.id && b.blocked_id === id),
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
      }, demoV3);
    }

    return LocalBackend();
  };
})();
