
-- ---------- 10. Встречи: Host, co-host, 9 категорий, посещаемость ----------
alter table public.events add column if not exists meet_cat text;
alter table public.events add column if not exists ends_at timestamptz;
alter table public.events add column if not exists host_id uuid references public.profiles(id) on delete set null;
alter table public.events add column if not exists cohost_id uuid references public.profiles(id) on delete set null;
alter table public.events add column if not exists status text not null default 'scheduled';
alter table public.events add column if not exists cancel_reason text;
alter table public.events add column if not exists chat_id uuid;
do $$ begin
  alter table public.events add constraint events_meet_cat_chk check (meet_cat is null or meet_cat in ('sport','games','walk','food','study','creative','volunteer','family','other'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.events add constraint events_status_chk check (status in ('scheduled','cancelled'));
exception when duplicate_object then null; end $$;
update public.events e set host_id = p.user_id from public.posts p where p.id = e.post_id and e.host_id is null;

alter table public.event_members add column if not exists status text not null default 'going';
alter table public.event_members add column if not exists withdrawn_at timestamptz;
alter table public.event_members add column if not exists host_mark boolean;
alter table public.event_members add column if not exists self_mark boolean;
do $$ begin
  alter table public.event_members add constraint event_members_status_chk check (status in ('going','withdrawn','excluded'));
exception when duplicate_object then null; end $$;

create or replace function public.meeting_end(e public.events) returns timestamptz
language sql immutable as $$ select coalesce(e.ends_at, e.starts_at + interval '3 hours') $$;

-- посещаемость: Host не подтверждает спорную в одиночку — при расхождении статус disputed
create or replace function public.attendance(host_mark boolean, self_mark boolean) returns text
language sql immutable as $$
  select case
    when host_mark is null and self_mark is null then 'unknown'
    when host_mark is not null and self_mark is not null and host_mark <> self_mark then 'disputed'
    when coalesce(host_mark, self_mark) then 'attended' else 'missed' end $$;

create or replace function public.is_meeting(p_post uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.posts where id = p_post and category = 'meetup') $$;

-- встречи пилота доступны только допущенным участникам (до возрастной проверки)
create or replace function public.meeting_access() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((public.shield_cfg()->>'meetings_pilot_only')::boolean, true) = false
      or coalesce((select meetings_pilot or is_admin from public.profiles where id = auth.uid()), false) $$;

create or replace function public.meeting_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'posts' then
    if new.category <> 'meetup' or tg_op <> 'INSERT' then return new; end if;
  elsif not public.is_meeting(new.post_id) then return new;
  end if;
  perform public.shield_require('meeting');
  if not public.meeting_access() then
    raise exception using errcode = 'NR403', message = 'Встречи пока доступны только участникам закрытого пилота', hint = 'pilot';
  end if;
  return new;
end $$;
drop trigger if exists posts_meeting_guard on public.posts;
create trigger posts_meeting_guard before insert on public.posts for each row execute function public.meeting_guard();
drop trigger if exists members_meeting_guard on public.event_members;
create trigger members_meeting_guard before insert on public.event_members for each row execute function public.meeting_guard();

-- при создании встречи: Host = автор, свой чат встречи
create or replace function public.meeting_setup() returns trigger
language plpgsql security definer set search_path = public as $$
declare cid uuid; t text;
begin
  if new.host_id is null then select user_id into new.host_id from public.posts where id = new.post_id; end if;
  if public.is_meeting(new.post_id) and new.chat_id is null then
    select left(text, 60) into t from public.posts where id = new.post_id;
    insert into public.group_chats (kind, title, post_id) values ('meeting', t, new.post_id)
    on conflict (post_id) do update set title = excluded.title returning id into cid;
    new.chat_id := cid;
    insert into public.chat_members (chat_id, user_id, role) values (cid, new.host_id, 'host') on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists events_meeting_setup on public.events;
create trigger events_meeting_setup before insert on public.events for each row execute function public.meeting_setup();

-- изменить встречу (время, отмену, co-host) может только Host; глобально заблокировать — никто из организаторов
drop policy if exists "events write" on public.events;
create policy "events write" on public.events for all
  using (exists (select 1 from public.posts p where p.id = post_id and p.user_id = auth.uid()) and not public.is_banned())
  with check (exists (select 1 from public.posts p where p.id = post_id and p.user_id = auth.uid()) and not public.is_banned());

create or replace function public.meeting_role(p_post uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when e.host_id = auth.uid() then 'host' when e.cohost_id = auth.uid() then 'cohost'
              when exists (select 1 from public.event_members m where m.post_id = p_post and m.user_id = auth.uid() and m.status = 'going') then 'member'
              else null end from public.events e where e.post_id = p_post $$;

create or replace function public.meeting_join(p_post uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e record;
begin
  perform public.shield_require('meeting');
  select * into e from public.events where post_id = p_post for update;
  if e.post_id is null or not public.can_see_post(p_post) then raise exception using errcode = 'NR404', message = 'Встреча не найдена'; end if;
  if e.status = 'cancelled' then raise exception using errcode = 'NR409', message = 'Встреча отменена'; end if;
  if e.starts_at < now() then raise exception using errcode = 'NR409', message = 'Встреча уже началась'; end if;
  if exists (select 1 from public.event_members where post_id = p_post and user_id = auth.uid() and status = 'excluded') then
    raise exception using errcode = 'NR403', message = 'Организатор исключил вас из этой встречи', hint = 'excluded';
  end if;
  insert into public.event_members (post_id, user_id, status) values (p_post, auth.uid(), 'going')
  on conflict (post_id, user_id) do update set status = 'going', withdrawn_at = null where public.event_members.status = 'withdrawn';
  if e.chat_id is not null then
    insert into public.chat_members (chat_id, user_id) values (e.chat_id, auth.uid()) on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true, 'chat_id', e.chat_id);
end $$;

-- своевременный отказ (за 2 часа и раньше) не портит посещаемость
create or replace function public.meeting_leave(p_post uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e record;
begin
  select * into e from public.events where post_id = p_post;
  update public.event_members set status = 'withdrawn', withdrawn_at = now()
   where post_id = p_post and user_id = auth.uid() and status = 'going';
  if e.starts_at - now() < interval '2 hours' then
    update public.event_members set withdrawn_at = withdrawn_at where false; -- поздний отказ: учитывается как обязательство в пересчете
  end if;
  delete from public.chat_members where chat_id = e.chat_id and user_id = auth.uid() and role = 'member';
end $$;

-- организатор: исключить участника из СВОЕЙ встречи (не глобальный бан)
create or replace function public.meeting_exclude(p_post uuid, p_user uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare e record;
begin
  perform public.shield_require('write');
  select * into e from public.events where post_id = p_post;
  if auth.uid() not in (e.host_id, e.cohost_id) then raise exception using errcode = 'NR403', message = 'Только организатор встречи'; end if;
  if p_user in (e.host_id, e.cohost_id) then raise exception using errcode = 'NR403', message = 'Нельзя исключить организатора'; end if;
  update public.event_members set status = 'excluded' where post_id = p_post and user_id = p_user;
  delete from public.chat_members where chat_id = e.chat_id and user_id = p_user;
  insert into public.user_bans (user_id, kind, scope, scope_id, rule, reason, moderator_id, source_key)
  values (p_user, 'restricted', 'meeting', p_post, 'minor', coalesce(nullif(btrim(p_reason), ''), 'Исключен организатором встречи'), auth.uid(), 'meet:' || p_post || ':' || p_user)
  on conflict (source_key) do nothing;
  perform public.audit('meeting_exclude', 'user', p_user, jsonb_build_object('meeting', p_post, 'reason', p_reason));
end $$;

create or replace function public.meeting_set_cohost(p_post uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e record;
begin
  perform public.shield_require('write');
  select * into e from public.events where post_id = p_post;
  if e.host_id <> auth.uid() then raise exception using errcode = 'NR403', message = 'Только организатор встречи'; end if;
  if p_user is not null and not exists (select 1 from public.event_members where post_id = p_post and user_id = p_user and status = 'going') then
    raise exception using errcode = 'NR422', message = 'Co-host выбирается из участников';
  end if;
  update public.events set cohost_id = p_user where post_id = p_post;
  if p_user is not null then update public.chat_members set role = 'cohost' where chat_id = e.chat_id and user_id = p_user; end if;
end $$;

create or replace function public.meeting_cancel_internal(p_post uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.events set status = 'cancelled', cancel_reason = p_reason where post_id = p_post and status = 'scheduled';
  insert into public.notifications (user_id, type, post_id, text)
  select m.user_id, 'meeting', p_post, left(p_reason, 200) from public.event_members m where m.post_id = p_post and m.status = 'going';
end $$;
create or replace function public.meeting_cancel(p_post uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if (select host_id from public.events where post_id = p_post) is distinct from auth.uid() and not public.is_mod() then
    raise exception using errcode = 'NR403', message = 'Только организатор встречи';
  end if;
  perform public.meeting_cancel_internal(p_post, coalesce(nullif(btrim(p_reason), ''), 'Организатор отменил встречу'));
end $$;

-- отметки посещаемости: организатор отмечает участников, участник — себя (после начала встречи)
create or replace function public.meeting_mark(p_post uuid, p_user uuid, p_attended boolean) returns text
language plpgsql security definer set search_path = public as $$
declare e record; r record;
begin
  perform public.shield_require('write');
  select * into e from public.events where post_id = p_post;
  if e.starts_at > now() then raise exception using errcode = 'NR409', message = 'Отмечать можно после начала встречи'; end if;
  if coalesce(e.ends_at, e.starts_at + interval '3 hours') + interval '7 days' < now() then raise exception using errcode = 'NR409', message = 'Срок отметок истек'; end if;
  if p_user = auth.uid() then
    update public.event_members set self_mark = p_attended where post_id = p_post and user_id = p_user and status = 'going' returning * into r;
  elsif auth.uid() in (e.host_id, e.cohost_id) then
    update public.event_members set host_mark = p_attended where post_id = p_post and user_id = p_user and status = 'going' returning * into r;
  else
    raise exception using errcode = 'NR403', message = 'Отмечать других может только организатор';
  end if;
  if r.post_id is null then raise exception using errcode = 'NR404', message = 'Участник не найден'; end if;
  if public.attendance(r.host_mark, r.self_mark) = 'disputed' then perform public.queue_add('attendance', p_post, p_user, 'disputed'); end if;
  perform public.rep_recalc(p_user);
  return public.attendance(r.host_mark, r.self_mark);
end $$;

-- ---------- 11. Отзывы после встречи ----------
create table if not exists public.user_reviews (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.posts(id) on delete cascade,
  reviewer_id  uuid not null references public.profiles(id) on delete cascade,
  target_id    uuid not null references public.profiles(id) on delete cascade,
  target_role  text not null check (target_role in ('host','participant')),
  rating       int not null check (rating between 1 and 5),
  tags         text[] not null default '{}',
  comment      text check (comment is null or char_length(comment) <= 500),
  status       text not null default 'visible' check (status in ('visible','pending','hidden')),
  created_at   timestamptz not null default now(),
  unique (meeting_id, reviewer_id, target_id),
  check (reviewer_id <> target_id)
);
create index if not exists user_reviews_target_idx on public.user_reviews (target_id, status);
alter table public.user_reviews enable row level security;
drop policy if exists "reviews read" on public.user_reviews;
create policy "reviews read" on public.user_reviews for select using (
  (status = 'visible' and not public.is_blocked(auth.uid(), reviewer_id)) or reviewer_id = auth.uid() or public.is_mod());
drop trigger if exists user_reviews_clean_comment on public.user_reviews;
create trigger user_reviews_clean_comment before insert or update of comment on public.user_reviews for each row execute function public.clean_guard('comment', 'review');

create or replace function public.member_attended(p_post uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from public.events e where e.post_id = p_post and p_user in (e.host_id, e.cohost_id)) then true
    else coalesce((select public.attendance(m.host_mark, m.self_mark) = 'attended' from public.event_members m
                    where m.post_id = p_post and m.user_id = p_user and m.status = 'going'), false) end $$;

-- кого можно оценить по этой встрече (окно 7 суток после окончания, оба присутствовали)
create or replace function public.review_targets(p_post uuid) returns table (user_id uuid, nickname text, role text, done boolean)
language sql stable security definer set search_path = public as $$
  with e as (select * from public.events where post_id = p_post and status = 'scheduled'
              and public.meeting_end(events) < now() and public.meeting_end(events) + interval '7 days' > now()),
  people as (
    select e.host_id uid, 'host' r from e union select e.cohost_id, 'host' from e where e.cohost_id is not null
    union select m.user_id, 'participant' from public.event_members m join e on e.post_id = m.post_id where m.status = 'going')
  select p.uid, pr.nickname, p.r, exists (select 1 from public.user_reviews r where r.meeting_id = p_post and r.reviewer_id = auth.uid() and r.target_id = p.uid)
    from people p join public.profiles pr on pr.id = p.uid
   where p.uid <> auth.uid() and public.member_attended(p_post, auth.uid()) and public.member_attended(p_post, p.uid) $$;

create or replace function public.review_submit(p_post uuid, p_target uuid, p_rating int, p_tags text[], p_comment text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t record; rv record;
begin
  perform public.shield_require('write');
  select * into t from public.review_targets(p_post) where user_id = p_target;
  if t.user_id is null then
    raise exception using errcode = 'NR403', message = 'Отзыв могут оставить только подтвержденные участники в течение 7 дней после встречи', hint = 'review_closed';
  end if;
  if p_rating not between 1 and 5 then raise exception using errcode = 'NR422', message = 'Поставьте оценку от 1 до 5'; end if;
  perform public.rate('review');
  insert into public.user_reviews (meeting_id, reviewer_id, target_id, target_role, rating, tags, comment)
  values (p_post, auth.uid(), p_target, t.role, p_rating,
          (select coalesce(array_agg(x), '{}') from unnest(coalesce(p_tags, '{}')) x where x in ('punctual','polite','responsible','organized','as_described','team')),
          nullif(left(btrim(coalesce(p_comment, '')), 500), ''))
  on conflict (meeting_id, reviewer_id, target_id) do nothing returning * into rv;
  if rv.id is null then select * into rv from public.user_reviews where meeting_id = p_post and reviewer_id = auth.uid() and target_id = p_target;
    return jsonb_build_object('id', rv.id, 'repeat', true); end if;
  perform public.rep_recalc(p_target);
  return jsonb_build_object('id', rv.id);
end $$;

-- встречи, по которым ждут отзыва (для уведомления "Оцените встречу")
create or replace function public.reviews_pending() returns table (post_id uuid, title text, ended_at timestamptz, left_count int)
language sql stable security definer set search_path = public as $$
  select e.post_id, left(p.text, 80), public.meeting_end(e), (select count(*)::int from public.review_targets(e.post_id) t where not t.done)
    from public.events e join public.posts p on p.id = e.post_id
   where p.category = 'meetup' and e.status = 'scheduled' and public.meeting_end(e) < now() and public.meeting_end(e) + interval '7 days' > now()
     and (e.host_id = auth.uid() or e.cohost_id = auth.uid() or exists (select 1 from public.event_members m where m.post_id = e.post_id and m.user_id = auth.uid() and m.status = 'going'))
     and exists (select 1 from public.review_targets(e.post_id) t where not t.done) $$;

-- ---------- 12. Репутация NEAR Reputation ----------
create table if not exists public.user_reputation (
  user_id          uuid primary key references public.profiles(id) on delete cascade,
  score            int,                 -- null = "Новый участник · недостаточно данных"
  components       jsonb not null default '{}'::jsonb,
  review_count     int not null default 0,
  host_rating      numeric(3,2), host_reviews int not null default 0,
  member_rating    numeric(3,2), member_reviews int not null default 0,
  attendance_pct   int,
  thanks           int not null default 0,
  meetings_done    int not null default 0,
  formula_version  text not null default 'rep-1',
  updated_at       timestamptz not null default now()
);
alter table public.user_reputation enable row level security;
drop policy if exists "rep read" on public.user_reputation;
create policy "rep read" on public.user_reputation for select using (true);

-- R = round(0,30·V + 0,25·A + 0,25·S + 0,10·U + 0,10·H); отсутствующий компонент исключается, веса перенормируются
create or replace function public.rep_formula(v numeric, a numeric, s numeric, u numeric, h numeric) returns int
language sql immutable as $$
  select case when w = 0 then null else round(t / w)::int end from (
    select coalesce(0.30 * v, 0) + coalesce(0.25 * a, 0) + coalesce(0.25 * s, 0) + coalesce(0.10 * u, 0) + coalesce(0.10 * h, 0) t,
           (case when v is null then 0 else 0.30 end) + (case when a is null then 0 else 0.25 end) + (case when s is null then 0 else 0.25 end)
         + (case when u is null then 0 else 0.10 end) + (case when h is null then 0 else 0.10 end) w) x $$;

create or replace function public.rep_level(score int) returns text
language sql immutable as $$
  select case when score is null then 'new' when score >= 90 then 'high' when score >= 75 then 'good' when score >= 50 then 'medium' else 'low' end $$;

create or replace function public.rep_recalc(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  avg_r numeric; n_rev int; n_people int; v numeric; committed int; attended int; a numeric; pen int; s numeric;
  thanks int; useful int; u numeric; months numeric; h numeric; hr numeric; hn int; mr numeric; mn int; done int; sc int;
begin
  select avg(rating), count(*), count(distinct reviewer_id) into avg_r, n_rev, n_people from public.user_reviews where target_id = p_user and status = 'visible';
  v := case when n_rev > 0 then 25 * (avg_r - 1) end;
  select avg(rating), count(*) into hr, hn from public.user_reviews where target_id = p_user and status = 'visible' and target_role = 'host';
  select avg(rating), count(*) into mr, mn from public.user_reviews where target_id = p_user and status = 'visible' and target_role = 'participant';
  -- обязательства: прошедшие неотмененные встречи; своевременный отказ и спорные исключены
  select count(*) filter (where public.attendance(m.host_mark, m.self_mark) in ('attended','missed') and m.status = 'going'),
         count(*) filter (where public.attendance(m.host_mark, m.self_mark) = 'attended' and m.status = 'going')
    into committed, attended
    from public.event_members m join public.events e on e.post_id = m.post_id join public.posts p on p.id = m.post_id
   where m.user_id = p_user and p.category = 'meetup' and e.status = 'scheduled' and public.meeting_end(e) < now();
  a := case when committed > 0 then 100.0 * attended / committed end;
  select count(*) into done from public.events e join public.posts p on p.id = e.post_id
   where p.category = 'meetup' and e.status = 'scheduled' and public.meeting_end(e) < now()
     and (e.host_id = p_user or public.member_attended(e.post_id, p_user));
  -- соблюдение правил: только подтвержденные решения (жалобы без решения не влияют)
  select coalesce(-sum(points), 0) into pen from public.reputation_events where user_id = p_user and kind in ('penalty','reversal');
  s := greatest(0, 100 - pen);
  -- полезность: благодарности (лайки) от разных людей к помощи и находкам, без взаимных серий
  select count(distinct l.user_id) into thanks from public.likes l join public.posts p on p.id = l.post_id
   where p.user_id = p_user and l.user_id <> p_user and p.category in ('lost','found','incident','talk')
     and (select count(*) from public.likes l2 join public.posts p2 on p2.id = l2.post_id
           where l2.user_id = p_user and p2.user_id = l.user_id and l2.created_at > now() - interval '30 days') < 3;
  useful := thanks;
  u := case when useful > 0 then least(100, 40 + 10 * useful) end;
  -- история: только прибавляется со стажем, не уменьшается за неактивность
  select extract(epoch from now() - created_at) / 2592000 into months from public.profiles where id = p_user;
  h := case when months >= 1 then least(100, 50 + 10 * floor(months)) end;
  sc := case when n_people >= 3 and done >= 3 then public.rep_formula(v, a, s, u, h) end;
  insert into public.user_reputation (user_id, score, components, review_count, host_rating, host_reviews, member_rating, member_reviews,
                                      attendance_pct, thanks, meetings_done, formula_version, updated_at)
  values (p_user, sc, jsonb_build_object('V', round(v), 'A', round(a), 'S', round(s), 'U', round(u), 'H', round(h)), n_rev, round(hr, 2), hn, round(mr, 2), mn,
          round(a)::int, thanks, done, coalesce(public.shield_cfg()->>'formula', 'rep-1'), now())
  on conflict (user_id) do update set score = excluded.score, components = excluded.components, review_count = excluded.review_count,
    host_rating = excluded.host_rating, host_reviews = excluded.host_reviews, member_rating = excluded.member_rating, member_reviews = excluded.member_reviews,
    attendance_pct = excluded.attendance_pct, thanks = excluded.thanks, meetings_done = excluded.meetings_done,
    formula_version = excluded.formula_version, updated_at = now();
end $$;

create or replace function public.reputation(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.user_reputation where user_id = p_user;
  if r.user_id is null or r.updated_at < now() - interval '1 hour' then perform public.rep_recalc(p_user); select * into r from public.user_reputation where user_id = p_user; end if;
  return jsonb_build_object('score', r.score, 'level', public.rep_level(r.score), 'review_count', r.review_count,
    'host_rating', r.host_rating, 'host_reviews', r.host_reviews, 'member_rating', r.member_rating, 'member_reviews', r.member_reviews,
    'attendance_pct', r.attendance_pct, 'thanks', r.thanks, 'meetings_done', r.meetings_done, 'formula', r.formula_version,
    'components', case when p_user = auth.uid() then r.components end);
end $$;

-- ---------- 13. Общие чаты (вместо личных сообщений) ----------
create table if not exists public.group_chats (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('city','district','meeting')),
  title       text not null,
  district    text,
  post_id     uuid unique references public.posts(id) on delete cascade,
  created_at  timestamptz not null default now(),
  last_message_at timestamptz,
  unique (kind, district)
);
create table if not exists public.chat_members (
  chat_id           uuid not null references public.group_chats(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  role              text not null default 'member' check (role in ('member','host','cohost')),
  joined_at         timestamptz not null default now(),
  last_read_at      timestamptz not null default now(),
  restricted_until  timestamptz,
  primary key (chat_id, user_id)
);
create table if not exists public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.group_chats(id) on delete cascade,
  sender_id   uuid not null references public.profiles(id) on delete cascade,
  text        text not null check (char_length(text) between 1 and 1000),
  client_key  uuid,
  mod_status  text not null default 'ok' check (mod_status in ('ok','pending','hidden')),
  created_at  timestamptz not null default now(),
  unique (sender_id, client_key)
);
create index if not exists chat_messages_chat_idx on public.chat_messages (chat_id, created_at desc);
alter table public.group_chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;

create unique index if not exists group_chats_one_city on public.group_chats (kind) where kind = 'city';
insert into public.group_chats (kind, title) select 'city', 'Алматы — общий чат' where not exists (select 1 from public.group_chats where kind = 'city');
insert into public.group_chats (kind, title, district)
select 'district', d || ' — чат района', d from unnest(array['Алмалинский район','Бостандыкский район','Медеуский район','Ауэзовский район',
  'Алатауский район','Наурызбайский район','Жетысуский район','Турксибский район']) d on conflict do nothing;

create or replace function public.chat_can_read(p_chat uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.shield_ok() and exists (select 1 from public.group_chats c where c.id = p_chat and
    (c.kind in ('city','district') or exists (select 1 from public.chat_members m where m.chat_id = c.id and m.user_id = auth.uid()) or public.is_mod())) $$;

drop policy if exists "chats read" on public.group_chats;
create policy "chats read" on public.group_chats for select using (public.chat_can_read(id));
drop policy if exists "chat members read" on public.chat_members;
create policy "chat members read" on public.chat_members for select using (public.chat_can_read(chat_id));
drop policy if exists "chat messages read" on public.chat_messages;
-- блокировка между пользователями скрывает историю, превью и счетчики
create policy "chat messages read" on public.chat_messages for select using (
  public.chat_can_read(chat_id) and (mod_status = 'ok' or sender_id = auth.uid() or public.is_mod())
  and not public.is_blocked(auth.uid(), sender_id));

drop trigger if exists chat_messages_clean on public.chat_messages;
create trigger chat_messages_clean before insert or update of text on public.chat_messages for each row execute function public.clean_guard('text', 'chat');
drop trigger if exists chat_messages_profile on public.chat_messages;
create trigger chat_messages_profile before insert on public.chat_messages for each row execute function public.profile_guard();
drop trigger if exists chat_messages_verified on public.chat_messages;
create trigger chat_messages_verified before insert on public.chat_messages for each row execute function public.verified_guard();

-- отправка только через функцию: guard, ограничения чата, лимит 10/мин, повтор с тем же ключом не создает дубль
create or replace function public.chat_send(p_chat uuid, p_text text, p_key uuid) returns public.chat_messages
language plpgsql security definer set search_path = public as $$
declare c record; m record; r public.chat_messages;
begin
  perform public.shield_require('write');
  if p_key is not null then
    select * into r from public.chat_messages where sender_id = auth.uid() and client_key = p_key;
    if r.id is not null then return r; end if;
  end if;
  select * into c from public.group_chats where id = p_chat;
  if c.id is null or not public.chat_can_read(p_chat) then raise exception using errcode = 'NR404', message = 'Чат не найден'; end if;
  if c.kind = 'meeting' and not exists (select 1 from public.chat_members where chat_id = p_chat and user_id = auth.uid()) then
    raise exception using errcode = 'NR403', message = 'Чат встречи — только для участников';
  end if;
  select * into m from public.chat_members where chat_id = p_chat and user_id = auth.uid();
  if m.restricted_until > now() then
    raise exception using errcode = 'NR403', message = 'Организатор ограничил вас в этом чате до ' || to_char(m.restricted_until at time zone 'Asia/Almaty', 'DD.MM HH24:MI'), hint = 'chat_restricted';
  end if;
  if exists (select 1 from public.user_bans where user_id = auth.uid() and scope = 'chat' and scope_id = p_chat and status = 'active' and (expires_at is null or expires_at > now())) then
    raise exception using errcode = 'NR403', message = 'Модератор ограничил вас в этом чате', hint = 'chat_restricted';
  end if;
  perform public.rate('chat');
  if c.kind <> 'meeting' then insert into public.chat_members (chat_id, user_id) values (p_chat, auth.uid()) on conflict do nothing; end if;
  insert into public.chat_messages (chat_id, sender_id, text, client_key) values (p_chat, auth.uid(), p_text, p_key) returning * into r;
  update public.group_chats set last_message_at = r.created_at where id = p_chat;
  update public.chat_members set last_read_at = r.created_at where chat_id = p_chat and user_id = auth.uid();
  return r;
end $$;

-- ответы и реакции в общих чатах
alter table public.chat_messages add column if not exists reply_to uuid references public.chat_messages(id) on delete set null;
create table if not exists public.chat_reactions (
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  emoji      text not null check (emoji in ('❤️','👍','😂','😮','😢','🙏')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
alter table public.chat_reactions enable row level security;
drop policy if exists "reactions read" on public.chat_reactions;
create policy "reactions read" on public.chat_reactions for select using (
  exists (select 1 from public.chat_messages m where m.id = message_id and public.chat_can_read(m.chat_id)));

create or replace function public.chat_react(p_msg uuid, p_emoji text) returns boolean
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  perform public.shield_require('write');
  select * into m from public.chat_messages where id = p_msg and mod_status = 'ok';
  if m.id is null or not public.chat_can_read(m.chat_id) or public.is_blocked(auth.uid(), m.sender_id) then raise exception using errcode = 'NR404', message = 'Сообщение не найдено'; end if;
  if exists (select 1 from public.chat_reactions where message_id = p_msg and user_id = auth.uid() and emoji = p_emoji) then
    delete from public.chat_reactions where message_id = p_msg and user_id = auth.uid() and emoji = p_emoji; return false;
  end if;
  perform public.rate('like');
  insert into public.chat_reactions (message_id, user_id, emoji) values (p_msg, auth.uid(), p_emoji);
  return true;
end $$;

-- страница сообщений: ник, ответ, реакции; блокировка скрывает сообщения и реакции
create or replace function public.chat_page(p_chat uuid, p_before timestamptz default null, p_limit int default 40)
returns table (id uuid, chat_id uuid, sender_id uuid, nickname text, avatar_url text, text text, mod_status text, created_at timestamptz,
               reply_to uuid, reply_nick text, reply_text text, reactions jsonb, mine_reactions text[])
language sql stable security definer set search_path = public as $$
  select m.id, m.chat_id, m.sender_id, p.nickname, p.avatar_url, m.text, m.mod_status, m.created_at,
         m.reply_to, rp.nickname, left(r.text, 80),
         coalesce((select jsonb_object_agg(emoji, n) from (select x.emoji, count(*) n from public.chat_reactions x
                    where x.message_id = m.id and not public.is_blocked(auth.uid(), x.user_id) group by x.emoji) z), '{}'::jsonb),
         coalesce((select array_agg(x.emoji) from public.chat_reactions x where x.message_id = m.id and x.user_id = auth.uid()), '{}')
    from public.chat_messages m join public.profiles p on p.id = m.sender_id
    left join public.chat_messages r on r.id = m.reply_to left join public.profiles rp on rp.id = r.sender_id
   where m.chat_id = p_chat and public.chat_can_read(p_chat) and (m.mod_status = 'ok' or m.sender_id = auth.uid())
     and not public.is_blocked(auth.uid(), m.sender_id) and (p_before is null or m.created_at < p_before)
   order by m.created_at desc limit least(greatest(p_limit, 1), 100) $$;

create or replace function public.chat_send2(p_chat uuid, p_text text, p_key uuid, p_reply uuid default null) returns public.chat_messages
language plpgsql security definer set search_path = public as $$
declare r public.chat_messages;
begin
  r := public.chat_send(p_chat, p_text, p_key);
  if p_reply is not null and r.reply_to is null and exists (select 1 from public.chat_messages where id = p_reply and chat_id = p_chat) then
    update public.chat_messages set reply_to = p_reply where id = r.id returning * into r;
  end if;
  return r;
end $$;

-- организатор встречи ограничивает участника только в чате своей встречи
create or replace function public.chat_restrict(p_chat uuid, p_user uuid, p_hours int) returns void
language plpgsql security definer set search_path = public as $$
declare c record; e record;
begin
  perform public.shield_require('write');
  select * into c from public.group_chats where id = p_chat;
  select * into e from public.events where post_id = c.post_id;
  if c.kind <> 'meeting' or auth.uid() not in (e.host_id, e.cohost_id) then
    if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Ограничивать в чате может организатор встречи или модератор'; end if;
  end if;
  if p_user in (e.host_id, e.cohost_id) then raise exception using errcode = 'NR403', message = 'Нельзя ограничить организатора'; end if;
  insert into public.chat_members (chat_id, user_id) values (p_chat, p_user) on conflict do nothing;
  update public.chat_members set restricted_until = now() + make_interval(hours => least(greatest(p_hours, 1), 720)) where chat_id = p_chat and user_id = p_user;
  perform public.audit('chat_restrict', 'user', p_user, jsonb_build_object('chat', p_chat, 'hours', p_hours));
end $$;

create or replace function public.chat_list() returns table (id uuid, kind text, title text, district text, post_id uuid, last_message_at timestamptz,
  last_text text, last_nick text, unread int, member boolean, role text)
language sql stable security definer set search_path = public as $$
  select c.id, c.kind, c.title, c.district, c.post_id, c.last_message_at,
         lm.text, lm.nickname,
         (select count(*)::int from public.chat_messages x where x.chat_id = c.id and x.mod_status = 'ok' and x.sender_id <> auth.uid()
            and x.created_at > coalesce(m.last_read_at, now()) and not public.is_blocked(auth.uid(), x.sender_id)),
         m.user_id is not null, m.role
    from public.group_chats c
    left join public.chat_members m on m.chat_id = c.id and m.user_id = auth.uid()
    left join lateral (select x.text, pr.nickname from public.chat_messages x join public.profiles pr on pr.id = x.sender_id
                        where x.chat_id = c.id and x.mod_status = 'ok' and not public.is_blocked(auth.uid(), x.sender_id)
                        order by x.created_at desc limit 1) lm on true
   where public.shield_ok() and (c.kind = 'city' or m.user_id is not null
      or (c.kind = 'district' and c.district = (select district from public.profiles where id = auth.uid())))
   order by (c.kind = 'city') desc, c.last_message_at desc nulls last $$;

create or replace function public.chat_read(p_chat uuid) returns void
language sql security definer set search_path = public as $$
  update public.chat_members set last_read_at = now() where chat_id = p_chat and user_id = auth.uid() $$;

do $$ begin
  begin alter publication supabase_realtime add table public.chat_messages; exception when others then null; end;
end $$;

-- личные сообщения в v14.8 убраны: новые переписки и сообщения не создаются, старые доступны только для чтения
create or replace function public.dm_disabled() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not coalesce((public.shield_cfg()->>'dm')::boolean, false) then
    -- переписка, которую создавал бы другой триггер (например, принятая дружба), просто не создается
    if tg_table_name = 'conversations' and pg_trigger_depth() > 1 then return null; end if;
    raise exception using errcode = 'NR403', message = 'Личные сообщения в NEAR отключены. Общайтесь в общих чатах и чатах встреч', hint = 'dm_off';
  end if;
  return new;
end $$;
drop trigger if exists conversations_dm_off on public.conversations;
create trigger conversations_dm_off before insert on public.conversations for each row execute function public.dm_disabled();
drop trigger if exists messages_dm_off on public.messages;
create trigger messages_dm_off before insert on public.messages for each row execute function public.dm_disabled();

-- ---------- 14. Медиа: приватный staging → processing → pending_review → approved ----------
-- Видео обязательно (ТЗ плеера v14.9): публикуется только после серверной обработки и проверки.
update public.app_settings set shield = shield || '{"video": true}'::jsonb where id = 1 and (shield->>'video_decided') is null;
update public.app_settings set shield = shield || '{"video_decided": "player_v14_9"}'::jsonb where id = 1;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-staging', 'post-staging', false, 20971520,
        array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm'])
on conflict (id) do update set public = false, file_size_limit = 20971520, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "staging own write" on storage.objects;
drop policy if exists "staging own read" on storage.objects;
drop policy if exists "staging own delete" on storage.objects;
create policy "staging own write" on storage.objects for insert to authenticated
  with check (bucket_id = 'post-staging' and (storage.foldername(name))[1] = auth.uid()::text and not public.is_banned());
create policy "staging own read" on storage.objects for select to authenticated
  using (bucket_id = 'post-staging' and public.shield_ok() and ((storage.foldername(name))[1] = auth.uid()::text or public.is_mod()));
create policy "staging own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'post-staging' and (storage.foldername(name))[1] = auth.uid()::text);

alter table public.post_media add column if not exists state text not null default 'approved';
alter table public.post_media add column if not exists object_key text;
alter table public.post_media add column if not exists size_bytes bigint;
alter table public.post_media add column if not exists cover_key text;
alter table public.post_media add column if not exists moderation_id text;
alter table public.post_media add column if not exists job_id uuid;
alter table public.post_media add column if not exists edit jsonb not null default '{}'::jsonb;
alter table public.post_media add column if not exists error text;
do $$ begin
  alter table public.post_media add constraint post_media_state_chk check (state in ('uploading','processing','pending_review','approved','rejected','failed'));
exception when duplicate_object then null; end $$;
alter table public.posts add column if not exists publish_requested boolean not null default false;

create table if not exists public.media_jobs (
  id           uuid primary key default gen_random_uuid(),
  media_id     uuid not null unique references public.post_media(id) on delete cascade,   -- одно задание на файл: повтор идемпотентен
  kind         text not null check (kind in ('image','video')),
  status       text not null default 'queued' check (status in ('queued','running','done','failed')),
  attempts     int not null default 0,
  worker       text,
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists media_jobs_queue_idx on public.media_jobs (status, created_at);
alter table public.media_jobs enable row level security;

create or replace function public.media_shield() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then return new; end if;
  if new.type = 'video' and not coalesce((public.shield_cfg()->>'video')::boolean, true) then
    raise exception using errcode = 'NR422', message = 'Видео временно недоступно', hint = 'video_off';
  end if;
  if public.is_banned() then raise exception using errcode = 'NR403', message = 'Действие недоступно', hint = 'banned'; end if;
  select count(*) into n from public.post_media where post_id = new.post_id;
  if n >= 5 then raise exception using errcode = 'NR422', message = 'Не больше 5 вложений', hint = 'media_limit'; end if;
  if new.size_bytes is not null and new.size_bytes > 20971520 then raise exception using errcode = 'NR422', message = 'Файл больше 20 МБ', hint = 'media_size'; end if;
  -- статус и доступ задает только сервер: клиенту не доверяем
  new.state := 'processing'; new.mod_status := 'pending'; new.bucket := 'post-staging';
  new.object_key := coalesce(new.object_key, new.path); new.path := new.object_key;
  new.url := 'private:' || new.object_key; new.thumb_url := null; new.poster_url := null; new.cover_key := null;
  new.checked_at := null; new.moderation_id := null;
  if new.object_key is null or split_part(new.object_key, '/', 1) <> auth.uid()::text then
    raise exception using errcode = 'NR403', message = 'Файл должен быть в вашей папке', hint = 'media_owner';
  end if;
  return new;
end $$;
drop trigger if exists post_media_shield on public.post_media;
create trigger post_media_shield before insert on public.post_media for each row execute function public.media_shield();

-- статус меняет только сервер
create or replace function public.media_state_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_mod() then
    new.state := old.state; new.mod_status := old.mod_status; new.url := old.url; new.bucket := old.bucket;
    new.thumb_url := old.thumb_url; new.poster_url := old.poster_url; new.cover_key := old.cover_key; new.object_key := old.object_key;
  end if;
  new.mod_status := case new.state when 'approved' then 'ok' when 'rejected' then 'flagged' else 'pending' end;
  return new;
end $$;
drop trigger if exists post_media_state_guard on public.post_media;
create trigger post_media_state_guard before update on public.post_media for each row execute function public.media_state_guard();

-- задание обработки создается сразу; фото проверяет функция moderate, видео — изолированный FFmpeg worker
create or replace function public.media_enqueue() returns trigger
language plpgsql security definer set search_path = public as $$
declare jid uuid;
begin
  insert into public.media_jobs (media_id, kind) values (new.id, new.type) on conflict (media_id) do nothing returning id into jid;
  if jid is not null then
    update public.post_media set job_id = jid where id = new.id;
    if new.type = 'image' then perform public.call_fn('moderate', jsonb_build_object('kind', 'media_check', 'id', new.id)); end if;
  end if;
  return null;
end $$;
drop trigger if exists post_media_check on public.post_media;
drop trigger if exists post_media_ai on public.post_media;
drop trigger if exists post_media_enqueue on public.post_media;
create trigger post_media_enqueue after insert on public.post_media for each row execute function public.media_enqueue();

-- публикация атомарная: пост становится видимым, только когда ВСЕ вложения approved
create or replace function public.post_publish_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'active' and old.status = 'draft' and auth.uid() is not null
     and exists (select 1 from public.post_media where post_id = new.id and state <> 'approved') then
    new.status := 'draft'; new.publish_requested := true;
  end if;
  return new;
end $$;
drop trigger if exists posts_publish_guard on public.posts;
create trigger posts_publish_guard before update of status on public.posts for each row execute function public.post_publish_guard();

create or replace function public.media_after_state() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if new.state = old.state then return null; end if;
  select * into p from public.posts where id = new.post_id;
  if new.state = 'approved' and p.status = 'draft' and p.publish_requested
     and not exists (select 1 from public.post_media where post_id = new.post_id and state <> 'approved') then
    perform set_config('near.system', '1', true);
    update public.posts set status = 'active', publish_requested = false, created_at = now() where id = new.post_id;
    insert into public.notifications (user_id, type, post_id, text) values (new.user_id, 'media', new.post_id, 'Публикация прошла проверку и опубликована');
  elsif new.state in ('rejected','failed') then
    insert into public.notifications (user_id, type, post_id, text) values (new.user_id, 'media', new.post_id,
      case new.state when 'rejected' then 'Файл не прошел проверку' || coalesce(': ' || new.error, '') || '. Замените файл или подайте апелляцию'
                     else 'Не удалось обработать файл. Повторите загрузку' end);
  end if;
  return null;
end $$;
drop trigger if exists post_media_after_state on public.post_media;
create trigger post_media_after_state after update of state on public.post_media for each row execute function public.media_after_state();

-- worker забирает задание (SKIP LOCKED: два worker не возьмут одно и то же), повтор до 3 раз
create or replace function public.media_job_claim(p_worker text, p_kind text default 'video') returns jsonb
language plpgsql security definer set search_path = public as $$
declare j record; m record;
begin
  select * into j from public.media_jobs
   where kind = p_kind and (status = 'queued' or (status = 'running' and locked_until < now())) and attempts < 3
   order by created_at for update skip locked limit 1;
  if j.id is null then return null; end if;
  update public.media_jobs set status = 'running', attempts = attempts + 1, worker = p_worker, locked_until = now() + interval '5 minutes', updated_at = now() where id = j.id;
  select * into m from public.post_media where id = j.media_id;
  return jsonb_build_object('job_id', j.id, 'attempt', j.attempts + 1, 'media_id', m.id, 'post_id', m.post_id, 'user_id', m.user_id,
                            'object_key', m.object_key, 'edit', m.edit, 'type', m.type);
end $$;

create or replace function public.media_job_done(p_job uuid, p_state text, p_result jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare j record;
begin
  select * into j from public.media_jobs where id = p_job for update;
  -- повтор отчета ничего не меняет; после pending_review решение принимает модератор (approved/rejected)
  if j.id is null then return; end if;
  if j.status = 'done' and not (p_state in ('approved','rejected') and (select state from public.post_media where id = j.media_id) = 'pending_review'
                                and coalesce(p_result->>'by', '') = 'moderator') then return; end if;
  if p_state = 'retry' then
    update public.media_jobs set status = case when attempts >= 3 then 'failed' else 'queued' end, last_error = left(p_result->>'error', 300), updated_at = now() where id = p_job;
    if j.attempts >= 3 then update public.post_media set state = 'failed', error = left(p_result->>'error', 200) where id = j.media_id; end if;
    insert into public.client_errors (kind, message) select 'media_worker', left(coalesce(p_result->>'error', 'error'), 300) where to_regclass('public.client_errors') is not null;
    return;
  end if;
  if p_state not in ('approved','pending_review','rejected','failed') then raise exception 'bad state'; end if;
  update public.media_jobs set status = case when p_state = 'failed' then 'failed' else 'done' end, updated_at = now() where id = p_job;
  update public.post_media set
    state = p_state, error = p_result->>'error',
    object_key = coalesce(p_result->>'object_key', object_key), cover_key = coalesce(p_result->>'cover_key', cover_key),
    url = coalesce(p_result->>'url', url), poster_url = coalesce(p_result->>'poster_url', poster_url), thumb_url = coalesce(p_result->>'thumb_url', thumb_url),
    bucket = coalesce(p_result->>'bucket', bucket), duration = coalesce((p_result->>'duration')::real, duration),
    w = coalesce((p_result->>'w')::int, w), h = coalesce((p_result->>'h')::int, h), size_bytes = coalesce((p_result->>'size')::bigint, size_bytes),
    moderation_id = coalesce(p_result->>'moderation_id', moderation_id), checked_at = now()
  where id = j.media_id;
  if p_state = 'pending_review' then
    perform public.queue_add('post_media', j.media_id, (select user_id from public.post_media where id = j.media_id),
      case when p_result->>'reason' in ('intimate','minors') then p_result->>'reason' else 'media_review' end);
  end if;
end $$;

-- решение модератора по медиа: публикация копирует файл из staging в публичный бакет (делает функция moderate)
create or replace function public.media_decide(p_media uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  if p_approve then
    perform public.call_fn('moderate', jsonb_build_object('kind', 'media_publish', 'id', p_media));
  else
    update public.post_media set state = 'rejected', error = 'Отклонено модератором' where id = p_media;
  end if;
  update public.moderation_queue set status = 'decided', decision = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now()
   where content_type = 'post_media' and content_id = p_media;
  perform public.audit('media_decide', 'media', p_media, jsonb_build_object('approve', p_approve));
end $$;

-- повторить обработку своего файла (после сбоя) — без дубля задания
create or replace function public.media_retry(p_media uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.shield_require('write');
  update public.media_jobs set status = 'queued', attempts = 0, updated_at = now()
   where media_id = p_media and status = 'failed' and exists (select 1 from public.post_media m where m.id = p_media and m.user_id = auth.uid());
  update public.post_media set state = 'processing', error = null where id = p_media and user_id = auth.uid() and state = 'failed';
end $$;

-- просмотр видео: после 3 секунд видимого воспроизведения, уникальные зрители за сутки
create table if not exists public.media_views (
  media_id uuid not null references public.post_media(id) on delete cascade,
  viewer   text not null,
  day      date not null default (now() at time zone 'Asia/Almaty')::date,
  watched  real not null default 0,
  primary key (media_id, viewer, day)
);
alter table public.media_views enable row level security;
create or replace function public.media_view(p_media uuid, p_seconds real) returns void
language sql security definer set search_path = public as $$
  insert into public.media_views (media_id, viewer, watched)
  select p_media, coalesce(auth.uid()::text, public.req_ip_hash(), 'anon'), least(greatest(p_seconds, 0), 60)
   where p_seconds >= 3 and exists (select 1 from public.post_media where id = p_media and state = 'approved')
  on conflict (media_id, viewer, day) do update set watched = greatest(media_views.watched, excluded.watched) $$;
create or replace function public.media_stats(p_post uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('views', count(*), 'avg_seconds', round(avg(watched)::numeric, 1))
    from public.media_views v join public.post_media m on m.id = v.media_id
   where m.post_id = p_post and exists (select 1 from public.posts p where p.id = p_post and (p.user_id = auth.uid() or public.is_mod())) $$;

-- ---------- 15. Защита закрытых данных: только актуальная сессия ----------
create or replace function public.is_participant(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.shield_ok() and exists (select 1 from public.conversations c where c.id = conv and auth.uid() in (c.user_a, c.user_b)) $$;
drop policy if exists "notifs read" on public.notifications;
create policy "notifs read" on public.notifications for select using (auth.uid() = user_id and public.shield_ok());

-- подписка на push только с актуальной сессией и без бана
create or replace function public.push_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and public.is_banned() then
    raise exception using errcode = 'NR403', message = 'Уведомления недоступны', hint = 'banned';
  end if;
  return new;
end $$;
drop trigger if exists push_subs_guard on public.push_subs;
create trigger push_subs_guard before insert or update on public.push_subs for each row execute function public.push_guard();

-- жалобы на сообщения общих чатов и отзывы
do $$ begin
  alter table public.reports drop constraint if exists reports_target_type_check;
  alter table public.reports add constraint reports_target_type_check check (target_type in ('post','user','message','comment','chat_message','review'));
end $$;
alter table public.reports add column if not exists priority int not null default 3;
create or replace function public.report_priority() returns trigger
language plpgsql as $$
begin
  if new.reason in ('threat','threats','intimate','minors','угрозы','интимный контент') then new.priority := 1;
    perform public.queue_add(new.target_type, new.target_id, new.target_user, case when new.reason in ('minors') then 'minors' when new.reason in ('intimate','интимный контент') then 'intimate' else 'threat' end);
  end if;
  return new;
end $$;
drop trigger if exists reports_priority on public.reports;
create trigger reports_priority before insert on public.reports for each row execute function public.report_priority();

-- ---------- 16. Карточка решения для администратора ----------
create or replace function public.shield_overview() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  return jsonb_build_object(
    'active_bans', (select count(distinct user_id) from public.user_bans where status = 'active' and kind = 'ban' and scope = 'global' and (expires_at is null or expires_at > now())),
    'evasion', (select count(*) from public.account_links where review_status = 'pending'),
    'appeals', (select count(*) from public.ban_appeals where status in ('pending','in_review')),
    'reports', (select count(*) from public.reports where status = 'open'),
    'queue', (select count(*) from public.moderation_queue where status = 'open' and (public.is_admin() or not restricted)),
    'overdue_appeals', (select count(*) from public.ban_appeals where status in ('pending','in_review') and due_at < now()));
end $$;

create or replace function public.shield_find(p_q text) returns table (id uuid, nickname text, name text, state text, risk int, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  return query select p.id, p.nickname, p.name, public.account_state(p.id)->>'state', public.risk_score(p.id), p.created_at
    from public.profiles p
   where p_q is null or p_q = '' or p.nickname ilike public.nick_norm(p_q) || '%' or p.id::text = btrim(p_q)
   order by p.created_at desc limit 20;
end $$;

create or replace function public.shield_user_card(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p record; st jsonb;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  select id, nickname, name, created_at, verified into p from public.profiles where id = p_user;
  if p.id is null then raise exception using errcode = 'NR404', message = 'Пользователь не найден'; end if;
  st := public.account_state(p_user);
  perform public.audit('view_user_card', 'user', p_user, '{}'::jsonb);
  return jsonb_build_object(
    'user', to_jsonb(p), 'account', st, 'reputation', public.reputation(p_user),
    'risk', public.risk_score(p_user), 'hold', public.risk_hold_active(p_user),
    'risk_events', (select coalesce(jsonb_agg(jsonb_build_object('type', event_type, 'weight', weight, 'confirmed', confirmed, 'at', created_at) order by created_at desc), '[]')
                      from public.risk_events where user_id = p_user and status = 'active' and (expires_at is null or expires_at > now())),
    'reports', jsonb_build_object(
      'total', (select count(*) from public.reports where target_user = p_user or (target_type = 'user' and target_id = p_user)),
      'confirmed', (select count(*) from public.reports where (target_user = p_user or target_id = p_user) and status = 'resolved'),
      'rejected', (select count(*) from public.reports where (target_user = p_user or target_id = p_user) and status = 'dismissed'),
      'open', (select count(*) from public.reports where (target_user = p_user or target_id = p_user) and status = 'open')),
    'links', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'candidate', l.candidate_id, 'nickname', c.nickname, 'evidence', l.evidence, 'status', l.review_status)), '[]')
                from public.account_links l join public.profiles c on c.id = l.candidate_id where l.account_id = p_user),
    'decisions', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'no', b.decision_no, 'kind', b.kind, 'scope', b.scope, 'rule', b.rule, 'reason', b.reason,
                     'starts_at', b.starts_at, 'expires_at', b.expires_at, 'status', b.status, 'moderator', m.nickname) order by b.created_at desc), '[]')
                    from public.user_bans b left join public.profiles m on m.id = b.moderator_id where b.user_id = p_user),
    'appeals', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'ban', a.ban_id, 'message', a.message, 'status', a.status, 'due_at', a.due_at) order by a.created_at desc), '[]')
                  from public.ban_appeals a where a.user_id = p_user),
    'sessions', (select coalesce(jsonb_agg(jsonb_build_object('device', device_label, 'status', status, 'at', created_at) order by created_at desc), '[]')
                   from (select * from public.user_sessions where user_id = p_user order by created_at desc limit 5) s),
    'rules', public.ban_rules());
end $$;

create or replace function public.shield_queue() returns table (id uuid, content_type text, content_id uuid, user_id uuid, nickname text, reason text, priority int, created_at timestamptz, preview text)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  return query
  select q.id, q.content_type, q.content_id, q.user_id, p.nickname, q.reason, q.priority, q.created_at,
         case q.content_type
           when 'posts' then (select left(text, 160) from public.posts where posts.id = q.content_id)
           when 'comments' then (select left(text, 160) from public.comments where comments.id = q.content_id)
           when 'chat_messages' then (select left(text, 160) from public.chat_messages where chat_messages.id = q.content_id)
           when 'appeal' then (select left(message, 160) from public.ban_appeals where ban_appeals.id = q.content_id)
           else null end
    from public.moderation_queue q left join public.profiles p on p.id = q.user_id
   where q.status = 'open' and (public.is_admin() or not q.restricted)
   order by q.priority, q.created_at limit 100;
end $$;

create or replace function public.audit_list(p_target uuid default null) returns setof public.security_audit_log
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_auditor() then raise exception using errcode = 'NR403', message = 'Только для аудита'; end if;
  return query select * from public.security_audit_log where p_target is null or target_id = p_target order by id desc limit 200;
end $$;

-- модераторские действия v11 тоже пишутся в аудит
create or replace function public.mod_actions_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.security_audit_log (actor_id, action, target_type, target_id, details)
  values (new.moderator_id, 'mod_' || new.action, new.target_type, new.target_id, jsonb_build_object('note', new.note));
  return new;
end $$;
drop trigger if exists mod_actions_to_audit on public.mod_actions;
create trigger mod_actions_to_audit after insert on public.mod_actions for each row execute function public.mod_actions_audit();

-- ---------- 17. Сроки хранения ----------
create or replace function public.shield_cleanup() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a int; b int; c int;
begin
  -- сырые сигналы — 30 дней
  update public.user_sessions set ip_hash = null where ip_hash is not null and created_at < now() - interval '30 days';
  get diagnostics a = row_count;
  delete from public.session_challenges where created_at < now() - interval '30 days';
  delete from public.clean_recent where created_at < now() - interval '1 day';
  delete from public.risk_events where not confirmed and expires_at < now() - interval '30 days'; get diagnostics b = row_count;
  -- журнал решений — 180 дней после завершения
  perform set_config('near.audit_purge', '1', true);
  delete from public.security_audit_log where created_at < now() - interval '180 days'
    and (target_id is null or not exists (select 1 from public.user_bans u where u.user_id = target_id and u.status = 'active'
         and (u.expires_at is null or u.expires_at > now() - interval '180 days')));
  get diagnostics c = row_count;
  -- уведомления "Оцените встречу" — один раз на встречу
  insert into public.notifications (user_id, type, post_id, text)
  select x.uid, 'review', x.post_id, 'Встреча завершена. Оцените участников'
    from (select e.post_id, e.host_id uid from public.events e join public.posts p on p.id = e.post_id
           where p.category = 'meetup' and e.status = 'scheduled' and public.meeting_end(e) between now() - interval '1 day' and now()
          union select m.post_id, m.user_id from public.event_members m join public.events e on e.post_id = m.post_id join public.posts p on p.id = m.post_id
           where p.category = 'meetup' and m.status = 'going' and e.status = 'scheduled' and public.meeting_end(e) between now() - interval '1 day' and now()) x
   where not exists (select 1 from public.notifications n where n.user_id = x.uid and n.post_id = x.post_id and n.type = 'review');
  return jsonb_build_object('ip_cleared', a, 'risk_deleted', b, 'audit_deleted', c);
end $$;

-- ---------- 18. Права: SECURITY DEFINER с фиксированным search_path, минимальные grants ----------
revoke all on public.shield_secret, public.clean_recent, public.session_challenges from public, anon, authenticated;
grant select on public.security_audit_log, public.user_devices, public.user_sessions, public.user_bans, public.risk_events, public.risk_holds,
  public.account_links, public.ban_appeals, public.reputation_events, public.moderation_queue, public.user_reviews,
  public.group_chats, public.chat_members, public.chat_messages, public.chat_reactions, public.device_restrictions to authenticated;
grant select on public.user_reputation to anon, authenticated;
revoke insert, update, delete on public.security_audit_log, public.user_bans, public.risk_events, public.risk_holds, public.account_links,
  public.ban_appeals, public.reputation_events, public.moderation_queue, public.user_reviews, public.user_sessions, public.user_devices,
  public.chat_messages, public.chat_members, public.group_chats, public.chat_reactions, public.user_reputation, public.device_restrictions from anon, authenticated;
grant execute on function public.session_begin(text, text), public.session_confirm(uuid, text), public.session_resend(uuid), public.session_cancel(),
  public.session_end(), public.session_state(), public.session_list(), public.account_state(uuid), public.my_decisions(),
  public.appeal_submit(uuid, text), public.nickname_available(text), public.reputation(uuid), public.review_targets(uuid),
  public.review_submit(uuid, uuid, int, text[], text), public.reviews_pending(), public.meeting_join(uuid), public.meeting_leave(uuid),
  public.meeting_exclude(uuid, uuid, text), public.meeting_set_cohost(uuid, uuid), public.meeting_cancel(uuid, text),
  public.meeting_mark(uuid, uuid, boolean), public.meeting_role(uuid), public.chat_send(uuid, text, uuid), public.chat_restrict(uuid, uuid, int),
  public.chat_list(), public.chat_read(uuid), public.chat_react(uuid, text), public.chat_page(uuid, timestamptz, int), public.chat_send2(uuid, text, uuid, uuid), public.staff_role(), public.shield_sanction(uuid, text, text, int, text, text, text, text, uuid),
  public.shield_revoke(uuid, text), public.shield_extend(uuid, int, text), public.shield_link_decide(uuid, boolean, text),
  public.risk_decide(uuid, boolean, text), public.appeal_take(uuid), public.appeal_decide(uuid, boolean, text), public.shield_overview(),
  public.shield_find(text), public.shield_user_card(uuid), public.shield_queue(), public.audit_list(uuid), public.media_decide(uuid, boolean),
  public.media_retry(uuid), public.media_view(uuid, real), public.media_stats(uuid),
  public.clean_text(text, text), public.session_ok(), public.shield_ok(), public.is_auditor(), public.chat_can_read(uuid),
  public.member_attended(uuid, uuid), public.is_meeting(uuid), public.meeting_access()
  to authenticated;
grant execute on function public.nickname_available(text), public.reputation(uuid), public.account_state(uuid), public.session_state(), public.clean_text(text, text), public.media_view(uuid, real) to anon;
revoke all on public.media_jobs, public.media_views from anon, authenticated;
revoke execute on function public.shield_hash(text), public.risk_add(uuid, text, text, boolean, jsonb), public.risk_on_register(uuid, text),
  public.shield_revoke_internal(uuid, text), public.meeting_cancel_internal(uuid, text), public.queue_add(text, uuid, uuid, text),
  public.ban_sync(uuid), public.audit(text, text, uuid, jsonb), public.revoke_auth_session(uuid), public.session_reauth_mark(uuid, uuid),
  public.rep_recalc(uuid), public.shield_cleanup(), public.clean_guard(), public.nick_guard(), public.dm_disabled(), public.media_shield(),
  public.meeting_guard(), public.meeting_setup(), public.push_guard(), public.media_state_guard(), public.media_enqueue(), public.post_publish_guard(), public.media_after_state(),
  public.media_job_claim(text, text), public.media_job_done(uuid, text, jsonb), public.on_password_change(), public.mod_actions_audit(), public.audit_immutable()
  from public, anon, authenticated;
-- Готово ✅ v14.9 NEAR Shield

-- удаление аккаунта: встречи передаются co-host или отменяются с уведомлением, членство в чатах снимается,
-- файлы в приватном staging удаляет функция delete-account (папка пользователя)
create or replace function public.account_predelete(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m record; moved int := 0; cancelled int := 0;
begin
  for m in select e.post_id, e.cohost_id from public.events e where e.host_id = p_user and e.status = 'scheduled' and e.starts_at > now() loop
    if m.cohost_id is not null and public.ban_level(m.cohost_id) = 0 then
      update public.events set host_id = m.cohost_id, cohost_id = null where post_id = m.post_id;
      update public.posts set user_id = m.cohost_id where id = m.post_id;     -- встреча не исчезает вместе с автором
      insert into public.notifications (user_id, type, post_id, text) values (m.cohost_id, 'meeting', m.post_id, 'Вы стали организатором встречи');
      moved := moved + 1;
    else
      perform public.meeting_cancel_internal(m.post_id, 'Встреча отменена: организатор удалил аккаунт');
      cancelled := cancelled + 1;
    end if;
  end loop;
  delete from public.chat_members where user_id = p_user;
  update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'deleted' where user_id = p_user and status <> 'revoked';
  insert into public.security_audit_log (actor_id, action, target_type, target_id, details) values (p_user, 'account_delete', 'user', p_user, jsonb_build_object('moved', moved, 'cancelled', cancelled));
  return jsonb_build_object('moved', moved, 'cancelled', cancelled);
end $$;
revoke execute on function public.account_predelete(uuid) from public, anon, authenticated;
