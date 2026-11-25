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
