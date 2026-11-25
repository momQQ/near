
-- ---------- 5. Устройства и сессии: одна активная сессия на аккаунт ----------
create table if not exists public.user_devices (
  user_id            uuid not null references public.profiles(id) on delete cascade,
  installation_hash  text not null,
  label              text,
  first_seen         timestamptz not null default now(),
  last_seen          timestamptz not null default now(),
  status             text not null default 'ok' check (status in ('ok','restricted')),
  primary key (user_id, installation_hash)
);
create index if not exists user_devices_hash_idx on public.user_devices (installation_hash);

create table if not exists public.user_sessions (
  session_id         uuid primary key,                       -- claim session_id из проверенного JWT, не от приложения
  user_id            uuid not null references public.profiles(id) on delete cascade,
  installation_hash  text,
  device_label       text,
  ip_hash            text,
  status             text not null default 'pending' check (status in ('pending','active','revoked')),
  created_at         timestamptz not null default now(),
  activated_at       timestamptz,
  last_seen          timestamptz not null default now(),
  revoked_at         timestamptz,
  revoke_reason      text,
  reauth_at          timestamptz
);
-- ровно одна активная сессия, даже при параллельных запросах
create unique index if not exists user_sessions_one_active on public.user_sessions (user_id) where status = 'active';
create index if not exists user_sessions_user_idx on public.user_sessions (user_id, created_at desc);

create table if not exists public.session_challenges (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  session_id       uuid not null,
  old_session_id   uuid,
  code_hash        text not null,
  attempts         int not null default 0,
  sends            int not null default 1,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '10 minutes',
  resend_at        timestamptz not null default now() + interval '60 seconds',
  consumed_at      timestamptz,
  cancelled_at     timestamptz
);
create index if not exists session_challenges_user_idx on public.session_challenges (user_id, created_at desc);

create table if not exists public.device_restrictions (
  installation_hash  text primary key,
  reason             text not null,
  expires_at         timestamptz,
  review_status      text not null default 'pending' check (review_status in ('pending','confirmed','rejected')),
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);

alter table public.user_devices enable row level security;
alter table public.user_sessions enable row level security;
alter table public.session_challenges enable row level security;
alter table public.device_restrictions enable row level security;
drop policy if exists "devices own" on public.user_devices;
drop policy if exists "sessions own" on public.user_sessions;
create policy "devices own" on public.user_devices for select using (auth.uid() = user_id or public.is_mod());
create policy "sessions own" on public.user_sessions for select using (auth.uid() = user_id or public.is_mod());

create or replace function public.jwt_sid() returns uuid
language plpgsql stable as $$
begin
  return nullif(public.jwt_claim('session_id'), '')::uuid;
exception when others then return null;
end $$;

-- актуальная сессия: токен не просто действителен, а принадлежит единственной активной сессии
create or replace function public.session_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    coalesce((public.shield_cfg()->>'enforce_sessions')::boolean, true) = false
    or exists (select 1 from public.user_sessions s where s.session_id = public.jwt_sid() and s.user_id = auth.uid() and s.status = 'active')) $$;

-- ---------- 6. Санкции (баны), состояние аккаунта ----------
create sequence if not exists public.ban_decision_seq start 241;
create table if not exists public.user_bans (
  id             uuid primary key default gen_random_uuid(),
  decision_no    text not null unique default 'NS-' || lpad(nextval('public.ban_decision_seq')::text, 5, '0'),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  kind           text not null check (kind in ('warning','restricted','ban')),
  scope          text not null default 'global' check (scope in ('global','chat','meeting')),
  scope_id       uuid,
  rule           text not null,
  reason         text not null check (char_length(reason) between 5 and 500),
  evidence       text check (evidence is null or char_length(evidence) <= 2000),
  starts_at      timestamptz not null default now(),
  expires_at     timestamptz,                                   -- null у бана = бессрочно
  status         text not null default 'active' check (status in ('active','revoked')),
  moderator_id   uuid references public.profiles(id) on delete set null,
  approved_by    uuid references public.profiles(id) on delete set null,
  source_key     text unique,                                   -- повтор того же решения не создает второй бан
  linked_from    uuid references public.user_bans(id) on delete set null,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  revoked_by     uuid references public.profiles(id) on delete set null,
  revoke_reason  text,
  check (kind <> 'warning' or expires_at is null),
  check (expires_at is null or expires_at > starts_at)
);
create index if not exists user_bans_user_idx on public.user_bans (user_id, status, expires_at);
alter table public.user_bans enable row level security;
drop policy if exists "bans read" on public.user_bans;
create policy "bans read" on public.user_bans for select using (auth.uid() = user_id or public.is_mod());

