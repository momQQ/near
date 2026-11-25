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

-- =====================================================================
-- Часть B (разделы 08, 09, 12): единая модель комнат — город, районы, темы, встречи.
-- rooms / room_members / room_messages / room_mentions / outbox. Без личных диалогов.
-- =====================================================================

create table if not exists public.rooms (
  id              uuid primary key default gen_random_uuid(),
  type            text not null check (type in ('city','district','topic','meeting')),
  scope_id        text,                    -- 'almaty', название района, тема или id встречи
  title           text not null check (char_length(title) between 2 and 80),
  about           text check (about is null or char_length(about) <= 300),
  rules           text check (rules is null or char_length(rules) <= 1000),
  pinned          text check (pinned is null or char_length(pinned) <= 300),
  status          text not null default 'active' check (status in ('active','readonly','archived','closed')),
  is_public       boolean not null default true,
  slow_mode_sec   int not null default 0 check (slow_mode_sec between 0 and 600),
  meeting_id      uuid unique,             -- UNIQUE(meeting_id): одна комната на встречу
  last_message_at timestamptz,
  members_count   int not null default 0,
  created_at      timestamptz not null default now(),
  unique (type, scope_id)
);
create index if not exists rooms_type_idx on public.rooms (type, status, last_message_at desc nulls last);

