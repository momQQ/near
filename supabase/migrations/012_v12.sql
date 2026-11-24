-- =====================================================
--  Миграция v12. Для базы, где уже стоит v11 (schema.sql уже включает этот блок).
--  Запуск: Supabase → SQL Editor → вставить файл целиком → Run.
--  Скрипт идемпотентный: повторный запуск ничего не ломает.
--
--  Откат (если что-то пошло не так) — по шагам, данные пользователей не трогаются:
--    1) клиент: вернуть на GitHub Pages файлы v11 (app.html, js/, css/, sw.js);
--    2) триггеры v12:  drop trigger if exists posts_verified on public.posts;   (то же comments_verified, messages_verified)
--                      drop trigger if exists posts_profile on public.posts;    (то же comments_profile, messages_profile)
--                      drop trigger if exists conversations_orphan on public.conversations;
--                      drop trigger if exists post_media_check on public.post_media;
--    3) новые таблицы saved_places и feedback можно оставить — v11 их не использует;
--    4) post_prepare и track из 011_v11.sql — запустить 011 повторно (он тоже идемпотентный).
--  Перед миграцией сделайте резервную копию (SETUP.md, шаг 16).
-- =====================================================


-- =====================================================
--  NEAR v12 — миграция: атомарный SOS, подтвержденный email,
--  хранение переписки удаленного аккаунта 30 дней, сортировка ленты,
--  фильтры карты, избранные места, обратная связь, события аналитики.
--  Скрипт идемпотентный. Коды ошибок те же: NR403/NR404/NR409/NR422/NR429.
-- =====================================================

-- ---------- SOS-01: срок назначает только сервер; второй активный SOS невозможен даже при параллельной отправке ----------
create or replace function public.post_ttl(cat text, sos boolean) returns interval
language sql immutable as $$
  select case when sos then interval '3 hours'
    when cat = 'incident' then interval '24 hours'
    when cat in ('lost','found') then interval '30 days'
    when cat in ('deal','ad') then interval '14 days'
    when cat = 'meetup' then interval '7 days'
    when cat = 'event' then interval '30 days'
    else interval '90 days' end $$;

create or replace function public.post_prepare() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.is_sos and new.category <> 'incident' then
      raise exception using errcode = 'NR422', message = 'SOS бывает только у происшествия';
    end if;
    if new.is_sos then
      -- одна блокировка на автора: параллельные запросы выстраиваются в очередь и видят уже созданный SOS
      perform pg_advisory_xact_lock(hashtextextended('near-sos:' || new.user_id::text, 0));
      if exists (select 1 from public.posts where user_id = new.user_id and is_sos and status in ('draft','active')
                  and (expires_at is null or expires_at > now())) then
        raise exception using errcode = 'NR409', message = 'У вас уже есть активный SOS. Закройте его, чтобы отправить новый';
      end if;
    end if;
    -- срок актуальности всегда считает сервер (значение от приложения игнорируется)
    if auth.uid() is not null or new.expires_at is null or new.is_sos then
      new.expires_at := now() + public.post_ttl(new.category, new.is_sos);
    end if;
  else
    if new.status = 'closed' and old.status <> 'closed' then new.resolved_at := now(); end if;
    if new.status = 'active' and old.status = 'closed' then
      -- закрытый SOS повторно не открывается
      if old.is_sos then new.status := 'closed'; else new.resolved_at := null; end if;
    end if;
    if auth.uid() is not null and not public.is_mod() and coalesce(current_setting('near.system', true), '') <> '1' then
      new.is_sos := old.is_sos; new.user_id := old.user_id; new.client_key := old.client_key; new.created_at := old.created_at;
      new.expires_at := old.expires_at; new.exact := old.exact;
      if old.status <> 'draft' then new.lat := old.lat; new.lng := old.lng; end if;
    end if;
  end if;
  -- место по умолчанию приблизительное: точка привязывается к сетке ~200 м, исходные координаты не сохраняются
  if not new.exact then
    new.lat := round((new.lat / 0.002)::numeric) * 0.002;
    new.lng := round((new.lng / 0.0026)::numeric) * 0.0026;
  end if;
  return new;
