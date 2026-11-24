-- =====================================================
--  Миграция v11. Запускается после основной схемы (schema.sql уже включает этот блок).
-- =====================================================
--  NEAR v11 — миграция: безопасность, PostGIS, лимиты,
--  модерация, запросы на общение, SOS, события, аналитика.
--  Скрипт идемпотентный: повторный запуск ничего не ломает.
--  Коды ошибок для приложения (SQLSTATE):
--    NR403 — нет прав, NR404 — не найдено, NR409 — конфликт/повтор,
--    NR422 — неверные данные, NR429 — слишком часто.
-- =====================================================

create extension if not exists postgis with schema extensions;

-- ---------- роли: модератор отдельно от администратора ----------
alter table public.profiles add column if not exists is_moderator boolean not null default false;

create or replace function public.is_mod() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or is_moderator from public.profiles where id = auth.uid()), false) $$;

-- ---------- SEC-01: профиль создает только сервер ----------
drop policy if exists "profiles insert" on public.profiles;
drop policy if exists "profiles update" on public.profiles;
create policy "profiles update" on public.profiles for update
  using (auth.uid() = id or public.is_admin()) with check (auth.uid() = id or public.is_admin());

create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() пустой у сервера (регистрация, SQL Editor, сервисные функции)
  if auth.uid() is null or public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    new.is_admin := false; new.is_moderator := false; new.banned := false; new.verified := false;
    return new;
  end if;
  new.is_admin := old.is_admin;
  new.is_moderator := old.is_moderator;
  new.banned := old.banned;
  new.verified := old.verified;
  new.id := old.id;
  new.created_at := old.created_at;
  if new.show_seen = false then new.last_seen_at := null; end if;
  if old.gender is not null then new.gender := old.gender; end if;
  return new;
end $$;
drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before insert or update on public.profiles
  for each row execute function public.protect_profile();

-- если профиль почему-то не создался при регистрации — создаем его на сервере
create or replace function public.ensure_profile() returns void
language plpgsql security definer set search_path = public as $$
declare u record;
begin
  if auth.uid() is null then return; end if;
  if exists (select 1 from public.profiles where id = auth.uid()) then return; end if;
  select id, email, raw_user_meta_data m into u from auth.users where id = auth.uid();
  if u.id is null then return; end if;
  insert into public.profiles (id, name, district)
  values (u.id, left(coalesce(nullif(u.m->>'name', ''), nullif(u.m->>'full_name', ''), split_part(u.email, '@', 1), 'Пользователь'), 60),
          nullif(u.m->>'district', ''))
  on conflict (id) do nothing;
end $$;

-- ---------- публикации: новые поля ----------
alter table public.posts add column if not exists is_sos boolean not null default false;
alter table public.posts add column if not exists exact boolean not null default false;
alter table public.posts add column if not exists client_key text;
alter table public.posts add column if not exists expires_at timestamptz;
alter table public.posts add column if not exists resolved_at timestamptz;
alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check check (status in ('draft','active','closed','deleted','hidden'));
alter table public.posts drop constraint if exists posts_client_key_len;
alter table public.posts add constraint posts_client_key_len check (client_key is null or char_length(client_key) between 8 and 64);
create unique index if not exists posts_client_key_uidx on public.posts (user_id, client_key) where client_key is not null;
create index if not exists posts_created_id_idx on public.posts (created_at desc, id desc);
-- старые SOS (до v11 определялись по тексту) получают явный признак
update public.posts set is_sos = true where not is_sos and category = 'incident' and text like 'SOS%';

-- PostGIS: точка публикации для геозапросов
alter table public.posts add column if not exists geog extensions.geography(Point, 4326)
  generated always as (extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography) stored;
create index if not exists posts_geog_gix on public.posts using gist (geog);

-- кто может видеть публикацию (и все, что к ней относится)
create or replace function public.can_see_post(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.posts p where p.id = pid
    and (p.status in ('active','closed') or p.user_id = auth.uid() or public.is_mod())) $$;

-- срок актуальности, приблизительное место, SOS
create or replace function public.post_prepare() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.is_sos and new.category <> 'incident' then
      raise exception using errcode = 'NR422', message = 'SOS бывает только у происшествия';
    end if;
    if new.is_sos and auth.uid() is not null and exists (select 1 from public.posts
        where user_id = new.user_id and is_sos and status in ('draft','active')
          and (expires_at is null or expires_at > now())) then
      raise exception using errcode = 'NR409', message = 'У вас уже есть активный SOS. Закройте его, чтобы отправить новый';
    end if;
    if new.expires_at is null then
      new.expires_at := now() + case
        when new.is_sos then interval '3 hours'
        when new.category = 'incident' then interval '24 hours'
        when new.category in ('lost','found') then interval '30 days'
        when new.category in ('deal','ad') then interval '14 days'
        when new.category = 'meetup' then interval '7 days'
        when new.category = 'event' then interval '30 days'
        else interval '90 days' end;
    end if;
  else
    if new.status = 'closed' and old.status <> 'closed' then new.resolved_at := now(); end if;
    if new.status = 'active' and old.status = 'closed' then new.resolved_at := null; end if;
    if auth.uid() is not null and not public.is_mod() and coalesce(current_setting('near.system', true), '') <> '1' then
      new.is_sos := old.is_sos; new.user_id := old.user_id; new.client_key := old.client_key; new.created_at := old.created_at;
      if new.expires_at is distinct from old.expires_at then new.expires_at := old.expires_at; end if;
    end if;
  end if;
  -- место по умолчанию приблизительное: точка привязывается к сетке ~200 м
  if not new.exact then
    new.lat := round((new.lat / 0.002)::numeric) * 0.002;
    new.lng := round((new.lng / 0.0026)::numeric) * 0.0026;
  end if;
  return new;
end $$;
drop trigger if exists posts_prepare on public.posts;
create trigger posts_prepare before insert or update on public.posts for each row execute function public.post_prepare();

-- автор не может сам вернуть скрытую модератором публикацию или скрыть ее "как модератор"
create or replace function public.protect_post() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_mod() or current_setting('near.system', true) = '1' then return new; end if;
  if old.status = 'hidden' and new.status not in ('hidden','deleted') then new.status := 'hidden'; end if;
  if new.status = 'hidden' and old.status <> 'hidden' then new.status := old.status; end if;
  if new.status = 'draft' and old.status <> 'draft' then new.status := old.status; end if;
  return new;
