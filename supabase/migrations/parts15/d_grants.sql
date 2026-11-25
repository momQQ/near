-- =====================================================
--  Права v14.2
-- =====================================================
-- профиль: Instagram и служебные поля не читаются напрямую (Instagram — через profile_instagram, по настройке владельца)
revoke select on public.profiles from anon, authenticated;
grant select (id, name, nickname, avatar_url, district, created_at, updated_at, verified, last_seen_at, banned, bio, show_seen,
              is_admin, is_moderator, interests, accepted_rules_at) on public.profiles to anon, authenticated;
revoke update on public.profiles from authenticated;
grant update (avatar_url, district, instagram, instagram_public, interests, bio, show_seen, accepted_rules_at, updated_at) on public.profiles to authenticated;

revoke all on public.user_sanctions, public.city_log from anon, authenticated;
grant select on public.user_sanctions, public.city_log to authenticated; -- RLS: свои решения / модератор

grant execute on function public.mfa_ok(), public.has_mod_role(), public.profile_instagram(uuid), public.active_sanction(uuid, text),
  public.near_norm_text(text), public.near_block_reason(text), public.near_flag_reason(text), public.near_block_message(text),
  public.clean_url(text), public.post_meta_clean(text, jsonb), public.storage_media_visible(text),
  public.feed_v14(double precision, double precision, int, text[], text, text, boolean, uuid, timestamptz, int),
  public.map_v14(double precision, double precision, double precision, double precision, text[], double precision, double precision, int, text, boolean, int),
  public.ping()
  to anon, authenticated;
grant execute on function public.limit_status(text), public.my_account(), public.mod_restrict(uuid, text, int, text), public.mod_unrestrict(uuid, text),
  public.mod_media(uuid, boolean, text), public.mod_media_queue(), public.city_upsert(jsonb)
  to authenticated;
revoke execute on function public.sanction_guard(), public.message_age_guard(), public.flag_after_insert(), public.post_meta_trigger(),
  public.official_guard(), public.post_counters(), public.counters_reconcile()
  from public, anon, authenticated;

-- Готово ✅ v14.2 (этап 1.2)
