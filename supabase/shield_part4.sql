
-- ---------- 8. Risk Score (виден только уполномоченным) ----------
create table if not exists public.risk_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  event_type  text not null check (event_type in ('evasion','mass_reg','violation','suspicious')),
  weight      int not null check (weight between 0 and 100),
  source_key  text not null,                    -- один источник не начисляется дважды
  confirmed   boolean not null default false,
  status      text not null default 'active' check (status in ('active','dismissed')),
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  unique (user_id, event_type, source_key)
);
alter table public.risk_events enable row level security;
drop policy if exists "risk read" on public.risk_events;
create policy "risk read" on public.risk_events for select using (public.is_mod());

create table if not exists public.risk_holds (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  started_at  timestamptz not null default now(),
  until       timestamptz not null,
  reason      text not null,
  decided_by  uuid references public.profiles(id) on delete set null,
  decided_at  timestamptz
);
create index if not exists risk_holds_user_idx on public.risk_holds (user_id, until desc);
alter table public.risk_holds enable row level security;
drop policy if exists "holds read" on public.risk_holds;
create policy "holds read" on public.risk_holds for select using (public.is_mod());

create or replace function public.risk_score(p_user uuid) returns int
language plpgsql stable security definer set search_path = public as $$
declare s int; w jsonb := public.shield_cfg()->'weights'; l jsonb; k text; n int; susp boolean := false;
begin
  if p_user is null then return 0; end if;
  select coalesce(sum(weight), 0) into s from public.risk_events
   where user_id = p_user and status = 'active' and (expires_at is null or expires_at > now());
  -- подозрительная активность считается по факту: лимит исчерпан хотя бы по одному действию за сутки
  select limits into l from public.app_settings where id = 1;
  for k in select jsonb_object_keys(l) loop
    exit when susp;
    if k in ('log','push_sub','nick') then continue; end if;
    select count(*) into n from public.rate_events where kind = k and user_id = p_user and created_at > now() - ((l->k->>2)::interval);
    if n >= (l->k->>0)::int then susp := true; end if;
  end loop;
  if susp and not exists (select 1 from public.risk_events where user_id = p_user and event_type = 'suspicious' and status = 'active' and (expires_at is null or expires_at > now())) then
    s := s + coalesce((w->>'suspicious')::int, 12);
  end if;
  return least(100, s);
end $$;

create or replace function public.risk_hold_active(p_user uuid default null) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.risk_holds where user_id = coalesce(p_user, auth.uid()) and until > now() and decided_at is null) $$;