end $$;

-- ---------- SEC-02: скрытое не видно ни через API, ни по связанным таблицам ----------
drop policy if exists "posts read" on public.posts;
drop policy if exists "posts insert" on public.posts;
drop policy if exists "posts update" on public.posts;
drop policy if exists "posts delete" on public.posts;
create policy "posts read"   on public.posts for select using (status in ('active','closed') or auth.uid() = user_id or public.is_mod());
create policy "posts insert" on public.posts for insert with check (auth.uid() = user_id and not public.is_banned() and status in ('draft','active'));
create policy "posts update" on public.posts for update using (auth.uid() = user_id or public.is_mod()) with check (auth.uid() = user_id or public.is_mod());
create policy "posts delete" on public.posts for delete using (auth.uid() = user_id or public.is_admin());

drop policy if exists "media read" on public.post_media;
drop policy if exists "media insert" on public.post_media;
drop policy if exists "media delete" on public.post_media;
create policy "media read" on public.post_media for select using (
  public.can_see_post(post_id) and (mod_status = 'ok' or user_id = auth.uid() or public.is_mod()));
create policy "media insert" on public.post_media for insert with check (
  auth.uid() = user_id and exists (select 1 from public.posts p where p.id = post_id and p.user_id = auth.uid() and p.status in ('draft','active')));
create policy "media delete" on public.post_media for delete using (auth.uid() = user_id or public.is_mod());

alter table public.post_media add column if not exists bucket text not null default 'post-media';

-- не больше 5 вложений, только фото или видео
create or replace function public.media_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.post_media where post_id = new.post_id) >= 5 then
    raise exception using errcode = 'NR422', message = 'Не больше 5 вложений в публикации';
  end if;
  if new.path is not null and new.path !~ ('^' || new.user_id::text || '/') then
    raise exception using errcode = 'NR403', message = 'Файл должен лежать в вашей папке';
  end if;
  new.bucket := 'post-media';
  return new;
end $$;
drop trigger if exists post_media_limit on public.post_media;
create trigger post_media_limit before insert on public.post_media for each row execute function public.media_limit();

drop policy if exists "comments read" on public.comments;
drop policy if exists "comments insert" on public.comments;
create policy "comments read" on public.comments for select using (public.can_see_post(post_id));
create policy "comments insert" on public.comments for insert with check (
  auth.uid() = user_id and not public.is_banned() and exists (select 1 from public.posts p
    where p.id = post_id and p.status = 'active' and not public.is_blocked(auth.uid(), p.user_id)));

drop policy if exists "likes read" on public.likes;
drop policy if exists "likes insert" on public.likes;
create policy "likes read" on public.likes for select using (public.can_see_post(post_id));
create policy "likes insert" on public.likes for insert with check (auth.uid() = user_id and public.can_see_post(post_id) and not public.is_banned());

drop policy if exists "events read" on public.events;
drop policy if exists "members read" on public.event_members;
drop policy if exists "members insert" on public.event_members;
create policy "events read"  on public.events for select using (public.can_see_post(post_id));
create policy "members read" on public.event_members for select using (public.can_see_post(post_id));
create policy "members insert" on public.event_members for insert with check (auth.uid() = user_id and public.can_see_post(post_id) and not public.is_banned());

-- приватный бакет для скрытых модератором файлов (карантин)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-quarantine', 'post-quarantine', false, 52428800,
        array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm','video/x-m4v'])
on conflict (id) do update set public = false;
drop policy if exists "near quarantine read" on storage.objects;
create policy "near quarantine read" on storage.objects for select to authenticated
  using (bucket_id = 'post-quarantine' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_mod()));

-- лимит размера файлов публикаций: 20 МБ (видео на пилоте до 60 секунд)
update storage.buckets set file_size_limit = 20971520 where id = 'post-media';