end $$;

-- ---------- UX-01: публикации, комментарии и сообщения — только с подтвержденным email ----------
create or replace function public.is_verified() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users u where u.id = auth.uid()
    and (u.email_confirmed_at is not null or coalesce(u.raw_app_meta_data->>'provider', 'email') <> 'email')) $$;

create or replace function public.verified_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_verified() then
    raise exception using errcode = 'NR403', message = 'Подтвердите email: откройте письмо от NEAR и нажмите ссылку', hint = 'email_unconfirmed';
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['posts','comments','messages'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_verified', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.verified_guard()', t || '_verified', t);
  end loop;
end $$;

-- пол обязателен (решение владельца продукта): после регистрации без пола приложение просит дозаполнить профиль;
-- публикации и сообщения недоступны, пока пол не указан
create or replace function public.profile_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and exists (select 1 from public.profiles where id = auth.uid() and (gender is null or accepted_rules_at is null)) then
    raise exception using errcode = 'NR403', message = 'Заполните профиль: пол и согласие с правилами', hint = 'profile_incomplete';
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['posts','comments','messages'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_profile', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.profile_guard()', t || '_profile', t);
  end loop;
end $$;

-- ---------- PRIV-01: переписка удаленного аккаунта хранится у собеседника 30 дней ----------
alter table public.conversations add column if not exists orphaned_at timestamptz;
create or replace function public.conv_orphan() returns trigger
language plpgsql as $$
begin
  if (new.user_a is null or new.user_b is null) and new.orphaned_at is null then new.orphaned_at := now(); end if;
  return new;
end $$;
drop trigger if exists conversations_orphan on public.conversations;
create trigger conversations_orphan before update on public.conversations for each row execute function public.conv_orphan();
update public.conversations set orphaned_at = now() where (user_a is null or user_b is null) and orphaned_at is null;