-- новое событие риска; при 75+ — ограничение рискованных действий максимум на 24 ч до ручного решения
create or replace function public.risk_add(p_user uuid, p_type text, p_key text, p_confirmed boolean default false, p_details jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare c jsonb := public.shield_cfg(); w int; ins boolean;
begin
  w := coalesce((c->'weights'->>p_type)::int, 10);
  insert into public.risk_events (user_id, event_type, weight, source_key, confirmed, details, expires_at)
  values (p_user, p_type, w, p_key, p_confirmed, p_details,
          case when p_confirmed then now() + interval '180 days' else now() + make_interval(days => coalesce((c->'risk'->>'unconfirmed_days')::int, 7)) end)
  on conflict (user_id, event_type, source_key) do nothing;
  get diagnostics ins = row_count;
  if ins and public.risk_score(p_user) >= coalesce((c->'risk'->>'hold')::int, 75) and not public.risk_hold_active(p_user) then
    insert into public.risk_holds (user_id, until, reason)
    values (p_user, now() + make_interval(hours => coalesce((c->'risk'->>'hold_hours')::int, 24)), 'risk_score');
    perform public.queue_add('user', p_user, p_user, 'risk_hold');
  end if;
end $$;

-- сигналы при первой регистрации: совпадение установки с действующим баном, массовые регистрации из одной сети.
-- Общий IP сам по себе никого не блокирует: только вес 20 и проверка.
create table if not exists public.account_links (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.profiles(id) on delete cascade,
  candidate_id   uuid not null references public.profiles(id) on delete cascade,
  evidence       jsonb not null default '{}'::jsonb,
  review_status  text not null default 'pending' check (review_status in ('pending','confirmed','rejected')),
  reviewed_by    uuid references public.profiles(id) on delete set null,
  reviewed_at    timestamptz,
  note           text,
  created_at     timestamptz not null default now(),
  unique (account_id, candidate_id)
);
alter table public.account_links enable row level security;
drop policy if exists "links read" on public.account_links;
create policy "links read" on public.account_links for select using (public.is_mod());

create or replace function public.risk_on_register(p_user uuid, p_inst text) returns void
language plpgsql security definer set search_path = public as $$
declare cand record; iph text := public.req_ip_hash(); n int;
begin
  for cand in
    select distinct d.user_id from public.user_devices d
     where d.installation_hash = p_inst and d.user_id <> p_user and public.ban_level(d.user_id) = 2
  loop
    insert into public.account_links (account_id, candidate_id, evidence)
    values (p_user, cand.user_id, jsonb_build_object('match', 'installation')) on conflict do nothing;
    perform public.risk_add(p_user, 'evasion', 'inst:' || cand.user_id, false, jsonb_build_object('candidate', cand.user_id));
  end loop;
  if exists (select 1 from public.device_restrictions where installation_hash = p_inst and (expires_at is null or expires_at > now()) and review_status <> 'rejected') then
    perform public.risk_add(p_user, 'evasion', 'device_restriction', false, '{}'::jsonb);
  end if;
  -- ограниченная регистрация при совпадении с баном: рискованные действия на проверке до решения модератора (не больше 24 ч)
  if exists (select 1 from public.account_links where account_id = p_user and review_status = 'pending') and not public.risk_hold_active(p_user) then
    insert into public.risk_holds (user_id, until, reason) values (p_user, now() + interval '24 hours', 'evasion_suspect');
    perform public.queue_add('user', p_user, p_user, 'evasion');
  end if;
  if iph is not null then
    select count(distinct user_id) into n from public.user_sessions
     where ip_hash = iph and created_at > now() - interval '1 hour' and user_id <> p_user
       and user_id in (select id from public.profiles where created_at > now() - interval '1 hour');
    if n >= 3 then perform public.risk_add(p_user, 'mass_reg', 'ip:' || to_char(now(), 'YYYYMMDDHH24'), false, jsonb_build_object('accounts', n + 1)); end if;
  end if;
end $$;

-- ---------- 9. Решения модераторов: санкции, отмена, апелляции ----------
create table if not exists public.ban_appeals (
  id             uuid primary key default gen_random_uuid(),
  ban_id         uuid not null references public.user_bans(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  message        text not null check (char_length(message) between 10 and 1000),
  status         text not null default 'pending' check (status in ('pending','in_review','upheld','overturned')),
  reviewer_id    uuid references public.profiles(id) on delete set null,
  decision_note  text,
  created_at     timestamptz not null default now(),
  due_at         timestamptz not null default now() + interval '72 hours',
  taken_at       timestamptz,
  decided_at     timestamptz,
  unique (ban_id)
);
alter table public.ban_appeals enable row level security;
drop policy if exists "ban appeals read" on public.ban_appeals;
create policy "ban appeals read" on public.ban_appeals for select using (auth.uid() = user_id or public.is_mod());

-- репутационные события: уникальный ключ защищает от повторного начисления
create table if not exists public.reputation_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  source_key  text not null unique,
  kind        text not null check (kind in ('penalty','reversal','bonus')),
  points      int not null,
  reason      text,
  created_at  timestamptz not null default now()
);
create index if not exists reputation_events_user_idx on public.reputation_events (user_id);
alter table public.reputation_events enable row level security;
drop policy if exists "rep events own" on public.reputation_events;
create policy "rep events own" on public.reputation_events for select using (auth.uid() = user_id or public.is_mod());

create or replace function public.shield_sanction(p_user uuid, p_rule text, p_kind text, p_hours int, p_reason text,
  p_evidence text default null, p_key text default null, p_scope text default 'global', p_scope_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b record; pen int; prior int; m record;
begin
  if p_scope <> 'global' then raise exception using errcode = 'NR422', message = 'Для чата и встречи — отдельные действия организатора'; end if;
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов' , hint = 'role'; end if;
  if p_user = me then raise exception using errcode = 'NR403', message = 'Нельзя выносить решение о себе'; end if;
  if public.ban_rules()->p_rule is null then raise exception using errcode = 'NR422', message = 'Выберите правило из матрицы'; end if;
  if p_kind not in ('warning','restricted','ban') then raise exception using errcode = 'NR422', message = 'Неизвестный вид санкции'; end if;
  if coalesce(char_length(btrim(p_reason)), 0) < 5 then raise exception using errcode = 'NR422', message = 'Укажите причину решения', hint = 'reason'; end if;
  if p_kind = 'ban' and p_hours is null and not public.is_admin() then
    raise exception using errcode = 'NR403', message = 'Бессрочный бан подтверждает старший администратор', hint = 'senior';
  end if;
  if p_hours is not null and p_hours > 720 and not public.is_admin() then
    raise exception using errcode = 'NR403', message = 'Модератор может назначить срок до 30 дней', hint = 'senior';
  end if;
  if p_kind = 'warning' then p_hours := null; end if;
  insert into public.user_bans (user_id, kind, rule, reason, evidence, expires_at, moderator_id, approved_by, source_key)
  values (p_user, p_kind, p_rule, btrim(p_reason), p_evidence,
          case when p_kind = 'warning' or p_hours is null then null else now() + make_interval(hours => p_hours) end,
          me, case when p_kind = 'ban' and p_hours is null then me end, p_key)
  on conflict (source_key) do nothing returning * into b;
  if b.id is null then select * into b from public.user_bans where source_key = p_key; return jsonb_build_object('id', b.id, 'decision_no', b.decision_no, 'repeat', true); end if;

  pen := coalesce((public.shield_cfg()->'rep_penalty'->>p_kind)::int, 0);
  insert into public.reputation_events (user_id, source_key, kind, points, reason) values (p_user, 'ban:' || b.id, 'penalty', -pen, p_rule)
  on conflict (source_key) do nothing;
  perform public.risk_add(p_user, 'violation', 'ban:' || b.id, true, jsonb_build_object('rule', p_rule));
  if p_kind in ('restricted','ban') then
    perform public.ban_sync(p_user);
    if p_kind = 'ban' then
      -- глобальный бан: рабочие сессии отзываются, push не приходят
      update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'banned' where user_id = p_user and status <> 'revoked';
      delete from public.push_subs where user_id = p_user;
      -- встречи организатора: передать допущенному co-host или отменить и уведомить участников
      for m in select e.post_id, e.cohost_id from public.events e join public.posts p on p.id = e.post_id
                where e.host_id = p_user and e.status = 'scheduled' and e.starts_at > now() loop
        if m.cohost_id is not null and public.ban_level(m.cohost_id) = 0 then
          update public.events set host_id = m.cohost_id, cohost_id = null where post_id = m.post_id;
          insert into public.notifications (user_id, type, post_id, text) values (m.cohost_id, 'meeting', m.post_id, 'Вы стали организатором встречи');
        else
          perform public.meeting_cancel_internal(m.post_id, 'Встреча отменена: организатор не может ее провести');
        end if;
      end loop;
    end if;
  end if;
  insert into public.notifications (user_id, type, text)
  values (p_user, 'sanction', case p_kind when 'warning' then 'Предупреждение от модератора' when 'restricted' then 'Действия в NEAR ограничены' else 'Аккаунт заблокирован' end
          || ' · решение ' || b.decision_no);
  perform public.audit('sanction', 'user', p_user, jsonb_build_object('ban', b.id, 'no', b.decision_no, 'rule', p_rule, 'kind', p_kind, 'hours', p_hours, 'reason', p_reason));
  update public.reports set status = 'resolved', resolved_at = now(), resolved_by = me, resolution = p_kind || ': ' || left(p_reason, 200)
   where status = 'open' and target_type = 'user' and target_id = p_user;
  return jsonb_build_object('id', b.id, 'decision_no', b.decision_no, 'expires_at', b.expires_at);
end $$;

-- снятие решения: права восстанавливаются, штраф сторнируется; другие активные санкции остаются
create or replace function public.shield_revoke_internal(p_ban uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare b record;
begin
  update public.user_bans set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoke_reason = p_reason
   where id = p_ban and status = 'active' returning * into b;
  if b.id is null then return; end if;
  insert into public.reputation_events (user_id, source_key, kind, points, reason)
  select b.user_id, 'rev:' || b.id, 'reversal', -points, 'Решение отменено' from public.reputation_events where source_key = 'ban:' || b.id
  on conflict (source_key) do nothing;
  update public.risk_events set status = 'dismissed', reviewed_by = auth.uid() where user_id = b.user_id and source_key = 'ban:' || b.id;
  perform public.ban_sync(b.user_id);
  perform public.rep_recalc(b.user_id);
  insert into public.notifications (user_id, type, text) values (b.user_id, 'sanction', 'Решение ' || b.decision_no || ' отменено');
  perform public.audit('sanction_revoke', 'user', b.user_id, jsonb_build_object('ban', b.id, 'reason', p_reason));
end $$;

create or replace function public.shield_revoke(p_ban uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare b record;
begin
  select * into b from public.user_bans where id = p_ban;
  if b.id is null then raise exception using errcode = 'NR404', message = 'Решение не найдено'; end if;
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  if b.expires_at is null and b.kind = 'ban' and not public.is_admin() then
    raise exception using errcode = 'NR403', message = 'Бессрочное решение пересматривает старший администратор', hint = 'senior';
  end if;
  if coalesce(char_length(btrim(p_reason)), 0) < 5 then raise exception using errcode = 'NR422', message = 'Укажите причину'; end if;
  perform public.shield_revoke_internal(p_ban, p_reason);
end $$;

-- продление (за доказанный обход — не больше 30 дней от нового решения, с мотивировкой)
create or replace function public.shield_extend(p_ban uuid, p_days int, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare b record;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  if p_days not between 1 and 30 then raise exception using errcode = 'NR422', message = 'Продление — от 1 до 30 дней'; end if;
  if coalesce(char_length(btrim(p_reason)), 0) < 10 then raise exception using errcode = 'NR422', message = 'Опишите доказательства обхода'; end if;
  select * into b from public.user_bans where id = p_ban and status = 'active' and kind = 'ban' and expires_at is not null for update;
  if b.id is null then raise exception using errcode = 'NR404', message = 'Действующий срочный бан не найден'; end if;
  update public.user_bans set expires_at = greatest(b.expires_at, now() + make_interval(days => p_days)) where id = p_ban;
  perform public.audit('sanction_extend', 'user', b.user_id, jsonb_build_object('ban', b.id, 'days', p_days, 'reason', p_reason));
end $$;

-- связь аккаунтов: при подтверждении — оставшийся срок исходного бана; продление только отдельно, с мотивировкой
create or replace function public.shield_link_decide(p_link uuid, p_confirm boolean, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l record; src record; nb record;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  if coalesce(char_length(btrim(p_note)), 0) < 5 then raise exception using errcode = 'NR422', message = 'Укажите обоснование'; end if;
  update public.account_links set review_status = case when p_confirm then 'confirmed' else 'rejected' end,
         reviewed_by = auth.uid(), reviewed_at = now(), note = p_note
   where id = p_link and review_status = 'pending' returning * into l;
  if l.id is null then raise exception using errcode = 'NR404', message = 'Связь уже рассмотрена'; end if;
  if not p_confirm then
    update public.risk_events set status = 'dismissed', reviewed_by = auth.uid() where user_id = l.account_id and event_type = 'evasion';
    update public.risk_holds set decided_at = now(), decided_by = auth.uid() where user_id = l.account_id and decided_at is null;
    perform public.audit('link_rejected', 'user', l.account_id, jsonb_build_object('candidate', l.candidate_id));
    return jsonb_build_object('ok', true);
  end if;
  select * into src from public.user_bans where user_id = l.candidate_id and status = 'active' and kind = 'ban' and scope = 'global'
     and (expires_at is null or expires_at > now()) order by (expires_at is null) desc, expires_at desc limit 1;
  if src.id is not null then
    if src.expires_at is null and not public.is_admin() then
      raise exception using errcode = 'NR403', message = 'Связь с бессрочным баном подтверждает старший администратор', hint = 'senior';
    end if;
    insert into public.user_bans (user_id, kind, rule, reason, expires_at, moderator_id, approved_by, source_key, linked_from)
    values (l.account_id, 'ban', 'evasion', 'Подтвержденный обход блокировки: оставшийся срок решения ' || src.decision_no,
            src.expires_at, auth.uid(), case when src.expires_at is null then auth.uid() end, 'link:' || l.id, src.id)
    on conflict (source_key) do nothing returning * into nb;
    update public.risk_events set confirmed = true, reviewed_by = auth.uid() where user_id = l.account_id and event_type = 'evasion';
    update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'banned' where user_id = l.account_id and status <> 'revoked';
    insert into public.device_restrictions (installation_hash, reason, expires_at, review_status, created_by)
    select installation_hash, 'Подтвержденный обход ' || src.decision_no, src.expires_at, 'confirmed', auth.uid()
      from public.user_devices where user_id = l.account_id
    on conflict (installation_hash) do update set expires_at = excluded.expires_at, review_status = 'confirmed';
    perform public.ban_sync(l.account_id);
  end if;
  update public.risk_holds set decided_at = now(), decided_by = auth.uid() where user_id = l.account_id and decided_at is null;
  perform public.audit('link_confirmed', 'user', l.account_id, jsonb_build_object('candidate', l.candidate_id, 'ban', nb.id));
  return jsonb_build_object('ok', true, 'ban_id', nb.id, 'decision_no', nb.decision_no);
end $$;

-- ручное решение по риску: снять ограничение или оставить (не дольше, чем решит модератор)
create or replace function public.risk_decide(p_user uuid, p_clear boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  update public.risk_holds set decided_at = now(), decided_by = auth.uid(), until = case when p_clear then now() else until end
   where user_id = p_user and decided_at is null;
  if p_clear then update public.risk_events set status = 'dismissed', reviewed_by = auth.uid() where user_id = p_user and not confirmed; end if;
  update public.moderation_queue set status = 'decided', decision = case when p_clear then 'cleared' else 'kept' end, decided_by = auth.uid(), decided_at = now()
   where content_type = 'user' and content_id = p_user and status = 'open' and reason in ('risk_hold','evasion');
  perform public.audit('risk_decide', 'user', p_user, jsonb_build_object('clear', p_clear, 'note', p_note));
end $$;

-- апелляция: доступна заблокированному пользователю (нужен только вход, без активной сессии)
create or replace function public.appeal_submit(p_ban uuid, p_message text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b record; a record;
begin
  select * into b from public.user_bans where id = p_ban and user_id = auth.uid() and status = 'active';
  if b.id is null then raise exception using errcode = 'NR404', message = 'Решение не найдено'; end if;
  perform public.rate('appeal');
  insert into public.ban_appeals (ban_id, user_id, message) values (b.id, auth.uid(), left(btrim(p_message), 1000))
  on conflict (ban_id) do nothing returning * into a;
  if a.id is null then select * into a from public.ban_appeals where ban_id = b.id; end if;
  perform public.queue_add('appeal', a.id, auth.uid(), 'appeal');
  return jsonb_build_object('id', a.id, 'status', a.status, 'due_at', a.due_at);
end $$;

create or replace function public.appeal_take(p_appeal uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a record; b record;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  select * into a from public.ban_appeals where id = p_appeal for update;
  select * into b from public.user_bans where id = a.ban_id;
  if auth.uid() in (b.moderator_id, b.approved_by) then
    raise exception using errcode = 'NR403', message = 'Апелляцию рассматривает другой модератор', hint = 'independent';
  end if;
  update public.ban_appeals set status = 'in_review', reviewer_id = auth.uid(), taken_at = now() where id = p_appeal and status = 'pending';
  perform public.audit('appeal_take', 'user', a.user_id, jsonb_build_object('appeal', a.id));
end $$;

create or replace function public.appeal_decide(p_appeal uuid, p_overturn boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare a record; b record;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  if coalesce(char_length(btrim(p_note)), 0) < 5 then raise exception using errcode = 'NR422', message = 'Опишите решение'; end if;
  select * into a from public.ban_appeals where id = p_appeal for update;
  if a.id is null or a.status in ('upheld','overturned') then raise exception using errcode = 'NR404', message = 'Апелляция уже рассмотрена'; end if;
  select * into b from public.user_bans where id = a.ban_id;
  if auth.uid() in (b.moderator_id, b.approved_by) then
    raise exception using errcode = 'NR403', message = 'Апелляцию рассматривает другой модератор', hint = 'independent';
  end if;
  if p_overturn and b.expires_at is null and b.kind = 'ban' and not public.is_admin() then
    raise exception using errcode = 'NR403', message = 'Бессрочное решение пересматривает старший администратор', hint = 'senior';
  end if;
  update public.ban_appeals set status = case when p_overturn then 'overturned' else 'upheld' end, reviewer_id = auth.uid(),
         decision_note = p_note, decided_at = now(), taken_at = coalesce(taken_at, now()) where id = a.id;
  if p_overturn then perform public.shield_revoke_internal(b.id, 'Апелляция: ' || p_note);
  else insert into public.notifications (user_id, type, text) values (a.user_id, 'appeal', 'Апелляция по решению ' || b.decision_no || ' рассмотрена: решение оставлено в силе');
  end if;
  update public.moderation_queue set status = 'decided', decision = case when p_overturn then 'overturned' else 'upheld' end, decided_by = auth.uid(), decided_at = now()
   where content_type = 'appeal' and content_id = a.id;
  perform public.audit('appeal_decide', 'user', a.user_id, jsonb_build_object('appeal', a.id, 'overturn', p_overturn, 'note', p_note));
end $$;

-- собственные решения и апелляции — для экрана "Мои нарушения"
create or replace function public.my_decisions() returns table (id uuid, decision_no text, kind text, rule text, rule_title text, reason text,
  starts_at timestamptz, expires_at timestamptz, status text, appeal_status text, appeal_note text)
language sql stable security definer set search_path = public as $$
  select b.id, b.decision_no, b.kind, b.rule, public.ban_rules()->b.rule->>'title', b.reason, b.starts_at, b.expires_at,
         case when b.status = 'revoked' then 'revoked' when b.expires_at is not null and b.expires_at <= now() then 'expired' else 'active' end,
         a.status, a.decision_note
    from public.user_bans b left join public.ban_appeals a on a.ban_id = b.id
   where b.user_id = auth.uid() and b.scope = 'global' order by b.created_at desc limit 50 $$;