-- ---------- общий вызов серверных функций из базы ----------
create or replace function public.call_fn(fn text, body jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare cfg record;
begin
  select url, secret into cfg from public.push_config where id = 1;
  if cfg.url is null then return; end if;
  begin
    perform net.http_post(url := regexp_replace(cfg.url, '/[^/]+$', '/' || fn), body := body,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-near-secret', cfg.secret), timeout_milliseconds := 5000);
  exception when others then null;
  end;
end $$;

-- скрыли/вернули/удалили публикацию → файлы переносятся в карантин, обратно или стираются
create or replace function public.on_post_visibility() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and (new.status in ('hidden','deleted') or old.status = 'hidden') then
    perform public.call_fn('moderate', jsonb_build_object('kind', 'quarantine', 'post_id', new.id, 'status', new.status));
  end if;
  return new;
end $$;
drop trigger if exists posts_visibility on public.posts;
create trigger posts_visibility after update of status on public.posts for each row execute function public.on_post_visibility();

-- SOS отменен: уведомляем откликнувшихся (теперь по явному признаку is_sos)
create or replace function public.on_post_closed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'active' and new.status = 'closed' and new.is_sos then
    insert into public.notifications (user_id, actor_id, type, post_id, text)
    select distinct x.uid, new.user_id, 'sos_closed', new.id, 'закрыл(а) SOS: помощь больше не нужна'
      from (select user_id uid from public.comments where post_id = new.id
            union select user_id from public.likes where post_id = new.id) x
     where x.uid <> new.user_id;
  end if;
  return new;
end $$;

-- ---------- POST-02: события — атомарная запись с лимитом мест ----------
create or replace function public.event_capacity() returns trigger
language plpgsql security definer set search_path = public as $$
declare ev record; n int;
begin
  select * into ev from public.events where post_id = new.post_id for update;
  if ev.post_id is null then raise exception using errcode = 'NR404', message = 'Это не событие'; end if;
  if ev.starts_at < now() - interval '3 hours' then raise exception using errcode = 'NR409', message = 'Событие уже прошло'; end if;
  if ev.capacity is not null then
    select count(*) into n from public.event_members where post_id = new.post_id;
    if n >= ev.capacity then raise exception using errcode = 'NR409', message = 'Мест больше нет'; end if;
  end if;
  return new;
end $$;
drop trigger if exists event_members_capacity on public.event_members;
create trigger event_members_capacity before insert on public.event_members for each row execute function public.event_capacity();

-- срок события: через 6 часов после начала
create or replace function public.on_event_set() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('near.system', '1', true);
  update public.posts set expires_at = new.starts_at + interval '6 hours' where id = new.post_id;
  perform set_config('near.system', '', true);
  return new;
end $$;
drop trigger if exists events_set_expiry on public.events;
create trigger events_set_expiry after insert or update of starts_at on public.events for each row execute function public.on_event_set();

-- ---------- FEED-01 / MAP-01: серверная геовыборка ----------
create or replace function public.feed_page(p_lat double precision, p_lng double precision, p_radius int,
  p_cats text[] default null, p_before_ts timestamptz default null, p_before_id uuid default null, p_limit int default 12)
returns setof public.posts language sql stable set search_path = public, extensions as $$
  select p.* from public.posts p
   where p.status in ('active','closed')
     and (p.expires_at is null or p.expires_at > now())
     and extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
                               least(greatest(coalesce(p_radius, 1000), 100), 50000))
     and (p_cats is null or p.category = any (p_cats))
     and (p_before_ts is null or (p.created_at, p.id) < (p_before_ts, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
     and not public.is_blocked(auth.uid(), p.user_id)
   order by p.created_at desc, p.id desc
   limit least(greatest(coalesce(p_limit, 12), 1), 12) $$;

-- новые публикации после известной (для обновления ленты), по возрастанию
create or replace function public.feed_new(p_lat double precision, p_lng double precision, p_radius int,
  p_cats text[], p_after_ts timestamptz, p_after_id uuid, p_limit int default 50)
returns setof public.posts language sql stable set search_path = public, extensions as $$
  select p.* from public.posts p
   where p.status in ('active','closed')
     and (p.expires_at is null or p.expires_at > now())
     and extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
                               least(greatest(coalesce(p_radius, 1000), 100), 50000))
     and (p_cats is null or p.category = any (p_cats))
     and (p.created_at, p.id) > (p_after_ts, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
     and not public.is_blocked(auth.uid(), p.user_id)
   order by p.created_at asc, p.id asc
   limit least(greatest(coalesce(p_limit, 50), 1), 50) $$;

-- карта: те же правила видимости, режим "в радиусе" (центр + радиус) или "на экране" (рамка)
create or replace function public.map_posts(p_w double precision, p_s double precision, p_e double precision, p_n double precision,
  p_cats text[] default null, p_lat double precision default null, p_lng double precision default null, p_radius int default null, p_limit int default 300)
returns setof public.posts language sql stable set search_path = public, extensions as $$
  select p.* from public.posts p
   where p.status in ('active','closed')
     and (p.expires_at is null or p.expires_at > now())
     and case when p_radius is not null and p_lat is not null
           then extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
                                      least(greatest(p_radius, 100), 50000))
           else p.geog operator(extensions.&&) extensions.st_makeenvelope(p_w, p_s, p_e, p_n, 4326)::extensions.geography end
     and (p_cats is null or p.category = any (p_cats))
     and not public.is_blocked(auth.uid(), p.user_id)
   order by p.created_at desc, p.id desc
   limit least(greatest(coalesce(p_limit, 300), 1), 500) $$;

-- сколько публикаций за последний час по категориям (для счетчиков)
create or replace function public.recent_stats(p_lat double precision, p_lng double precision, p_radius int, p_cats text[] default null)
returns table (category text, n bigint) language sql stable set search_path = public, extensions as $$
  select p.category, count(*) from public.posts p
   where p.status = 'active' and p.created_at > now() - interval '1 hour'
     and (p.expires_at is null or p.expires_at > now())
     and extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
                               least(greatest(coalesce(p_radius, 1000), 100), 50000))
     and (p_cats is null or p.category = any (p_cats))
     and not public.is_blocked(auth.uid(), p.user_id)
   group by p.category $$;

-- ---------- SEC-07: лимиты частоты (по аккаунту и по IP с запасом на NAT) ----------
create table if not exists public.rate_events (
  id          bigserial primary key,
  kind        text not null,
  user_id     uuid,
  ip_hash     text,
  created_at  timestamptz not null default now()
);
create index if not exists rate_events_user_idx on public.rate_events (kind, user_id, created_at desc);
create index if not exists rate_events_ip_idx   on public.rate_events (kind, ip_hash, created_at desc);
alter table public.rate_events enable row level security;

create or replace function public.req_ip_hash() returns text
language plpgsql stable as $$
declare ip text;
begin
  begin
    ip := split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1);
  exception when others then ip := '';
  end;
  if ip is null or ip = '' then return null; end if;
  return md5('near-ip:' || trim(ip));
end $$;

create or replace function public.rate_check(p_kind text, p_user_max int, p_ip_max int, p_window interval) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); iph text := public.req_ip_hash(); n int;
begin
  if uid is null and iph is null then return; end if; -- сервер и SQL Editor без лимитов
  if uid is not null then
    select count(*) into n from public.rate_events where kind = p_kind and user_id = uid and created_at > now() - p_window;
    if n >= p_user_max then
      raise exception using errcode = 'NR429', message = 'Слишком часто. Попробуйте немного позже', hint = p_kind;
    end if;
  end if;
  if iph is not null and p_ip_max is not null then
    select count(*) into n from public.rate_events where kind = p_kind and ip_hash = iph and created_at > now() - p_window;
    if n >= p_ip_max then
      raise exception using errcode = 'NR429', message = 'Слишком много действий из этой сети. Попробуйте позже', hint = p_kind;
    end if;
  end if;
  insert into public.rate_events (kind, user_id, ip_hash) values (p_kind, uid, iph);
  if random() < 0.01 then delete from public.rate_events where created_at < now() - interval '2 days'; end if;
end $$;