-- ---------- избранные места: приватные, уведомления только по согласию ----------
create table if not exists public.saved_places (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  radius      int not null default 1000 check (radius between 300 and 5000),
  notify      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists saved_places_user_idx on public.saved_places (user_id);
alter table public.saved_places enable row level security;
drop policy if exists "places own" on public.saved_places;
create policy "places own" on public.saved_places for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create or replace function public.places_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and (select count(*) from public.saved_places where user_id = new.user_id) >= 5 then
    raise exception using errcode = 'NR422', message = 'Не больше 5 избранных мест';
  end if;
  -- точку храним с точностью ~100 м: этого достаточно для "что рядом"
  new.lat := round(new.lat::numeric, 3); new.lng := round(new.lng::numeric, 3);
  return new;
end $$;
drop trigger if exists saved_places_guard on public.saved_places;
create trigger saved_places_guard before insert or update on public.saved_places for each row execute function public.places_guard();

-- ---------- UX-02: лента — "Новое", "Рядом", "Для вас"; фильтры "Друзья" и период ----------
create or replace function public.feed_sorted(p_lat double precision, p_lng double precision, p_radius int,
  p_cats text[] default null, p_sort text default 'new', p_period text default null, p_friends boolean default false,
  p_after_ts timestamptz default null, p_after_dist double precision default null, p_after_id uuid default null,
  p_offset int default 0, p_limit int default 12)
returns table (post_id uuid, sort_ts timestamptz, sort_dist double precision, sort_score double precision)
language sql stable set search_path = public, extensions as $$
  with me as (select extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography g),
  base as (
    select p.id, p.created_at, p.category, p.is_sos, p.expires_at,
           extensions.st_distance(p.geog, me.g) dist,
           (select count(*) from public.comments c where c.post_id = p.id) nc,
           (select count(*) from public.likes l where l.post_id = p.id) nl
      from public.posts p, me
     where p.status in ('active','closed')
       and (p.expires_at is null or p.expires_at > now())
       and extensions.st_dwithin(p.geog, me.g, least(greatest(coalesce(p_radius, 1000), 100), 50000))
       and (p_cats is null or p.category = any (p_cats))
       and (p_period is null or (p_period = 'today' and p.created_at > date_trunc('day', now() at time zone 'Asia/Almaty') at time zone 'Asia/Almaty')
                             or (p_period = 'week' and p.created_at > now() - interval '7 days'))
       and (not coalesce(p_friends, false) or public.are_friends(auth.uid(), p.user_id))
       and not public.is_blocked(auth.uid(), p.user_id)
  ), scored as (
    select b.*,
      -- срочное (SOS и свежие происшествия) всегда наверху; дальше — свежесть, близость и полезность (ответы)
      (case when b.is_sos or (b.category = 'incident' and b.created_at > now() - interval '3 hours') then 1000 else 0 end)
      + 100 * exp(-extract(epoch from now() - b.created_at) / 86400.0)
      + 40 * exp(-b.dist / 1500.0)
      + 8 * ln(1 + b.nc) + 3 * ln(1 + b.nl) score
    from base b
  )
  select id, created_at, dist, score from scored s
   where case coalesce(p_sort, 'new')
           when 'near' then p_after_dist is null or (s.dist, s.id) > (p_after_dist, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
           when 'new' then p_after_ts is null or (s.created_at, s.id) < (p_after_ts, coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
           else true end
   order by case when p_sort = 'near' then s.dist end asc,
            case when p_sort = 'top' then s.score end desc,
            s.created_at desc, s.id desc
   offset case when p_sort = 'top' then greatest(coalesce(p_offset, 0), 0) else 0 end
   limit least(greatest(coalesce(p_limit, 12), 1), 12) $$;

-- карта: те же правила + период и "друзья"
create or replace function public.map_posts2(p_w double precision, p_s double precision, p_e double precision, p_n double precision,
  p_cats text[] default null, p_lat double precision default null, p_lng double precision default null, p_radius int default null,
  p_period text default null, p_friends boolean default false, p_limit int default 300)
returns setof public.posts language sql stable set search_path = public, extensions as $$
  select p.* from public.map_posts(p_w, p_s, p_e, p_n, p_cats, p_lat, p_lng, p_radius, 500) p
   where (p_period is null or (p_period = 'today' and p.created_at > date_trunc('day', now() at time zone 'Asia/Almaty') at time zone 'Asia/Almaty')
                         or (p_period = 'week' and p.created_at > now() - interval '7 days'))
     and (not coalesce(p_friends, false) or public.are_friends(auth.uid(), p.user_id))
   limit least(greatest(coalesce(p_limit, 300), 1), 500) $$;

-- ---------- поддержка: сообщение об ошибке из приложения ----------
create table if not exists public.feedback (
  id          bigserial primary key,
  user_id     uuid references public.profiles(id) on delete set null,
  text        text not null check (char_length(text) between 3 and 1000),
  route       text,
  app_version text,
  ua          text,
  status      text not null default 'new' check (status in ('new','done')),
  created_at  timestamptz not null default now()
);
alter table public.feedback enable row level security;
drop policy if exists "feedback admin" on public.feedback;
create policy "feedback admin" on public.feedback for select using (public.is_admin());
create or replace function public.send_feedback(p_text text, p_route text, p_version text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.rate('log');
  insert into public.feedback (user_id, text, route, app_version, ua)
  values (auth.uid(), left(trim(p_text), 1000), left(regexp_replace(coalesce(p_route, ''), '[?#].*$', ''), 100), left(p_version, 20),
          left(current_setting('request.headers', true)::json->>'user-agent', 200));
end $$;
create or replace function public.feedback_list() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_admin() then coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'text', f.text, 'route', f.route, 'version', f.app_version,
      'created_at', f.created_at, 'name', pr.name) order by f.created_at desc)
    from (select * from public.feedback where status = 'new' order by created_at desc limit 50) f left join public.profiles pr on pr.id = f.user_id), '[]'::jsonb) end $$;

