-- =====================================================================
-- NEAR v14.8 (ТЗ v14.8): общие чаты и встречи вместо личных сообщений и друзей.
-- Часть A: отключение личных сообщений и дружбы, вход по нику, состояния аккаунта.
-- Скрипт идемпотентный. Перед запуском — резервная копия (SETUP.md, шаг 19).
-- =====================================================================

-- ---------- 12: личные диалоги и друзья — контролируемый отказ ----------
alter table public.app_settings add column if not exists legacy_dm_closed_at timestamptz;
update public.app_settings set legacy_dm_closed_at = coalesce(legacy_dm_closed_at, now()) where id = 1;

create or replace function public.legacy_dm_refuse() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- сервер (service role, миграции) может чистить старые данные; пользователи ничего не создают
  if auth.uid() is null then return coalesce(new, old); end if;
  raise exception using errcode = 'NR410',
    message = 'Личные сообщения и друзья больше не поддерживаются. Общайтесь в общих чатах и встречах', hint = 'legacy_dm';
end $$;
drop trigger if exists legacy_dm_conv on public.conversations;
create trigger legacy_dm_conv before insert or update on public.conversations for each row execute function public.legacy_dm_refuse();
drop trigger if exists legacy_dm_msg on public.messages;
create trigger legacy_dm_msg before insert or update on public.messages for each row execute function public.legacy_dm_refuse();
drop trigger if exists legacy_dm_friend on public.friendships;
create trigger legacy_dm_friend before insert or update on public.friendships for each row execute function public.legacy_dm_refuse();

create or replace function public.get_or_create_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  raise exception using errcode = 'NR410',
    message = 'Личные сообщения больше не поддерживаются. Общайтесь в общих чатах и встречах', hint = 'legacy_dm';
end $$;
create or replace function public.conversation_respond(conv uuid, accept boolean) returns text
language plpgsql security definer set search_path = public as $$
begin
  raise exception using errcode = 'NR410', message = 'Личные сообщения больше не поддерживаются', hint = 'legacy_dm';
end $$;
-- старые данные: не читаются клиентом, не превращаются в публичные; удаление — по утвержденной политике хранения
revoke all on public.conversations, public.messages, public.friendships from anon, authenticated;
do $$ begin alter publication supabase_realtime drop table public.messages; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime drop table public.conversations; exception when others then null; end $$;
-- друзья больше ничего не открывают (в том числе обход возрастного допуска)
create or replace function public.are_friends(a uuid, b uuid) returns boolean language sql stable as $$ select false $$;

-- ---------- 03: вход по нику без раскрытия email ----------
-- Вызывается только Edge Function login (service role). Пользователь email чужого ника не получает никогда.
create or replace function public.login_email(p_login text) returns text
language sql stable security definer set search_path = public, auth as $$
  select u.email from auth.users u join public.profiles p on p.id = u.id
   where p.nickname_norm = public.nick_norm(btrim(p_login)) and u.deleted_at is null limit 1 $$;
revoke all on function public.login_email(text) from public, anon, authenticated;
do $$ begin grant execute on function public.login_email(text) to service_role; exception when undefined_object then null; end $$;

-- журнал попыток входа: ограничение частоты по нику и по IP (хэш), без паролей
create table if not exists public.login_attempts (
  id         bigserial primary key,
  login_key  text not null,
  ip_hash    text,
  ok         boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_key_idx on public.login_attempts (login_key, created_at desc);
create index if not exists login_attempts_ip_idx on public.login_attempts (ip_hash, created_at desc);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;

create or replace function public.login_gate(p_login text, p_ip text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text := public.nick_norm(lower(btrim(p_login))); n_key int; n_ip int;
begin
  select count(*) into n_key from public.login_attempts where login_key = k and not ok and created_at > now() - interval '15 minutes';
  select count(*) into n_ip from public.login_attempts where ip_hash = p_ip and not ok and created_at > now() - interval '15 minutes';
  if n_key >= 5 or n_ip >= 20 then
    return jsonb_build_object('ok', false, 'retry_after', 900);
  end if;
  return jsonb_build_object('ok', true);
end $$;
create or replace function public.login_note(p_login text, p_ip text, p_ok boolean) returns void
language sql security definer set search_path = public as $$
  insert into public.login_attempts (login_key, ip_hash, ok) values (public.nick_norm(lower(btrim(p_login))), p_ip, p_ok);
  delete from public.login_attempts where created_at < now() - interval '2 days' and random() < 0.05 $$;
revoke all on function public.login_gate(text, text), public.login_note(text, text, boolean) from public, anon, authenticated;
do $$ begin
  grant execute on function public.login_gate(text, text), public.login_note(text, text, boolean) to service_role;
exception when undefined_object then null; end $$;

-- ---------- 03: допуск к встречам — отдельно от возраста для чатов ----------
alter table public.app_settings add column if not exists meet_age_gate boolean not null default true;
create or replace function public.meet_ok(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not coalesce((select meet_age_gate from public.app_settings where id = 1), true)
      or exists (select 1 from public.profile_private where user_id = u and age_status = 'adult') $$;
