-- =====================================================================
--  v14.9 NEAR Shield: единая серверная безопасность
--  (сессии, санкции, риск, репутация, NEAR Clean, встречи, общие чаты)
--  Блок идемпотентный: повторный запуск ничего не ломает.
-- =====================================================================

-- ---------- 0. Настройки Shield (пороги и веса — стартовые для пилота) ----------
alter table public.app_settings add column if not exists shield jsonb not null default '{}'::jsonb;
update public.app_settings set shield = '{
  "enforce_sessions": true, "admin_mfa": true, "video": true, "dm": false,
  "meetings_pilot_only": true, "captcha_enforced": false, "formula": "rep-1",
  "risk": {"captcha": 25, "limit": 50, "hold": 75, "hold_hours": 24, "unconfirmed_days": 7},
  "weights": {"evasion": 35, "mass_reg": 20, "violation": 20, "suspicious": 12},
  "rep_penalty": {"warning": 5, "restricted": 15, "ban": 30}
}'::jsonb || shield where id = 1;
-- лимиты по ТЗ: 10 сообщений в минуту, 3 публикации за 10 минут (меняются в app_settings.limits)
update public.app_settings set limits = limits || '{
  "post": [3, 12, "10 minutes"], "chat": [10, 40, "1 minute"], "review": [20, 60, "1 day"],
  "nick": [10, 40, "1 hour"], "challenge": [5, 20, "1 hour"], "appeal": [5, 10, "1 day"]
}'::jsonb where id = 1 and not (limits ? 'chat');

create or replace function public.shield_cfg() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select shield from public.app_settings where id = 1), '{}'::jsonb) $$;

-- серверный ключ для HMAC идентификаторов (IP, установка). Не читается никем, кроме функций.
create table if not exists public.shield_secret (
  id int primary key default 1 check (id = 1),
  hmac_key text not null
);
alter table public.shield_secret enable row level security;
do $$ begin
  perform set_config('search_path', 'public, extensions', true);
  insert into public.shield_secret (id, hmac_key) values (1, encode(gen_random_bytes(32), 'hex')) on conflict do nothing;
end $$;

create or replace function public.shield_hash(v text) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case when v is null or v = '' then null
    else encode(hmac(v, (select hmac_key from public.shield_secret where id = 1), 'sha256'), 'hex') end $$;

-- IP хранится только как HMAC с серверным ключом (раньше — md5 с постоянной солью)
create or replace function public.req_ip_hash() returns text
language plpgsql stable security definer set search_path = public as $$
declare ip text;
begin
  begin
    ip := split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1);
  exception when others then ip := '';
  end;
  if ip is null or trim(ip) = '' then return null; end if;
  return public.shield_hash('ip:' || trim(ip));
end $$;

-- лимиты атомарные: параллельные запросы одного аккаунта/сети ждут друг друга
create or replace function public.rate_check(p_kind text, p_user_max int, p_ip_max int, p_window interval) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); iph text := public.req_ip_hash(); n int; rs int; c jsonb := public.shield_cfg();
begin
  if uid is null and iph is null then return; end if;
  if uid is not null then
    perform pg_advisory_xact_lock(hashtextextended('rate:' || p_kind || ':' || uid::text, 0));
    -- повышенный риск (50–74 и выше) — лимиты аккаунта вдвое ниже
    rs := public.risk_score(uid);
    if rs >= coalesce((c->'risk'->>'limit')::int, 50) then p_user_max := greatest(1, p_user_max / 2); end if;
    select count(*) into n from public.rate_events where kind = p_kind and user_id = uid and created_at > now() - p_window;
    if n >= p_user_max then
      raise exception using errcode = 'NR429', message = 'Слишком часто. Попробуйте немного позже', hint = p_kind;
    end if;
  end if;
  if iph is not null and p_ip_max is not null then
    perform pg_advisory_xact_lock(hashtextextended('rate:' || p_kind || ':' || iph, 0));
    select count(*) into n from public.rate_events where kind = p_kind and ip_hash = iph and created_at > now() - p_window;
    if n >= p_ip_max then
      raise exception using errcode = 'NR429', message = 'Слишком много действий из этой сети. Попробуйте позже', hint = p_kind;
    end if;
  end if;
  insert into public.rate_events (kind, user_id, ip_hash) values (p_kind, uid, iph);
end $$;

-- ---------- 1. Аудит: только добавление, изменить или удалить нельзя ----------
create table if not exists public.security_audit_log (
  id           bigserial primary key,
  actor_id     uuid,
  action       text not null,
  target_type  text,
  target_id    uuid,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists security_audit_target_idx on public.security_audit_log (target_id, created_at desc);
alter table public.security_audit_log enable row level security;
create or replace function public.audit_immutable() returns trigger
language plpgsql as $$
begin
  if current_setting('near.audit_purge', true) = '1' then return old; end if;  -- только плановая очистка по сроку хранения
  raise exception using errcode = 'NR403', message = 'Журнал аудита нельзя изменять';
end $$;
drop trigger if exists security_audit_immutable on public.security_audit_log;
create trigger security_audit_immutable before update or delete on public.security_audit_log for each row execute function public.audit_immutable();

create or replace function public.audit(p_action text, p_type text, p_id uuid, p_details jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.security_audit_log (actor_id, action, target_type, target_id, details)
  values (auth.uid(), p_action, p_type, p_id, coalesce(p_details, '{}'::jsonb)) $$;

-- ---------- 2. Роли и MFA: модератор, старший администратор, аудитор ----------
alter table public.profiles add column if not exists is_auditor boolean not null default false;
alter table public.profiles add column if not exists meetings_pilot boolean not null default false;

create or replace function public.jwt_claim(k text) returns text
language plpgsql stable as $$
begin
  return nullif(auth.jwt()->>k, '');
exception when others then return null;
end $$;

create or replace function public.aal_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((public.shield_cfg()->>'admin_mfa')::boolean, true) = false or public.jwt_claim('aal') = 'aal2' $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false) and public.aal_ok() $$;
create or replace function public.is_mod() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or is_moderator from public.profiles where id = auth.uid()), false) and public.aal_ok() $$;
create or replace function public.is_auditor() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or is_auditor from public.profiles where id = auth.uid()), false) and public.aal_ok() $$;
-- роль есть, но второй фактор не пройден — приложение просит включить 2FA
create or replace function public.staff_role() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'admin', coalesce(p.is_admin, false), 'moderator', coalesce(p.is_moderator, false), 'auditor', coalesce(p.is_auditor, false),
    'mfa_required', coalesce((public.shield_cfg()->>'admin_mfa')::boolean, true), 'aal', coalesce(public.jwt_claim('aal'), 'aal1'))
  from public.profiles p where p.id = auth.uid() $$;

drop policy if exists "audit read" on public.security_audit_log;
create policy "audit read" on public.security_audit_log for select using (public.is_auditor());

-- ---------- 3. Никнейм вместо имени и пола ----------
alter table public.profiles add column if not exists nickname text;
create unique index if not exists profiles_nickname_uq on public.profiles (lower(nickname)) where nickname is not null;

create or replace function public.nick_norm(t text) returns text
language sql immutable as $$ select lower(normalize(btrim(ltrim(btrim(coalesce(t, '')), '@')), NFKC)) $$;
