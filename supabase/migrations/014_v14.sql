-- =====================================================
--  Миграция v14 (этап 1 из ТЗ v14.4). Для базы, где уже стоит v12 (schema.sql уже включает этот блок).
--  Запуск: Supabase → SQL Editor → вставить файл целиком → Run. Скрипт идемпотентный.
--
--  Что внутри:
--   02 — исправления v12: лента (SOS, "Рядом", снимок "Для вас"), карта (фильтры до лимита), 5 мест (блокировка),
--        медиа только при включенной серверной проверке;
--   04 — никнейм вместо имени, фамилии и пола; приватный возрастной допуск; личные чаты с незнакомыми — только при допуске;
--   05 — NEAR Clean: маскирование мата (первая буква + звездочки), угрозы не публикуются;
--   08 — дневные лимиты (атомарно, 429 + retry_after, ключ идемпотентности), дубликаты текста.
--  Старые имя/фамилия/пол удаляются ОТДЕЛЬНО: 014b_purge_legacy.sql (после решения владельца).
--
--  Откат (данные не трогаются): вернуть клиент v12 и выполнить 012_v12.sql повторно — он вернет feed_sorted, map_posts2,
--  places_guard, profile_guard. Новые таблицы (profile_private, nickname_history, rate_counters, rate_idem) можно оставить.
--  Перед миграцией — резервная копия (SETUP.md, шаг 16).
-- =====================================================

-- ---------- 05 / NEAR Clean v1: маскирование мата (тот же алгоритм, что js/clean.src.js) ----------
-- Первая буква слова остается, каждая следующая графема → "*". Проверка до записи публичного текста.
-- Оригинал не сохраняется. Словарь версионируется: app_settings.clean_version.
create or replace function public.nc_is_w(k int) returns boolean language sql immutable as $$
  select (k between 48 and 57) or (k between 65 and 90) or (k between 97 and 122) or (k between 192 and 591 and k not in (215, 247))
      or (k between 1024 and 1279) or (k between 768 and 879) or (k between 8203 and 8205) or k in (8288, 65279, 173, 64, 36) $$;
create or replace function public.nc_is_sep(k int) returns boolean language sql immutable as $$ select k in (46, 45, 95, 42, 39, 8217, 96) $$;
create or replace function public.nc_is_zw(k int) returns boolean language sql immutable as $$ select (k between 8203 and 8205) or k in (8288, 65279, 173) $$;
create or replace function public.nc_is_mark(k int) returns boolean language sql immutable as $$ select k between 768 and 879 $$;

create or replace function public.nc_translit(s text) returns text language plpgsql immutable as $$
declare out text := ''; i int := 1; n int := char_length(s); g text; c text; L int; hit text;
begin
  while i <= n loop
    hit := null;
    foreach L in array array[4, 3, 2] loop
      g := substr(s, i, L);
      if char_length(g) = L then
        hit := case g when 'shch' then 'щ' when 'sch' then 'щ' when 'sh' then 'ш' when 'ch' then 'ч' when 'zh' then 'ж' when 'kh' then 'х'
          when 'ts' then 'ц' when 'ya' then 'я' when 'yu' then 'ю' when 'yo' then 'е' when 'ye' then 'е' when 'ja' then 'я' when 'ju' then 'ю' when 'jo' then 'е' end;
        if hit is not null then out := out || hit; i := i + L; exit; end if;
      end if;
    end loop;
    continue when hit is not null;
    c := substr(s, i, 1);
    if c = 'y' then out := out || case when out ~ '[аеиоуыэюя]$' then 'й' else 'ы' end;
    elsif c = 'x' then out := out || 'кс';
    else out := out || translate(c, 'abcdefghijklmnopqrstuvwz', 'абкдефгхийклмнопкрстуввз');
    end if;
    i := i + 1;
  end loop;
  return regexp_replace(out, '(.)\1+', '\1', 'g');
end $$;

create or replace function public.nc_bad_token(tok text) returns boolean language plpgsql immutable as $$
declare s text := ''; c text; k int; en text; hg text; kk text;
  pre constant text := '(вы|за|на|по|от|до|у|раз|рас|при|об|о|пере|под|недо|про|из|ис|без|бес|вз|съ|разъ|объ|подъ|отъ|изъ|въ|взъ)?';
  ru_full text; ru_strict text;
  en_re constant text := '^(mother|motha|mutha|holy)?(fuck.*|fuk.*|fck.*|phuck.*|shit.*|bitch.*|cunt.*|asshole.*|bullshit.*|dickhead.*|whore.*|slut.*)$';
  exc constant text[] := array['shiitake','shitake','shiite','shiites','fukuoka','fukushima','hue','hues','huey','hui','ebay','ebola','ebony','ebook','ebooks','suki','sukiyaki','scunthorpe'];
