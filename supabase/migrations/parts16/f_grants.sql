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
