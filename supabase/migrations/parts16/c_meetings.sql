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