-- значения лимитов — начальные, уточняются по логам (app_settings.limits)
alter table public.app_settings add column if not exists limits jsonb not null default '{
  "post":     [10, 40, "1 hour"],
  "post_day": [30, 120, "1 day"],
  "sos":      [2, 10, "1 hour"],
  "comment":  [60, 300, "1 hour"],
  "message":  [120, 600, "1 hour"],
  "report":   [20, 60, "1 day"],
  "friend":   [50, 150, "1 day"],
  "like":     [300, 1500, "1 hour"],
  "push_sub": [20, 60, "1 day"],
  "log":      [60, 300, "1 hour"]
}'::jsonb;
alter table public.app_settings add column if not exists report_hide_weight real not null default 3;

create or replace function public.rate(p_kind text) returns void
language plpgsql security definer set search_path = public as $$
declare l jsonb;
begin
  select limits->p_kind into l from public.app_settings where id = 1;
  if l is null then return; end if;
  perform public.rate_check(p_kind, (l->>0)::int, (l->>1)::int, (l->>2)::interval);
end $$;

create or replace function public.rate_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'posts' then
    perform public.rate('post'); perform public.rate('post_day');
    if new.is_sos then perform public.rate('sos'); end if;
  elsif tg_table_name = 'comments' then perform public.rate('comment');
  elsif tg_table_name = 'messages' then perform public.rate('message');
  elsif tg_table_name = 'reports' then perform public.rate('report');
  elsif tg_table_name = 'friendships' then perform public.rate('friend');
  elsif tg_table_name = 'likes' then perform public.rate('like');
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['posts','comments','messages','reports','friendships','likes'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_rate', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.rate_trigger()', t || '_rate', t);
  end loop;
end $$;

-- ---------- SEC-04: подписки push только у настоящих push-сервисов ----------
create or replace function public.push_endpoint_ok(p text) returns boolean
language sql immutable as $$
  select p ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/[A-Za-z0-9._~:/?#\[\]@!$&''()*+,;=%-]+$'
     and char_length(p) <= 1024 $$;

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_prefs jsonb, p_lat double precision, p_lng double precision, p_ua text)
returns void language plpgsql security definer set search_path = public as $$
declare ex record;
begin
  if auth.uid() is null then raise exception using errcode = 'NR403', message = 'Войдите, чтобы включить уведомления'; end if;
  if not public.push_endpoint_ok(p_endpoint) then raise exception using errcode = 'NR422', message = 'Этот браузер не поддерживается для уведомлений'; end if;
  if p_p256dh !~ '^[A-Za-z0-9_-]{86,88}={0,2}$' or p_auth !~ '^[A-Za-z0-9_-]{21,24}={0,2}$' then
    raise exception using errcode = 'NR422', message = 'Неверная подписка';
  end if;
  if octet_length(coalesce(p_prefs, '{}'::jsonb)::text) > 2000 then raise exception using errcode = 'NR422', message = 'Слишком большие настройки'; end if;
  perform public.rate('push_sub');
  select * into ex from public.push_subs where endpoint = p_endpoint;
  if ex.id is not null and ex.user_id <> auth.uid() then
    -- подписку другого аккаунта можно забрать только с тем же браузером (те же ключи)
    if ex.p256dh <> p_p256dh or ex.auth <> p_auth then
      raise exception using errcode = 'NR409', message = 'Подписка принадлежит другому аккаунту';
    end if;
    update public.push_subs set user_id = auth.uid(), prefs = coalesce(p_prefs, '{}'::jsonb),
      lat = round(p_lat::numeric, 2), lng = round(p_lng::numeric, 2), ua = left(p_ua, 200), updated_at = now()
     where id = ex.id;
    return;
  end if;
  if ex.id is null and (select count(*) from public.push_subs where user_id = auth.uid()) >= 10 then
    delete from public.push_subs where id = (select id from public.push_subs where user_id = auth.uid() order by updated_at limit 1);
  end if;
  insert into public.push_subs (user_id, endpoint, p256dh, auth, prefs, lat, lng, ua)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, coalesce(p_prefs, '{}'::jsonb), round(p_lat::numeric, 2), round(p_lng::numeric, 2), left(p_ua, 200))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, prefs = excluded.prefs,
    lat = coalesce(excluded.lat, push_subs.lat), lng = coalesce(excluded.lng, push_subs.lng), ua = excluded.ua, updated_at = now()
    where push_subs.user_id = auth.uid();
end $$;

-- push вызывается только для опубликованного (не черновика)
create or replace function public.push_fire() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if tg_table_name = 'posts' then
    if new.category <> 'incident' or new.status <> 'active' then return new; end if;
    if tg_op = 'UPDATE' and old.status <> 'draft' then return new; end if;
    k := 'near';
  elsif tg_table_name = 'messages' then k := 'msg';
  else k := 'notif'; end if;
  if not exists (select 1 from public.push_subs limit 1) then return new; end if;
  perform public.call_fn('push', jsonb_build_object('kind', k, 'id', new.id));
  return new;
end $$;
drop trigger if exists push_on_post on public.posts;
create trigger push_on_post after insert or update of status on public.posts for each row execute function public.push_fire();

create table if not exists public.push_log (
  id         bigserial primary key,
  kind       text not null,
  sent       int not null default 0,
  failed     int not null default 0,
  removed    int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.push_log enable row level security;

-- ---------- SEC-05: удаление аккаунта — задача с состояниями, сообщения у собеседника остаются ----------
create table if not exists public.deletion_jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  status      text not null default 'pending' check (status in ('pending','running','failed','done')),
  attempts    int not null default 0,
  error_code  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists deletion_jobs_active_uidx on public.deletion_jobs (user_id) where status <> 'done';
alter table public.deletion_jobs enable row level security;

alter table public.messages alter column sender_id drop not null;
alter table public.messages drop constraint if exists messages_sender_id_fkey;
alter table public.messages add constraint messages_sender_id_fkey foreign key (sender_id) references public.profiles(id) on delete set null;
alter table public.conversations alter column user_a drop not null;
alter table public.conversations alter column user_b drop not null;
alter table public.conversations drop constraint if exists conversations_user_a_fkey;
alter table public.conversations drop constraint if exists conversations_user_b_fkey;
alter table public.conversations add constraint conversations_user_a_fkey foreign key (user_a) references public.profiles(id) on delete set null;
alter table public.conversations add constraint conversations_user_b_fkey foreign key (user_b) references public.profiles(id) on delete set null;

-- ---------- CHAT-01: запросы на общение ----------
alter table public.conversations add column if not exists status text not null default 'accepted';
alter table public.conversations add column if not exists initiator uuid references public.profiles(id) on delete set null;
alter table public.conversations drop constraint if exists conversations_status_check;
alter table public.conversations add constraint conversations_status_check check (status in ('request','accepted','declined'));

create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships where status = 'accepted'
    and ((requester_id = a and addressee_id = b) or (requester_id = b and addressee_id = a))) $$;

