// =====================================================
//  NEAR — настройки подключения
// =====================================================
//  1. Создайте проект на https://supabase.com
//  2. Откройте Project Settings → API (или Connect)
//  3. Скопируйте "Project URL" и ключ "anon public"
//     и вставьте их ниже между кавычками.
//
//  ENV — режим работы:
//    "demo"    — демо: данные только в памяти телефона, сервер не нужен;
//    "staging" — тестовый проект Supabase (отдельные ключи);
//    "prod"    — рабочий проект. В staging/prod приложение НИКОГДА
//                не переключается на демо: при сбое показывает ошибку.
// =====================================================

window.NEAR_CONFIG = {
  ENV: "prod",

  SUPABASE_URL: "https://aswcegzkbzuqwfpxwuqw.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Vk2tcpFCdU11x2kemOMB_A_eObypm3O",  // публичный ключ, его можно хранить в коде

  // ИИ-проверка фото и сообщений (см. SETUP.md, шаг 7).
  // Включайте только после того, как развернули функцию "moderate".
  AI_MODERATION: false,

  // Центр карты по умолчанию (Алматы)
  CITY: { name: "Алматы", lat: 43.2389, lng: 76.8897, zoom: 13 },

  // Ограничения загрузки файлов
  MAX_FILES: 5,
  MAX_IMAGE_MB: 15,   // исходное фото (перед сжатием)
  MAX_VIDEO_MB: 20,    // v14.2: видео до 20 МБ и до 30 секунд
  MAX_VIDEO_SEC: 30,
  SUPPORT_EMAIL: "",

  // Push-уведомления: публичный VAPID-ключ (секретная пара — только в Supabase → Edge Functions → Secrets)
  VAPID_PUBLIC_KEY: "BGLgiT_VBCkSPbZ7U8H_88nKuuuhQnwZ83OJ6Mh6JB5Xqmu6XwbE1xsam2-iNw6w3oTqiizxw0aJkKTYM3IKkhc",

  // Вход через Google: true — только после включения провайдера Google в Supabase (SETUP.md, шаг 11)
  GOOGLE_AUTH: false,

  // Защита от ботов: Site Key из Cloudflare Turnstile (пусто — капча выключена)
  TURNSTILE_SITE_KEY: "",

  // Разделы-заготовки (услуги, опросы, сообщества, купоны) в рабочей версии скрыты
  SHOW_DEMO_SECTIONS: false,

  // Аналитика: псевдонимизированные события (без email, текстов и точных координат)
  ANALYTICS: true
};
