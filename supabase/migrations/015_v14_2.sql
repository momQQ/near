-- =====================================================
--  Миграция v14.2 (ТЗ v14.6, этап 1.2 / Stability). Для базы, где уже стоит 014_v14.sql.
--  Запуск: Supabase → SQL Editor → вставить файл целиком → Run. Идемпотентный.
--  Что внутри:
--   38/59 — аккаунт: состояния, разрешенные действия, лимиты в my_account; Instagram скрыт по умолчанию; интересы;
--   45/60/09 — дружба не снимает возрастной запрет; угрозы, интим, скам, сокращенные ссылки блокируются;
--              санкции по функциям и сроку; MFA (aal2) для модераторов и администратора;
--   06/58/60 — новые файлы публикаций только в приватный бакет post-private, выдача одобренных — по подписанным ссылкам;
--              прямая загрузка в публичный post-media закрыта; аватары — отдельный бакет avatars;
--   40/51/52 — поля форм (meta), категория "Помощь", сроки актуальности, проверка ссылок;
--   55 — NEAR City: официальные карточки редактора с источником и журналом версий;
--   57 — лента одним запросом (feed_v14), счетчики лайков/комментариев в таблице, легкая карта (map_v14).
--  Откат: вернуть клиент v14 (этап 1) и выполнить 014_v14.sql повторно; новые колонки и таблицы можно оставить.
--  Перед миграцией — резервная копия (SETUP.md, шаг 16).
-- =====================================================

-- ---------- 39/45: MFA для модераторов и администратора ----------
alter table public.app_settings add column if not exists mod_require_mfa boolean not null default true;
-- уровень входа из токена Supabase Auth: aal2 = вход с вторым фактором (TOTP)
create or replace function public.mfa_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select not coalesce((select mod_require_mfa from public.app_settings where id = 1), true)
      or coalesce(auth.jwt()->>'aal', '') = 'aal2' $$;
-- роль без второго фактора не дает прав: интерфейс попросит включить защиту
create or replace function public.is_mod() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or is_moderator from public.profiles where id = auth.uid()), false) and public.mfa_ok() $$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false) and public.mfa_ok() $$;
-- роль по профилю без проверки второго фактора — только чтобы интерфейс знал, что нужно включить MFA
create or replace function public.has_mod_role() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or is_moderator from public.profiles where id = auth.uid()), false) $$;

-- ---------- 38: профиль — интересы, Instagram скрыт по умолчанию ----------
alter table public.profiles add column if not exists instagram_public boolean not null default false;
alter table public.profiles add column if not exists interests text[] not null default '{}';
alter table public.profiles drop constraint if exists profiles_interests_chk;
alter table public.profiles add constraint profiles_interests_chk check (cardinality(interests) <= 5
  and interests <@ array['games','cinema','board','sport','cafe','walks','mountains','study','other','pets','music','kids','volunteer']);

-- Instagram виден другим только если владелец включил; через API — только эта функция
create or replace function public.profile_instagram(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when p.id = auth.uid() or p.instagram_public or public.is_mod() then p.instagram end
    from public.profiles p where p.id = p_user and not public.is_blocked(auth.uid(), p_user) $$;

-- ---------- 45/60: санкции — ограничение функции или аккаунта на срок ----------
create table if not exists public.user_sanctions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  scope       text not null check (scope in ('all','post','comment','chat','meet')),
  until       timestamptz,                         -- null = бессрочно (только администратор)
  reason      text not null check (char_length(reason) between 3 and 500),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid references public.profiles(id) on delete set null
);
create index if not exists user_sanctions_user_idx on public.user_sanctions (user_id) where revoked_at is null;
alter table public.user_sanctions enable row level security;
drop policy if exists "sanctions own or mod" on public.user_sanctions;
-- пользователь видит свои решения (без данных заявителя), модератор — все
create policy "sanctions own or mod" on public.user_sanctions for select using (auth.uid() = user_id or public.is_mod());

create or replace function public.active_sanction(u uuid, p_scope text) returns public.user_sanctions
language sql stable security definer set search_path = public as $$
  select * from public.user_sanctions
   where user_id = u and revoked_at is null and (until is null or until > now()) and scope in (p_scope, 'all')
   order by until desc nulls first limit 1 $$;

create or replace function public.sanction_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare s public.user_sanctions; sc text := case tg_table_name when 'posts' then 'post' when 'comments' then 'comment' when 'messages' then 'chat' else 'all' end;
begin
  if auth.uid() is null then return new; end if;
  s := public.active_sanction(auth.uid(), sc);
  if s.id is not null then
    raise exception using errcode = 'NR403', hint = 'restricted',
      message = 'Действие ограничено модератором' || case when s.until is null then '' else ' до ' || to_char(s.until at time zone 'Asia/Almaty', 'DD.MM HH24:MI') end || '. Причина: ' || s.reason;
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['posts','comments','messages'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_sanction', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.sanction_guard()', t || '_sanction', t);
  end loop;