create or replace function public.get_or_create_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid; b uuid; cid uuid;
begin
  if me is null then raise exception using errcode = 'NR403', message = 'Войдите, чтобы написать'; end if;
  if other is null or other = me then raise exception using errcode = 'NR422', message = 'Нельзя написать самому себе'; end if;
  if not exists (select 1 from public.profiles where id = other) then raise exception using errcode = 'NR404', message = 'Пользователь не найден'; end if;
  if public.is_blocked(me, other) then raise exception using errcode = 'NR403', message = 'Пользователь недоступен'; end if;
  if public.is_banned() then raise exception using errcode = 'NR403', message = 'Аккаунт заблокирован модератором'; end if;
  a := least(me, other); b := greatest(me, other);
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is null then
    insert into public.conversations (user_a, user_b, status, initiator)
    values (a, b, case when public.are_friends(me, other) then 'accepted' else 'request' end, me)
    returning id into cid;
  end if;
  return cid;
end $$;

-- принять или отклонить запрос (может только получатель)
create or replace function public.conversation_respond(conv uuid, accept boolean) returns text
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from public.conversations where id = conv;
  if c.id is null or auth.uid() not in (c.user_a, c.user_b) then raise exception using errcode = 'NR404', message = 'Переписка не найдена'; end if;
  if c.initiator = auth.uid() then raise exception using errcode = 'NR403', message = 'Ответить на запрос может только получатель'; end if;
  update public.conversations set status = case when accept then 'accepted' else 'declined' end where id = conv;
  return case when accept then 'accepted' else 'declined' end;
end $$;

-- проверка каждого сообщения на сервере: участник, блокировки, правила запроса
create or replace function public.message_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record; n int;
begin
  if auth.uid() is null then return new; end if;
  select * into c from public.conversations where id = new.conversation_id for update;
  if c.id is null or auth.uid() not in (c.user_a, c.user_b) then raise exception using errcode = 'NR403', message = 'Нет доступа к переписке'; end if;
  if c.user_a is null or c.user_b is null then raise exception using errcode = 'NR403', message = 'Собеседник удалил аккаунт'; end if;
  if public.is_blocked(c.user_a, c.user_b) then raise exception using errcode = 'NR403', message = 'Пользователь недоступен'; end if;
  if c.status = 'accepted' then return new; end if;
  if auth.uid() = c.initiator then
    if c.status = 'declined' then raise exception using errcode = 'NR403', message = 'Собеседник отклонил запрос'; end if;
    select count(*) into n from public.messages where conversation_id = c.id and sender_id = auth.uid();
    if n >= 1 then raise exception using errcode = 'NR403', message = 'Дождитесь, пока собеседник примет запрос'; end if;
    if new.kind <> 'text' or new.text ~* '(https?://|www\.|t\.me/|wa\.me/|[a-z0-9-]+\.(com|ru|kz|net|org|me|io)\b)' then
      raise exception using errcode = 'NR422', message = 'До принятия запроса нельзя отправлять файлы и ссылки';
    end if;
  else
    -- получатель ответил — запрос принят
    update public.conversations set status = 'accepted' where id = c.id;
  end if;
  return new;
end $$;
drop trigger if exists messages_guard on public.messages;
create trigger messages_guard before insert on public.messages for each row execute function public.message_guard();

-- стали друзьями — запрос принимается автоматически
create or replace function public.on_friend_accept_conv() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'accepted' then
    update public.conversations set status = 'accepted'
     where user_a = least(new.requester_id, new.addressee_id) and user_b = greatest(new.requester_id, new.addressee_id) and status <> 'accepted';
  end if;
  return new;
end $$;
drop trigger if exists friendships_conv on public.friendships;
create trigger friendships_conv after insert or update on public.friendships for each row execute function public.on_friend_accept_conv();

drop policy if exists "msg read" on public.messages;
drop policy if exists "msg insert" on public.messages;
create policy "msg read" on public.messages for select using (public.is_participant(conversation_id));
create policy "msg insert" on public.messages for insert with check (
  auth.uid() = sender_id and public.is_participant(conversation_id) and not public.is_banned());

-- файлы переписки: только участники, без блокировки, и не до принятия запроса
create or replace function public.chat_file_allowed(obj_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversations c
                  where c.id::text = (storage.foldername(obj_name))[2]
                    and auth.uid() in (c.user_a, c.user_b)
                    and c.status = 'accepted'
                    and not public.is_blocked(c.user_a, c.user_b)) $$;

-- ---------- SEC-08: жалобы с учетом доверия, журнал модерации, апелляции ----------
alter table public.reports alter column reporter_id drop not null;
alter table public.reports add column if not exists resolved_by uuid references public.profiles(id) on delete set null;
alter table public.reports add column if not exists resolution text;
alter table public.reports add column if not exists source text not null default 'user';
alter table public.reports drop constraint if exists reports_source_check;
alter table public.reports add constraint reports_source_check check (source in ('user','ai','system'));

create or replace function public.report_weight(rid uuid) returns real
language sql stable security definer set search_path = public as $$
  select case
    when rid is null then 0
    when p.banned then 0
    when (select count(*) from public.reports d where d.reporter_id = rid and d.status = 'dismissed' and d.created_at > now() - interval '30 days') >= 3 then 0
    when p.created_at > now() - interval '3 days' then 0.5
    else 1 end::real
  from public.profiles p where p.id = rid $$;