create table if not exists public.room_members (
  room_id       uuid not null references public.rooms(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  role          text not null default 'member' check (role in ('host','cohost','moderator','member')),
  status        text not null default 'active' check (status in ('active','left','removed')),
  muted_until   timestamptz,
  notify        text not null default 'mentions' check (notify in ('all','mentions','silent','off')),
  last_read_at  timestamptz not null default now(),
  active_until  timestamptz,               -- приложение открыто в этой комнате: push не дублируется
  joined_at     timestamptz not null default now(),
  primary key (room_id, user_id)           -- UNIQUE(room_id, user_id)
);
create index if not exists room_members_room_status_idx on public.room_members (room_id, status);
create index if not exists room_members_user_idx on public.room_members (user_id, status);

create table if not exists public.room_messages (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  sender_id   uuid references public.profiles(id) on delete set null,   -- null = системный автор
  kind        text not null default 'text' check (kind in ('text','system','action','checkin')),
  body_masked text not null check (char_length(body_masked) between 1 and 1000),
  client_id   text,
  reply_to    uuid references public.room_messages(id) on delete set null,
  meta        jsonb not null default '{}'::jsonb,
  status      text not null default 'ok' check (status in ('ok','hidden','deleted')),
  created_at  timestamptz not null default now(),
  unique (room_id, sender_id, client_id)   -- повтор отправки не создает дубль
);
create index if not exists room_messages_room_idx on public.room_messages (room_id, created_at desc, id desc);
create index if not exists room_messages_sender_idx on public.room_messages (sender_id, created_at desc);

create table if not exists public.room_mentions (
  message_id uuid not null references public.room_messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  primary key (message_id, user_id)
);
create index if not exists room_mentions_user_idx on public.room_mentions (user_id);

-- outbox: уведомления и напоминания с повтором и дедупликацией
create table if not exists public.outbox (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null,
  dedup_key   text not null unique,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  attempts    int not null default 0,
  next_retry  timestamptz not null default now(),
  last_error  text,
  created_at  timestamptz not null default now()
);
create index if not exists outbox_status_idx on public.outbox (status, next_retry);
alter table public.outbox enable row level security;
revoke all on public.outbox from anon, authenticated;

-- уведомления знают комнату и ссылку (deep link проверяет доступ при открытии)
alter table public.notifications add column if not exists room_id uuid references public.rooms(id) on delete cascade;
alter table public.notifications add column if not exists link text;

-- настройка push: все / упоминания и важное / без звука / отключить
alter table public.profiles add column if not exists notify_level text not null default 'important'
  check (notify_level in ('all','important','silent','off'));

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_messages enable row level security;
alter table public.room_mentions enable row level security;

create or replace function public.room_role(r uuid, u uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.room_members where room_id = r and user_id = u and status = 'active' $$;
create or replace function public.room_can_read(r uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.rooms x where x.id = r and x.status <> 'closed'
                   and ((x.is_public and x.type <> 'meeting') or public.room_role(r, auth.uid()) is not null))
      or public.is_mod() $$;

drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms for select using ((is_public and type <> 'meeting') or public.room_role(id, auth.uid()) is not null or public.is_mod());
drop policy if exists room_members_read on public.room_members;
-- состав видят участники комнаты; GPS, телефон и email в комнатах не хранятся
create policy room_members_read on public.room_members for select using (user_id = auth.uid() or public.room_role(room_id, auth.uid()) is not null or public.is_mod());
drop policy if exists room_messages_read on public.room_messages;
-- чтение: публичная комната (гость тоже) или участник; сообщения заблокированных скрыты; при кике доступ к истории сразу закрывается
create policy room_messages_read on public.room_messages for select using (
  public.room_can_read(room_id)
  and (status = 'ok' or public.is_mod() or (sender_id = auth.uid() and status <> 'deleted'))
  and (sender_id is null or auth.uid() is null or not exists (select 1 from public.blocks b where b.blocker_id = auth.uid() and b.blocked_id = room_messages.sender_id)));
drop policy if exists room_mentions_read on public.room_mentions;
create policy room_mentions_read on public.room_mentions for select using (user_id = auth.uid());
-- запись только через RPC: клиент не меняет роль, счетчики, статус
revoke insert, update, delete on public.rooms, public.room_members, public.room_messages, public.room_mentions from anon, authenticated;
grant select on public.rooms, public.room_members, public.room_messages, public.room_mentions to anon, authenticated;
do $$ begin alter publication supabase_realtime add table public.room_messages; exception when others then null; end $$;

-- ---------- города, районы ----------
insert into public.rooms (type, scope_id, title, about, rules, pinned) values
  ('city', 'almaty', 'Алматы — общий чат', 'Городские вопросы', 'Уважайте соседей. Без рекламы, ссылок на сборы денег и личных данных. Мат скрывается, угрозы и скам удаляются.', 'Правила: уважение, без личных данных и сборов денег')
on conflict (type, scope_id) do nothing;
insert into public.rooms (type, scope_id, title, about, rules)
select 'district', d, d || ' район', 'Новости соседей', 'Только о районе. Уважайте соседей, без рекламы и личных данных.'
from unnest(array['Алатауский','Алмалинский','Ауэзовский','Бостандыкский','Жетысуский','Медеуский','Наурызбайский','Турксибский']) d
on conflict (type, scope_id) do nothing;

-- ---------- outbox ----------
create or replace function public.outbox_put(p_user uuid, p_kind text, p_key text, p_payload jsonb, p_at timestamptz default now()) returns void
language sql security definer set search_path = public as $$
  insert into public.outbox (user_id, kind, dedup_key, payload, next_retry) values (p_user, p_kind, p_key, p_payload, p_at)
  on conflict (dedup_key) do nothing $$;

-- обработка: due → уведомление в приложении (push уходит триггером уведомлений). Повтор с паузой, без дублей.
create or replace function public.outbox_process(p_limit int default 200) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record; sent int := 0; skipped int := 0; failed int := 0; lvl text; mem record;
begin
  for o in select * from public.outbox where status = 'pending' and next_retry <= now() order by next_retry limit p_limit for update skip locked loop
    begin
      select notify_level into lvl from public.profiles where id = o.user_id;
      -- комната: участник ушел/исключен — уведомление не нужно; активный чат — не дублировать
      if o.payload ? 'room_id' then
        select * into mem from public.room_members where room_id = (o.payload->>'room_id')::uuid and user_id = o.user_id;
        if mem.status is distinct from 'active' or (o.kind = 'message' and mem.active_until > now()) then
          update public.outbox set status = 'skipped' where id = o.id; skipped := skipped + 1; continue;
        end if;
      end if;
      if lvl = 'off' or (lvl in ('important','silent') and o.kind = 'message') then
        update public.outbox set status = 'skipped' where id = o.id; skipped := skipped + 1; continue;
      end if;
      insert into public.notifications (user_id, actor_id, type, text, room_id, link, post_id)
      values (o.user_id, nullif(o.payload->>'actor', '')::uuid, o.kind, left(o.payload->>'text', 300),
              nullif(o.payload->>'room_id', '')::uuid, o.payload->>'link', nullif(o.payload->>'post_id', '')::uuid);
      update public.outbox set status = 'sent', attempts = attempts + 1 where id = o.id; sent := sent + 1;
    exception when others then
      update public.outbox set attempts = attempts + 1, last_error = left(sqlerrm, 200),
        status = case when attempts + 1 >= 5 then 'failed' else 'pending' end,
        next_retry = now() + (interval '1 minute' * power(2, attempts)) where id = o.id;
      failed := failed + 1;
    end;
  end loop;
  return jsonb_build_object('sent', sent, 'skipped', skipped, 'failed', failed);
end $$;
revoke all on function public.outbox_process(int) from public, anon, authenticated;

-- ---------- вступить / выйти / настройки комнаты ----------
create or replace function public.join_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.rooms;
begin
  if auth.uid() is null then raise exception using errcode = 'NR401', message = 'Войдите, чтобы вступить'; end if;
  select * into r from public.rooms where id = p_room;
  if r.id is null or r.status = 'closed' then raise exception using errcode = 'NR404', message = 'Комната не найдена'; end if;
  if r.type = 'meeting' then raise exception using errcode = 'NR403', message = 'Чат встречи открывается после принятия заявки', hint = 'meeting_room'; end if;
  insert into public.room_members (room_id, user_id) values (p_room, auth.uid())
  on conflict (room_id, user_id) do update set status = 'active', joined_at = now() where room_members.status = 'left';
  update public.rooms set members_count = (select count(*) from public.room_members where room_id = p_room and status = 'active') where id = p_room;
end $$;

create or replace function public.leave_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.rooms where id = p_room and type = 'meeting') then
    raise exception using errcode = 'NR409', message = 'Чтобы выйти из чата встречи, отмените участие во встрече', hint = 'meeting_room';
  end if;
  update public.room_members set status = 'left' where room_id = p_room and user_id = auth.uid() and status = 'active';
  update public.rooms set members_count = (select count(*) from public.room_members where room_id = p_room and status = 'active') where id = p_room;
end $$;

create or replace function public.room_settings(p_room uuid, p_notify text default null, p_read boolean default false, p_active boolean default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.room_members set
    notify = coalesce(p_notify, notify),
    last_read_at = case when p_read then now() else last_read_at end,
    active_until = case when p_active is true then now() + interval '90 seconds' when p_active is false then null else active_until end
  where room_id = p_room and user_id = auth.uid() and status = 'active';
end $$;

-- список: Рядом (город + районы + темы), Встречи (мои встречи), Мои (все, где я участник); с непрочитанными
create or replace function public.rooms_list(p_tab text default 'near', p_q text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.ord, x.last desc nulls last), '[]'::jsonb) from (
    select r.id, r.type, r.title, r.about, r.pinned, r.status, r.meeting_id, r.members_count,
           r.last_message_at as last,
           m.status = 'active' as joined, m.role, m.notify,
           case when m.status = 'active' then (select count(*) from public.room_messages x where x.room_id = r.id and x.created_at > m.last_read_at and x.status = 'ok' and x.sender_id is distinct from auth.uid()) else 0 end as unread,
           (select left(x.body_masked, 80) from public.room_messages x where x.room_id = r.id and x.status = 'ok' order by x.created_at desc limit 1) as preview,
           case r.type when 'city' then 0 when 'district' then 1 when 'meeting' then 2 else 3 end as ord
      from public.rooms r
      left join public.room_members m on m.room_id = r.id and m.user_id = auth.uid()
     where r.status <> 'closed'
       and case p_tab
             when 'near' then r.type in ('city','district','topic') and r.is_public
             when 'meet' then r.type = 'meeting' and m.status = 'active'
             else m.status = 'active' end
       and (p_q is null or r.title ilike '%' || replace(replace(btrim(p_q), '%', ''), '_', '') || '%')
     limit 100) x $$;

-- ---------- отправка сообщения: маска, блок опасного, лимиты, slow mode, упоминания ----------
create or replace function public.send_message(p_room uuid, p_body text, p_client_id text, p_reply_to uuid default null,
                                               p_kind text default 'text', p_action text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); r public.rooms; m public.room_members; s public.user_sanctions; body text; why text;
        mid uuid; ts timestamptz; n10 int; n60 int; links int; trusted boolean; all_mention boolean := false;
        meet record; t text; target uuid; host uuid; v_meta jsonb := '{}'::jsonb;
begin
  if uid is null then raise exception using errcode = 'NR401', message = 'Войдите, чтобы писать'; end if;
  if p_client_id is null or char_length(p_client_id) > 64 then raise exception using errcode = 'NR422', message = 'Нет ключа отправки'; end if;
  -- повтор того же ключа — тот же результат (идемпотентность)
  select id, created_at into mid, ts from public.room_messages where room_id = p_room and sender_id = uid and client_id = p_client_id;
  if mid is not null then return jsonb_build_object('id', mid, 'created_at', ts, 'duplicate', true); end if;

  select * into r from public.rooms where id = p_room;
  if r.id is null or r.status = 'closed' then raise exception using errcode = 'NR404', message = 'Комната не найдена'; end if;
  select * into m from public.room_members where room_id = p_room and user_id = uid;
  if m.status is distinct from 'active' then
    raise exception using errcode = 'NR403', message = case when r.type = 'meeting' then 'Писать могут только участники встречи' else 'Вступите в комнату, чтобы писать' end, hint = 'not_member';
  end if;
  if exists (select 1 from public.profiles where id = uid and (nickname is null or accepted_rules_at is null)) then
    raise exception using errcode = 'NR403', message = 'Заполните профиль: никнейм и согласие с правилами', hint = 'profile_incomplete';
  end if;
  if not exists (select 1 from public.profiles where id = uid and verified) then
    raise exception using errcode = 'NR403', message = 'Подтвердите почту, чтобы писать', hint = 'pending_email';
  end if;
  s := public.active_sanction(uid, 'chat');
  if s.id is not null then
    raise exception using errcode = 'NR403', hint = 'restricted',
      message = 'Сообщения ограничены модератором' || case when s.until is null then '' else ' до ' || to_char(s.until at time zone 'Asia/Almaty', 'DD.MM HH24:MI') end || '. Причина: ' || s.reason;
  end if;
  if m.muted_until > now() then
    raise exception using errcode = 'NR403', hint = 'muted', message = 'Вам временно нельзя писать в этой комнате до ' || to_char(m.muted_until at time zone 'Asia/Almaty', 'DD.MM HH24:MI');
  end if;
  -- архив встречи: только чтение через 7 дней после окончания; отмененная встреча — только чтение
  if r.type = 'meeting' then
    select mt.* into meet from public.meetings mt where mt.id = r.meeting_id;
    if meet.status = 'cancelled' or meet.ends_at < now() - interval '7 days' or r.status <> 'active' then
      raise exception using errcode = 'NR403', message = 'Чат встречи в архиве: только чтение', hint = 'archived';
    end if;
  elsif r.status <> 'active' then
    raise exception using errcode = 'NR403', message = 'Комната только для чтения', hint = 'readonly';
  end if;

  body := btrim(coalesce(p_body, ''));
  if p_kind = 'action' then
    if p_action is null then raise exception using errcode = 'NR422', message = 'Неизвестное действие'; end if;
    v_meta := jsonb_build_object('action', left(p_action, 40));
  elsif p_kind <> 'text' then raise exception using errcode = 'NR422', message = 'Недопустимый тип сообщения';
  end if;
  if body = '' then raise exception using errcode = 'NR422', message = 'Пустое сообщение'; end if;
  if char_length(body) > 1000 then raise exception using errcode = 'NR422', message = 'Сообщение длиннее 1000 символов'; end if;
  why := public.near_block_reason(body);
  if why is not null then raise exception using errcode = 'NR422', message = public.near_block_message(why), hint = why; end if;

  -- частота: 5 за 10 секунд, 30 в минуту; slow mode комнаты
  if not public.is_mod() then
    select count(*) filter (where created_at > now() - interval '10 seconds'), count(*) into n10, n60
      from public.room_messages where sender_id = uid and created_at > now() - interval '1 minute';
    if n10 >= 5 or n60 >= 30 then
      raise exception using errcode = 'NR429', message = 'Слишком часто. Подождите немного', hint = 'retry_after=' || case when n10 >= 5 then 10 else 60 end || ';action=chat';
    end if;
    if r.slow_mode_sec > 0 and m.role not in ('host','cohost','moderator') and exists (
         select 1 from public.room_messages where room_id = p_room and sender_id = uid and created_at > now() - make_interval(secs => r.slow_mode_sec)) then
      raise exception using errcode = 'NR429', message = 'В комнате медленный режим: одно сообщение в ' || r.slow_mode_sec || ' с', hint = 'retry_after=' || r.slow_mode_sec || ';action=slow';
    end if;
    -- ссылки: только доверенным (телефон или 7 дней в NEAR), не больше 3 в час
    if body ~* '(https?://|www\.|[a-z0-9-]+\.(kz|ru|com|net|org|me|io|ly|link)\y)' then
      select exists (select 1 from public.profile_private where user_id = uid and phone_verified_at is not null)
          or exists (select 1 from public.profiles where id = uid and created_at < now() - interval '7 days') into trusted;
      if not trusted then raise exception using errcode = 'NR403', message = 'Ссылки можно отправлять через 7 дней после регистрации', hint = 'links'; end if;
      select count(*) into links from public.room_messages where sender_id = uid and created_at > now() - interval '1 hour' and (room_messages.meta->>'link')::boolean;
      if links >= 3 then raise exception using errcode = 'NR429', message = 'Не больше 3 ссылок в час', hint = 'retry_after=3600;action=links'; end if;
      v_meta := v_meta || '{"link":true}';
    end if;
  end if;

  -- @all: Host, co-host или модератор комнаты, не чаще 1 раза в 5 минут
  if body ~* '(^|\s)@all\y' then
    if m.role not in ('host','cohost','moderator') and not public.is_mod() then
      raise exception using errcode = 'NR403', message = '@all доступен только организатору и модераторам', hint = 'mention_all';
    end if;
    if exists (select 1 from public.room_messages where room_id = p_room and (room_messages.meta->>'all')::boolean and created_at > now() - interval '5 minutes') then
      raise exception using errcode = 'NR429', message = '@all можно использовать раз в 5 минут', hint = 'retry_after=300;action=mention_all';
    end if;
    all_mention := true; v_meta := v_meta || '{"all":true}';
  end if;
  if p_reply_to is not null and not exists (select 1 from public.room_messages where id = p_reply_to and room_id = p_room) then p_reply_to := null; end if;

  insert into public.room_messages (room_id, sender_id, kind, body_masked, client_id, reply_to, meta)
  values (p_room, uid, p_kind, public.near_clean(body), p_client_id, p_reply_to, v_meta)
  on conflict (room_id, sender_id, client_id) do nothing
  returning id, created_at into mid, ts;
  if mid is null then
    select id, created_at into mid, ts from public.room_messages where room_id = p_room and sender_id = uid and client_id = p_client_id;
    return jsonb_build_object('id', mid, 'created_at', ts, 'duplicate', true);
  end if;
  update public.rooms set last_message_at = ts where id = p_room;
  update public.room_members set last_read_at = ts where room_id = p_room and user_id = uid;

  -- упоминания по ID; заблокировавшие отправителя не получают прямых упоминаний
  if r.type = 'meeting' then select host_id into host from public.meetings where id = r.meeting_id; end if;
  for target in
    select distinct rm.user_id from public.room_members rm
      left join public.profiles p on p.id = rm.user_id
     where rm.room_id = p_room and rm.status = 'active' and rm.user_id <> uid
       and (all_mention
            or (host is not null and rm.user_id = host and body ~* '(^|\s)@host\y')
            or (p.nickname_norm is not null and public.nick_norm(body) ~ ('(^|[^[:alnum:]_])@' || p.nickname_norm || '($|[^[:alnum:]_])')))
       and not exists (select 1 from public.blocks b where b.blocker_id = rm.user_id and b.blocked_id = uid)
  loop
    insert into public.room_mentions (message_id, user_id) values (mid, target) on conflict do nothing;
    perform public.outbox_put(target, 'mention', 'mention:' || mid || ':' || target,
      jsonb_build_object('room_id', p_room, 'actor', uid, 'text', case when all_mention then 'Сообщение для всех в "' || r.title || '"' else 'Вас упомянули в "' || r.title || '"' end,
                         'link', '#room=' || p_room));
  end loop;
  -- сообщение для тех, кто включил "все" (кроме упомянутых и автора)
  if r.type = 'meeting' then
    insert into public.outbox (user_id, kind, dedup_key, payload)
    select rm.user_id, 'message', 'msg:' || mid || ':' || rm.user_id,
           jsonb_build_object('room_id', p_room, 'actor', uid, 'text', 'Новое сообщение в "' || r.title || '"', 'link', '#room=' || p_room)
      from public.room_members rm
     where rm.room_id = p_room and rm.status = 'active' and rm.user_id <> uid and rm.notify = 'all'
       and not exists (select 1 from public.room_mentions x where x.message_id = mid and x.user_id = rm.user_id)
    on conflict (dedup_key) do nothing;
  end if;
  return jsonb_build_object('id', mid, 'created_at', ts);
end $$;

-- системное сообщение (шаблон RU + ключ для перевода в приложении)
create or replace function public.room_system(p_room uuid, p_body text, p_meta jsonb default '{}'::jsonb, p_kind text default 'system') returns uuid
language sql security definer set search_path = public as $$
  with i as (insert into public.room_messages (room_id, sender_id, kind, body_masked, meta) values (p_room, null, p_kind, left(p_body, 1000), p_meta) returning id, created_at)
  , u as (update public.rooms set last_message_at = (select created_at from i) where id = p_room)
  select id from i $$;
revoke all on function public.room_system(uuid, text, jsonb, text) from public, anon, authenticated;

-- лента сообщений комнаты, по 40, курсором (created_at, id)
create or replace function public.room_feed(p_room uuid, p_before timestamptz default null, p_before_id uuid default null, p_limit int default 40) returns setof public.room_messages
language sql stable security invoker set search_path = public as $$
  select * from public.room_messages
   where room_id = p_room
     and (p_before is null or (created_at, id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
   order by created_at desc, id desc
   limit least(greatest(coalesce(p_limit, 40), 1), 50) $$;

-- модерация комнаты: скрыть сообщение, мут, медленный режим
create or replace function public.room_hide_message(p_msg uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid; role text := '';
begin
  select room_id into r from public.room_messages where id = p_msg;
  role := coalesce(public.room_role(r, auth.uid()), '');
  if not (public.is_mod() or role in ('host','cohost','moderator')) then raise exception using errcode = 'NR403', message = 'Нет прав'; end if;
  update public.room_messages set status = 'hidden', meta = meta || jsonb_build_object('hidden_by', auth.uid(), 'reason', left(p_reason, 200)) where id = p_msg;
end $$;

create or replace function public.set_mute(p_room uuid, p_user uuid, p_minutes int, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare my text := coalesce(public.room_role(p_room, auth.uid()), ''); their text := coalesce(public.room_role(p_room, p_user), ''); mt uuid;
begin
  if not (public.is_mod() or my in ('host','cohost','moderator')) then raise exception using errcode = 'NR403', message = 'Мутить может организатор или модератор'; end if;
  if their = '' then raise exception using errcode = 'NR404', message = 'Участник не найден'; end if;
  if their = 'host' or (their in ('cohost','moderator') and my not in ('host') and not public.is_mod()) then
    raise exception using errcode = 'NR403', message = 'Нельзя ограничить организатора';
  end if;
  if p_minutes is null or p_minutes < 0 or p_minutes > 10080 then raise exception using errcode = 'NR422', message = 'Срок от 0 до 7 дней'; end if;
  update public.room_members set muted_until = case when p_minutes = 0 then null else now() + make_interval(mins => p_minutes) end where room_id = p_room and user_id = p_user;
  select meeting_id into mt from public.rooms where id = p_room;
  if mt is not null then
    insert into public.meeting_audit (meeting_id, actor_id, action, target_id, reason) values (mt, auth.uid(), case when p_minutes = 0 then 'unmute' else 'mute' end, p_user, left(p_reason, 300));
  end if;
end $$;

create or replace function public.room_slow_mode(p_room uuid, p_sec int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_mod() or coalesce(public.room_role(p_room, auth.uid()), '') in ('host','cohost','moderator')) then raise exception using errcode = 'NR403', message = 'Нет прав'; end if;
  update public.rooms set slow_mode_sec = greatest(0, least(coalesce(p_sec, 0), 600)) where id = p_room;
end $$;

-- тематическая комната создается модератором по спросу
create or replace function public.mod_create_room(p_title text, p_about text, p_rules text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только модератор'; end if;
  insert into public.rooms (type, scope_id, title, about, rules) values ('topic', public.nick_norm(p_title), public.near_clean(btrim(p_title)), public.near_clean(p_about), public.near_clean(p_rules))
  on conflict (type, scope_id) do update set status = 'active' returning rooms.id into v_id;
  return v_id;
end $$;

-- жалоба на сообщение комнаты: в общую очередь модерации
alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check check (target_type in ('post','user','message','comment','room_message','meeting','review'));

-- =====================================================================
-- Часть C (разделы 07, 09, 12): встречи, заявки, Host, готовность, напоминания, посещение.
-- Встреча — это публикация категории meetup (лента и карта) + запись meetings + комната.
-- =====================================================================

create table if not exists public.meetings (
  id           uuid primary key references public.posts(id) on delete cascade,
  host_id      uuid references public.profiles(id) on delete set null,
  category     text not null check (category in ('games','cinema','board','sport','cafe','walk','mountains','study','other')),
  title        text not null check (char_length(title) between 5 and 80),
  details      jsonb not null default '{}'::jsonb,
  pin          text,
  place_name   text check (place_name is null or char_length(place_name) <= 120),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  capacity     int not null check (capacity between 3 and 50),          -- включая Host
  price_kzt    int check (price_kzt is null or price_kzt >= 0),         -- null = неизвестно
  rules        text check (rules is null or char_length(rules) <= 500),
  status       text not null default 'open' check (status in ('open','closed','cancelled','finished')),
  cancel_reason text,
  room_id      uuid references public.rooms(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '24 hours')
);
create index if not exists meetings_starts_idx on public.meetings (status, starts_at);
create index if not exists meetings_cat_idx on public.meetings (category, starts_at);

create table if not exists public.meeting_members (
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        text not null default 'member' check (role in ('host','cohost','member')),
  status      text not null default 'requested' check (status in ('requested','waitlist','accepted','declined','removed','left','left_late')),
  note        text check (note is null or char_length(note) <= 200),
  reason      text,
  attended    text check (attended in ('claimed','confirmed','noshow','disputed')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  primary key (meeting_id, user_id)
);
create index if not exists meeting_members_user_idx on public.meeting_members (user_id, status);
create index if not exists meeting_members_status_idx on public.meeting_members (meeting_id, status);

create table if not exists public.meeting_checkins (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  created_by  uuid references public.profiles(id) on delete set null,
  for_start   timestamptz not null,       -- время встречи на момент запроса; перенос закрывает запрос
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);
create unique index if not exists meeting_checkins_open_uidx on public.meeting_checkins (meeting_id) where closed_at is null;
create table if not exists public.checkin_answers (
  checkin_id  uuid not null references public.meeting_checkins(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  answer      text not null check (answer in ('ready','late','cant')),
  updated_at  timestamptz not null default now(),
  primary key (checkin_id, user_id)        -- один изменяемый ответ на запрос
);

create table if not exists public.meeting_audit (
  id          bigserial primary key,
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null,
  target_id   uuid,
  reason      text,
  created_at  timestamptz not null default now()
);
create index if not exists meeting_audit_idx on public.meeting_audit (meeting_id, created_at desc);

alter table public.meetings enable row level security;
alter table public.meeting_members enable row level security;
alter table public.meeting_checkins enable row level security;
alter table public.checkin_answers enable row level security;
alter table public.meeting_audit enable row level security;

create or replace function public.meet_role(mt uuid, u uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.meeting_members where meeting_id = mt and user_id = u and status = 'accepted' $$;

drop policy if exists meetings_read on public.meetings;
create policy meetings_read on public.meetings for select using (
  exists (select 1 from public.posts p where p.id = meetings.id and p.status in ('active','closed')) or host_id = auth.uid() or public.is_mod());
drop policy if exists meeting_members_read on public.meeting_members;
-- свою заявку видит заявитель; состав — участники; заявки — Host и co-host
create policy meeting_members_read on public.meeting_members for select using (
  user_id = auth.uid() or public.is_mod()
  or (status = 'accepted' and public.meet_role(meeting_id, auth.uid()) is not null)
  or public.meet_role(meeting_id, auth.uid()) in ('host','cohost'));
drop policy if exists checkins_read on public.meeting_checkins;
create policy checkins_read on public.meeting_checkins for select using (public.meet_role(meeting_id, auth.uid()) is not null or public.is_mod());
drop policy if exists checkin_answers_read on public.checkin_answers;
create policy checkin_answers_read on public.checkin_answers for select using (
  exists (select 1 from public.meeting_checkins c where c.id = checkin_id and (public.meet_role(c.meeting_id, auth.uid()) is not null or public.is_mod())));
drop policy if exists meeting_audit_read on public.meeting_audit;
create policy meeting_audit_read on public.meeting_audit for select using (public.meet_role(meeting_id, auth.uid()) in ('host','cohost') or public.is_mod());
revoke insert, update, delete on public.meetings, public.meeting_members, public.meeting_checkins, public.checkin_answers, public.meeting_audit from anon, authenticated;
grant select on public.meetings to anon, authenticated;
grant select on public.meeting_members, public.meeting_checkins, public.checkin_answers, public.meeting_audit to authenticated;

-- ---------- справочник категорий: поля, закрепление, приветствие ----------
create or replace function public.meet_fields(cat text) returns text[] language sql immutable as $$
  select case cat
    when 'games'     then array['game','mode','level','club','booking','price_hour']
    when 'cinema'    then array['film','cinema','session','lang','format','price']
    when 'board'     then array['game','level','club','inventory','duration']
    when 'sport'     then array['sport','format','level','venue','inventory','rent']
    when 'cafe'      then array['goal','cafe','budget','table','topic']
    when 'walk'      then array['route','meet_point','distance','pace','duration']
    when 'mountains' then array['route','difficulty','distance','elevation','gear','return_time','weather']
    when 'study'     then array['topic','level','format','place','materials','duration']
    when 'other'     then array['goal','place','materials','cost']
  end $$;

create or replace function public.meet_greeting(cat text) returns text language sql immutable as $$
  select case cat
    when 'games'     then 'Всем привет! Напишите, кто на какой позиции играет.'
    when 'cinema'    then 'Обсудим покупку билетов и места в зале. Каждый покупает билет сам.'
    when 'board'     then 'Новичкам объясним правила.'
    when 'sport'     then 'Напишите позицию и подтвердите участие.'
    when 'cafe'      then 'Обсудим время и бронирование столика.'
    when 'walk'      then 'Маршрут и время закреплены в чате.'
    when 'mountains' then 'Проверьте снаряжение, прогноз и маршрут. Подтвердите готовность.'
    when 'study'     then 'Подготовьте материалы. Распределим задания заранее.'
    else 'Обсудим организацию и необходимые материалы.' end $$;

-- закрепление строится сервером из полей категории
create or replace function public.meet_pin(cat text, d jsonb, st timestamptz, en timestamptz, cap int) returns text
language sql immutable as $$
  select left(case cat
    when 'games'     then concat_ws(' • ', nullif(d->>'game',''), nullif(d->>'mode',''), coalesce(nullif(d->>'level',''), 'любой уровень'))
    when 'cinema'    then 'Кино • сеанс ' || coalesce(nullif(d->>'session',''), to_char(st at time zone 'Asia/Almaty', 'HH24:MI'))
    when 'board'     then concat_ws(' • ', coalesce(nullif(d->>'game',''), 'Настольные игры'), cap || ' участников', coalesce(nullif(d->>'duration',''), round(extract(epoch from en - st) / 3600.0, 1) || ' ч'))
    when 'sport'     then concat_ws(' • ', coalesce(nullif(d->>'sport',''), 'Спорт'), nullif(d->>'format',''), round(extract(epoch from en - st) / 60) || ' минут')
    when 'cafe'      then coalesce(nullif(d->>'goal',''), 'Кофе') || ' • каждый платит за себя'
    when 'walk'      then concat_ws(' • ', nullif(d->>'distance',''), coalesce(nullif(d->>'pace',''), 'спокойный темп'))
    when 'mountains' then concat_ws(' • ', nullif(d->>'distance',''), coalesce(nullif(d->>'difficulty',''), 'сложность уточняется'))
    when 'study'     then concat_ws(' • ', coalesce(nullif(d->>'topic',''), 'Обучение'), nullif(d->>'format',''), nullif(d->>'duration',''))
    else coalesce(nullif(d->>'goal',''), 'Совместное мероприятие') end, 120) $$;

create or replace function public.meet_details_clean(cat text, d jsonb) returns jsonb
language plpgsql as $$
declare k text; v text; o jsonb := '{}'::jsonb; why text;
begin
  if public.meet_fields(cat) is null then raise exception using errcode = 'NR422', message = 'Неизвестная категория встречи'; end if;
  foreach k in array public.meet_fields(cat) loop
    v := btrim(coalesce(d->>k, ''));
    if v = '' then continue; end if;
    if char_length(v) > 60 then raise exception using errcode = 'NR422', message = 'Поле слишком длинное (до 60 символов)'; end if;
    why := public.near_block_reason(v);
    if why is not null then raise exception using errcode = 'NR422', message = public.near_block_message(why), hint = why; end if;
    o := o || jsonb_build_object(k, public.near_clean(v));
  end loop;
  return o;
end $$;

-- напоминания 24 ч / 1 ч / 15 мин без дублей
create or replace function public.meet_schedule(mt uuid, u uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; x record;
begin
  select * into m from public.meetings where id = mt;
  for x in select * from (values ('24h', interval '24 hours'), ('1h', interval '1 hour'), ('15m', interval '15 minutes')) v(k, d) loop
    if m.starts_at - x.d > now() then
      perform public.outbox_put(u, 'meeting_reminder', 'remind:' || mt || ':' || u || ':' || x.k || ':' || extract(epoch from m.starts_at)::bigint,
        jsonb_build_object('room_id', m.room_id, 'post_id', mt, 'text', 'Скоро встреча "' || m.title || '"', 'link', '#meet=' || mt), m.starts_at - x.d);
    end if;
  end loop;
end $$;
create or replace function public.meet_unschedule(mt uuid, u uuid) returns void
language sql security definer set search_path = public as $$
  update public.outbox set status = 'skipped' where status = 'pending' and dedup_key like 'remind:' || mt || ':' || coalesce(u::text, '') || '%' $$;

create or replace function public.meet_notify(mt uuid, u uuid, p_kind text, p_text text, p_key text) returns void
language sql security definer set search_path = public as $$
  select public.outbox_put(u, p_kind, p_key, jsonb_build_object('post_id', mt, 'text', left(p_text, 300), 'link', '#meet=' || mt,
    'room_id', (select room_id from public.meetings where id = mt))) $$;

create or replace function public.meet_accepted_count(mt uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.meeting_members where meeting_id = mt and status = 'accepted' $$;

-- ---------- создание: атомарно публикация + встреча + Host + комната + приветствие ----------
create or replace function public.create_meeting(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); cat text := p->>'category'; title text := btrim(coalesce(p->>'title', ''));
        descr text := btrim(coalesce(p->>'description', '')); st timestamptz; en timestamptz; cap int; price int; d jsonb;
        pid uuid; rid uuid; why text; ck text := left(p->>'client_key', 64);
begin
  if uid is null then raise exception using errcode = 'NR401', message = 'Войдите, чтобы создать встречу'; end if;
  -- повтор с тем же ключом — та же встреча
  if ck is not null then
    select id into pid from public.posts where user_id = uid and client_key = ck and category = 'meetup';
    if pid is not null then return pid; end if;
  end if;
  if not public.meet_ok(uid) then
    raise exception using errcode = 'NR403', message = 'Встречи пока доступны только после проверки возраста', hint = 'meet_age';
  end if;
  if char_length(title) not between 5 and 80 then raise exception using errcode = 'NR422', message = 'Название: от 5 до 80 символов'; end if;
  if char_length(descr) not between 10 and 1000 then raise exception using errcode = 'NR422', message = 'Описание: от 10 до 1000 символов'; end if;
  begin st := (p->>'starts_at')::timestamptz; en := (p->>'ends_at')::timestamptz;
  exception when others then raise exception using errcode = 'NR422', message = 'Укажите дату и время'; end;
  if st is null or en is null then raise exception using errcode = 'NR422', message = 'Укажите начало и конец'; end if;
  if st < now() + interval '15 minutes' then raise exception using errcode = 'NR422', message = 'Начало — не раньше чем через 15 минут'; end if;
  if st > now() + interval '90 days' then raise exception using errcode = 'NR422', message = 'Дата — не дальше 90 дней вперед'; end if;
  if en <= st then raise exception using errcode = 'NR422', message = 'Конец должен быть позже начала'; end if;
  if en > st + interval '24 hours' then raise exception using errcode = 'NR422', message = 'Длительность — до 24 часов'; end if;
  cap := (p->>'capacity')::int;
  if cap is null or cap not between 3 and 50 then raise exception using errcode = 'NR422', message = 'Участников: от 3 до 50, включая организатора'; end if;
  price := nullif(p->>'price_kzt', '')::int;
  if price < 0 then raise exception using errcode = 'NR422', message = 'Цена не может быть отрицательной'; end if;
  if coalesce((p->>'public_place')::boolean, false) is not true then
    raise exception using errcode = 'NR422', message = 'Встречи проводятся только в публичных местах', hint = 'public_place';
  end if;
  why := coalesce(public.near_block_reason(title), public.near_block_reason(descr), public.near_block_reason(p->>'rules'));
  if why is not null then raise exception using errcode = 'NR422', message = public.near_block_message(why), hint = why; end if;
  -- сборы денег через организатора запрещены (ТЗ 07: не принимать платежи через Host)
  if (descr || ' ' || coalesce(p->>'rules', '')) ~* '(переведите|перевод на карту|скиньте на (карту|kaspi|каспи)|оплата организатору|предоплат)' then
    raise exception using errcode = 'NR422', message = 'Нельзя собирать деньги через организатора. Каждый платит сам на месте или на сайте площадки', hint = 'payment';
  end if;
  d := public.meet_details_clean(cat, coalesce(p->'details', '{}'::jsonb));

  perform set_config('near.meeting', '1', true);
  insert into public.posts (user_id, category, text, lat, lng, exact, meta, client_key)
  values (uid, 'meetup', descr, (p->>'lat')::float8, (p->>'lng')::float8, coalesce((p->>'exact')::boolean, true),
          jsonb_build_object('title', title, 'mcat', cat), ck)
  returning id into pid;
  perform set_config('near.meeting', '', true);

  insert into public.rooms (type, scope_id, title, is_public, meeting_id, pinned, rules)
  values ('meeting', pid::text, public.near_clean(title), false, pid, public.meet_pin(cat, d, st, en, cap), nullif(public.near_clean(btrim(coalesce(p->>'rules', ''))), ''))
  returning id into rid;
  insert into public.meetings (id, host_id, category, title, details, pin, place_name, starts_at, ends_at, capacity, price_kzt, rules, room_id)
  values (pid, uid, cat, public.near_clean(title), d, public.meet_pin(cat, d, st, en, cap), nullif(public.near_clean(left(btrim(coalesce(p->>'place_name', '')), 120)), ''),
          st, en, cap, price, nullif(public.near_clean(btrim(coalesce(p->>'rules', ''))), ''), rid);
  update public.posts set expires_at = en + interval '1 hour' where id = pid;
  insert into public.meeting_members (meeting_id, user_id, role, status, decided_at) values (pid, uid, 'host', 'accepted', now());
  insert into public.room_members (room_id, user_id, role, notify) values (rid, uid, 'host', 'all');
  update public.rooms set members_count = 1 where id = rid;
  perform public.room_system(rid, public.meet_greeting(cat), jsonb_build_object('tpl', 'greet.' || cat));
  if cat = 'mountains' then
    perform public.room_system(rid, 'Горы — это риск. Проверьте прогноз погоды, снаряжение и время возврата. Сообщите близким маршрут. В экстренной ситуации звоните 112.', '{"tpl":"warn.mountains"}');
  end if;
  insert into public.meeting_audit (meeting_id, actor_id, action) values (pid, uid, 'create');
  perform public.meet_schedule(pid, uid);
  return pid;
end $$;

-- публикацию "встреча" можно создать только через create_meeting; лимит — свой
create or replace function public.meetup_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.category = 'meetup' and auth.uid() is not null and current_setting('near.meeting', true) is distinct from '1' then
    raise exception using errcode = 'NR403', message = 'Встречи создаются через форму встречи', hint = 'use_create_meeting';
  end if;
  return new;
end $$;
drop trigger if exists posts_meetup_guard on public.posts;
create trigger posts_meetup_guard before insert on public.posts for each row execute function public.meetup_guard();
update public.app_settings set day_limits = jsonb_set(day_limits, '{meeting}', '[1,3]') where id = 1 and day_limits->'meeting' = '[0,3]'::jsonb;

-- лимит публикаций: встреча расходует свой лимит "meeting", а не "post"
create or replace function public.rate_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'posts' then
    perform public.rate('post'); perform public.rate('post_day');
    if new.is_sos then perform public.rate('sos');
    elsif new.category = 'meetup' then perform public.rate_take('meeting', new.client_key);
    else
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
  elsif tg_table_name = 'reports' then perform public.rate('report');
  elsif tg_table_name = 'likes' then perform public.rate('like');
  end if;
  return new;
end $$;

-- ---------- заявка участника ----------
create or replace function public.request_join(p_meeting uuid, p_note text default null) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); m public.meetings; cur text; st text;
begin
  if uid is null then raise exception using errcode = 'NR401', message = 'Войдите, чтобы подать заявку'; end if;
  if not public.meet_ok(uid) then raise exception using errcode = 'NR403', message = 'Встречи пока доступны только после проверки возраста', hint = 'meet_age'; end if;
  if exists (select 1 from public.profiles where id = uid and (nickname is null or accepted_rules_at is null or not verified)) then
    raise exception using errcode = 'NR403', message = 'Подтвердите почту и заполните никнейм', hint = 'profile_incomplete';
  end if;
  select * into m from public.meetings where id = p_meeting for update;
  if m.id is null then raise exception using errcode = 'NR404', message = 'Встреча не найдена'; end if;
  if m.status <> 'open' or m.starts_at <= now() then raise exception using errcode = 'NR409', message = 'Набор закрыт', hint = 'closed'; end if;
  if public.is_blocked(uid, m.host_id) then raise exception using errcode = 'NR403', message = 'Заявка недоступна'; end if;
  select status into cur from public.meeting_members where meeting_id = p_meeting and user_id = uid;
  if cur in ('accepted','requested','waitlist') then return cur; end if;
  if cur = 'removed' then raise exception using errcode = 'NR403', message = 'Организатор исключил вас из этой встречи', hint = 'removed'; end if;
  st := case when public.meet_accepted_count(p_meeting) >= m.capacity then 'waitlist' else 'requested' end;
  if p_note is not null and public.near_block_reason(p_note) is not null then raise exception using errcode = 'NR422', message = public.near_block_message(public.near_block_reason(p_note)); end if;
  insert into public.meeting_members (meeting_id, user_id, status, note) values (p_meeting, uid, st, nullif(public.near_clean(left(btrim(coalesce(p_note, '')), 200)), ''))
  on conflict (meeting_id, user_id) do update set status = excluded.status, note = excluded.note, created_at = now(), decided_at = null, reason = null;
  perform public.meet_notify(p_meeting, m.host_id, 'meeting_request', 'Новая заявка на "' || m.title || '"', 'req:' || p_meeting || ':' || uid || ':' || extract(epoch from now())::bigint);
  return st;
end $$;

-- ---------- решение Host: транзакция с блокировкой встречи и проверкой мест ----------
create or replace function public.decide_request(p_meeting uuid, p_user uuid, p_accept boolean, p_reason text default null) returns text
language plpgsql security definer set search_path = public as $$
declare m public.meetings; my text := coalesce(public.meet_role(p_meeting, auth.uid()), ''); cur text; nick text;
begin
  if my not in ('host','cohost') then raise exception using errcode = 'NR403', message = 'Решать заявки может организатор'; end if;
  select * into m from public.meetings where id = p_meeting for update;      -- два решения на последнее место: одно успешно
  select status into cur from public.meeting_members where meeting_id = p_meeting and user_id = p_user for update;
  if cur not in ('requested','waitlist') then raise exception using errcode = 'NR409', message = 'Заявка уже рассмотрена', hint = 'decided'; end if;
  if m.status in ('cancelled','finished') or m.ends_at < now() then raise exception using errcode = 'NR409', message = 'Встреча уже завершена или отменена'; end if;
  if not p_accept then
    update public.meeting_members set status = 'declined', decided_at = now(), reason = left(p_reason, 300) where meeting_id = p_meeting and user_id = p_user;
    insert into public.meeting_audit (meeting_id, actor_id, action, target_id, reason) values (p_meeting, auth.uid(), 'decline', p_user, left(p_reason, 300));
    perform public.meet_notify(p_meeting, p_user, 'meeting_declined', 'Заявка на "' || m.title || '" отклонена', 'dec:' || p_meeting || ':' || p_user || ':' || extract(epoch from now())::bigint);
    return 'declined';
  end if;
  if public.meet_accepted_count(p_meeting) >= m.capacity then
    raise exception using errcode = 'NR409', message = 'Свободных мест нет', hint = 'full';
  end if;
  update public.meeting_members set status = 'accepted', decided_at = now(), reason = null where meeting_id = p_meeting and user_id = p_user;
  insert into public.room_members (room_id, user_id, role, notify) values (m.room_id, p_user, 'member', 'all')
  on conflict (room_id, user_id) do update set status = 'active', role = 'member', joined_at = now();
  update public.rooms set members_count = public.meet_accepted_count(p_meeting) where id = m.room_id;
  select nickname into nick from public.profiles where id = p_user;
  perform public.room_system(m.room_id, '@' || coalesce(nick, 'участник') || ' присоединился', jsonb_build_object('tpl', 'joined', 'user', p_user));
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id) values (p_meeting, auth.uid(), 'accept', p_user);
  perform public.meet_notify(p_meeting, p_user, 'meeting_accepted', 'Вас приняли во встречу "' || m.title || '". Чат открыт', 'acc:' || p_meeting || ':' || p_user);
  perform public.meet_schedule(p_meeting, p_user);
  return 'accepted';
end $$;

-- место освободилось: лист ожидания получает уведомление и снова становится заявкой
create or replace function public.meet_free_place(p_meeting uuid) returns void
language plpgsql security definer set search_path = public as $$
declare w record; m public.meetings;
begin
  select * into m from public.meetings where id = p_meeting;
  update public.rooms set members_count = public.meet_accepted_count(p_meeting) where id = m.room_id;
  for w in update public.meeting_members set status = 'requested' where meeting_id = p_meeting and status = 'waitlist' returning user_id loop
    perform public.meet_notify(p_meeting, w.user_id, 'meeting_place', 'Освободилось место во встрече "' || m.title || '"', 'free:' || p_meeting || ':' || w.user_id || ':' || extract(epoch from now())::bigint);
    perform public.meet_notify(p_meeting, m.host_id, 'meeting_request', 'Заявка из листа ожидания на "' || m.title || '"', 'req:' || p_meeting || ':' || w.user_id || ':' || extract(epoch from now())::bigint);
  end loop;
end $$;

-- ---------- исключение: атомарно членство, история, подписка Realtime (RLS) и будущие push ----------
create or replace function public.remove_member(p_meeting uuid, p_user uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; my text := coalesce(public.meet_role(p_meeting, auth.uid()), ''); their text := coalesce(public.meet_role(p_meeting, p_user), '');
begin
  if my not in ('host','cohost') and not public.is_mod() then raise exception using errcode = 'NR403', message = 'Исключать может организатор'; end if;
  if their = '' then raise exception using errcode = 'NR404', message = 'Участник не найден'; end if;
  if their = 'host' or (their = 'cohost' and my <> 'host' and not public.is_mod()) then raise exception using errcode = 'NR403', message = 'Нельзя исключить организатора'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception using errcode = 'NR422', message = 'Укажите причину'; end if;
  select * into m from public.meetings where id = p_meeting for update;
  update public.meeting_members set status = 'removed', role = 'member', reason = left(p_reason, 300), decided_at = now() where meeting_id = p_meeting and user_id = p_user;
  update public.room_members set status = 'removed', muted_until = null where room_id = m.room_id and user_id = p_user;
  update public.outbox set status = 'skipped' where status = 'pending' and user_id = p_user and payload->>'room_id' = m.room_id::text;
  perform public.meet_unschedule(p_meeting, p_user);
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id, reason) values (p_meeting, auth.uid(), 'remove', p_user, left(p_reason, 300));
  perform public.room_system(m.room_id, 'Участник исключен организатором', jsonb_build_object('tpl', 'removed'));
  perform public.meet_notify(p_meeting, p_user, 'meeting_removed', 'Организатор исключил вас из встречи "' || m.title || '". Причина: ' || left(p_reason, 200), 'rm:' || p_meeting || ':' || p_user);
  perform public.meet_free_place(p_meeting);
end $$;

-- отказ участника: за 2 часа и раньше — без штрафа, позже — учитывается как неявка
create or replace function public.leave_meeting(p_meeting uuid) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); m public.meetings; cur text; st text;
begin
  select * into m from public.meetings where id = p_meeting for update;
  select status into cur from public.meeting_members where meeting_id = p_meeting and user_id = uid;
  if cur is null then raise exception using errcode = 'NR404', message = 'Вы не участвуете'; end if;
  if m.host_id = uid then raise exception using errcode = 'NR409', message = 'Организатор не может выйти: передайте роль или отмените встречу', hint = 'host'; end if;
  if cur in ('requested','waitlist') then
    delete from public.meeting_members where meeting_id = p_meeting and user_id = uid; return 'withdrawn';
  end if;
  if cur <> 'accepted' then return cur; end if;
  st := case when m.starts_at - now() >= interval '2 hours' then 'left' else 'left_late' end;
  update public.meeting_members set status = st, role = 'member', decided_at = now() where meeting_id = p_meeting and user_id = uid;
  update public.room_members set status = 'left' where room_id = m.room_id and user_id = uid;
  perform public.meet_unschedule(p_meeting, uid);
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id) values (p_meeting, uid, st, uid);
  perform public.room_system(m.room_id, 'Участник отказался от участия', jsonb_build_object('tpl', 'left'));
  perform public.meet_free_place(p_meeting);
  return st;
end $$;

-- ---------- роли: co-host и передача Host ----------
create or replace function public.set_cohost(p_meeting uuid, p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  if public.meet_role(p_meeting, auth.uid()) <> 'host' then raise exception using errcode = 'NR403', message = 'Назначать co-host может только Host'; end if;
  if coalesce(public.meet_role(p_meeting, p_user), '') not in ('member','cohost') then raise exception using errcode = 'NR404', message = 'Участник не найден'; end if;
  select * into m from public.meetings where id = p_meeting;
  update public.meeting_members set role = case when p_on then 'cohost' else 'member' end where meeting_id = p_meeting and user_id = p_user;
  update public.room_members set role = case when p_on then 'cohost' else 'member' end where room_id = m.room_id and user_id = p_user;
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id) values (p_meeting, auth.uid(), case when p_on then 'cohost_on' else 'cohost_off' end, p_user);
end $$;

create or replace function public.transfer_host(p_meeting uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; old uuid := auth.uid();
begin
  select * into m from public.meetings where id = p_meeting for update;
  if m.host_id is distinct from old then raise exception using errcode = 'NR403', message = 'Передать роль может только Host'; end if;
  if coalesce(public.meet_role(p_meeting, p_user), '') not in ('member','cohost') then raise exception using errcode = 'NR404', message = 'Новый Host должен быть участником встречи'; end if;
  if not public.meet_ok(p_user) then raise exception using errcode = 'NR403', message = 'У участника нет допуска к организации встреч'; end if;
  update public.meetings set host_id = p_user, updated_at = now() where id = p_meeting;
  update public.posts set user_id = p_user where id = p_meeting;
  update public.meeting_members set role = 'host' where meeting_id = p_meeting and user_id = p_user;
  update public.meeting_members set role = 'cohost' where meeting_id = p_meeting and user_id = old;
  update public.room_members set role = 'host' where room_id = m.room_id and user_id = p_user;
  update public.room_members set role = 'cohost' where room_id = m.room_id and user_id = old;
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id) values (p_meeting, old, 'transfer_host', p_user);
  perform public.room_system(m.room_id, 'Организатор передал роль Host', jsonb_build_object('tpl', 'host_changed', 'user', p_user));
end $$;

-- ---------- изменение места/времени, закрыть набор, отменить, завершить ----------
create or replace function public.update_meeting(p_meeting uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; st timestamptz; en timestamptz; moved boolean; u record; why text; nt text;
begin
  if public.meet_role(p_meeting, auth.uid()) not in ('host','cohost') then raise exception using errcode = 'NR403', message = 'Менять встречу может организатор'; end if;
  select * into m from public.meetings where id = p_meeting for update;
  if m.status in ('cancelled','finished') then raise exception using errcode = 'NR409', message = 'Встреча уже завершена или отменена'; end if;
  st := coalesce((p->>'starts_at')::timestamptz, m.starts_at); en := coalesce((p->>'ends_at')::timestamptz, m.ends_at);
  if en <= st or en > st + interval '24 hours' then raise exception using errcode = 'NR422', message = 'Конец позже начала, длительность до 24 часов'; end if;
  if st <> m.starts_at and (st < now() + interval '15 minutes' or st > now() + interval '90 days') then raise exception using errcode = 'NR422', message = 'Новое время: от 15 минут до 90 дней вперед'; end if;
  if p ? 'capacity' and ((p->>'capacity')::int not between 3 and 50 or (p->>'capacity')::int < public.meet_accepted_count(p_meeting)) then
    raise exception using errcode = 'NR422', message = 'Мест не меньше, чем уже принято, и от 3 до 50';
  end if;
  nt := btrim(coalesce(p->>'place_name', ''));
  why := public.near_block_reason(nt);
  if why is not null then raise exception using errcode = 'NR422', message = public.near_block_message(why); end if;
  moved := st <> m.starts_at or en <> m.ends_at or (p ? 'lat');
  update public.meetings set starts_at = st, ends_at = en,
    capacity = coalesce((p->>'capacity')::int, capacity),
    place_name = case when p ? 'place_name' then nullif(public.near_clean(left(nt, 120)), '') else place_name end,
    pin = public.meet_pin(category, details, st, en, coalesce((p->>'capacity')::int, capacity)), updated_at = now()
  where id = p_meeting;
  if p ? 'lat' then update public.posts set lat = (p->>'lat')::float8, lng = (p->>'lng')::float8, expires_at = en + interval '1 hour' where id = p_meeting;
  else update public.posts set expires_at = en + interval '1 hour' where id = p_meeting; end if;
  update public.rooms set pinned = (select pin from public.meetings where id = p_meeting) where id = m.room_id;
  if moved then
    update public.meeting_checkins set closed_at = now() where meeting_id = p_meeting and closed_at is null;   -- перенос закрывает старый запрос готовности
    for u in select user_id from public.meeting_members where meeting_id = p_meeting and status = 'accepted' loop
      perform public.meet_unschedule(p_meeting, u.user_id);
      perform public.meet_schedule(p_meeting, u.user_id);
      if u.user_id <> auth.uid() then
        perform public.meet_notify(p_meeting, u.user_id, 'meeting_changed', 'Встреча "' || m.title || '" изменена: проверьте место и время', 'chg:' || p_meeting || ':' || u.user_id || ':' || extract(epoch from now())::bigint);
      end if;
    end loop;
    perform public.room_system(m.room_id, 'Организатор изменил место или время встречи', jsonb_build_object('tpl', 'moved', 'starts_at', st));
  end if;
  insert into public.meeting_audit (meeting_id, actor_id, action, reason) values (p_meeting, auth.uid(), 'update', left(p::text, 300));
  if p ? 'capacity' then perform public.meet_free_place(p_meeting); end if;
end $$;

create or replace function public.close_recruiting(p_meeting uuid, p_closed boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.meet_role(p_meeting, auth.uid()) not in ('host','cohost') then raise exception using errcode = 'NR403', message = 'Нет прав'; end if;
  update public.meetings set status = case when p_closed then 'closed' else 'open' end, updated_at = now() where id = p_meeting and status in ('open','closed');
  insert into public.meeting_audit (meeting_id, actor_id, action) values (p_meeting, auth.uid(), case when p_closed then 'close' else 'reopen' end);
end $$;

create or replace function public.cancel_meeting(p_meeting uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; u record;
begin
  select * into m from public.meetings where id = p_meeting for update;
  if m.host_id is distinct from auth.uid() and not public.is_mod() then raise exception using errcode = 'NR403', message = 'Отменить может Host'; end if;
  if m.status in ('cancelled','finished') then return; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception using errcode = 'NR422', message = 'Укажите причину отмены'; end if;
  update public.meetings set status = 'cancelled', cancel_reason = left(p_reason, 300), updated_at = now() where id = p_meeting;
  update public.posts set status = 'closed' where id = p_meeting;
  update public.meeting_checkins set closed_at = now() where meeting_id = p_meeting and closed_at is null;
  for u in select user_id from public.meeting_members where meeting_id = p_meeting and status in ('accepted','requested','waitlist') loop
    perform public.meet_unschedule(p_meeting, u.user_id);
    if u.user_id <> m.host_id then
      perform public.meet_notify(p_meeting, u.user_id, 'meeting_cancelled', 'Встреча "' || m.title || '" отменена: ' || left(p_reason, 200), 'cancel:' || p_meeting || ':' || u.user_id);
    end if;
  end loop;
  perform public.room_system(m.room_id, 'Встреча отменена. Причина: ' || left(public.near_clean(p_reason), 200), jsonb_build_object('tpl', 'cancelled'));
  insert into public.meeting_audit (meeting_id, actor_id, action, reason) values (p_meeting, auth.uid(), 'cancel', left(p_reason, 300));
end $$;

create or replace function public.finish_meeting(p_meeting uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  select * into m from public.meetings where id = p_meeting for update;
  if public.meet_role(p_meeting, auth.uid()) not in ('host','cohost') then raise exception using errcode = 'NR403', message = 'Нет прав'; end if;
  if m.starts_at > now() then raise exception using errcode = 'NR409', message = 'Встреча еще не началась'; end if;
  update public.meetings set status = 'finished', ends_at = least(ends_at, now()), updated_at = now() where id = p_meeting and status in ('open','closed');
  update public.meeting_checkins set closed_at = now() where meeting_id = p_meeting and closed_at is null;
  perform public.room_system(m.room_id, 'Встреча завершена. Отметьте посещение и оцените участников в течение 7 дней', jsonb_build_object('tpl', 'finished'));
  insert into public.meeting_audit (meeting_id, actor_id, action) values (p_meeting, auth.uid(), 'finish');
end $$;

-- ---------- готовность: запрос Host/co-host, один изменяемый ответ ----------
create or replace function public.request_checkin(p_meeting uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare m public.meetings; cid uuid; u record;
begin
  if public.meet_role(p_meeting, auth.uid()) not in ('host','cohost') then raise exception using errcode = 'NR403', message = 'Запросить готовность может организатор'; end if;
  select * into m from public.meetings where id = p_meeting for update;
  if m.status in ('cancelled','finished') or m.ends_at < now() then raise exception using errcode = 'NR409', message = 'Встреча уже прошла'; end if;
  if exists (select 1 from public.meeting_checkins where meeting_id = p_meeting and created_at > now() - interval '5 minutes') then
    raise exception using errcode = 'NR429', message = 'Запрос готовности — не чаще раза в 5 минут', hint = 'retry_after=300;action=checkin';
  end if;
  update public.meeting_checkins set closed_at = now() where meeting_id = p_meeting and closed_at is null;
  insert into public.meeting_checkins (meeting_id, created_by, for_start) values (p_meeting, auth.uid(), m.starts_at) returning id into cid;
  insert into public.checkin_answers (checkin_id, user_id, answer) values (cid, auth.uid(), 'ready');
  insert into public.room_messages (room_id, sender_id, kind, body_masked, meta)
  values (m.room_id, auth.uid(), 'checkin', '@all • Подтвердите готовность', jsonb_build_object('checkin_id', cid, 'all', true, 'tpl', 'checkin'));
  update public.rooms set last_message_at = now() where id = m.room_id;
  for u in select user_id from public.meeting_members where meeting_id = p_meeting and status = 'accepted' and user_id <> auth.uid() loop
    perform public.meet_notify(p_meeting, u.user_id, 'meeting_checkin', 'Подтвердите готовность: "' || m.title || '"', 'chk:' || cid || ':' || u.user_id);
  end loop;
  return cid;
end $$;

create or replace function public.answer_checkin(p_checkin uuid, p_answer text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.meeting_checkins;
begin
  select * into c from public.meeting_checkins where id = p_checkin;
  if c.id is null or public.meet_role(c.meeting_id, auth.uid()) is null then raise exception using errcode = 'NR403', message = 'Вы не участник встречи'; end if;
  if c.closed_at is not null then raise exception using errcode = 'NR409', message = 'Запрос закрыт: время встречи изменилось', hint = 'closed'; end if;
  if p_answer not in ('ready','late','cant') then raise exception using errcode = 'NR422', message = 'Неизвестный ответ'; end if;
  insert into public.checkin_answers (checkin_id, user_id, answer) values (p_checkin, auth.uid(), p_answer)
  on conflict (checkin_id, user_id) do update set answer = excluded.answer, updated_at = now();
end $$;

-- ---------- посещение: участник отмечается, Host подтверждает после окончания; спор — ручная проверка ----------
create or replace function public.mark_attended(p_meeting uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  select * into m from public.meetings where id = p_meeting;
  if public.meet_role(p_meeting, auth.uid()) is null then raise exception using errcode = 'NR403', message = 'Вы не участник встречи'; end if;
  if m.starts_at > now() then raise exception using errcode = 'NR409', message = 'Отметиться можно после начала встречи'; end if;
  if m.ends_at < now() - interval '7 days' then raise exception using errcode = 'NR409', message = 'Срок отметки прошел'; end if;
  update public.meeting_members set attended = case when attended = 'noshow' then 'disputed' else coalesce(attended, 'claimed') end
   where meeting_id = p_meeting and user_id = auth.uid() and coalesce(attended, '') <> 'confirmed';
end $$;

create or replace function public.confirm_attendance(p_meeting uuid, p_user uuid, p_came boolean) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; cur text;
begin
  select * into m from public.meetings where id = p_meeting;
  if m.host_id is distinct from auth.uid() then raise exception using errcode = 'NR403', message = 'Подтверждает Host'; end if;
  if m.ends_at > now() and m.status <> 'finished' then raise exception using errcode = 'NR409', message = 'Подтвердить можно после окончания встречи'; end if;
  if m.ends_at < now() - interval '7 days' then raise exception using errcode = 'NR409', message = 'Срок подтверждения прошел'; end if;
  select attended into cur from public.meeting_members where meeting_id = p_meeting and user_id = p_user and status in ('accepted','left_late');
  if not found then raise exception using errcode = 'NR404', message = 'Участник не найден'; end if;
  update public.meeting_members set attended = case
      when p_came then 'confirmed'
      when cur = 'claimed' or cur = 'disputed' then 'disputed'     -- участник говорит "был", Host — "нет": ручная проверка
      else 'noshow' end
   where meeting_id = p_meeting and user_id = p_user;
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id) values (p_meeting, auth.uid(), case when p_came then 'attend_yes' else 'attend_no' end, p_user);
end $$;

-- Host считается пришедшим, если встреча не отменена
create or replace function public.meet_attended(mt uuid, u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.meeting_members mm join public.meetings m on m.id = mm.meeting_id
                  where mm.meeting_id = mt and mm.user_id = u and m.status <> 'cancelled'
                    and (mm.attended = 'confirmed' or (mm.role = 'host' and mm.status = 'accepted'))) $$;

create or replace function public.mod_resolve_attendance(p_meeting uuid, p_user uuid, p_came boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только модератор'; end if;
  update public.meeting_members set attended = case when p_came then 'confirmed' else 'noshow' end where meeting_id = p_meeting and user_id = p_user and attended = 'disputed';
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id, reason) values (p_meeting, auth.uid(), 'attend_resolved', p_user, left(p_note, 300));
end $$;


-- =====================================================================
-- Часть D (раздел 10): отзывы, рейтинг с журналом (ledger), публичный профиль, состояния аккаунта.
-- Score = round(0.30R + 0.25A + 0.25S + 0.10U + 0.10H). Веса — проектные, калибруются по данным пилота.
-- =====================================================================

create table if not exists public.reviews (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.meetings(id) on delete cascade,
  reviewer_id  uuid not null references public.profiles(id) on delete cascade,
  target_id    uuid not null references public.profiles(id) on delete cascade,
  target_role  text not null check (target_role in ('host','member')),
  stars        int not null check (stars between 1 and 5),
  punctual     boolean, respectful boolean, organized boolean,
  comment      text check (comment is null or char_length(comment) <= 500),
  status       text not null default 'ok' check (status in ('ok','hidden')),
  created_at   timestamptz not null default now(),
  unique (reviewer_id, target_id, meeting_id),
  check (reviewer_id <> target_id)          -- без самооценки
);
create index if not exists reviews_target_idx on public.reviews (target_id, target_role);
alter table public.reviews enable row level security;
revoke all on public.reviews from anon, authenticated;
grant select on public.reviews to authenticated;
-- автор видит свой отзыв; цель — только опубликованные (после взаимного отзыва или окончания окна 7 дней)
create or replace function public.review_published(r public.reviews) returns boolean
language sql stable security definer set search_path = public as $$
  select r.status = 'ok' and (
    exists (select 1 from public.reviews x where x.meeting_id = r.meeting_id and x.reviewer_id = r.target_id and x.target_id = r.reviewer_id)
    or (select ends_at from public.meetings where id = r.meeting_id) < now() - interval '7 days') $$;
drop policy if exists reviews_read on public.reviews;
create policy reviews_read on public.reviews for select using (reviewer_id = auth.uid() or public.is_mod() or public.review_published(reviews));

create or replace function public.submit_review(p_meeting uuid, p_target uuid, p_stars int, p_punctual boolean default null,
                                                p_respectful boolean default null, p_organized boolean default null, p_comment text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); m public.meetings; v_id uuid; why text;
begin
  select * into m from public.meetings where id = p_meeting;
  if m.id is null then raise exception using errcode = 'NR404', message = 'Встреча не найдена'; end if;
  if uid = p_target then raise exception using errcode = 'NR422', message = 'Себя оценить нельзя'; end if;
  if m.status = 'cancelled' or (m.ends_at > now() and m.status <> 'finished') then raise exception using errcode = 'NR409', message = 'Оценить можно после окончания встречи'; end if;
  if m.ends_at < now() - interval '7 days' then raise exception using errcode = 'NR409', message = 'Окно отзывов (7 дней) закрыто'; end if;
  if not public.meet_attended(p_meeting, uid) or not public.meet_attended(p_meeting, p_target) then
    raise exception using errcode = 'NR403', message = 'Отзывы оставляют только подтвержденные участники', hint = 'not_attended';
  end if;
  if p_stars is null or p_stars not between 1 and 5 then raise exception using errcode = 'NR422', message = 'Оценка от 1 до 5'; end if;
  if p_comment is not null then
    why := public.near_block_reason(p_comment);
    if why is not null then raise exception using errcode = 'NR422', message = public.near_block_message(why); end if;
  end if;
  insert into public.reviews (meeting_id, reviewer_id, target_id, target_role, stars, punctual, respectful, organized, comment)
  values (p_meeting, uid, p_target, case when p_target = m.host_id then 'host' else 'member' end, p_stars, p_punctual, p_respectful, p_organized,
          nullif(public.near_clean(left(btrim(coalesce(p_comment, '')), 500)), ''))
  on conflict (reviewer_id, target_id, meeting_id) do nothing returning reviews.id into v_id;
  if v_id is null then raise exception using errcode = 'NR409', message = 'Вы уже оценили этого участника', hint = 'duplicate'; end if;
  return v_id;
end $$;

-- ---------- журнал рейтинга: только безопасность (S); идемпотентный ключ, апелляция компенсирует ----------
create table if not exists public.rating_ledger (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  component   text not null default 'S' check (component in ('S')),
  kind        text not null check (kind in ('spam','insult','scam','reversal')),
  delta       int not null,
  decays      boolean not null default true,
  source_key  text not null unique,
  reason      text,
  reverses    bigint references public.rating_ledger(id),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists rating_ledger_user_idx on public.rating_ledger (user_id);
alter table public.rating_ledger enable row level security;
revoke all on public.rating_ledger from anon, authenticated;   -- сырые числа видит только модератор (через RPC)

-- подтвержденное нарушение (решение модератора, а не сама жалоба)
create or replace function public.rating_penalty(p_user uuid, p_kind text, p_source text, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только модератор'; end if;
  if p_kind not in ('spam','insult','scam') then raise exception using errcode = 'NR422', message = 'Тип: spam, insult или scam'; end if;
  insert into public.rating_ledger (user_id, kind, delta, decays, source_key, reason, created_by)
  values (p_user, p_kind, case p_kind when 'spam' then -10 when 'insult' then -15 else -40 end, p_kind <> 'scam', p_source, left(p_reason, 300), auth.uid())
  on conflict (source_key) do nothing returning rating_ledger.id into v_id;
  if p_kind = 'scam' and v_id is not null then
    perform public.mod_restrict(p_user, 'all', 30, 'Мошенничество: ' || left(p_reason, 200));    -- скам: штраф плюс санкция
  end if;
  return v_id;
end $$;
create or replace function public.rating_reverse(p_ledger bigint, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare l public.rating_ledger; v_id bigint;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только модератор'; end if;
  select * into l from public.rating_ledger where rating_ledger.id = p_ledger and kind <> 'reversal';
  if l.id is null then raise exception using errcode = 'NR404', message = 'Запись не найдена'; end if;
  insert into public.rating_ledger (user_id, kind, delta, decays, source_key, reason, reverses, created_by)
  values (l.user_id, 'reversal', -l.delta, false, 'reverse:' || l.id, left(p_reason, 300), l.id, auth.uid())
  on conflict (source_key) do nothing returning rating_ledger.id into v_id;
  return v_id;
end $$;

-- компоненты 0–100
create or replace function public.rating_parts(u uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with rv as (select r.* from public.reviews r where r.target_id = u and public.review_published(r)),
       mm as (select mm.*, m.status ms, m.ends_at from public.meeting_members mm join public.meetings m on m.id = mm.meeting_id
               where mm.user_id = u and m.status <> 'cancelled' and m.ends_at < now()),
       att as (select count(*) filter (where attended = 'confirmed' or (role = 'host' and status = 'accepted')) ok,
                      count(*) filter (where status = 'left_late' or attended = 'noshow') bad,
                      count(*) filter (where (attended = 'confirmed' or (role = 'host' and status = 'accepted'))) meetings
                 from mm where status in ('accepted','left_late')),
       s as (select coalesce(sum(case when l.reverses is not null then 0
                                      when exists (select 1 from public.rating_ledger x where x.reverses = l.id) then 0
                                      when l.decays then l.delta * greatest(0, 1 - extract(epoch from now() - l.created_at) / (90 * 86400))
                                      else l.delta end), 0) d
               from public.rating_ledger l where l.user_id = u),
       lk as (select count(*) n from public.likes k join public.posts p on p.id = k.post_id where p.user_id = u and k.user_id <> u),
       pr as (select created_at from public.profiles where id = u)
  select jsonb_build_object(
    'R', case when (select count(*) from rv) = 0 then null else round((((select avg(stars) from rv) - 1) / 4.0 * 100)::numeric) end,
    'A', case when (select ok + bad from att) = 0 then null else round(100.0 * (select ok from att) / (select ok + bad from att)) end,
    'S', greatest(0, least(100, round(100 + (select d from s)))),
    'U', least(100, round(20 * ln(1 + (select n from lk)))),
    'H', least(100, round(extract(epoch from now() - (select created_at from pr)) / 86400 / 3 + 5 * (select meetings from att))),
    'meetings', (select meetings from att),
    'reviewers', (select count(distinct reviewer_id) from rv)) $$;

-- публичный рейтинг: Host и участник отдельно с количеством отзывов; общий балл — только при ≥5 встреч и ≥3 независимых отзывов
create or replace function public.user_rating(u uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with p as (select public.rating_parts(u) j),
       rv as (select r.* from public.reviews r where r.target_id = u and public.review_published(r))
  select jsonb_build_object(
    'host', jsonb_build_object('avg', (select round(avg(stars)::numeric, 1) from rv where target_role = 'host'), 'count', (select count(*) from rv where target_role = 'host')),
    'member', jsonb_build_object('avg', (select round(avg(stars)::numeric, 1) from rv where target_role = 'member'), 'count', (select count(*) from rv where target_role = 'member')),
    'meetings', (p.j->>'meetings')::int,
    'score', case when (p.j->>'meetings')::int >= 5 and (p.j->>'reviewers')::int >= 3 then
      round(0.30 * coalesce((p.j->>'R')::numeric, 0) + 0.25 * coalesce((p.j->>'A')::numeric, 100) + 0.25 * (p.j->>'S')::numeric
          + 0.10 * (p.j->>'U')::numeric + 0.10 * (p.j->>'H')::numeric) end,
    'enough', (p.j->>'meetings')::int >= 5 and (p.j->>'reviewers')::int >= 3)
  from p $$;

create or replace function public.mod_rating_raw(u uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только модератор'; end if;
  return public.rating_parts(u) || jsonb_build_object('ledger', (select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb) from public.rating_ledger l where l.user_id = u));
end $$;

-- публичный профиль: ник, аватар, подтверждение, лайки, публикации, встречи, рейтинги. Без личных сообщений и дружбы.
create or replace function public.profile_public(u uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', p.id, 'nickname', p.nickname, 'avatar_url', p.avatar_url, 'verified', p.verified, 'bio', p.bio, 'district', p.district,
    'interests', p.interests, 'created_at', p.created_at, 'instagram', public.profile_instagram(p.id),
    'likes', (select count(*) from public.likes k join public.posts x on x.id = k.post_id where x.user_id = p.id and k.user_id <> p.id),
    'posts', (select count(*) from public.posts x where x.user_id = p.id and x.status in ('active','closed') and x.category <> 'meetup'),
    'meetings', (select count(*) from public.meeting_members mm join public.meetings m on m.id = mm.meeting_id
                   where mm.user_id = p.id and m.status <> 'cancelled' and (mm.attended = 'confirmed' or (mm.role = 'host' and mm.status = 'accepted'))),
    'rating', public.user_rating(p.id),
    'blocked', exists (select 1 from public.blocks b where b.blocker_id = auth.uid() and b.blocked_id = p.id))
  from public.profiles p where p.id = u and not p.banned $$;

-- состояние аккаунта: + deleted (запрошено удаление), встречи — отдельный допуск, лимит встреч
create or replace function public.my_account() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p record; pp record; st text; sa public.user_sanctions; can jsonb;
begin
  if auth.uid() is null then return null; end if;
  select * into p from public.profiles where id = auth.uid();
  if p.id is null or exists (select 1 from public.deletion_jobs where user_id = auth.uid() and status <> 'done') then return jsonb_build_object('state', 'deleted'); end if;
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
    'chat', st in ('active','restricted') and public.active_sanction(auth.uid(), 'chat') is null,
    'meet', st = 'active' and public.meet_ok(auth.uid()),
    'report', st <> 'suspended');
  return jsonb_build_object(
    'state', st, 'can', can,
    'age_status', coalesce(pp.age_status, 'unknown'), 'meet_ok', public.meet_ok(auth.uid()),
    'phone_verified', pp.phone_verified_at is not null,
    'nickname_next_change', case when p.nickname_changed_at > now() - interval '30 days' then p.nickname_changed_at + interval '30 days' end,
    'instagram', p.instagram, 'instagram_public', p.instagram_public, 'accepted_rules', p.accepted_rules_at is not null,
    'notify_level', p.notify_level,
    'mod_role', p.is_admin or p.is_moderator, 'mfa_ok', public.mfa_ok(),
    'sanction', case when sa.id is not null then jsonb_build_object('until', sa.until, 'reason', sa.reason) end,
    'limits', jsonb_build_object('post', public.limit_status('post'), 'comment', public.limit_status('comment'), 'meeting', public.limit_status('meeting')),
    'clean_version', (select clean_version from public.app_settings where id = 1),
    'media_ok', true);
end $$;

create or replace function public.set_notify_level(p_level text) returns void
language sql security definer set search_path = public as $$
  update public.profiles set notify_level = p_level where id = auth.uid() and p_level in ('all','important','silent','off') $$;
-- ---------- данные для экранов ----------
-- карточка встречи: без точного GPS при скрытом месте (точку дает posts), участники — только ники
create or replace function public.meeting_get(p_meeting uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', m.id, 'category', m.category, 'title', m.title, 'details', m.details, 'pin', m.pin, 'place_name', m.place_name,
    'starts_at', m.starts_at, 'ends_at', m.ends_at, 'capacity', m.capacity, 'price_kzt', m.price_kzt, 'rules', m.rules,
    'status', case when m.status in ('cancelled','finished') then m.status when m.ends_at < now() then 'finished' when m.starts_at <= now() then 'live' else m.status end,
    'cancel_reason', m.cancel_reason, 'room_id', case when public.meet_role(m.id, auth.uid()) is not null or public.is_mod() then m.room_id end,
    'accepted', public.meet_accepted_count(m.id),
    'host', (select jsonb_build_object('id', p.id, 'nickname', p.nickname, 'avatar_url', p.avatar_url, 'verified', p.verified, 'rating', public.user_rating(p.id))
               from public.profiles p where p.id = m.host_id),
    'my_status', (select status from public.meeting_members where meeting_id = m.id and user_id = auth.uid()),
    'my_role', public.meet_role(m.id, auth.uid()),
    'my_attended', (select attended from public.meeting_members where meeting_id = m.id and user_id = auth.uid()),
    'members', case when public.meet_role(m.id, auth.uid()) is not null or public.is_mod() then
      (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nickname', p.nickname, 'avatar_url', p.avatar_url, 'role', mm.role, 'attended', mm.attended,
                                                    'muted_until', rm.muted_until) order by mm.role = 'host' desc, mm.decided_at), '[]'::jsonb)
         from public.meeting_members mm join public.profiles p on p.id = mm.user_id
         left join public.room_members rm on rm.room_id = m.room_id and rm.user_id = mm.user_id
        where mm.meeting_id = m.id and mm.status = 'accepted') end,
    'requests', case when public.meet_role(m.id, auth.uid()) in ('host','cohost') then
      (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nickname', p.nickname, 'avatar_url', p.avatar_url, 'status', mm.status, 'note', mm.note,
                                                    'rating', public.user_rating(p.id)) order by mm.created_at), '[]'::jsonb)
         from public.meeting_members mm join public.profiles p on p.id = mm.user_id
        where mm.meeting_id = m.id and mm.status in ('requested','waitlist')) end,
    'checkin', case when public.meet_role(m.id, auth.uid()) is not null then
      (select jsonb_build_object('id', c.id, 'created_at', c.created_at,
              'answers', (select coalesce(jsonb_object_agg(a.user_id, a.answer), '{}'::jsonb) from public.checkin_answers a where a.checkin_id = c.id))
         from public.meeting_checkins c where c.meeting_id = m.id and c.closed_at is null) end)
  from public.meetings m
  where m.id = p_meeting and (exists (select 1 from public.posts p where p.id = m.id and p.status in ('active','closed')) or public.meet_role(m.id, auth.uid()) is not null or public.is_mod()) $$;

-- список встреч рядом: категория, дата, радиус, стоимость, свободные места
create or replace function public.meetings_near(p_lat float8, p_lng float8, p_radius int default 10000, p_cats text[] default null,
                                                p_from timestamptz default null, p_to timestamptz default null,
                                                p_free_only boolean default false, p_max_price int default null, p_limit int default 30) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.starts_at), '[]'::jsonb) from (
    select m.id, m.category, m.title, m.pin, m.place_name, m.starts_at, m.ends_at, m.capacity, m.price_kzt, p.lat, p.lng,
           public.meet_accepted_count(m.id) as accepted,
           (select nickname from public.profiles where id = m.host_id) as host,
           (select status from public.meeting_members where meeting_id = m.id and user_id = auth.uid()) as my_status,
           round((6371000 * 2 * asin(sqrt(power(sin(radians(p.lat - p_lat) / 2), 2) + cos(radians(p_lat)) * cos(radians(p.lat)) * power(sin(radians(p.lng - p_lng) / 2), 2))))::numeric) as dist
      from public.meetings m join public.posts p on p.id = m.id
     where m.status = 'open' and m.starts_at > now() and p.status = 'active'
       and (p_cats is null or m.category = any (p_cats))
       and (p_from is null or m.starts_at >= p_from) and (p_to is null or m.starts_at < p_to)
       and (p_max_price is null or coalesce(m.price_kzt, 0) <= p_max_price)
       and (not p_free_only or public.meet_accepted_count(m.id) < m.capacity)
       and p.lat between p_lat - p_radius / 111000.0 and p_lat + p_radius / 111000.0
       and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = m.host_id) or (b.blocker_id = m.host_id and b.blocked_id = auth.uid()))
     order by m.starts_at
     limit least(coalesce(p_limit, 30), 50)) x
  where x.dist <= p_radius $$;

-- мои встречи (создатель, участник, заявки, архив)
create or replace function public.my_meetings() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'category', m.category, 'starts_at', m.starts_at, 'ends_at', m.ends_at,
    'status', case when m.status in ('cancelled','finished') then m.status when m.ends_at < now() then 'finished' else m.status end,
    'my_status', mm.status, 'my_role', mm.role, 'room_id', case when mm.status = 'accepted' then m.room_id end,
    'review_due', mm.status = 'accepted' and m.ends_at < now() and m.ends_at > now() - interval '7 days') order by m.starts_at desc), '[]'::jsonb)
  from public.meeting_members mm join public.meetings m on m.id = mm.meeting_id
  where mm.user_id = auth.uid() and mm.status not in ('declined') $$;

-- =====================================================================
-- Часть E (раздел 04): поля семи типов публикаций, событие с концом, SOS с типом.
-- =====================================================================
alter table public.events add column if not exists ends_at timestamptz;
alter table public.events drop constraint if exists events_ends_check;
alter table public.events add constraint events_ends_check check (ends_at is null or (ends_at > starts_at and ends_at <= starts_at + interval '14 days'));

create or replace function public.post_meta_clean(cat text, m jsonb) returns jsonb
language plpgsql immutable as $$
declare o jsonb := '{}'::jsonb; t text; r text; k text;
begin
  m := coalesce(m, '{}'::jsonb);
  foreach k in array array['title','organizer','org','conditions','price_text','source_name'] loop
    t := btrim(m->>k);
    if t is not null and t <> '' then
      r := public.near_block_reason(t);
      if r is not null then raise exception using errcode = 'NR422', message = public.near_block_message(r), hint = r; end if;
      m := jsonb_set(m, array[k], to_jsonb(public.near_clean(left(t, case k when 'title' then 80 when 'conditions' then 300 else 60 end))));
    end if;
  end loop;
  if cat = 'incident' then
    if m->>'itype' in ('dtp','water','power','gas','heat','road','other') then o := o || jsonb_build_object('itype', m->>'itype'); end if;
    if (m->>'ttl_h') in ('1','3','6','12','24') then o := o || jsonb_build_object('ttl_h', (m->>'ttl_h')::int); end if;
    -- v14.8: время происшествия — не в будущем и не старше суток
    if m ? 'occurred_at' then
      begin
        if (m->>'occurred_at')::timestamptz between now() - interval '24 hours' and now() + interval '5 minutes' then o := o || jsonb_build_object('occurred_at', m->>'occurred_at');
        else raise exception using errcode = 'NR422', message = 'Время происшествия: за последние 24 часа'; end if;
      exception when invalid_datetime_format or datetime_field_overflow then raise exception using errcode = 'NR422', message = 'Проверьте время происшествия'; end;
    end if;
    if m->>'stype' in ('medical','fire','crime','accident','lost_person','other') then o := o || jsonb_build_object('stype', m->>'stype'); end if;
  elsif cat = 'event' then
    -- название обязательно в форме; старые клиенты без поля — название пустое (карточка покажет текст)
    if coalesce(m->>'title', '') <> '' then
      if char_length(m->>'title') < 5 then raise exception using errcode = 'NR422', message = 'Название события: от 5 до 80 символов'; end if;
      o := o || jsonb_build_object('title', m->>'title');
    end if;
    if coalesce(m->>'organizer', '') <> '' then o := o || jsonb_build_object('organizer', m->>'organizer'); end if;
    if (m->>'price_kzt') ~ '^\d{1,7}$' then o := o || jsonb_build_object('price_kzt', (m->>'price_kzt')::int);
    elsif m->>'price_kzt' = 'free' then o := o || jsonb_build_object('price_kzt', 0); end if;
    if public.clean_url(m->>'source_url') is not null then o := o || jsonb_build_object('source_url', m->>'source_url'); end if;
    if coalesce(m->>'conditions', '') <> '' then o := o || jsonb_build_object('conditions', m->>'conditions'); end if;
  elsif cat = 'deal' then
    if coalesce(m->>'conditions', '') <> '' then o := o || jsonb_build_object('conditions', m->>'conditions'); end if;
    if coalesce(m->>'source_name', '') <> '' then o := o || jsonb_build_object('source_name', m->>'source_name'); end if;
    if coalesce(m->>'org', '') <> '' then o := o || jsonb_build_object('org', m->>'org'); end if;
    if coalesce(m->>'price_text', '') <> '' then o := o || jsonb_build_object('price_text', m->>'price_text'); end if;
    if (m->>'until') is not null then
      begin
        if (m->>'until')::timestamptz > now() and (m->>'until')::timestamptz <= now() + interval '14 days' then o := o || jsonb_build_object('until', m->>'until');
        else raise exception using errcode = 'NR422', message = 'Срок акции: от сегодня до 14 дней'; end if;
      exception when invalid_datetime_format or datetime_field_overflow then raise exception using errcode = 'NR422', message = 'Проверьте срок акции'; end;
    end if;
    if public.clean_url(m->>'url') is not null then o := o || jsonb_build_object('url', m->>'url'); end if;
  elsif cat = 'help' then
    if m->>'hkind' in ('need','offer','lost','found','home') then o := o || jsonb_build_object('hkind', m->>'hkind'); else o := o || '{"hkind":"need"}'::jsonb; end if;
  elsif cat = 'meetup' then
    if coalesce(m->>'title', '') <> '' then o := o || jsonb_build_object('title', m->>'title'); end if;
    if m->>'mcat' in ('games','cinema','board','sport','cafe','walk','mountains','study','other') then o := o || jsonb_build_object('mcat', m->>'mcat'); end if;
  elsif cat = 'talk' then
    if m->>'kind' in ('discussion','announcement') then o := o || jsonb_build_object('kind', m->>'kind'); end if;
  elsif cat = 'ad' then
    if coalesce(m->>'price_text', '') <> '' then o := o || jsonb_build_object('price_text', m->>'price_text'); end if;
  end if;
  return o;
end $$;

-- v14.8: угрозы с обратным порядком слов ("тебя убью", "найду где живешь") — тот же список в src/lib/clean.js
create or replace function public.near_is_threat(t text) returns boolean language sql immutable as $$
  select coalesce(replace(lower(translate(t, 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя')), 'ё', 'е')
    ~ '(^|[^а-яa-z])(убью (тебя|вас|его|ее|тебе)|(тебя|вас|его|ее) (убью|прибью|зарежу)|зарежу|пристрелю|задушу (тебя|вас)|урою|тебе конец|найду тебя и|найду,? где (ты )?живешь|приду за тобой|сожгу (тебя|вас|твой|твою|ваш)|i will kill you|i''ll kill you|kill you|өлтіремін)([^а-яa-z]|$)', false) $$;

-- =====================================================================
-- Часть F: права. Service role — только сервер; клиент — только RPC и чтение по RLS.
-- =====================================================================
do $$ declare f text; begin
  -- внутренние функции: не вызываются клиентом
  foreach f in array array[
    'public.outbox_put(uuid, text, text, jsonb, timestamptz)', 'public.outbox_process(int)', 'public.room_system(uuid, text, jsonb, text)',
    'public.meet_schedule(uuid, uuid)', 'public.meet_unschedule(uuid, uuid)', 'public.meet_notify(uuid, uuid, text, text, text)',
    'public.meet_free_place(uuid)', 'public.legacy_dm_refuse()', 'public.meetup_guard()', 'public.rating_parts(uuid)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
  end loop;
  -- для всех, включая гостя: чтение городских данных
  foreach f in array array[
    'public.rooms_list(text, text)', 'public.room_feed(uuid, timestamptz, uuid, int)', 'public.meetings_near(float8, float8, int, text[], timestamptz, timestamptz, boolean, int, int)',
    'public.meeting_get(uuid)', 'public.profile_public(uuid)', 'public.user_rating(uuid)', 'public.meet_pin(text, jsonb, timestamptz, timestamptz, int)',
    'public.room_can_read(uuid)', 'public.room_role(uuid, uuid)', 'public.meet_role(uuid, uuid)', 'public.review_published(public.reviews)'] loop
    execute 'grant execute on function ' || f || ' to anon, authenticated';
  end loop;
  -- действия: только вошедшие
  foreach f in array array[
    'public.join_room(uuid)', 'public.leave_room(uuid)', 'public.room_settings(uuid, text, boolean, boolean)',
    'public.send_message(uuid, text, text, uuid, text, text)', 'public.room_hide_message(uuid, text)', 'public.set_mute(uuid, uuid, int, text)',
    'public.room_slow_mode(uuid, int)', 'public.mod_create_room(text, text, text)',
    'public.create_meeting(jsonb)', 'public.request_join(uuid, text)', 'public.decide_request(uuid, uuid, boolean, text)',
    'public.remove_member(uuid, uuid, text)', 'public.leave_meeting(uuid)', 'public.set_cohost(uuid, uuid, boolean)', 'public.transfer_host(uuid, uuid)',
    'public.update_meeting(uuid, jsonb)', 'public.close_recruiting(uuid, boolean)', 'public.cancel_meeting(uuid, text)', 'public.finish_meeting(uuid)',
    'public.request_checkin(uuid)', 'public.answer_checkin(uuid, text)', 'public.mark_attended(uuid)', 'public.confirm_attendance(uuid, uuid, boolean)',
    'public.mod_resolve_attendance(uuid, uuid, boolean, text)', 'public.submit_review(uuid, uuid, int, boolean, boolean, boolean, text)',
    'public.rating_penalty(uuid, text, text, text)', 'public.rating_reverse(bigint, text)', 'public.mod_rating_raw(uuid)',
    'public.my_meetings()', 'public.set_notify_level(text)', 'public.my_account()'] loop
    execute 'revoke all on function ' || f || ' from public, anon';
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $$;
grant select (notify_level) on public.profiles to authenticated;
grant update (notify_level) on public.profiles to authenticated;

-- уборка: напоминания и уведомления из outbox (каждую минуту — отдельное задание pg_cron, см. SETUP шаг 19)
create or replace function public.near_minutely() returns jsonb
language sql security definer set search_path = public as $$ select public.outbox_process(500) $$;
revoke all on function public.near_minutely() from public, anon, authenticated;
do $$ begin
  perform cron.schedule('near-minutely', '* * * * *', 'select public.near_minutely()');
exception when others then null;   -- без pg_cron: задание добавляется вручную (SETUP, шаг 19)
end $$;

-- ---------- 06: метрики пилота (только админ): непустые ленты, возврат, полезные публикации, жалобы, реакция ----------
create or replace function public.kpi_city(p_days int default 7) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)));
begin
  if not public.is_admin() then raise exception using errcode = 'NR403', message = 'Только администратор'; end if;
  return jsonb_build_object(
    'nonempty_feed_share', (select round(100.0 * count(*) filter (where coalesce((props->>'count')::int, 0) > 0) / nullif(count(*), 0), 1)
                              from public.analytics_events where name = 'feed_loaded' and created_at > since),
    'useful_posts_share', (select round(100.0 * count(*) filter (where likes_count + comments_count > 0) / nullif(count(*), 0), 1)
                              from public.posts where created_at > since and status in ('active','closed') and not official),
    'official_posts', (select count(*) from public.posts where official and created_at > since),
    'meetings_created', (select count(*) from public.meetings where created_at > since),
    'meetings_held', (select count(*) from public.meetings where ends_at between since and now() and status <> 'cancelled'),
    'room_messages', (select count(*) from public.room_messages where created_at > since and sender_id is not null),
    'reports', (select count(*) from public.reports where created_at > since),
    'report_reaction_hours_median', (select round((percentile_cont(0.5) within group (order by extract(epoch from resolved_at - created_at) / 3600))::numeric, 1)
                              from public.reports where created_at > since and resolved_at is not null),
    'retention', (select jsonb_build_object('d1', s->'d1', 'd7', s->'d7') from (select public.kpi_summary() s) x));
exception when undefined_function then
  return jsonb_build_object('error', 'kpi_summary недоступна');
end $$;
revoke all on function public.kpi_city(int) from public, anon;
grant execute on function public.kpi_city(int) to authenticated;