-- матрица пилота: правило → сроки (в часах; null = бессрочно; 0 = предупреждение)
create or replace function public.ban_rules() returns jsonb
language sql immutable as $$ select '{
  "minor":      {"title": "Незначительное нарушение", "first": 0,    "repeat": 24},
  "spam":       {"title": "Спам",                    "first": 24,   "repeat": 168, "repeat_max": 720},
  "ads":        {"title": "Массовая реклама",        "first": 24,   "repeat": 720},
  "insult":     {"title": "Оскорбления",             "first": 0,    "repeat": 168, "repeat_max": 720},
  "harassment": {"title": "Домогательства",          "first": 720,  "repeat": null},
  "intimate":   {"title": "Интимный контент",        "first": 720,  "repeat": null},
  "threat":     {"title": "Угрозы",                  "first": 720,  "repeat": null},
  "scam":       {"title": "Подтвержденный скам",     "first": null, "repeat": null},
  "evasion":    {"title": "Подтвержденный обход бана","first": 720, "repeat": null},
  "boosting":   {"title": "Накрутка рейтинга",       "first": 24,   "repeat": 720}
}'::jsonb $$;

-- самая строгая действующая санкция; срок проверяется при каждом запросе (без cron)
create or replace function public.account_state(p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := coalesce(p_user, auth.uid()); b record; ap record;
begin
  if uid is null then return jsonb_build_object('state', 'guest', 'server_now', now()); end if;
  if p_user is not null and p_user <> auth.uid() and not public.is_mod() and auth.uid() is not null then
    raise exception using errcode = 'NR403', message = 'Нет доступа';
  end if;
  select * into b from public.user_bans
   where user_id = uid and status = 'active' and scope = 'global' and kind in ('restricted','ban')
     and starts_at <= now() and (expires_at is null or expires_at > now())
   order by (kind = 'ban') desc, (expires_at is null) desc, expires_at desc limit 1;
  if b.id is null then return jsonb_build_object('state', 'active', 'server_now', now()); end if;
  select status, created_at into ap from public.ban_appeals where ban_id = b.id order by created_at desc limit 1;
  return jsonb_build_object(
    'state', case when b.kind = 'restricted' then 'restricted' when b.expires_at is null then 'banned_permanent' else 'banned_until' end,
    'ban_id', b.id, 'decision_no', b.decision_no, 'rule', b.rule, 'rule_title', public.ban_rules()->b.rule->>'title',
    'reason', b.reason, 'starts_at', b.starts_at, 'expires_at', b.expires_at, 'server_now', now(),
    'appeal', ap.status);
end $$;

-- 0 — можно все, 1 — ограничение (только чтение), 2 — бан
create or replace function public.ban_level(p_user uuid default null) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(max(case kind when 'ban' then 2 else 1 end), 0) from public.user_bans
   where user_id = coalesce(p_user, auth.uid()) and status = 'active' and scope = 'global' and kind in ('restricted','ban')
     and starts_at <= now() and (expires_at is null or expires_at > now()) $$;

-- Главный guard: используется всеми правилами записи (RLS, RPC, Storage).
-- true = писать нельзя: нет актуальной сессии, ограничение или бан.
create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (not public.session_ok() or public.ban_level() > 0) $$;
-- чтение закрытых данных: актуальная сессия и нет бана
create or replace function public.shield_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select public.session_ok() and public.ban_level() < 2 $$;

create or replace function public.shield_require(p_action text default 'write') returns void
language plpgsql security definer set search_path = public as $$
declare lvl int;
begin
  if auth.uid() is null then raise exception using errcode = 'NR401', message = 'Войдите в NEAR', hint = 'auth'; end if;
  if not public.session_ok() then
    raise exception using errcode = 'NR401', message = 'Вы вышли из аккаунта: выполнен вход на другом устройстве', hint = 'session_revoked';
  end if;
  lvl := public.ban_level();
  if lvl = 2 then raise exception using errcode = 'NR403', message = 'Аккаунт заблокирован', hint = 'banned'; end if;
  if lvl = 1 and p_action <> 'read' then raise exception using errcode = 'NR403', message = 'Действие ограничено решением модератора', hint = 'restricted'; end if;
  if p_action in ('risky','meeting') and public.risk_hold_active() then
    raise exception using errcode = 'NR403', message = 'Действие временно ограничено: аккаунт на проверке', hint = 'risk_hold';
  end if;
end $$;

-- старое поле profiles.banned остается для отчетов и совместимости, источник правды — user_bans
create or replace function public.ban_sync(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('near.ban_sync', '1', true);
  update public.profiles set banned = (public.ban_level(p_user) = 2) where id = p_user;
  perform set_config('near.ban_sync', '', true);
end $$;
-- старый путь бана (mod_act 'ban' без причины) закрыт: решение выносится только через NEAR Shield
create or replace function public.legacy_ban_guard() returns trigger
language plpgsql as $$
begin
  if new.banned is distinct from old.banned and coalesce(current_setting('near.ban_sync', true), '') <> '1' and auth.uid() is not null then
    raise exception using errcode = 'NR403', message = 'Блокировка выносится в NEAR Shield: с причиной, сроком и номером решения', hint = 'use_shield';
  end if;
  return new;
end $$;
drop trigger if exists profiles_legacy_ban on public.profiles;
create trigger profiles_legacy_ban before update of banned on public.profiles for each row execute function public.legacy_ban_guard();

-- перенос старых банов v11/v12 в user_bans (бессрочно, с пометкой о переносе)
insert into public.user_bans (user_id, kind, rule, reason, source_key)
select id, 'ban', 'minor', 'Перенесено из прежней системы блокировок (v12)', 'legacy:' || id
  from public.profiles where banned on conflict (source_key) do nothing;

-- ---------- 7. Вход: начало сессии, подтверждение нового устройства ----------
create or replace function public.session_begin(p_installation text, p_label text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  uid uuid := auth.uid(); sid uuid := public.jwt_sid(); inst text; cur record; act record; ch record;
  code text; st jsonb; first_login boolean;
begin
  if uid is null or sid is null then raise exception using errcode = 'NR401', message = 'Войдите в NEAR', hint = 'auth'; end if;
  inst := public.shield_hash('inst:' || coalesce(nullif(p_installation, ''), sid::text));
  p_label := left(coalesce(nullif(p_label, ''), 'Устройство'), 60);
  -- блокировка строки пользователя: параллельные входы выстраиваются в очередь
  perform 1 from public.profiles where id = uid for update;
  first_login := not exists (select 1 from public.user_sessions where user_id = uid);

  st := public.account_state(uid);
  if st->>'state' in ('banned_until','banned_permanent') then
    -- бан при входе с любого устройства не снимается; доступен только экран решения
    return jsonb_build_object('state', 'banned', 'account', st);
  end if;

  select * into cur from public.user_sessions where session_id = sid;
  if cur.status = 'active' then
    update public.user_sessions set last_seen = now() where session_id = sid and last_seen < now() - interval '1 minute';
    return jsonb_build_object('state', 'active', 'account', st);
  end if;
  if cur.status = 'revoked' then
    return jsonb_build_object('state', 'revoked', 'reason', cur.revoke_reason);
  end if;

  insert into public.user_devices (user_id, installation_hash, label) values (uid, inst, p_label)
  on conflict (user_id, installation_hash) do update set last_seen = now(), label = excluded.label;
  if first_login then perform public.risk_on_register(uid, inst); end if;

  select * into act from public.user_sessions where user_id = uid and status = 'active';
  -- нет активной сессии или вход с того же устройства — активируем сразу
  if act.session_id is null or act.installation_hash = inst then
    if act.session_id is not null then
      update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'same_device' where session_id = act.session_id;
    end if;
    insert into public.user_sessions (session_id, user_id, installation_hash, device_label, ip_hash, status, activated_at)
    values (sid, uid, inst, p_label, public.req_ip_hash(), 'active', now())
    on conflict (session_id) do update set status = 'active', activated_at = now();
    perform public.audit('session_activate', 'user', uid, jsonb_build_object('device', p_label, 'first', first_login));
    return jsonb_build_object('state', 'active', 'account', st);
  end if;

  -- новое устройство: нужна проверка по почте. Пока ее нет — закрытые данные недоступны.
  insert into public.user_sessions (session_id, user_id, installation_hash, device_label, ip_hash, status)
  values (sid, uid, inst, p_label, public.req_ip_hash(), 'pending') on conflict (session_id) do nothing;
  select * into ch from public.session_challenges
   where user_id = uid and consumed_at is null and cancelled_at is null and expires_at > now() order by created_at desc limit 1;
  if ch.id is not null and ch.session_id <> sid then
    raise exception using errcode = 'NR409', message = 'Вход уже подтверждается на другом устройстве. Попробуйте через 10 минут', hint = 'challenge_busy';
  end if;
  if ch.id is null then
    perform public.rate('challenge');
    code := lpad((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
    insert into public.session_challenges (user_id, session_id, old_session_id, code_hash)
    values (uid, sid, act.session_id, public.shield_hash('code:' || code)) returning * into ch;
    perform public.call_fn('shield-mail', jsonb_build_object('kind', 'login_code', 'user_id', uid, 'code', code, 'device', p_label));
    -- демо и тесты без почтового сервиса: код виден только серверу; в демо-режиме приложение работает локально
  end if;
  return jsonb_build_object('state', 'challenge', 'challenge_id', ch.id, 'expires_at', ch.expires_at, 'resend_at', ch.resend_at,
    'attempts_left', 5 - ch.attempts, 'old_device', act.device_label, 'old_last_seen', act.last_seen, 'server_now', now());
end $$;

create or replace function public.session_confirm(p_challenge uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid := auth.uid(); sid uuid := public.jwt_sid(); ch record; act record; st jsonb; old_label text;
begin
  if uid is null or sid is null then raise exception using errcode = 'NR401', message = 'Войдите в NEAR', hint = 'auth'; end if;
  perform 1 from public.profiles where id = uid for update;
  select * into ch from public.session_challenges where id = p_challenge and user_id = uid and session_id = sid for update;
  if ch.id is null or ch.consumed_at is not null or ch.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'error', 'Код больше не действует. Войдите заново', 'final', true);
  end if;
  if ch.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'Срок кода истек. Запросите новый код', 'expired', true);
  end if;
  if ch.attempts >= 5 then
    update public.session_challenges set cancelled_at = now() where id = ch.id;
    return jsonb_build_object('ok', false, 'error', 'Слишком много попыток. Войдите заново', 'final', true);
  end if;
  -- бан мог появиться во время подтверждения
  st := public.account_state(uid);
  if st->>'state' in ('banned_until','banned_permanent') then
    update public.session_challenges set cancelled_at = now() where id = ch.id;
    return jsonb_build_object('ok', false, 'state', 'banned', 'account', st, 'final', true);
  end if;
  if public.shield_hash('code:' || coalesce(btrim(p_code), '')) is distinct from ch.code_hash then
    update public.session_challenges set attempts = attempts + 1 where id = ch.id;   -- попытка сохраняется (функция не падает)
    return jsonb_build_object('ok', false, 'error', 'Неверный код', 'attempts_left', 4 - ch.attempts, 'final', ch.attempts + 1 >= 5);
  end if;
  -- гонка: за время подтверждения активной стала другая сессия — этот challenge отклоняем
  select * into act from public.user_sessions where user_id = uid and status = 'active';
  if act.session_id is distinct from ch.old_session_id then
    update public.session_challenges set cancelled_at = now() where id = ch.id;
    return jsonb_build_object('ok', false, 'error', 'Вход уже выполнен на другом устройстве. Войдите заново', 'final', true);
  end if;
  -- одна транзакция: погасить код, отозвать старую сессию, активировать новую
  update public.session_challenges set consumed_at = now() where id = ch.id;
  old_label := act.device_label;
  if act.session_id is not null then
    update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'new_device' where session_id = act.session_id;
    perform public.revoke_auth_session(act.session_id);
  end if;
  update public.user_sessions set status = 'active', activated_at = now(), last_seen = now() where session_id = sid;
  delete from public.push_subs where user_id = uid;   -- push старого устройства больше не приходят
  perform public.audit('session_new_device', 'user', uid, jsonb_build_object('old', old_label));
  perform public.call_fn('shield-mail', jsonb_build_object('kind', 'new_login', 'user_id', uid,
    'device', (select device_label from public.user_sessions where session_id = sid)));
  return jsonb_build_object('ok', true, 'state', 'active');
end $$;

create or replace function public.session_resend(p_challenge uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid := auth.uid(); ch record; code text;
begin
  select * into ch from public.session_challenges where id = p_challenge and user_id = uid and session_id = public.jwt_sid()
     and consumed_at is null and cancelled_at is null for update;
  if ch.id is null then return jsonb_build_object('ok', false, 'error', 'Войдите заново'); end if;
  if ch.resend_at > now() then return jsonb_build_object('ok', false, 'error', 'Повторно — через минуту', 'resend_at', ch.resend_at); end if;
  if ch.sends >= 3 then return jsonb_build_object('ok', false, 'error', 'Лимит писем исчерпан. Войдите заново позже'); end if;
  code := lpad((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
  update public.session_challenges set code_hash = public.shield_hash('code:' || code), sends = sends + 1,
         resend_at = now() + interval '60 seconds', expires_at = now() + interval '10 minutes' where id = ch.id;
  perform public.call_fn('shield-mail', jsonb_build_object('kind', 'login_code', 'user_id', uid, 'code', code));
  return jsonb_build_object('ok', true, 'resend_at', now() + interval '60 seconds');
end $$;

-- отмена: новое устройство не входит, старое продолжает работать
create or replace function public.session_cancel() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.session_challenges set cancelled_at = now() where user_id = auth.uid() and session_id = public.jwt_sid() and consumed_at is null;
  update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'cancelled' where session_id = public.jwt_sid() and status = 'pending';
end $$;

create or replace function public.session_end() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'logout'
   where session_id = public.jwt_sid() and user_id = auth.uid() and status <> 'revoked';
  delete from public.push_subs where user_id = auth.uid();
end $$;

create or replace function public.session_state() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; rs int;
begin
  if auth.uid() is null then return jsonb_build_object('state', 'guest', 'server_now', now()); end if;
  select * into s from public.user_sessions where session_id = public.jwt_sid() and user_id = auth.uid();
  if s.status = 'active' then
    update public.user_sessions set last_seen = now() where session_id = s.session_id and last_seen < now() - interval '1 minute';
  end if;
  rs := public.risk_score(auth.uid());
  return jsonb_build_object(
    'state', case when coalesce((public.shield_cfg()->>'enforce_sessions')::boolean, true) = false then 'active' else coalesce(s.status, 'none') end,
    'reason', s.revoke_reason, 'account', public.account_state(), 'server_now', now(),
    'captcha', rs >= coalesce((public.shield_cfg()->'risk'->>'captcha')::int, 25) and coalesce((public.shield_cfg()->>'captcha_enforced')::boolean, false),
    'hold', public.risk_hold_active());
end $$;

-- история входов: только свои данные, без IP
create or replace function public.session_list() returns table (device_label text, status text, created_at timestamptz, last_seen timestamptz, revoked_at timestamptz, revoke_reason text, current boolean)
language sql stable security definer set search_path = public as $$
  select s.device_label, s.status, s.created_at, s.last_seen, s.revoked_at, s.revoke_reason, s.session_id = public.jwt_sid()
    from public.user_sessions s where s.user_id = auth.uid() order by s.created_at desc limit 30 $$;

-- отзыв токенов в самой системе входа (если доступна): старый refresh-токен перестает работать
create or replace function public.revoke_auth_session(p_sid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  begin execute 'delete from auth.sessions where id = $1' using p_sid; exception when others then null; end;
end $$;

-- смена пароля (в том числе восстановление) отзывает все прежние сессии
create or replace function public.on_password_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'password_changed'
     where user_id = new.id and status <> 'revoked';
    insert into public.security_audit_log (actor_id, action, target_type, target_id) values (new.id, 'password_changed', 'user', new.id);
  end if;
  return new;
end $$;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'encrypted_password') then
    execute 'drop trigger if exists on_auth_password_change on auth.users';
    execute 'create trigger on_auth_password_change after update of encrypted_password on auth.users for each row execute function public.on_password_change()';
  end if;
end $$;

-- повторное подтверждение личности (пароль проверяет функция shield-login) — 5 минут на смену почты или удаление
create or replace function public.session_reauth_mark(p_user uuid, p_sid uuid) returns void
language sql security definer set search_path = public as $$
  update public.user_sessions set reauth_at = now() where session_id = p_sid and user_id = p_user and status = 'active' $$;
create or replace function public.reauth_fresh() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_sessions where session_id = public.jwt_sid() and user_id = auth.uid()
                  and status = 'active' and reauth_at > now() - interval '5 minutes') $$;

-- ---------- 7a. Вход по никнейму или почте (функция shield-login, только сервер) ----------
-- Лимиты атомарные: по источнику и по паре "аккаунт + источник". Чужие попытки из другой сети
-- не блокируют владельца — по аккаунту только включается CAPTCHA.
create table if not exists public.login_attempts (
  id          bigserial primary key,
  src_hash    text,
  acct_hash   text,
  ok          boolean not null,
  created_at  timestamptz not null default now()
);
create index if not exists login_attempts_src_idx on public.login_attempts (src_hash, created_at desc);
create index if not exists login_attempts_acct_idx on public.login_attempts (acct_hash, created_at desc);
alter table public.login_attempts enable row level security;

create or replace function public.login_gate(p_src text, p_login text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s text := public.shield_hash('ip:' || coalesce(p_src, '')); a text := public.shield_hash('acct:' || public.nick_norm(p_login)); n_src int; n_pair int; n_acct int;
begin
  perform pg_advisory_xact_lock(hashtextextended('login:' || coalesce(s, '') || ':' || a, 0));
  select count(*) into n_src from public.login_attempts where src_hash = s and not ok and created_at > now() - interval '10 minutes';
  select count(*) into n_pair from public.login_attempts where src_hash = s and acct_hash = a and not ok and created_at > now() - interval '15 minutes';
  select count(*) into n_acct from public.login_attempts where acct_hash = a and not ok and created_at > now() - interval '15 minutes';
  return jsonb_build_object('allowed', n_src < 20 and n_pair < 5, 'captcha', n_acct >= 5 or n_src >= 5);
end $$;

create or replace function public.login_record(p_src text, p_login text, p_ok boolean) returns void
language sql security definer set search_path = public as $$
  insert into public.login_attempts (src_hash, acct_hash, ok)
  values (public.shield_hash('ip:' || coalesce(p_src, '')), public.shield_hash('acct:' || public.nick_norm(p_login)), p_ok) $$;

create or replace function public.login_email(p_login text) returns text
language sql stable security definer set search_path = public as $$
  select u.email from auth.users u join public.profiles p on p.id = u.id where lower(p.nickname) = public.nick_norm(p_login) limit 1 $$;
revoke all on public.login_attempts from public, anon, authenticated;
revoke execute on function public.login_gate(text, text), public.login_record(text, text, boolean), public.login_email(text) from public, anon, authenticated;