create or replace function public.on_report() returns trigger
language plpgsql security definer set search_path = public as $$
declare w real; owner uuid; th real;
begin
  if new.target_type = 'post' and new.source = 'user' then
    select coalesce(sum(public.report_weight(reporter_id)), 0) into w from public.reports
     where target_type = 'post' and target_id = new.target_id and status = 'open' and source = 'user';
    select report_hide_weight into th from public.app_settings where id = 1;
    if w >= coalesce(th, 3) then
      perform set_config('near.system', '1', true);
      update public.posts set status = 'hidden' where id = new.target_id and status = 'active' returning user_id into owner;
      if owner is not null then
        insert into public.notifications (user_id, type, post_id, text)
        values (owner, 'post_hidden', new.target_id, 'Ваша публикация скрыта по жалобам и ждет проверки модератора. Можно подать апелляцию');
        insert into public.mod_actions (moderator_id, target_type, target_id, action, note) values (null, 'post', new.target_id, 'auto_hide', 'вес жалоб ' || w);
      end if;
      perform set_config('near.system', '', true);
    end if;
  end if;
  return new;
end $$;

create table if not exists public.mod_actions (
  id            uuid primary key default gen_random_uuid(),
  moderator_id  uuid references public.profiles(id) on delete set null,
  target_type   text not null,
  target_id     uuid not null,
  action        text not null,
  note          text check (note is null or char_length(note) <= 500),
  created_at    timestamptz not null default now()
);
create index if not exists mod_actions_target_idx on public.mod_actions (target_type, target_id, created_at desc);
alter table public.mod_actions enable row level security;
drop policy if exists "mod actions read" on public.mod_actions;
create policy "mod actions read" on public.mod_actions for select using (public.is_mod());

create table if not exists public.appeals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  target_type  text not null check (target_type in ('post','user')),
  target_id    uuid not null,
  text         text not null check (char_length(text) between 5 and 1000),
  status       text not null default 'open' check (status in ('open','accepted','rejected')),
  decided_by   uuid references public.profiles(id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (user_id, target_type, target_id)
);
alter table public.appeals enable row level security;
drop policy if exists "appeals read" on public.appeals;
drop policy if exists "appeals insert" on public.appeals;
create policy "appeals read" on public.appeals for select using (auth.uid() = user_id or public.is_mod());
create policy "appeals insert" on public.appeals for insert with check (
  auth.uid() = user_id and status = 'open' and (
    (target_type = 'user' and target_id = auth.uid())
    or (target_type = 'post' and exists (select 1 from public.posts p where p.id = target_id and p.user_id = auth.uid() and p.status = 'hidden'))));

drop policy if exists "reports read" on public.reports;
drop policy if exists "reports update" on public.reports;
drop policy if exists "reports insert" on public.reports;
create policy "reports insert" on public.reports for insert with check (auth.uid() = reporter_id and source = 'user' and status = 'open');
create policy "reports read" on public.reports for select using (auth.uid() = reporter_id or public.is_mod());

-- все действия модератора — одной функцией, с проверкой роли и журналом
create or replace function public.mod_act(p_kind text, p_id uuid, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); ap record; tgt uuid;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  if p_action in ('ban','unban','make_mod','remove_mod') and not public.is_admin() then
    raise exception using errcode = 'NR403', message = 'Только для администратора';
  end if;
  perform set_config('near.system', '1', true);
  if p_kind = 'post' then
    if p_action not in ('hide','restore','delete') then raise exception using errcode = 'NR422', message = 'Неизвестное действие'; end if;
    update public.posts set status = case p_action when 'hide' then 'hidden' when 'restore' then 'active' else 'deleted' end where id = p_id;
    if not found then raise exception using errcode = 'NR404', message = 'Публикация не найдена'; end if;
    if p_action = 'restore' then update public.post_media set mod_status = 'ok' where post_id = p_id; end if;
  elsif p_kind = 'comment' and p_action = 'delete' then
    delete from public.comments where id = p_id;
  elsif p_kind = 'message' and p_action = 'delete' then
    if not exists (select 1 from public.reports where target_type = 'message' and target_id = p_id) then
      raise exception using errcode = 'NR403', message = 'Личные сообщения доступны модератору только по жалобе';
    end if;
    delete from public.messages where id = p_id;
  elsif p_kind = 'user' and p_action in ('ban','unban','make_mod','remove_mod') then
    update public.profiles set
      banned = case p_action when 'ban' then true when 'unban' then false else banned end,
      is_moderator = case p_action when 'make_mod' then true when 'remove_mod' then false else is_moderator end
     where id = p_id;
  elsif p_kind = 'report' and p_action = 'dismiss' then
    select target_id into tgt from public.reports where id = p_id;
    update public.reports set status = 'dismissed', resolved_at = now(), resolved_by = me, resolution = p_note
     where status = 'open' and (target_type, target_id) = (select target_type, target_id from public.reports where id = p_id);
  elsif p_kind = 'appeal' and p_action in ('accept','reject') then
    select * into ap from public.appeals where id = p_id and status = 'open';
    if ap.id is null then raise exception using errcode = 'NR404', message = 'Апелляция не найдена'; end if;
    update public.appeals set status = case when p_action = 'accept' then 'accepted' else 'rejected' end, decided_by = me, decided_at = now() where id = p_id;
    if p_action = 'accept' and ap.target_type = 'post' then update public.posts set status = 'active' where id = ap.target_id and status = 'hidden'; end if;
    if p_action = 'accept' and ap.target_type = 'user' then update public.profiles set banned = false where id = ap.target_id; end if;
    insert into public.notifications (user_id, type, post_id, text)
    values (ap.user_id, 'appeal', case when ap.target_type = 'post' then ap.target_id end,
            case when p_action = 'accept' then 'Апелляция принята' else 'Апелляция отклонена' end || coalesce(': ' || left(p_note, 120), ''));
  else
    raise exception using errcode = 'NR422', message = 'Неизвестное действие';
  end if;
  -- решение по объекту закрывает открытые жалобы на него
  if p_kind in ('post','comment','message','user') then
    update public.reports set status = 'resolved', resolved_at = now(), resolved_by = me, resolution = p_action || coalesce(': ' || p_note, '')
     where status = 'open' and target_id = p_id and target_type = p_kind;
  end if;
  insert into public.mod_actions (moderator_id, target_type, target_id, action, note)
  values (me, p_kind, coalesce(tgt, p_id), p_action, left(p_note, 500));
  perform set_config('near.system', '', true);
end $$;

