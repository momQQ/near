-- =====================================================================
-- NEAR v14.9 — ОТКАТ (rollback) миграции 014_v14_9.sql
-- Мягкий откат: возвращает поведение v12, данные новых таблиц сохраняются
-- (журнал аудита, решения, отзывы, чаты). Повторное применение 014 безопасно.
-- Полный откат = восстановление резервной копии, снятой перед миграцией
-- (см. SETUP.md, шаг 17.9).
-- =====================================================================
begin;

-- 1) выключаем принудительные проверки NEAR Shield
update public.app_settings
   set shield = shield || '{"enforce_sessions":false,"admin_mfa":false,"dm":true,"meetings_pilot_only":false}'::jsonb
 where id = 1;

-- 2) снимаем триггеры v14.9 со старых таблиц
drop trigger if exists posts_clean_text on public.posts;
drop trigger if exists comments_clean_text on public.comments;
drop trigger if exists profiles_clean_name on public.profiles;
drop trigger if exists profiles_clean_bio on public.profiles;
drop trigger if exists profiles_nick on public.profiles;
drop trigger if exists profiles_legacy_ban on public.profiles;
drop trigger if exists posts_meeting_guard on public.posts;
drop trigger if exists posts_publish_guard on public.posts;
drop trigger if exists events_meeting_setup on public.events;
drop trigger if exists members_meeting_guard on public.event_members;
drop trigger if exists messages_dm_off on public.messages;
drop trigger if exists conversations_dm_off on public.conversations;
drop trigger if exists mod_actions_to_audit on public.mod_actions;
drop trigger if exists push_subs_guard on public.push_subs;
drop trigger if exists reports_priority on public.reports;
drop trigger if exists post_media_shield on public.post_media;
drop trigger if exists post_media_state_guard on public.post_media;
drop trigger if exists post_media_enqueue on public.post_media;
drop trigger if exists post_media_after_state on public.post_media;
drop trigger if exists on_auth_password_change on auth.users;

-- 3) уже опубликованные медиа остаются видимыми
update public.post_media set state = 'approved' where state = 'pending_review';

-- 4) возвращаем определения функций v12
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, district, name)
  values (new.id, nullif(new.raw_user_meta_data->>'district', ''), left(coalesce(nullif(new.raw_user_meta_data->>'name', ''), nullif(new.raw_user_meta_data->>'full_name', ''), split_part(new.email, '@', 1)), 60))
  on conflict (id) do nothing;
  -- пол и подтверждение аккаунта (колонки появляются в части 2 схемы)
  begin
    execute 'update public.profiles set gender = $2, verified = $3 where id = $1'
      using new.id,
            case when new.raw_user_meta_data->>'gender' in ('m','f') then new.raw_user_meta_data->>'gender' end,
            (new.email_confirmed_at is not null or coalesce(new.raw_app_meta_data->>'provider', '') = 'google');
  exception when undefined_column then null;
  end;
  -- согласие с правилами сообщества (колонка появляется в части 2 схемы)
  begin
    if new.raw_user_meta_data->>'accepted_rules' = 'true' then
      execute 'update public.profiles set accepted_rules_at = now() where id = $1' using new.id;
    end if;
  exception when undefined_column then null;
  end;
  return new;
end $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;

create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select banned from public.profiles where id = auth.uid()), false) $$;

create or replace function public.is_participant(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversations c where c.id = conv and auth.uid() in (c.user_a, c.user_b)) $$;

create or replace function public.is_mod() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or is_moderator from public.profiles where id = auth.uid()), false) $$;

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

create or replace function public.profile_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and exists (select 1 from public.profiles where id = auth.uid() and (gender is null or accepted_rules_at is null)) then
    raise exception using errcode = 'NR403', message = 'Заполните профиль: пол и согласие с правилами', hint = 'profile_incomplete';
  end if;
  return new;
end $$;

commit;
