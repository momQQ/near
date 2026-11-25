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