-- содержимое жалобы на личное сообщение: модератор видит только его, каждый просмотр в журнале
create or replace function public.mod_report_content(p_report uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; m record;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  select * into r from public.reports where id = p_report;
  if r.id is null then raise exception using errcode = 'NR404', message = 'Жалоба не найдена'; end if;
  if r.target_type <> 'message' then return null; end if;
  select id, kind, text, media_path, sender_id, created_at into m from public.messages where id = r.target_id;
  insert into public.mod_actions (moderator_id, target_type, target_id, action) values (auth.uid(), 'message', r.target_id, 'view');
  return to_jsonb(m);
end $$;

-- история по объекту: жалобы и решения
create or replace function public.mod_history(p_type text, p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_mod() then jsonb_build_object(
    'reports', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'status', status, 'source', source, 'created_at', created_at, 'resolution', resolution) order by created_at desc)
                 from public.reports where target_type = p_type and target_id = p_id), '[]'::jsonb),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('action', a.action, 'note', a.note, 'created_at', a.created_at, 'by', pr.name) order by a.created_at desc)
                 from public.mod_actions a left join public.profiles pr on pr.id = a.moderator_id
                where a.target_type = p_type and a.target_id = p_id), '[]'::jsonb)) end $$;

-- ИИ-проверка: если включена, новое фото и текст ждут ее; при сбое — очередь модератора
create or replace function public.media_pending() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select ai_moderation from public.app_settings where id = 1) then
    if tg_table_name = 'post_media' and new.type = 'image' then new.mod_status := 'pending';
    elsif tg_table_name = 'messages' and new.kind in ('image','text') then new.mod_status := 'pending';
    else new.mod_status := 'ok'; end if;
  else
    new.mod_status := 'ok';
  end if;
  return new;
end $$;

-- ИИ-проверка запускается сервером (не клиентом): новая запись "на проверке" → функция moderate
create or replace function public.ai_fire() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.mod_status = 'pending' then
    perform public.call_fn('moderate', jsonb_build_object('table', tg_table_name, 'id', new.id));
  end if;
  return new;
end $$;
drop trigger if exists post_media_ai on public.post_media;
create trigger post_media_ai after insert on public.post_media for each row execute function public.ai_fire();
drop trigger if exists messages_ai on public.messages;
create trigger messages_ai after insert on public.messages for each row execute function public.ai_fire();

-- ---------- наблюдаемость и аналитика (без токенов, текстов сообщений и точных координат) ----------
create table if not exists public.client_errors (
  id              bigserial primary key,
  kind            text not null,
  message         text,
  stack           text,
  correlation_id  text,
  app_version     text,
  route           text,
  ua              text,
  created_at      timestamptz not null default now()
);
create index if not exists client_errors_created_idx on public.client_errors (created_at desc);
alter table public.client_errors enable row level security;