end $$;

-- модератор ограничивает функцию на 1–30 дней; бессрочно — только администратор. Исключение из встречи не strike.
create or replace function public.mod_restrict(p_user uuid, p_scope text, p_days int, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  if p_user = auth.uid() then raise exception using errcode = 'NR422', message = 'Нельзя ограничить себя'; end if;
  if p_scope not in ('all','post','comment','chat','meet') then raise exception using errcode = 'NR422', message = 'Неизвестная функция'; end if;
  if p_days is null and not public.is_admin() then raise exception using errcode = 'NR403', message = 'Бессрочное ограничение — только администратор'; end if;
  if p_days is not null and (p_days < 1 or p_days > 30) then raise exception using errcode = 'NR422', message = 'Срок от 1 до 30 дней'; end if;
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception using errcode = 'NR422', message = 'Укажите причину'; end if;
  insert into public.user_sanctions (user_id, scope, until, reason, created_by)
  values (p_user, p_scope, case when p_days is null then null else now() + make_interval(days => p_days) end, left(trim(p_reason), 500), auth.uid())
  returning id into sid;
  insert into public.mod_actions (moderator_id, target_type, target_id, action, note) values (auth.uid(), 'user', p_user, 'restrict_' || p_scope, coalesce(p_days::text || ' дн.', 'бессрочно') || ': ' || left(p_reason, 400));
  insert into public.notifications (user_id, type, text)
  values (p_user, 'sanction', 'Ограничение: ' || case p_scope when 'all' then 'все действия' when 'post' then 'публикации' when 'comment' then 'комментарии' when 'chat' then 'сообщения' else 'встречи' end
          || coalesce(' на ' || p_days || ' дн.', ' бессрочно') || '. Причина: ' || left(p_reason, 200) || '. Обжаловать можно 14 дней');
  return sid;
end $$;
create or replace function public.mod_unrestrict(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  update public.user_sanctions set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null returning * into s;
  if s.id is null then raise exception using errcode = 'NR404', message = 'Ограничение не найдено'; end if;
  insert into public.mod_actions (moderator_id, target_type, target_id, action, note) values (auth.uid(), 'user', s.user_id, 'unrestrict', left(p_note, 400));
  insert into public.notifications (user_id, type, text) values (s.user_id, 'sanction', 'Ограничение снято' || coalesce(': ' || left(p_note, 200), ''));
end $$;

-- ---------- 45/59: дружба не снимает возрастной запрет на личные чаты ----------
create or replace function public.get_or_create_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid; b uuid; cid uuid; fr boolean;
begin
  if me is null then raise exception using errcode = 'NR403', message = 'Войдите, чтобы написать'; end if;
  if other is null or other = me then raise exception using errcode = 'NR422', message = 'Нельзя написать самому себе'; end if;
  if not exists (select 1 from public.profiles where id = other) then raise exception using errcode = 'NR404', message = 'Пользователь не найден'; end if;
  if public.is_blocked(me, other) then raise exception using errcode = 'NR403', message = 'Пользователь недоступен'; end if;
  if public.is_banned() then raise exception using errcode = 'NR403', message = 'Аккаунт заблокирован модератором'; end if;
  if not (public.age_ok(me) and public.age_ok(other)) then
    raise exception using errcode = 'NR403', message = 'Личные сообщения пока недоступны: возраст не проверен. Общаться можно в комментариях', hint = 'age_gate';
  end if;
  a := least(me, other); b := greatest(me, other);
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is null then
    fr := public.are_friends(me, other);
    if not fr then perform public.rate_take('chat_request', null); end if;
    insert into public.conversations (user_a, user_b, status, initiator)
    values (a, b, case when fr then 'accepted' else 'request' end, me)
    returning id into cid;
  end if;
  return cid;
end $$;
-- каждое сообщение: возрастной допуск обеих сторон (в том числе в старых переписках и между друзьями)
create or replace function public.message_age_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if auth.uid() is null then return new; end if;
  select user_a, user_b into c from public.conversations where id = new.conversation_id;
  if c.user_a is not null and c.user_b is not null and not (public.age_ok(c.user_a) and public.age_ok(c.user_b)) then
    raise exception using errcode = 'NR403', message = 'Личные сообщения пока недоступны: возраст не проверен', hint = 'age_gate';
  end if;
  return new;
end $$;
drop trigger if exists messages_age on public.messages;
create trigger messages_age before insert on public.messages for each row execute function public.message_age_guard();

-- ---------- 38: состояние аккаунта, разрешенные действия и лимиты — с сервера ----------
create or replace function public.limit_status(p_action text) returns jsonb
language sql stable security definer set search_path = public as $$
  with l as (select (day_limits->p_action->>(case when exists (select 1 from public.profile_private where user_id = auth.uid() and phone_verified_at is not null) then 1 else 0 end))::int lim
               from public.app_settings where id = 1),
       d as (select (now() at time zone 'Asia/Almaty')::date d),
       u as (select coalesce((select n from public.rate_counters, d where user_id = auth.uid() and action = p_action and day = d.d), 0) used)
  select jsonb_build_object('used', u.used, 'limit', l.lim,
    'retry_after', case when public.is_mod() or l.lim is null or u.used < l.lim then null
                        else greatest(60, ceil(extract(epoch from ((d.d + 1)::timestamp at time zone 'Asia/Almaty') - now())))::int end)
    from l, d, u $$;

create or replace function public.my_account() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p record; pp record; st text; sa public.user_sanctions; can jsonb;
begin
  if auth.uid() is null then return null; end if;
  select * into p from public.profiles where id = auth.uid();
  if p.id is null then return jsonb_build_object('state', 'deleted'); end if;
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
    'chat', st in ('active','restricted') and public.active_sanction(auth.uid(), 'chat') is null and public.age_ok(auth.uid()),
    'meet', st = 'active' and public.age_ok(auth.uid()),
    'report', st <> 'suspended');
  return jsonb_build_object(
    'state', st, 'can', can,
    'age_status', coalesce(pp.age_status, 'unknown'), 'age_ok', public.age_ok(auth.uid()),
    'phone_verified', pp.phone_verified_at is not null,
    'nickname_next_change', case when p.nickname_changed_at > now() - interval '30 days' then p.nickname_changed_at + interval '30 days' end,
    'instagram', p.instagram, 'instagram_public', p.instagram_public, 'accepted_rules', p.accepted_rules_at is not null,
    'mod_role', p.is_admin or p.is_moderator, 'mfa_ok', public.mfa_ok(),
    'sanction', case when sa.id is not null then jsonb_build_object('until', sa.until, 'reason', sa.reason) end,
    'limits', jsonb_build_object('post', public.limit_status('post'), 'comment', public.limit_status('comment'), 'chat_request', public.limit_status('chat_request')),
    'clean_version', (select clean_version from public.app_settings where id = 1),
    'media_ok', true);
end $$;

-- ---------- 45/60/07: опасное содержание блокируется независимо от маскирования мата ----------
-- Тот же набор правил, что в src/lib/clean.js (nearBlockReason / nearFlagReason); совпадение проверяет clean_parity.mjs.
create or replace function public.near_norm_text(t text) returns text language sql immutable as $$
  select replace(lower(translate(coalesce(t, ''), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя')), 'ё', 'е') $$;
create or replace function public.near_block_reason(t text) returns text language plpgsql immutable as $$
declare s text := public.near_norm_text(t);
begin
  if s = '' then return null; end if;
  if public.near_is_threat(t) then return 'threat'; end if;
  if s ~ '(интим[ -]?(услуг|за деньг|встреч)|эскорт|секс за деньг|секс[ -]?услуг|досуг для (мужчин|джентльмен)|нюдс|nudes|onlyfans|скинь (фото|нюдс) без одежды|sex for money)' then return 'sexual'; end if;
  if s ~ '(?<!не )(скинь|пришли|назови|сообщи|продиктуй|отправь)(те)? (мне |нам )?(код из смс|код|смс|cvv|cvc|пин-?код|номер карты|данные карты)([^а-яa-z]|$)' then return 'scam'; end if;
  if s ~ '(bit\.ly|clck\.ru|tinyurl\.com|cutt\.ly|goo\.su|t\.ly|is\.gd|rb\.gy|shorturl\.at|ow\.ly|u\.to|vk\.cc)/' then return 'shortlink'; end if;
  return null;
end $$;
-- сомнительное (предоплата, перевод на карту): публикуется, но попадает в очередь модератора
create or replace function public.near_flag_reason(t text) returns text language sql immutable as $$
  select case when public.near_norm_text(t) ~ '((?<!без )предоплат|переведи(те)? (на |деньги)|перевод(ом)? на (карту|каспи|kaspi))' then 'prepay' end $$;

create or replace function public.near_block_message(r text) returns text language sql immutable as $$
  select case r when 'threat' then 'Угрозы запрещены правилами NEAR. Текст не опубликован'
    when 'sexual' then 'Интимные услуги и откровенные предложения запрещены. NEAR — не сервис знакомств'
    when 'scam' then 'Нельзя просить коды из SMS и данные карт. NEAR никогда не просит SMS-коды'
    when 'shortlink' then 'Сокращенные ссылки запрещены: укажите полный адрес сайта'
    else 'Текст нарушает правила NEAR' end $$;

create or replace function public.mask_text_trigger() returns trigger
language plpgsql as $$
declare r text;
begin
  if tg_op = 'INSERT' or new.text is distinct from old.text then
    r := public.near_block_reason(new.text);
    if r is not null then raise exception using errcode = 'NR422', message = public.near_block_message(r), hint = r; end if;
    new.text := public.near_clean(new.text);
  end if;
  return new;
end $$;
create or replace function public.mask_bio_trigger() returns trigger
language plpgsql as $$
declare r text;
begin
  if new.bio is distinct from old.bio and new.bio is not null then
    r := public.near_block_reason(new.bio);
    if r is not null then raise exception using errcode = 'NR422', message = public.near_block_message(r), hint = r; end if;
    new.bio := public.near_clean(new.bio);
  end if;
  return new;
end $$;

alter table public.reports drop constraint if exists reports_source_check;
alter table public.reports add constraint reports_source_check check (source in ('user','ai','system','rules'));
create or replace function public.flag_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := public.near_flag_reason(new.text);
begin
  if r is null then return new; end if;
  insert into public.reports (reporter_id, source, target_type, target_id, target_user, reason, details)
  values (null, 'rules', case when tg_table_name = 'posts' then 'post' else 'comment' end, new.id, new.user_id, 'scam', 'Правило: ' || r)
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists posts_flag on public.posts;
create trigger posts_flag after insert on public.posts for each row execute function public.flag_after_insert();
drop trigger if exists comments_flag on public.comments;
create trigger comments_flag after insert on public.comments for each row execute function public.flag_after_insert();

-- ---------- 40/52: поля форм по типам, категория "Помощь", сроки ----------
alter table public.posts drop constraint if exists posts_category_check;
alter table public.posts add constraint posts_category_check check (category in ('incident','event','deal','lost','found','help','meetup','ad','talk'));
alter table public.posts add column if not exists meta jsonb not null default '{}'::jsonb;

create or replace function public.post_ttl(cat text, sos boolean) returns interval
language sql immutable as $$
  select case when sos then interval '3 hours'
    when cat = 'incident' then interval '24 hours'
    when cat in ('lost','found') then interval '30 days'
    when cat = 'help' then interval '7 days'
    when cat in ('deal','ad') then interval '14 days'
    when cat = 'meetup' then interval '7 days'
    when cat = 'event' then interval '30 days'
    else interval '90 days' end $$;

-- ссылка: только https, без сокращателей; иначе null
create or replace function public.clean_url(u text) returns text language sql immutable as $$
  select case when u ~* '^https://[a-z0-9.-]+\.[a-z]{2,}(/[^\s<>"]*)?$' and char_length(u) <= 300 and public.near_block_reason(u || ' ') is null then u end $$;

-- разрешенные поля по категории; тексты проходят NEAR Clean и правила блокировки
create or replace function public.post_meta_clean(cat text, m jsonb) returns jsonb
language plpgsql immutable as $$
declare o jsonb := '{}'::jsonb; t text; r text; k text;
begin
  m := coalesce(m, '{}'::jsonb);
  foreach k in array array['title','organizer','org','conditions','price_text'] loop
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
  elsif cat = 'deal' then
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
    if m->>'hkind' in ('need','offer') then o := o || jsonb_build_object('hkind', m->>'hkind'); else o := o || '{"hkind":"need"}'::jsonb; end if;
  elsif cat = 'ad' then
    if coalesce(m->>'price_text', '') <> '' then o := o || jsonb_build_object('price_text', m->>'price_text'); end if;
  end if;
  return o;
end $$;

-- триггер последним в цепочке (имя "zz"): очищает meta и уточняет срок по полям формы
create or replace function public.post_meta_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.meta is distinct from old.meta or new.category is distinct from old.category then
    new.meta := public.post_meta_clean(new.category, new.meta);
    if tg_op = 'INSERT' and not new.is_sos then
      if new.category = 'incident' and new.meta ? 'ttl_h' then new.expires_at := least(new.expires_at, now() + make_interval(hours => (new.meta->>'ttl_h')::int)); end if;
      if new.category = 'deal' and new.meta ? 'until' then new.expires_at := least(new.expires_at, (new.meta->>'until')::timestamptz); end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists posts_zz_meta on public.posts;
create trigger posts_zz_meta before insert or update on public.posts for each row execute function public.post_meta_trigger();

-- ---------- 06/58/60: закрытые медиа ----------
-- Новые файлы публикаций: приватный бакет post-private (своя папка <user>/<post>/...).
-- Читать (получить подписанную ссылку) можно: автору, модератору, а остальным — только одобренный файл видимой публикации.
-- Прямая загрузка в публичный post-media закрыта (старые файлы там остаются читаемыми).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-private', 'post-private', false, 20971520,
        array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm','video/x-m4v'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
-- аватары: отдельный публичный бакет, только изображения до 2 МБ, своя папка
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

alter table public.post_media drop constraint if exists post_media_mod_status_check;
alter table public.post_media add constraint post_media_mod_status_check check (mod_status in ('ok','pending','review','flagged','rejected'));

create or replace function public.storage_media_visible(obj_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select (storage.foldername(obj_name))[1] = auth.uid()::text or public.is_mod()
      or exists (select 1 from public.post_media m
                  where obj_name in (m.path, regexp_replace(m.path, '\.[a-z0-9]+$', '') || '-t.jpg', regexp_replace(m.path, '\.[a-z0-9]+$', '') || '-t.webp', regexp_replace(m.path, '\.[a-z0-9]+$', '') || '-p.jpg')
                    and m.bucket = 'post-private' and m.mod_status = 'ok' and public.can_see_post(m.post_id)) $$;

drop policy if exists "near media upload" on storage.objects;
drop policy if exists "near media delete" on storage.objects;
drop policy if exists "near private read" on storage.objects;
drop policy if exists "near avatars read" on storage.objects;
create policy "near media upload" on storage.objects for insert to authenticated
  with check ((storage.foldername(name))[1] = auth.uid()::text and (
    bucket_id in ('post-private','avatars') or (bucket_id = 'chat-media' and public.chat_file_allowed(name))));
create policy "near media delete" on storage.objects for delete to authenticated
  using (bucket_id in ('post-media','chat-media','post-private','avatars') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "near private read" on storage.objects for select using (bucket_id = 'post-private' and public.storage_media_visible(name));
create policy "near avatars read" on storage.objects for select using (bucket_id = 'avatars');

-- файл публикации: только своя папка, только post-private; статус — по настройкам проверки (fail closed)
create or replace function public.media_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.post_media where post_id = new.post_id) >= 5 then
    raise exception using errcode = 'NR422', message = 'Не больше 5 вложений в публикации';
  end if;
  if new.path is null or new.path !~ ('^' || new.user_id::text || '/' || new.post_id::text || '/') then
    raise exception using errcode = 'NR403', message = 'Файл должен лежать в вашей папке публикации';
  end if;
  if auth.uid() is not null then
    new.bucket := 'post-private';
    new.url := 'private:' || new.path;
    if new.thumb_url is not null and new.thumb_url !~ '^private:' then new.thumb_url := null; end if;
    if new.poster_url is not null and new.poster_url !~ '^private:' then new.poster_url := null; end if;
  end if;
  return new;
end $$;
-- статус нового файла: ИИ включена — "pending" (решит ИИ); нужна проверка, но ИИ нет — "review" (решит модератор);
-- проверка не требуется — "ok". Функция moderate в любом случае проверяет тип, размер и метаданные.
create or replace function public.media_pending() returns trigger
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  select ai_moderation, media_requires_check into s from public.app_settings where id = 1;
  if tg_table_name = 'post_media' then
    new.mod_status := case when s.ai_moderation then 'pending' when s.media_requires_check then 'review' else 'ok' end;
  elsif tg_table_name = 'messages' then
    new.mod_status := case when s.ai_moderation and new.kind in ('image','text') then 'pending' else 'ok' end;
  end if;
  return new;
end $$;
-- запрет вставки файла без ИИ из 014 заменен статусом "review"
drop trigger if exists post_media_gate on public.post_media;

-- модератор одобряет или отклоняет файл из очереди
create or replace function public.mod_media(p_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  update public.post_media set mod_status = case when p_approve then 'ok' else 'rejected' end where id = p_id returning * into m;
  if m.id is null then raise exception using errcode = 'NR404', message = 'Файл не найден'; end if;
  insert into public.mod_actions (moderator_id, target_type, target_id, action, note) values (auth.uid(), 'media', p_id, case when p_approve then 'approve' else 'reject' end, left(p_note, 400));
  if not p_approve then
    insert into public.notifications (user_id, type, post_id, text) values (m.user_id, 'post_hidden', m.post_id, 'Файл в публикации отклонен' || coalesce(': ' || left(p_note, 160), '') || '. Можно обжаловать 14 дней');
    perform public.call_fn('moderate', jsonb_build_object('kind', 'media_delete', 'id', p_id));
  end if;
end $$;
create or replace function public.mod_media_queue() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_mod() then coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'post_id', m.post_id, 'type', m.type, 'path', m.path, 'bucket', m.bucket,
      'status', m.mod_status, 'created_at', m.created_at, 'text', left(p.text, 120), 'author', pr.name) order by m.created_at)
    from public.post_media m join public.posts p on p.id = m.post_id left join public.profiles pr on pr.id = m.user_id
   where m.mod_status in ('review','flagged','pending') and p.status <> 'deleted'), '[]'::jsonb) end $$;

-- ---------- 55: NEAR City — официальные карточки ----------
alter table public.posts add column if not exists official boolean not null default false;
alter table public.posts add column if not exists source_name text;
alter table public.posts add column if not exists source_url text;
alter table public.posts add column if not exists source_id text;
alter table public.posts add column if not exists verified_at timestamptz;
create unique index if not exists posts_source_uidx on public.posts (source_id) where source_id is not null;
create table if not exists public.city_log (
  id         bigserial primary key,
  post_id    uuid not null references public.posts(id) on delete cascade,
  version    int not null,
  data       jsonb not null,
  editor_id  uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.city_log enable row level security;
drop policy if exists "city log mod" on public.city_log;
create policy "city log mod" on public.city_log for select using (public.is_mod());

-- пользователь не может выдать свою публикацию за официальную
create or replace function public.official_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('near.city', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.likes_count := 0; new.comments_count := 0; end if;
    new.official := false; new.source_name := null; new.source_url := null; new.source_id := null; new.verified_at := null;
  else
    new.official := old.official; new.source_name := old.source_name; new.source_url := old.source_url; new.source_id := old.source_id; new.verified_at := old.verified_at;
    -- счетчики меняют только триггеры лайков и комментариев
    if coalesce(current_setting('near.system', true), '') <> '1' and auth.uid() is not null then
      new.likes_count := old.likes_count; new.comments_count := old.comments_count;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists posts_official on public.posts;
create trigger posts_official before insert or update on public.posts for each row execute function public.official_guard();

-- редактор (модератор) создает или обновляет карточку по уникальному source_id; каждая версия — в журнал
create or replace function public.city_upsert(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare pid uuid; v int; cat text := coalesce(p->>'category', 'incident'); exp timestamptz; sid text := nullif(btrim(p->>'source_id'), '');
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для редакторов NEAR City'; end if;
  if cat not in ('incident','event','talk') then raise exception using errcode = 'NR422', message = 'Тип: происшествие, событие или новость'; end if;
  if char_length(coalesce(btrim(p->>'source_name'), '')) < 2 then raise exception using errcode = 'NR422', message = 'Укажите источник'; end if;
  if char_length(coalesce(btrim(p->>'text'), '')) < 5 then raise exception using errcode = 'NR422', message = 'Добавьте описание'; end if;
  if (p->>'lat') is null or (p->>'lng') is null then raise exception using errcode = 'NR422', message = 'Укажите место на карте'; end if;
  exp := nullif(p->>'expires_at', '')::timestamptz;
  if exp is not null and (exp <= now() or exp > now() + interval '30 days') then raise exception using errcode = 'NR422', message = 'Срок: от сейчас до 30 дней'; end if;
  perform set_config('near.city', '1', true); perform set_config('near.system', '1', true);
  sid := coalesce(sid, 'manual:' || md5(cat || coalesce(p->>'source_name', '') || coalesce(p->>'text', '') || coalesce(p->>'lat', '') || coalesce(p->>'lng', '')));
  select id into pid from public.posts where source_id = sid for update;
  if pid is null then
    insert into public.posts (user_id, category, text, lat, lng, exact, status, meta, official, source_name, source_url, source_id, verified_at)
    values (auth.uid(), cat, left(btrim(p->>'text'), 1000), (p->>'lat')::float8, (p->>'lng')::float8, true, 'active',
            jsonb_strip_nulls(jsonb_build_object('title', p->>'title', 'itype', p->>'itype')),
            true, left(btrim(p->>'source_name'), 80), public.clean_url(p->>'source_url'), sid, now())
    returning id into pid;
  else
    update public.posts set text = left(btrim(p->>'text'), 1000), lat = (p->>'lat')::float8, lng = (p->>'lng')::float8, category = cat,
      meta = jsonb_strip_nulls(jsonb_build_object('title', p->>'title', 'itype', p->>'itype')),
      source_name = left(btrim(p->>'source_name'), 80), source_url = public.clean_url(p->>'source_url'), verified_at = now(),
      status = case when p->>'status' = 'closed' then 'closed' else 'active' end, updated_at = now()
     where id = pid;
  end if;
  if exp is not null then update public.posts set expires_at = exp where id = pid; end if;
  select coalesce(max(version), 0) + 1 into v from public.city_log where post_id = pid;
  insert into public.city_log (post_id, version, data, editor_id) values (pid, v, p, auth.uid());
  insert into public.mod_actions (moderator_id, target_type, target_id, action, note) values (auth.uid(), 'post', pid, 'city_v' || v, left(p->>'source_name', 80));
  perform set_config('near.city', '', true); perform set_config('near.system', '', true);
  return pid;
end $$;

-- ---------- 57: счетчики лайков и комментариев в таблице (транзакционно, с периодической сверкой) ----------
alter table public.posts add column if not exists likes_count int not null default 0;
alter table public.posts add column if not exists comments_count int not null default 0;
create or replace function public.post_counters() returns trigger
language plpgsql security definer set search_path = public as $$
declare d int := case when tg_op = 'INSERT' then 1 else -1 end; pid uuid := coalesce(new.post_id, old.post_id);
begin
  perform set_config('near.system', '1', true);
  if tg_table_name = 'likes' then update public.posts set likes_count = greatest(0, likes_count + d) where id = pid;
  else update public.posts set comments_count = greatest(0, comments_count + d) where id = pid; end if;
  perform set_config('near.system', '', true);
  return null;
end $$;
drop trigger if exists likes_counter on public.likes;
create trigger likes_counter after insert or delete on public.likes for each row execute function public.post_counters();
drop trigger if exists comments_counter on public.comments;
create trigger comments_counter after insert or delete on public.comments for each row execute function public.post_counters();
create or replace function public.counters_reconcile() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform set_config('near.system', '1', true);
  update public.posts p set likes_count = x.l, comments_count = x.c
    from (select p2.id, (select count(*) from public.likes where post_id = p2.id) l, (select count(*) from public.comments where post_id = p2.id) c from public.posts p2) x
   where x.id = p.id and (p.likes_count <> x.l or p.comments_count <> x.c);
  get diagnostics n = row_count;
  perform set_config('near.system', '', true);
  return n;
end $$;
select public.counters_reconcile();

-- ---------- 57: лента одним запросом ----------
-- Возвращает строки posts (клиент подтягивает автора, файлы и событие тем же запросом через select).
-- Курсор: id последней карточки (+ время снимка для "Для вас"); позиция якоря пересчитывается на сервере.
create or replace function public.feed_v14(p_lat double precision, p_lng double precision, p_radius int,
  p_cats text[] default null, p_sort text default 'new', p_period text default null, p_friends boolean default false,
  p_after_id uuid default null, p_snapshot timestamptz default null, p_limit int default 15)
returns setof public.posts
language sql stable set search_path = public, extensions as $$
  with prm as (select least(coalesce(p_snapshot, now()), now()) t0),
  me as (select extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography g),
  base as (
    select p.id, p.created_at, p.category, p.is_sos, p.status,
           extensions.st_distance(p.geog, me.g) dist,
           case when coalesce(p_sort, 'new') = 'top' then
             (case when p.status = 'active' and (p.is_sos or (p.category = 'incident' and p.created_at > prm.t0 - interval '3 hours')) then 1000 else 0 end)
             + case when p.official then 50 else 0 end
             + 100 * exp(-greatest(extract(epoch from prm.t0 - p.created_at), 0) / 86400.0)
             + 40 * exp(-extensions.st_distance(p.geog, me.g) / 1500.0)
             + 8 * ln(1 + (select count(*) from public.comments c where c.post_id = p.id and c.created_at <= prm.t0))
             + 3 * ln(1 + (select count(*) from public.likes l where l.post_id = p.id and l.created_at <= prm.t0))
           else 0 end score
      from public.posts p, me, prm
     where p.status in ('active','closed')
       and (p.expires_at is null or p.expires_at > now())
       and (coalesce(p_sort, 'new') <> 'top' or p.created_at <= prm.t0)
       and extensions.st_dwithin(p.geog, me.g, least(greatest(coalesce(p_radius, 1000), 100), 50000))
       and (p_cats is null or p.category = any (p_cats))
       and (p_period is null or (p_period = 'today' and p.created_at > date_trunc('day', now() at time zone 'Asia/Almaty') at time zone 'Asia/Almaty')
                             or (p_period = 'week' and p.created_at > now() - interval '7 days'))
       and (not coalesce(p_friends, false) or public.are_friends(auth.uid(), p.user_id))
       and not public.is_blocked(auth.uid(), p.user_id)
  ), anchor as (select * from base where id = p_after_id),
  page as (
    select b.* from base b
     where p_after_id is null or not exists (select 1 from anchor) or case coalesce(p_sort, 'new')
       when 'near' then (b.dist, b.id) > (select a.dist, a.id from anchor a)
       when 'top' then (b.score, b.id) < (select a.score, a.id from anchor a)
       else (b.created_at, b.id) < (select a.created_at, a.id from anchor a) end
     order by case when p_sort = 'near' then b.dist end asc, case when p_sort = 'near' then b.id end asc,
              case when p_sort = 'top' then b.score end desc, case when p_sort = 'top' then b.id end desc,
              b.created_at desc, b.id desc
     limit least(greatest(coalesce(p_limit, 15), 1), 20)
  )
  select p.* from page g join public.posts p on p.id = g.id
   order by case when p_sort = 'near' then g.dist end asc, case when p_sort = 'near' then g.id end asc,
            case when p_sort = 'top' then g.score end desc, case when p_sort = 'top' then g.id end desc,
            g.created_at desc, g.id desc $$;

-- ---------- 46/57: карта — легкий ответ и признак неполной выдачи ----------
create or replace function public.map_v14(p_w double precision, p_s double precision, p_e double precision, p_n double precision,
  p_cats text[] default null, p_lat double precision default null, p_lng double precision default null, p_radius int default null,
  p_period text default null, p_friends boolean default false, p_limit int default 400)
returns jsonb language sql stable set search_path = public, extensions as $$
  with q as (
    select p.id, p.lat, p.lng, p.category, p.status, p.created_at, p.is_sos, p.official, p.user_id, p.expires_at,
           p.likes_count, p.comments_count, ev.starts_at, left(coalesce(p.meta->>'title', p.text), 80) title
      from public.posts p left join public.events ev on ev.post_id = p.id
     where p.status in ('active','closed')
       and (p.expires_at is null or p.expires_at > now())
       and case when p_radius is not null and p_lat is not null
             then extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography, least(greatest(p_radius, 100), 50000))
             else p.geog operator(extensions.&&) extensions.st_makeenvelope(p_w, p_s, p_e, p_n, 4326)::extensions.geography end
       and (p_cats is null or p.category = any (p_cats))
       and (p_period is null or (p_period = 'today' and p.created_at > date_trunc('day', now() at time zone 'Asia/Almaty') at time zone 'Asia/Almaty')
                             or (p_period = 'week' and p.created_at > now() - interval '7 days'))
       and (not coalesce(p_friends, false) or public.are_friends(auth.uid(), p.user_id))
       and not public.is_blocked(auth.uid(), p.user_id)
     order by p.created_at desc, p.id desc
     limit least(greatest(coalesce(p_limit, 400), 1), 500) + 1)
  select jsonb_build_object(
    'truncated', (select count(*) from q) > least(greatest(coalesce(p_limit, 400), 1), 500),
    'items', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id') from (select * from q limit least(greatest(coalesce(p_limit, 400), 1), 500)) x), '[]'::jsonb)) $$;

-- ---------- 61/03: замер задержки API из приложения (без данных пользователя) ----------
create or replace function public.ping() returns timestamptz language sql stable as $$ select now() $$;

-- ---------- уборка: + сверка счетчиков ----------
create or replace function public.near_cleanup() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int; e int;
begin
  delete from public.rate_events where created_at < now() - interval '2 days';
  delete from public.rate_counters where day < (now() at time zone 'Asia/Almaty')::date - 2;
  delete from public.rate_idem where created_at < now() - interval '3 days';
  delete from public.client_errors where created_at < now() - interval '30 days'; get diagnostics a = row_count;
  delete from public.analytics_events where created_at < now() - interval '180 days'; get diagnostics b = row_count;
  delete from public.push_log where created_at < now() - interval '90 days';
  select count(*) into c from public.posts where status = 'draft' and created_at < now() - interval '24 hours';
  select count(*) into d from public.conversations where orphaned_at < now() - interval '30 days';
  e := public.counters_reconcile();
  perform public.call_fn('moderate', jsonb_build_object('kind', 'cleanup'));
  return jsonb_build_object('errors_removed', a, 'events_removed', b, 'stale_drafts', c, 'orphaned_conversations', d, 'counters_fixed', e);
end $$;

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