begin
  ru_full := '^(' || pre || '(ху[йяеёию].*|пизд.*|еб[аулнышиоеё].*|бля[дт].*|бля|долбоеб.*|мудак.*|мудил.*|мудо[хз].*|мудач.*|гандон.*|пид[оа]р.*|шлюх.*|залуп.*)'
    || '|сук(а|и|е|у|ой|ою|ам|ами|ах|ин.*)|суч(к|ар|ий|ья|ье).*|котак.*|қотақ.*|сиг(ей|ейин|ем|у|ип).*|шешеңди.*)$';
  ru_strict := '^(' || pre || '(хуй.*|хуя.*|хуе[втлн].*|хую.*|пизд.*|еба[лнт].*|ебл.*|ебу.*|еби.*|ебн.*|ебош.*|бля[дт].*|бля|долбоеб.*|мудак.*|мудил.*|гандон.*|пид[оа]р.*|шлюх.*|залуп.*)'
    || '|сук(а|и|е|у|ой|ам|ами|ах|ин.*))$';
  kk := lower(translate(normalize(tok, NFKC), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯӘҒҚҢӨҰҮҺІ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһі'));
  foreach c in array regexp_split_to_array(kk, '') loop
    k := ascii(c);
    if not (public.nc_is_zw(k) or public.nc_is_mark(k) or public.nc_is_sep(k)) then s := s || c; end if;
  end loop;
  if s = '' or s = any (exc) then return false; end if;
  if s ~ '[Ѐ-ӿ]' then
    hg := regexp_replace(translate(translate(s, 'aceopxykmthiunr0346@$', 'асеорхукмтниипгозчбас'), 'ёі', 'еи'), '(.)\1+', '\1', 'g');
    return hg ~ ru_full;
  end if;
  if s !~ '[a-zA-Z]' and s !~ '[À-ɏ]' then return false; end if;
  en := regexp_replace(translate(s, '013457@$', 'oieastas'), '(.)\1+', '\1', 'g');
  if en = any (exc) then return false; end if;
  if en ~ en_re then return true; end if;
  if public.nc_translit(en) ~ ru_strict then return true; end if;
  hg := regexp_replace(translate(s, 'aceopxykmthiunr0346@$', 'асеорхукмтниипгозчбас'), '(.)\1+', '\1', 'g');
  return hg !~ '[a-zA-ZÀ-ɏ]' and hg ~ ru_full;
end $$;

-- маскирование: возвращает текст и число найденных слов
create or replace function public.near_clean_x(t text, out txt text, out hits int) language plpgsql immutable as $$
declare ch text[]; o text[]; n int; i int; j int; k int; q int; a int; b int; ts int[] := '{}'; te int[] := '{}'; done boolean[]; w text; first boolean; m text; nt int;
begin
  hits := 0;
  if t is null or t = '' then txt := t; return; end if;
  ch := regexp_split_to_array(t, ''); o := ch; n := array_length(ch, 1);
  -- слова: буквы/цифры, внутри допускаются разделители
  i := 1;
  while i <= n loop
    if not public.nc_is_w(ascii(ch[i])) then i := i + 1; continue; end if;
    j := i;
    loop
      while j <= n and public.nc_is_w(ascii(ch[j])) loop j := j + 1; end loop;
      if j <= n and public.nc_is_sep(ascii(ch[j])) then
        k := j; while k <= n and public.nc_is_sep(ascii(ch[k])) loop k := k + 1; end loop;
        if k <= n and public.nc_is_w(ascii(ch[k])) then j := k; continue; end if;
      end if;
      exit;
    end loop;
    ts := ts || i; te := te || j; i := j;
  end loop;
  nt := coalesce(array_length(ts, 1), 0);
  if nt = 0 then txt := t; return; end if;
  done := array_fill(false, array[nt]);
  -- "х у й": три и больше одиночных букв через один пробел
  a := 1;
  while a <= nt loop
    b := a;
    while b + 1 <= nt and te[b] - ts[b] = 1 and te[b + 1] - ts[b + 1] = 1 and ts[b + 1] = te[b] + 1 and ch[te[b]] = ' ' loop b := b + 1; end loop;
    if b - a >= 2 and te[a] - ts[a] = 1 then
      w := ''; for q in a..b loop w := w || ch[ts[q]]; end loop;
      if public.nc_bad_token(w) then
        for q in a + 1..b loop o[ts[q]] := '*'; end loop;
        for q in a..b loop done[q] := true; end loop;
        hits := hits + 1; a := b + 1; continue;
      end if;
    end if;
    a := a + 1;
  end loop;
  for q in 1..nt loop
    continue when done[q];
    w := array_to_string(ch[ts[q]:te[q] - 1], '');
    if public.nc_bad_token(w) then
      hits := hits + 1; m := ch[ts[q]]; first := true;
      for i in ts[q] + 1..te[q] - 1 loop
        k := ascii(ch[i]);
        if public.nc_is_mark(k) then if first then m := m || ch[i]; end if;
        elsif public.nc_is_zw(k) then null;
        else m := m || '*'; first := false;
        end if;
      end loop;
      o[ts[q]] := m;
      for i in ts[q] + 1..te[q] - 1 loop o[i] := ''; end loop;
    end if;
  end loop;
  txt := array_to_string(o, '');
end $$;

create or replace function public.near_clean(t text) returns text language sql immutable as $$ select (public.near_clean_x(t)).txt $$;
create or replace function public.near_has_bad(t text) returns boolean language sql immutable as $$ select coalesce((public.near_clean_x(t)).hits, 0) > 0 $$;
-- старое имя: триггеры posts_mask, comments_mask, messages_mask вызывают mask_bad
create or replace function public.mask_bad(t text) returns text language sql immutable as $$ select public.near_clean(t) $$;

-- явные угрозы: не маскируются, а не публикуются
create or replace function public.near_is_threat(t text) returns boolean language sql immutable as $$
  select coalesce(replace(lower(translate(t, 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя')), 'ё', 'е')
    ~ '(^|[^а-яa-z])(убью (тебя|вас|его|ее|тебе)|зарежу|пристрелю|задушу (тебя|вас)|урою|тебе конец|найду тебя и|сожгу (тебя|вас|твой|твою|ваш)|i will kill you|i''ll kill you|kill you|өлтіремін)([^а-яa-z]|$)', false) $$;

create or replace function public.mask_text_trigger() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.text is distinct from old.text then
    if public.near_is_threat(new.text) then
      raise exception using errcode = 'NR422', message = 'Угрозы запрещены правилами NEAR. Текст не опубликован', hint = 'threat';
    end if;
    new.text := public.near_clean(new.text);
  end if;
  return new;
end $$;
-- описание профиля тоже проходит NEAR Clean
create or replace function public.mask_bio_trigger() returns trigger
language plpgsql as $$
begin
  if new.bio is distinct from old.bio and new.bio is not null then
    if public.near_is_threat(new.bio) then raise exception using errcode = 'NR422', message = 'Угрозы запрещены правилами NEAR'; end if;
    new.bio := public.near_clean(new.bio);
  end if;
  return new;
end $$;
drop trigger if exists profiles_bio_mask on public.profiles;
create trigger profiles_bio_mask before update of bio on public.profiles for each row execute function public.mask_bio_trigger();

-- =====================================================
--  02 / Исправления v12
-- =====================================================

-- ---------- лента: закрытый SOS без подъема; "Рядом" — порядок и курсор по одним полям;
--            "Для вас" — снимок на момент первой страницы (p_snapshot) и курсор (score, id) вместо OFFSET ----------
drop function if exists public.feed_sorted(double precision, double precision, int, text[], text, text, boolean, timestamptz, double precision, uuid, int, int);
create or replace function public.feed_sorted(p_lat double precision, p_lng double precision, p_radius int,
  p_cats text[] default null, p_sort text default 'new', p_period text default null, p_friends boolean default false,
  p_after_ts timestamptz default null, p_after_dist double precision default null, p_after_id uuid default null,
  p_offset int default 0, p_limit int default 12, p_after_score double precision default null, p_snapshot timestamptz default null)
returns table (post_id uuid, sort_ts timestamptz, sort_dist double precision, sort_score double precision, snapshot timestamptz)
language sql stable set search_path = public, extensions as $$
  with prm as (select least(coalesce(p_snapshot, now()), now()) t0),
  me as (select extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography g),
  base as (
    select p.id, p.created_at, p.category, p.is_sos, p.status,
           extensions.st_distance(p.geog, me.g) dist,
           -- счетчики на момент снимка: новые лайки не двигают уже показанные страницы
           (select count(*) from public.comments c where c.post_id = p.id and c.created_at <= prm.t0) nc,
           (select count(*) from public.likes l where l.post_id = p.id and l.created_at <= prm.t0) nl
      from public.posts p, me, prm
     where p.status in ('active','closed')
       and (p.expires_at is null or p.expires_at > now())
       and (coalesce(p_sort, 'new') <> 'top' or p.created_at <= prm.t0)
       and extensions.st_dwithin(p.geog, me.g, least(greatest(coalesce(p_radius, 1000), 100), 50000))
       and (p_cats is null or p.category = any (p_cats))
       and (p_period is null or (p_period = 'today' and p.created_at > date_trunc('day', now() at time zone 'Asia/Almaty') at time zone 'Asia/Almaty')
                             or (p_period = 'week' and p.created_at > now() - interval '7 days'))
       and (not coalesce(p_friends, false) or public.are_friends(auth.uid(), p.user_id))
       and not public.is_blocked(auth.uid(), p.user_id)
  ), scored as (
    select b.*,
      -- подъем только у действующего SOS и свежего происшествия; закрытые не поднимаются
      (case when b.status = 'active' and (b.is_sos or (b.category = 'incident' and b.created_at > prm.t0 - interval '3 hours')) then 1000 else 0 end)
      + 100 * exp(-greatest(extract(epoch from prm.t0 - b.created_at), 0) / 86400.0)
      + 40 * exp(-b.dist / 1500.0)
      + 8 * ln(1 + b.nc) + 3 * ln(1 + b.nl) score
    from base b, prm
  )
  select s.id, s.created_at, s.dist, s.score, (select t0 from prm) from scored s
   where case coalesce(p_sort, 'new')
           when 'near' then p_after_dist is null or (s.dist, s.id) > (p_after_dist, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
           when 'top' then p_after_score is null or (s.score, s.id) < (p_after_score, coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
           else p_after_ts is null or (s.created_at, s.id) < (p_after_ts, coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)) end
   order by case when p_sort = 'near' then s.dist end asc,
            case when p_sort = 'near' then s.id end asc,
            case when p_sort = 'top' then s.score end desc,
            case when p_sort = 'top' then s.id end desc,
            s.created_at desc, s.id desc
   limit least(greatest(coalesce(p_limit, 12), 1), 12) $$;

-- ---------- карта: период и "друзья" фильтруются ДО лимита (раньше — после 500 строк, редкая категория пропадала) ----------
create or replace function public.map_posts2(p_w double precision, p_s double precision, p_e double precision, p_n double precision,
  p_cats text[] default null, p_lat double precision default null, p_lng double precision default null, p_radius int default null,
  p_period text default null, p_friends boolean default false, p_limit int default 300)
returns setof public.posts language sql stable set search_path = public, extensions as $$
  select p.* from public.posts p
   where p.status in ('active','closed')
     and (p.expires_at is null or p.expires_at > now())
     and case when p_radius is not null and p_lat is not null
           then extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
                                      least(greatest(p_radius, 100), 50000))
           else p.geog operator(extensions.&&) extensions.st_makeenvelope(p_w, p_s, p_e, p_n, 4326)::extensions.geography end
     and (p_cats is null or p.category = any (p_cats))
     and (p_period is null or (p_period = 'today' and p.created_at > date_trunc('day', now() at time zone 'Asia/Almaty') at time zone 'Asia/Almaty')
                           or (p_period = 'week' and p.created_at > now() - interval '7 days'))
     and (not coalesce(p_friends, false) or public.are_friends(auth.uid(), p.user_id))
     and not public.is_blocked(auth.uid(), p.user_id)
   order by p.created_at desc, p.id desc
   limit least(greatest(coalesce(p_limit, 300), 1), 500) $$;

-- ---------- избранные места: блокировка по автору, 5 мест даже при параллельных вставках ----------
create or replace function public.places_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('near-places:' || new.user_id::text, 0));
    if (select count(*) from public.saved_places where user_id = new.user_id) >= 5 then
      raise exception using errcode = 'NR422', message = 'Не больше 5 избранных мест';
    end if;
  end if;
  new.lat := round(new.lat::numeric, 3); new.lng := round(new.lng::numeric, 3);
  return new;
end $$;

-- ---------- медиа: без серверной проверки публикация файлов закрыта ----------
-- Решение ТЗ v14.4: "Включить серверную проверку; без нее публикация медиа недоступна".
-- media_requires_check = true (по умолчанию): файл принимается, только если включена ИИ-проверка (ai_moderation).
alter table public.app_settings add column if not exists media_requires_check boolean not null default true;
create or replace function public.media_gate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_mod()
     and (select media_requires_check and not ai_moderation from public.app_settings where id = 1) then
    raise exception using errcode = 'NR503', message = 'Фото и видео временно недоступны: на сервере не включена проверка файлов. Опубликуйте текст без файлов', hint = 'media_check_off';
  end if;
  return new;
end $$;
drop trigger if exists post_media_gate on public.post_media;
create trigger post_media_gate before insert on public.post_media for each row execute function public.media_gate();

-- =====================================================
--  04 / Никнейм вместо имени, фамилии и пола; возрастной допуск — приватно
-- =====================================================
alter table public.profiles add column if not exists nickname text;
alter table public.profiles add column if not exists nickname_norm text;
alter table public.profiles add column if not exists nickname_changed_at timestamptz;
create unique index if not exists profiles_nickname_norm_uidx on public.profiles (nickname_norm) where nickname_norm is not null;
-- пол больше не обязателен и не принимается (колонка удаляется в 014b после перехода всех клиентов)
alter table public.profiles drop constraint if exists profiles_gender_chk;

-- приватные данные аккаунта: видит только сам пользователь (через my_account) и администратор
create table if not exists public.profile_private (
  user_id           uuid primary key references public.profiles(id) on delete cascade,
  age_status        text not null default 'unknown' check (age_status in ('unknown','adult','minor')),
  age_checked_at    timestamptz,
  age_checked_by    uuid references public.profiles(id) on delete set null,
  phone_verified_at timestamptz,
  updated_at        timestamptz not null default now()
);
alter table public.profile_private enable row level security;
drop policy if exists "private admin" on public.profile_private;
create policy "private admin" on public.profile_private for select using (public.is_admin());

-- история никнеймов: только модераторы
create table if not exists public.nickname_history (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  old_nick    text,
  new_nick    text not null,
  changed_at  timestamptz not null default now()
);
create index if not exists nickname_history_user_idx on public.nickname_history (user_id, changed_at desc);
alter table public.nickname_history enable row level security;
drop policy if exists "nick history mod" on public.nickname_history;
create policy "nick history mod" on public.nickname_history for select using (public.is_mod());

alter table public.app_settings add column if not exists age_gate boolean not null default true;
alter table public.app_settings add column if not exists clean_version text not null default 'clean-1';
update public.app_settings set clean_version = 'clean-1' where id = 1;

-- нормализация для уникальности: регистр, NFKC, похожие кириллические и латинские буквы — одна форма
create or replace function public.nick_norm(t text) returns text language sql immutable as $$
  select translate(lower(translate(normalize(t, NFKC), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯӘҒҚҢӨҰҮҺІ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһі')),
                   'аеёорсухкмтнві', 'aeeopcyxkmthbi') $$;

-- проверка никнейма: пустая строка — можно, иначе текст ошибки
create or replace function public.nick_problem(t text) returns text language plpgsql immutable as $$
declare n text := coalesce(t, ''); l text := lower(translate(coalesce(t, ''), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'));
begin
  if char_length(n) < 3 or char_length(n) > 20 then return 'Никнейм: от 3 до 20 символов'; end if;
  if n !~ '^[A-Za-z0-9_А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]+$' then return 'Никнейм: только буквы, цифры и _ (без пробелов и ссылок)'; end if;
  if n !~ '[A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]' then return 'В никнейме нужна хотя бы одна буква'; end if;
  if n ~ '[A-Za-z]' and n ~ '[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]' then return 'Никнейм: используйте одну раскладку — только латиницу или только кириллицу'; end if;
  if public.near_has_bad(n) or public.near_has_bad(regexp_replace(n, '[_0-9]+', ' ', 'g')) then return 'Никнейм содержит недопустимые слова. Выберите другой'; end if;
  if l ~ '(near|admin|moder|support|official|offical|akimat|police|mvd|админ|модер|поддержк|официал|акимат|полици|мвд)' or l ~ '^(112|101|102|103|104)'
     or public.nick_norm(n) ~ '(near|admin|moder|support|official|akimat|police)' then
    return 'Такой никнейм похож на официальный аккаунт. Выберите другой';
  end if;
  return '';
end $$;

create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() пустой у сервера (регистрация, SQL Editor, сервисные функции)
  if auth.uid() is null or public.is_admin() or coalesce(current_setting('near.system', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    new.is_admin := false; new.is_moderator := false; new.banned := false; new.verified := false;
    new.nickname := null; new.nickname_norm := null; new.name := 'Новый пользователь';
    return new;
  end if;
  new.is_admin := old.is_admin;
  new.is_moderator := old.is_moderator;
  new.banned := old.banned;
  new.verified := old.verified;
  new.id := old.id;
  new.created_at := old.created_at;
  -- имя на экране = никнейм; меняется только через set_nickname (проверки и лимит 30 дней)
  new.name := old.name; new.nickname := old.nickname; new.nickname_norm := old.nickname_norm; new.nickname_changed_at := old.nickname_changed_at;
  if new.show_seen = false then new.last_seen_at := null; end if;
  return new;
end $$;

-- установка и смена никнейма
create or replace function public.set_nickname(p_nick text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); p record; prob text; nn text; nick text := btrim(coalesce(p_nick, '')); wait int;
begin
  if me is null then raise exception using errcode = 'NR403', message = 'Войдите, чтобы выбрать никнейм'; end if;
  prob := public.nick_problem(nick);
  if prob <> '' then raise exception using errcode = 'NR422', message = prob, hint = 'nickname'; end if;
  nn := public.nick_norm(nick);
  select * into p from public.profiles where id = me for update;
  if p.id is null then raise exception using errcode = 'NR404', message = 'Профиль не найден'; end if;
  if p.nickname is not null and p.nickname_norm <> nn and p.nickname_changed_at > now() - interval '30 days' and not public.is_admin() then
    wait := ceil(extract(epoch from p.nickname_changed_at + interval '30 days' - now()) / 86400);
    raise exception using errcode = 'NR429', message = format('Никнейм можно менять раз в 30 дней. Следующая смена через %s дн.', wait), hint = 'retry_after=' || (wait * 86400);
  end if;
  if exists (select 1 from public.profiles where nickname_norm = nn and id <> me) then
    raise exception using errcode = 'NR409', message = 'Этот никнейм уже занят. Попробуйте другой', hint = 'nickname_taken';
  end if;
  perform set_config('near.system', '1', true);
  -- вместе с никнеймом стираются старые имя/фамилия и пол
  update public.profiles set nickname = nick, nickname_norm = nn, name = nick,
         nickname_changed_at = case when p.nickname_norm is distinct from nn then now() else p.nickname_changed_at end, updated_at = now()
   where id = me;
  begin execute 'update public.profiles set gender = null where id = $1' using me; exception when undefined_column then null; end;
  perform set_config('near.system', '', true);
  if p.nickname is distinct from nick then insert into public.nickname_history (user_id, old_nick, new_nick) values (me, p.nickname, nick); end if;
  return jsonb_build_object('nickname', nick);
exception when unique_violation then
  raise exception using errcode = 'NR409', message = 'Этот никнейм уже занят. Попробуйте другой', hint = 'nickname_taken';
end $$;

-- свободен ли никнейм (для подсказки в форме; окончательно проверяет set_nickname)
create or replace function public.nickname_check(p_nick text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare prob text := public.nick_problem(btrim(coalesce(p_nick, '')));
begin
  if prob <> '' then return jsonb_build_object('ok', false, 'error', prob); end if;
  if exists (select 1 from public.profiles where nickname_norm = public.nick_norm(btrim(p_nick)) and id is distinct from auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'Этот никнейм уже занят');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- регистрация: имя, фамилия и пол из метаданных (в том числе Google) больше не переносятся
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare nick text := btrim(coalesce(new.raw_user_meta_data->>'nickname', ''));
begin
  insert into public.profiles (id, district, name)
  values (new.id, nullif(new.raw_user_meta_data->>'district', ''), 'Новый пользователь')
  on conflict (id) do nothing;
  begin
    update public.profiles set verified = (new.email_confirmed_at is not null or coalesce(new.raw_app_meta_data->>'provider', '') = 'google') where id = new.id;
    if new.raw_user_meta_data->>'accepted_rules' = 'true' then update public.profiles set accepted_rules_at = now() where id = new.id; end if;
    -- никнейм из формы регистрации: если подходит и свободен; иначе приложение попросит выбрать после входа
    if nick <> '' and public.nick_problem(nick) = '' and not exists (select 1 from public.profiles where nickname_norm = public.nick_norm(nick)) then
      update public.profiles set nickname = nick, nickname_norm = public.nick_norm(nick), name = nick, nickname_changed_at = now() where id = new.id;
    end if;
  exception when undefined_column or unique_violation then null;
  end;
  insert into public.profile_private (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create or replace function public.ensure_profile() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  insert into public.profiles (id, name) select u.id, 'Новый пользователь' from auth.users u where u.id = auth.uid() on conflict (id) do nothing;
  insert into public.profile_private (user_id) select auth.uid() where exists (select 1 from public.profiles where id = auth.uid()) on conflict do nothing;
end $$;

-- публиковать и писать можно с никнеймом и согласием с правилами (пол больше не нужен)
create or replace function public.profile_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and exists (select 1 from public.profiles where id = auth.uid() and (nickname is null or accepted_rules_at is null)) then
    raise exception using errcode = 'NR403', message = 'Заполните профиль: никнейм и согласие с правилами', hint = 'profile_incomplete';
  end if;
  return new;
end $$;

-- возрастной допуск: по умолчанию неизвестен; рискованные функции (личные чаты с незнакомыми, встречи) — только "adult"
create or replace function public.age_ok(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not coalesce((select age_gate from public.app_settings where id = 1), true)
      or exists (select 1 from public.profile_private where user_id = u and age_status = 'adult') $$;

create or replace function public.my_account() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'age_status', coalesce(pp.age_status, 'unknown'),
    'age_ok', public.age_ok(auth.uid()),
    'phone_verified', pp.phone_verified_at is not null,
    'nickname_next_change', case when p.nickname_changed_at > now() - interval '30 days' then p.nickname_changed_at + interval '30 days' end,
    'clean_version', (select clean_version from public.app_settings where id = 1),
    'media_ok', (select not media_requires_check or ai_moderation from public.app_settings where id = 1))
  end
  from public.profiles p left join public.profile_private pp on pp.user_id = p.id where p.id = auth.uid() $$;

-- администратор отмечает проверку возраста или телефона (документы NEAR не хранит)
create or replace function public.admin_set_private(p_user uuid, p_age text default null, p_phone boolean default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception using errcode = 'NR403', message = 'Только для администратора'; end if;
  if p_age is not null and p_age not in ('unknown','adult','minor') then raise exception using errcode = 'NR422', message = 'Неверный статус возраста'; end if;
  insert into public.profile_private (user_id) values (p_user) on conflict do nothing;
  update public.profile_private set
    age_status = coalesce(p_age, age_status),
    age_checked_at = case when p_age is not null then now() else age_checked_at end,
    age_checked_by = case when p_age is not null then auth.uid() else age_checked_by end,
    phone_verified_at = case when p_phone is null then phone_verified_at when p_phone then coalesce(phone_verified_at, now()) else null end,
    updated_at = now()
   where user_id = p_user;
  insert into public.mod_actions (moderator_id, target_type, target_id, action, note)
  values (auth.uid(), 'user', p_user, 'set_private', concat_ws(' ', 'age=' || p_age, 'phone=' || p_phone::text));
end $$;
insert into public.profile_private (user_id) select id from public.profiles on conflict do nothing;

-- личная переписка с незнакомым — только при возрастном допуске обеих сторон; новые запросы — в дневном лимите
create or replace function public.get_or_create_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid; b uuid; cid uuid; fr boolean;
begin
  if me is null then raise exception using errcode = 'NR403', message = 'Войдите, чтобы написать'; end if;
  if other is null or other = me then raise exception using errcode = 'NR422', message = 'Нельзя написать самому себе'; end if;
  if not exists (select 1 from public.profiles where id = other) then raise exception using errcode = 'NR404', message = 'Пользователь не найден'; end if;
  if public.is_blocked(me, other) then raise exception using errcode = 'NR403', message = 'Пользователь недоступен'; end if;
  if public.is_banned() then raise exception using errcode = 'NR403', message = 'Аккаунт заблокирован модератором'; end if;
  a := least(me, other); b := greatest(me, other);
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is null then
    fr := public.are_friends(me, other);
    if not fr and not (public.age_ok(me) and public.age_ok(other)) then
      raise exception using errcode = 'NR403', message = 'Личные сообщения незнакомым пока недоступны. Добавьте человека в друзья — после принятия заявки можно писать', hint = 'age_gate';
    end if;
    if not fr then perform public.rate_take('chat_request', null); end if;
    insert into public.conversations (user_a, user_b, status, initiator)
    values (a, b, case when fr then 'accepted' else 'request' end, me)
    returning id into cid;
  end if;
  return cid;
end $$;

-- =====================================================
--  08 / Anti-Spam: дневные лимиты (атомарные счетчики), 429 + retry_after, повторы без двойного списания, дубликаты
-- =====================================================
-- лимиты на сутки (по времени Алматы): [новый аккаунт, телефон подтвержден]; часовые лимиты v11 (rate) остаются как burst
alter table public.app_settings add column if not exists day_limits jsonb not null default '{
  "post":         [3, 15],
  "comment":      [20, 100],
  "chat_request": [3, 10],
  "meeting":      [0, 3]
}'::jsonb;

create table if not exists public.rate_counters (
  user_id  uuid not null,
  action   text not null,
  day      date not null,
  n        int  not null default 0,
  primary key (user_id, action, day)
);
alter table public.rate_counters enable row level security;
create table if not exists public.rate_idem (
  user_id    uuid not null,
  action     text not null,
  key        text not null check (char_length(key) between 8 and 64),
  created_at timestamptz not null default now(),
  primary key (user_id, action, key)
);
alter table public.rate_idem enable row level security;

create or replace function public.ru_plural(n int, a text, b text, c text) returns text language sql immutable as $$
  select n || ' ' || case when n % 10 = 1 and n % 100 <> 11 then a when n % 10 between 2 and 4 and (n % 100 < 10 or n % 100 >= 20) then b else c end $$;

-- списать одно действие из дневного лимита. Ключ идемпотентности: повтор того же запроса не списывает дважды.
-- Атомарно: insert ... on conflict do update ... where n < лимит — параллельные запросы не проходят сверх лимита.
create or replace function public.rate_take(p_action text, p_key text default null) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); l jsonb; lim int; d date := (now() at time zone 'Asia/Almaty')::date; got int; secs int; ok boolean;
begin
  if uid is null or public.is_mod() then return; end if;
  select day_limits->p_action into l from public.app_settings where id = 1;
  if l is null then return; end if;
  lim := (l->>(case when exists (select 1 from public.profile_private where user_id = uid and phone_verified_at is not null) then 1 else 0 end))::int;
  if p_key is not null then
    insert into public.rate_idem (user_id, action, key) values (uid, p_action, left(p_key, 64)) on conflict do nothing returning true into ok;
    if ok is null then return; end if; -- уже списано этим ключом
  end if;
  insert into public.rate_counters as rc (user_id, action, day, n) values (uid, p_action, d, 1)
  on conflict (user_id, action, day) do update set n = rc.n + 1 where rc.n < lim
  returning n into got;
  if got is null or got > lim then
    secs := greatest(60, ceil(extract(epoch from ((d + 1)::timestamp at time zone 'Asia/Almaty') - now())));
    raise exception using errcode = 'NR429',
      message = format('Лимит на сегодня исчерпан: %s. Снова можно через %s',
        case p_action when 'post' then public.ru_plural(lim, 'публикация', 'публикации', 'публикаций')
          when 'comment' then public.ru_plural(lim, 'комментарий', 'комментария', 'комментариев')
          when 'chat_request' then public.ru_plural(lim, 'новый запрос в чат', 'новых запроса в чат', 'новых запросов в чат')
          when 'meeting' then public.ru_plural(lim, 'встреча', 'встречи', 'встреч') else public.ru_plural(lim, 'действие', 'действия', 'действий') end,
        case when secs >= 3600 then (secs / 3600) || ' ч ' || ((secs % 3600) / 60) || ' мин' else ceil(secs / 60.0) || ' мин' end),
      hint = 'retry_after=' || secs || ';action=' || p_action;
  end if;
end $$;

-- ключ текста для поиска дублей: регистр, пробелы и знаки не важны
create or replace function public.text_key(t text) returns text language sql immutable as $$
  select md5(regexp_replace(lower(translate(coalesce(t, ''), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеежзийклмнопрстуфхцчшщъыьэюя')), '[^a-zа-яәғқңөұүһі0-9]+', '', 'g')) $$;

alter table public.comments add column if not exists client_key text;
create unique index if not exists comments_client_key_uidx on public.comments (user_id, client_key) where client_key is not null;

create or replace function public.rate_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'posts' then
    perform public.rate('post'); perform public.rate('post_day');
    if new.is_sos then perform public.rate('sos');
    else
      -- одинаковый текст от одного автора за сутки — повтор, а не новая публикация
      if auth.uid() is not null and char_length(coalesce(new.text, '')) >= 10 and exists (
           select 1 from public.posts where user_id = new.user_id and created_at > now() - interval '24 hours'
              and status in ('draft','active','closed','hidden') and client_key is distinct from new.client_key
              and public.text_key(text) = public.text_key(new.text)) then
        raise exception using errcode = 'NR409', message = 'Вы уже публиковали такой же текст сегодня', hint = 'duplicate';
      end if;
      perform public.rate_take('post', new.client_key);
    end if;
  elsif tg_table_name = 'comments' then
    perform public.rate('comment');
    if auth.uid() is not null and char_length(coalesce(new.text, '')) >= 10 and exists (
         select 1 from public.comments where user_id = new.user_id and created_at > now() - interval '10 minutes' and public.text_key(text) = public.text_key(new.text)) then
      raise exception using errcode = 'NR409', message = 'Такой же комментарий вы уже отправляли. Напишите по-другому', hint = 'duplicate';
    end if;
    perform public.rate_take('comment', new.client_key);
  elsif tg_table_name = 'messages' then perform public.rate('message');
  elsif tg_table_name = 'reports' then perform public.rate('report');
  elsif tg_table_name = 'friendships' then perform public.rate('friend');
  elsif tg_table_name = 'likes' then perform public.rate('like');
  end if;
  return new;
end $$;

-- медиа в переписке: те же условия, что в публикациях (фото и видео — только при включенной проверке)
create or replace function public.message_media_gate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('image','video') and auth.uid() is not null and not public.is_mod()
     and (select media_requires_check and not ai_moderation from public.app_settings where id = 1) then
    raise exception using errcode = 'NR503', message = 'Фото и видео временно недоступны: на сервере не включена проверка файлов', hint = 'media_check_off';
  end if;
  return new;
end $$;
drop trigger if exists messages_media_gate on public.messages;
create trigger messages_media_gate before insert on public.messages for each row execute function public.message_media_gate();

-- уборка: старые счетчики и ключи
create or replace function public.near_cleanup() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int;
begin
  delete from public.rate_events where created_at < now() - interval '2 days';
  delete from public.rate_counters where day < (now() at time zone 'Asia/Almaty')::date - 2;
  delete from public.rate_idem where created_at < now() - interval '3 days';
  delete from public.client_errors where created_at < now() - interval '30 days'; get diagnostics a = row_count;
  delete from public.analytics_events where created_at < now() - interval '180 days'; get diagnostics b = row_count;
  delete from public.push_log where created_at < now() - interval '90 days';
  select count(*) into c from public.posts where status = 'draft' and created_at < now() - interval '24 hours';
  select count(*) into d from public.conversations where orphaned_at < now() - interval '30 days';
  perform public.call_fn('moderate', jsonb_build_object('kind', 'cleanup'));
  return jsonb_build_object('errors_removed', a, 'events_removed', b, 'stale_drafts', c, 'orphaned_conversations', d);
end $$;

-- =====================================================
--  Права v14: новые функции и таблицы (общий revoke v12 остается в силе)
-- =====================================================
revoke all on public.profile_private, public.nickname_history, public.rate_counters, public.rate_idem from anon, authenticated;
grant select on public.nickname_history to authenticated; -- RLS: только модераторы
-- профиль: пользователь меняет только эти поля; имя/никнейм — через set_nickname, роли и пол — никогда
revoke update on public.profiles from authenticated;
grant update (avatar_url, district, instagram, bio, show_seen, accepted_rules_at, updated_at) on public.profiles to authenticated;
revoke execute on function public.feed_sorted(double precision, double precision, int, text[], text, text, boolean, timestamptz, double precision, uuid, int, int, double precision, timestamptz) from public;
grant execute on function public.feed_sorted(double precision, double precision, int, text[], text, text, boolean, timestamptz, double precision, uuid, int, int, double precision, timestamptz),
  public.nickname_check(text), public.age_ok(uuid)
  to anon, authenticated;
grant execute on function public.set_nickname(text), public.my_account(), public.admin_set_private(uuid, text, boolean) to authenticated;
-- чистые функции NEAR Clean: можно вызывать для предпросмотра
grant execute on function public.near_clean(text), public.near_has_bad(text), public.near_is_threat(text), public.near_clean_x(text),
  public.nc_bad_token(text), public.nc_translit(text), public.nc_is_w(int), public.nc_is_sep(int), public.nc_is_zw(int), public.nc_is_mark(int),
  public.nick_norm(text), public.nick_problem(text), public.text_key(text), public.ru_plural(int, text, text, text)
  to anon, authenticated;
-- служебные — только сервер
revoke execute on function public.rate_take(text, text), public.media_gate(), public.message_media_gate(), public.mask_bio_trigger(),
  public.handle_new_user(), public.protect_profile(), public.profile_guard()
  from public, anon, authenticated;

-- Готово ✅ v14 (этап 1)
