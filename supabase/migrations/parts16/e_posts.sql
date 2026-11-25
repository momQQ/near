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