-- ---------- аналитика: события из ТЗ v12 (без текстов, email, токенов и координат) ----------
create or replace function public.track(p_name text, p_props jsonb default '{}'::jsonb, p_install text default null) returns void
language plpgsql security definer set search_path = public as $$
declare clean jsonb := '{}'::jsonb; k text;
begin
  if p_name not in ('app_open','signup','activation','feed_loaded','post_created','comment_created','message_sent','first_reply',
                    'push_opened','push_opt_in','report_sent','sos_sent','onboarding_skip','onboarding_complete','onboarding_skipped','onboarding_done',
                    'location_permission','filter_changed','chat_request_accepted','error','error_shown') then return; end if;
  perform public.rate('log');
  foreach k in array array['ms','count','category','radius','page','error','theme','lang','source','ok','sort','period','filter','state'] loop
    if p_props ? k then clean := clean || jsonb_build_object(k, left(p_props->>k, 40)); end if;
  end loop;
  insert into public.analytics_events (name, user_hash, install_id, props)
  values (p_name, case when auth.uid() is null then null else md5('near-u:' || auth.uid()::text) end, left(p_install, 40), clean);
exception when others then
  if sqlstate = 'NR429' then return; end if; raise;
end $$;

-- ---------- уборка: + переписки удаленных аккаунтов старше 30 дней (файлы стирает функция moderate) ----------
create or replace function public.near_cleanup() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int;
begin
  delete from public.rate_events where created_at < now() - interval '2 days';
  delete from public.client_errors where created_at < now() - interval '30 days'; get diagnostics a = row_count;
  delete from public.analytics_events where created_at < now() - interval '180 days'; get diagnostics b = row_count;
  delete from public.push_log where created_at < now() - interval '90 days';
  select count(*) into c from public.posts where status = 'draft' and created_at < now() - interval '24 hours';
  select count(*) into d from public.conversations where orphaned_at < now() - interval '30 days';
  perform public.call_fn('moderate', jsonb_build_object('kind', 'cleanup'));
  return jsonb_build_object('errors_removed', a, 'events_removed', b, 'stale_drafts', c, 'orphaned_conversations', d);
end $$;

-- ---------- MEDIA-01: каждый загруженный файл проверяет сервер (сигнатура, размер, GPS в видео) ----------
alter table public.post_media add column if not exists checked_at timestamptz;
create or replace function public.media_check_fire() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.call_fn('moderate', jsonb_build_object('kind', 'media_check', 'id', new.id));
  return new;
end $$;
drop trigger if exists post_media_check on public.post_media;
create trigger post_media_check after insert on public.post_media for each row execute function public.media_check_fire();

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
grant select, insert, update, delete on public.saved_places to authenticated;
grant select on public.feedback to authenticated;
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
  public.track(text, jsonb, text),
  public.feed_sorted(double precision, double precision, int, text[], text, text, boolean, timestamptz, double precision, uuid, int, int),
  public.map_posts2(double precision, double precision, double precision, double precision, text[], double precision, double precision, int, text, boolean, int),
  public.send_feedback(text, text, text), public.is_verified()
  to anon, authenticated;
grant execute on function public.feedback_list() to authenticated;
grant execute on function public.ensure_profile(), public.touch_seen(), public.get_or_create_conversation(uuid),
  public.conversation_respond(uuid, boolean), public.mark_conversation_read(uuid),
  public.push_subscribe(text, text, text, jsonb, double precision, double precision, text), public.push_unsubscribe(text),
  public.mod_act(text, uuid, text, text), public.mod_report_content(uuid), public.mod_history(text, uuid), public.kpi_summary(int)
  to authenticated;
-- безопасные чистые функции, которые вызываются внутри триггеров с правами вызывающего
grant execute on function public.mask_bad(text), public.push_endpoint_ok(text), public.req_ip_hash() to anon, authenticated;
-- служебные функции — только серверу
revoke execute on function public.push_fire(), public.ai_fire(), public.media_check_fire(), public.verified_guard(), public.profile_guard(), public.call_fn(text, jsonb), public.near_cleanup(), public.rate_check(text, int, int, interval),
  public.rate(text) from public, anon, authenticated;

-- Готово ✅ v12
