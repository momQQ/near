-- =====================================================
--  Миграция v14.2 (ТЗ v14.6, этап 1.2 / Stability). Для базы, где уже стоит 014_v14.sql.
--  Запуск: Supabase → SQL Editor → вставить файл целиком → Run. Идемпотентный.
--  Что внутри:
--   38/59 — аккаунт: состояния, разрешенные действия, лимиты в my_account; Instagram скрыт по умолчанию; интересы;
--   45/60/09 — дружба не снимает возрастной запрет; угрозы, интим, скам, сокращенные ссылки блокируются;
--              санкции по функциям и сроку; MFA (aal2) для модераторов и администратора;
--   06/58/60 — новые файлы публикаций только в приватный бакет post-private, выдача одобренных — по подписанным ссылкам;
--              прямая загрузка в публичный post-media закрыта; аватары — отдельный бакет avatars;
--   40/51/52 — поля форм (meta), категория "Помощь", сроки актуальности, проверка ссылок;
--   55 — NEAR City: официальные карточки редактора с источником и журналом версий;
--   57 — лента одним запросом (feed_v14), счетчики лайков/комментариев в таблице, легкая карта (map_v14).
--  Откат: вернуть клиент v14 (этап 1) и выполнить 014_v14.sql повторно; новые колонки и таблицы можно оставить.
--  Перед миграцией — резервная копия (SETUP.md, шаг 16).
-- =====================================================

-- ---------- 39/45: MFA для модераторов и администратора ----------
alter table public.app_settings add column if not exists mod_require_mfa boolean not null default true;
-- уровень входа из токена Supabase Auth: aal2 = вход с вторым фактором (TOTP)
create or replace function public.mfa_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select not coalesce((select mod_require_mfa from public.app_settings where id = 1), true)
      or coalesce(auth.jwt()->>'aal', '') = 'aal2' $$;
-- роль без второго фактора не дает прав: интерфейс попросит включить защиту
create or replace function public.is_mod() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or is_moderator from public.profiles where id = auth.uid()), false) and public.mfa_ok() $$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false) and public.mfa_ok() $$;
-- роль по профилю без проверки второго фактора — только чтобы интерфейс знал, что нужно включить MFA
create or replace function public.has_mod_role() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or is_moderator from public.profiles where id = auth.uid()), false) $$;

-- ---------- 38: профиль — интересы, Instagram скрыт по умолчанию ----------
alter table public.profiles add column if not exists instagram_public boolean not null default false;
alter table public.profiles add column if not exists interests text[] not null default '{}';
alter table public.profiles drop constraint if exists profiles_interests_chk;
alter table public.profiles add constraint profiles_interests_chk check (cardinality(interests) <= 5
  and interests <@ array['games','cinema','board','sport','cafe','walks','mountains','study','other','pets','music','kids','volunteer']);

-- Instagram виден другим только если владелец включил; через API — только эта функция
create or replace function public.profile_instagram(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when p.id = auth.uid() or p.instagram_public or public.is_mod() then p.instagram end
    from public.profiles p where p.id = p_user and not public.is_blocked(auth.uid(), p_user) $$;

-- ---------- 45/60: санкции — ограничение функции или аккаунта на срок ----------
create table if not exists public.user_sanctions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  scope       text not null check (scope in ('all','post','comment','chat','meet')),
  until       timestamptz,                         -- null = бессрочно (только администратор)
  reason      text not null check (char_length(reason) between 3 and 500),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid references public.profiles(id) on delete set null
);
create index if not exists user_sanctions_user_idx on public.user_sanctions (user_id) where revoked_at is null;
alter table public.user_sanctions enable row level security;
drop policy if exists "sanctions own or mod" on public.user_sanctions;
-- пользователь видит свои решения (без данных заявителя), модератор — все
create policy "sanctions own or mod" on public.user_sanctions for select using (auth.uid() = user_id or public.is_mod());

create or replace function public.active_sanction(u uuid, p_scope text) returns public.user_sanctions
language sql stable security definer set search_path = public as $$
  select * from public.user_sanctions
   where user_id = u and revoked_at is null and (until is null or until > now()) and scope in (p_scope, 'all')
   order by until desc nulls first limit 1 $$;

