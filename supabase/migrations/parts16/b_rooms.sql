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