create or replace function public.log_client_error(p_kind text, p_message text, p_stack text, p_corr text, p_version text, p_route text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.rate('log');
  insert into public.client_errors (kind, message, stack, correlation_id, app_version, route, ua)
  values (left(p_kind, 40), left(regexp_replace(coalesce(p_message, ''), '(eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)', '[скрыто]', 'g'), 500),
          left(p_stack, 2000), left(p_corr, 64), left(p_version, 20), left(regexp_replace(coalesce(p_route, ''), '[?#].*$', ''), 100),
          left(current_setting('request.headers', true)::json->>'user-agent', 200));
exception when others then
  if sqlstate = 'NR429' then return; end if; raise;
end $$;

create table if not exists public.analytics_events (
  id          bigserial primary key,
  name        text not null,
  user_hash   text,
  install_id  text,
  props       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists analytics_events_name_idx on public.analytics_events (name, created_at desc);
create index if not exists analytics_events_user_idx on public.analytics_events (user_hash, created_at);
alter table public.analytics_events enable row level security;

-- псевдонимизированное событие: вместо id пользователя — хэш, свойства только из разрешенного списка
create or replace function public.track(p_name text, p_props jsonb default '{}'::jsonb, p_install text default null) returns void
language plpgsql security definer set search_path = public as $$
declare clean jsonb := '{}'::jsonb; k text;
begin
  if p_name not in ('app_open','signup','activation','feed_loaded','post_created','comment_created','message_sent',
                    'push_opened','report_sent','sos_sent','onboarding_skipped','onboarding_done','error_shown') then return; end if;
  perform public.rate('log');
  foreach k in array array['ms','count','category','radius','page','error','theme','lang','source','ok'] loop
    if p_props ? k then clean := clean || jsonb_build_object(k, left(p_props->>k, 40)); end if;
  end loop;
  insert into public.analytics_events (name, user_hash, install_id, props)
  values (p_name, case when auth.uid() is null then null else md5('near-u:' || auth.uid()::text) end, left(p_install, 40), clean);
exception when others then
  if sqlstate = 'NR429' then return; end if; raise;
end $$;

-- KPI пилота (только администратор)
create or replace function public.kpi_summary(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not public.is_admin() then raise exception using errcode = 'NR403', message = 'Только для администратора'; end if;
  with users as (
    select user_hash, min(created_at) first_at from public.analytics_events where user_hash is not null group by user_hash
  ), cohort as (
    select * from users where first_at > now() - make_interval(days => p_days)
  ), active as (
    select distinct user_hash, created_at::date d from public.analytics_events where user_hash is not null
  )
  select jsonb_build_object(
    'new_users', (select count(*) from cohort),
    'activation', (select round(100.0 * count(distinct e.user_hash) / nullif((select count(*) from cohort), 0), 1)
                     from public.analytics_events e join cohort c using (user_hash) where e.name = 'activation'),
    'd1', (select round(100.0 * count(distinct a.user_hash) / nullif(count(distinct c.user_hash), 0), 1)
             from cohort c left join active a on a.user_hash = c.user_hash and a.d = (c.first_at::date + 1)
            where c.first_at < now() - interval '1 day'),
    'd7', (select round(100.0 * count(distinct a.user_hash) / nullif(count(distinct c.user_hash), 0), 1)
             from cohort c left join active a on a.user_hash = c.user_hash and a.d = (c.first_at::date + 7)
            where c.first_at < now() - interval '7 days'),
    'd30', (select round(100.0 * count(distinct a.user_hash) / nullif(count(distinct c.user_hash), 0), 1)
             from cohort c left join active a on a.user_hash = c.user_hash and a.d = (c.first_at::date + 30)
            where c.first_at < now() - interval '30 days'),
    'dau', (select count(distinct user_hash) from active where d = current_date),
    'mau', (select count(distinct user_hash) from active where d > current_date - 30),
    'posts', (select count(*) from public.posts where created_at > now() - make_interval(days => p_days) and status <> 'draft'),
    'reports_open', (select count(*) from public.reports where status = 'open'),
    'report_median_hours', (select round((percentile_cont(0.5) within group (order by extract(epoch from resolved_at - created_at)) / 3600)::numeric, 1)
                              from public.reports where resolved_at is not null and created_at > now() - make_interval(days => p_days)),
    'time_to_first_reply_min', (select round((percentile_cont(0.5) within group (order by extract(epoch from r.created_at - f.created_at)) / 60)::numeric, 1)
       from (select conversation_id, min(created_at) created_at, (array_agg(sender_id order by created_at))[1] first_sender
               from public.messages where created_at > now() - make_interval(days => p_days) group by conversation_id) f
       join lateral (select min(created_at) created_at from public.messages m
                      where m.conversation_id = f.conversation_id and m.sender_id is distinct from f.first_sender) r on r.created_at is not null),
    'push_sent', (select coalesce(sum(sent), 0) from public.push_log where created_at > now() - make_interval(days => p_days)),
    'push_failed', (select coalesce(sum(failed), 0) from public.push_log where created_at > now() - make_interval(days => p_days)),
    'push_opened', (select count(*) from public.analytics_events where name = 'push_opened' and created_at > now() - make_interval(days => p_days)),
    'errors_24h', (select count(*) from public.client_errors where created_at > now() - interval '24 hours'),
    'mod_queue', (select count(*) from public.reports where status = 'open') + (select count(*) from public.appeals where status = 'open'),
    'storage_mb', (select round(coalesce(sum((metadata->>'size')::bigint), 0) / 1048576.0, 1) from storage.objects where bucket_id in ('post-media','chat-media','post-quarantine'))
  ) into res;
  return res;
end $$;

-- уборка старых служебных данных (вызывать раз в день через pg_cron, см. SETUP.md)
create or replace function public.near_cleanup() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a int; b int; c int;
begin
  delete from public.rate_events where created_at < now() - interval '2 days';
  delete from public.client_errors where created_at < now() - interval '30 days'; get diagnostics a = row_count;
  delete from public.analytics_events where created_at < now() - interval '180 days'; get diagnostics b = row_count;
  delete from public.push_log where created_at < now() - interval '90 days';
  select count(*) into c from public.posts where status = 'draft' and created_at < now() - interval '24 hours';
  -- черновики старше суток стирает функция moderate (файлы + строки)
  perform public.call_fn('moderate', jsonb_build_object('kind', 'cleanup'));
  return jsonb_build_object('errors_removed', a, 'events_removed', b, 'stale_drafts', c);
end $$;

-- ---------- обновления в реальном времени: список переписок ----------
do $$ begin
  begin alter publication supabase_realtime add table public.conversations; exception when others then null; end;
end $$;

-- =====================================================
--  SEC-03: МИНИМАЛЬНЫЕ ПРАВА
--  Гость (anon) — только чтение публичного; вошедший (authenticated) — только нужные таблицы.
--  Все остальное — через функции с проверкой роли и владельца.
-- =====================================================
grant usage on schema public to anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant select on public.posts, public.post_media, public.comments, public.likes, public.events, public.event_members,
                public.profiles, public.app_settings to anon, authenticated;
grant insert, update, delete on public.posts to authenticated;
grant insert, delete on public.post_media, public.comments, public.likes, public.event_members to authenticated;
grant insert, update, delete on public.events to authenticated;
grant update on public.profiles to authenticated;
grant select, insert, delete on public.saved_posts, public.blocks to authenticated;
grant select, insert, update, delete on public.friendships to authenticated;
grant select on public.conversations to authenticated;
grant select, insert, delete on public.messages to authenticated;
grant select, insert on public.reports to authenticated;
grant select, update on public.notifications to authenticated;
grant select, delete on public.push_subs to authenticated;
grant select, insert on public.appeals to authenticated;
grant select on public.mod_actions to authenticated;
grant update (ai_moderation, limits, report_hide_weight) on public.app_settings to authenticated;

-- функции, которые вызываются в правилах RLS, и публичные RPC
grant execute on function public.is_admin(), public.is_mod(), public.is_banned(), public.is_blocked(uuid, uuid),
  public.is_participant(uuid), public.can_see_post(uuid), public.chat_file_allowed(text), public.are_friends(uuid, uuid)
  to anon, authenticated;
grant execute on function public.feed_page(double precision, double precision, int, text[], timestamptz, uuid, int),
  public.feed_new(double precision, double precision, int, text[], timestamptz, uuid, int),
  public.map_posts(double precision, double precision, double precision, double precision, text[], double precision, double precision, int, int),
  public.recent_stats(double precision, double precision, int, text[]),
  public.log_client_error(text, text, text, text, text, text),
  public.track(text, jsonb, text)
  to anon, authenticated;
grant execute on function public.ensure_profile(), public.touch_seen(), public.get_or_create_conversation(uuid),
  public.conversation_respond(uuid, boolean), public.mark_conversation_read(uuid),
  public.push_subscribe(text, text, text, jsonb, double precision, double precision, text), public.push_unsubscribe(text),
  public.mod_act(text, uuid, text, text), public.mod_report_content(uuid), public.mod_history(text, uuid), public.kpi_summary(int)
  to authenticated;
-- безопасные чистые функции, которые вызываются внутри триггеров с правами вызывающего
grant execute on function public.mask_bad(text), public.push_endpoint_ok(text), public.req_ip_hash() to anon, authenticated;
-- служебные функции — только серверу
revoke execute on function public.push_fire(), public.ai_fire(), public.call_fn(text, jsonb), public.near_cleanup(), public.rate_check(text, int, int, interval),
  public.rate(text) from public, anon, authenticated;

-- Готово ✅ v11