create or replace function public.sanction_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare s public.user_sanctions; sc text := case tg_table_name when 'posts' then 'post' when 'comments' then 'comment' when 'messages' then 'chat' else 'all' end;
begin
  if auth.uid() is null then return new; end if;
  s := public.active_sanction(auth.uid(), sc);
  if s.id is not null then
    raise exception using errcode = 'NR403', hint = 'restricted',
      message = 'Действие ограничено модератором' || case when s.until is null then '' else ' до ' || to_char(s.until at time zone 'Asia/Almaty', 'DD.MM HH24:MI') end || '. Причина: ' || s.reason;
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['posts','comments','messages'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_sanction', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.sanction_guard()', t || '_sanction', t);
  end loop;
end $$;

-- модератор ограничивает функцию на 1–30 дней; бессрочно — только администратор. Исключение из встречи не strike.
create or replace function public.mod_restrict(p_user uuid, p_scope text, p_days int, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  if p_user = auth.uid() then raise exception using errcode = 'NR422', message = 'Нельзя ограничить себя'; end if;
  if p_scope not in ('all','post','comment','chat','meet') then raise exception using errcode = 'NR422', message = 'Неизвестная функция'; end if;
  if p_days is null and not public.is_admin() then raise exception using errcode = 'NR403', message = 'Бессрочное ограничение — только администратор'; end if;
  if p_days is not null and (p_days < 1 or p_days > 30) then raise exception using errcode = 'NR422', message = 'Срок от 1 до 30 дней'; end if;
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception using errcode = 'NR422', message = 'Укажите причину'; end if;
  insert into public.user_sanctions (user_id, scope, until, reason, created_by)
  values (p_user, p_scope, case when p_days is null then null else now() + make_interval(days => p_days) end, left(trim(p_reason), 500), auth.uid())
  returning id into sid;
  insert into public.mod_actions (moderator_id, target_type, target_id, action, note) values (auth.uid(), 'user', p_user, 'restrict_' || p_scope, coalesce(p_days::text || ' дн.', 'бессрочно') || ': ' || left(p_reason, 400));
  insert into public.notifications (user_id, type, text)
  values (p_user, 'sanction', 'Ограничение: ' || case p_scope when 'all' then 'все действия' when 'post' then 'публикации' when 'comment' then 'комментарии' when 'chat' then 'сообщения' else 'встречи' end
          || coalesce(' на ' || p_days || ' дн.', ' бессрочно') || '. Причина: ' || left(p_reason, 200) || '. Обжаловать можно 14 дней');
  return sid;
end $$;
create or replace function public.mod_unrestrict(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  update public.user_sanctions set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null returning * into s;
  if s.id is null then raise exception using errcode = 'NR404', message = 'Ограничение не найдено'; end if;
  insert into public.mod_actions (moderator_id, target_type, target_id, action, note) values (auth.uid(), 'user', s.user_id, 'unrestrict', left(p_note, 400));
  insert into public.notifications (user_id, type, text) values (s.user_id, 'sanction', 'Ограничение снято' || coalesce(': ' || left(p_note, 200), ''));
end $$;

-- ---------- 45/59: дружба не снимает возрастной запрет на личные чаты ----------
create or replace function public.get_or_create_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid; b uuid; cid uuid; fr boolean;
begin
  if me is null then raise exception using errcode = 'NR403', message = 'Войдите, чтобы написать'; end if;
  if other is null or other = me then raise exception using errcode = 'NR422', message = 'Нельзя написать самому себе'; end if;
  if not exists (select 1 from public.profiles where id = other) then raise exception using errcode = 'NR404', message = 'Пользователь не найден'; end if;
  if public.is_blocked(me, other) then raise exception using errcode = 'NR403', message = 'Пользователь недоступен'; end if;
  if public.is_banned() then raise exception using errcode = 'NR403', message = 'Аккаунт заблокирован модератором'; end if;
  if not (public.age_ok(me) and public.age_ok(other)) then
    raise exception using errcode = 'NR403', message = 'Личные сообщения пока недоступны: возраст не проверен. Общаться можно в комментариях', hint = 'age_gate';
  end if;
  a := least(me, other); b := greatest(me, other);
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is null then
    fr := public.are_friends(me, other);
    if not fr then perform public.rate_take('chat_request', null); end if;
    insert into public.conversations (user_a, user_b, status, initiator)
    values (a, b, case when fr then 'accepted' else 'request' end, me)
    returning id into cid;
  end if;
  return cid;
end $$;
-- каждое сообщение: возрастной допуск обеих сторон (в том числе в старых переписках и между друзьями)
create or replace function public.message_age_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if auth.uid() is null then return new; end if;
  select user_a, user_b into c from public.conversations where id = new.conversation_id;
  if c.user_a is not null and c.user_b is not null and not (public.age_ok(c.user_a) and public.age_ok(c.user_b)) then
    raise exception using errcode = 'NR403', message = 'Личные сообщения пока недоступны: возраст не проверен', hint = 'age_gate';
  end if;
  return new;
end $$;
drop trigger if exists messages_age on public.messages;
create trigger messages_age before insert on public.messages for each row execute function public.message_age_guard();

-- ---------- 38: состояние аккаунта, разрешенные действия и лимиты — с сервера ----------
create or replace function public.limit_status(p_action text) returns jsonb
language sql stable security definer set search_path = public as $$
  with l as (select (day_limits->p_action->>(case when exists (select 1 from public.profile_private where user_id = auth.uid() and phone_verified_at is not null) then 1 else 0 end))::int lim
               from public.app_settings where id = 1),
       d as (select (now() at time zone 'Asia/Almaty')::date d),
       u as (select coalesce((select n from public.rate_counters, d where user_id = auth.uid() and action = p_action and day = d.d), 0) used)
  select jsonb_build_object('used', u.used, 'limit', l.lim,
    'retry_after', case when public.is_mod() or l.lim is null or u.used < l.lim then null
                        else greatest(60, ceil(extract(epoch from ((d.d + 1)::timestamp at time zone 'Asia/Almaty') - now())))::int end)
    from l, d, u $$;

create or replace function public.my_account() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p record; pp record; st text; sa public.user_sanctions; can jsonb;
begin
  if auth.uid() is null then return null; end if;
  select * into p from public.profiles where id = auth.uid();
  if p.id is null then return jsonb_build_object('state', 'deleted'); end if;
  select * into pp from public.profile_private where user_id = auth.uid();
  sa := public.active_sanction(auth.uid(), 'all');
  st := case when p.banned then 'suspended'
             when not public.is_verified() then 'pending_email'
             when p.nickname is null or p.accepted_rules_at is null then 'profile_incomplete'
             when sa.id is not null or exists (select 1 from public.user_sanctions where user_id = auth.uid() and revoked_at is null and (until is null or until > now())) then 'restricted'
             else 'active' end;
  can := jsonb_build_object(
    'post', st in ('active','restricted') and public.active_sanction(auth.uid(), 'post') is null,
    'comment', st in ('active','restricted') and public.active_sanction(auth.uid(), 'comment') is null,
    'chat', st in ('active','restricted') and public.active_sanction(auth.uid(), 'chat') is null and public.age_ok(auth.uid()),
    'meet', st = 'active' and public.age_ok(auth.uid()),
    'report', st <> 'suspended');
  return jsonb_build_object(
    'state', st, 'can', can,
    'age_status', coalesce(pp.age_status, 'unknown'), 'age_ok', public.age_ok(auth.uid()),
    'phone_verified', pp.phone_verified_at is not null,
    'nickname_next_change', case when p.nickname_changed_at > now() - interval '30 days' then p.nickname_changed_at + interval '30 days' end,
    'instagram', p.instagram, 'instagram_public', p.instagram_public, 'accepted_rules', p.accepted_rules_at is not null,
    'mod_role', p.is_admin or p.is_moderator, 'mfa_ok', public.mfa_ok(),
    'sanction', case when sa.id is not null then jsonb_build_object('until', sa.until, 'reason', sa.reason) end,
    'limits', jsonb_build_object('post', public.limit_status('post'), 'comment', public.limit_status('comment'), 'chat_request', public.limit_status('chat_request')),
    'clean_version', (select clean_version from public.app_settings where id = 1),
    'media_ok', true);
end $$;
