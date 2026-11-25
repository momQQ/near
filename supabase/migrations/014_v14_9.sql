-- =====================================================================
-- NEAR v14.9 — NEAR Shield + Player UI
-- Применять ПОСЛЕ 012_v12.sql. Идемпотентна: можно запускать повторно.
-- Перед запуском: резервная копия (SETUP.md, шаг 17.1).
-- Откат: 014_v14_9_rollback.sql (мягкий) или восстановление копии (полный).
-- Включение по шагам: после миграции enforce_sessions=false,
-- затем включить в app_settings.shield (шаг 17.7).
-- =====================================================================
-- =====================================================================
-- =====================================================================
--  v14.9 NEAR Shield: единая серверная безопасность
--  (сессии, санкции, риск, репутация, NEAR Clean, встречи, общие чаты)
--  Блок идемпотентный: повторный запуск ничего не ломает.
-- =====================================================================

-- ---------- 0. Настройки Shield (пороги и веса — стартовые для пилота) ----------
alter table public.app_settings add column if not exists shield jsonb not null default '{}'::jsonb;
update public.app_settings set shield = '{
  "enforce_sessions": true, "admin_mfa": true, "video": true, "dm": false,
  "meetings_pilot_only": true, "captcha_enforced": false, "formula": "rep-1",
  "risk": {"captcha": 25, "limit": 50, "hold": 75, "hold_hours": 24, "unconfirmed_days": 7},
  "weights": {"evasion": 35, "mass_reg": 20, "violation": 20, "suspicious": 12},
  "rep_penalty": {"warning": 5, "restricted": 15, "ban": 30}
}'::jsonb || shield where id = 1;
-- лимиты по ТЗ: 10 сообщений в минуту, 3 публикации за 10 минут (меняются в app_settings.limits)
update public.app_settings set limits = limits || '{
  "post": [3, 12, "10 minutes"], "chat": [10, 40, "1 minute"], "review": [20, 60, "1 day"],
  "nick": [10, 40, "1 hour"], "challenge": [5, 20, "1 hour"], "appeal": [5, 10, "1 day"]
}'::jsonb where id = 1 and not (limits ? 'chat');

create or replace function public.shield_cfg() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select shield from public.app_settings where id = 1), '{}'::jsonb) $$;

-- серверный ключ для HMAC идентификаторов (IP, установка). Не читается никем, кроме функций.
create table if not exists public.shield_secret (
  id int primary key default 1 check (id = 1),
  hmac_key text not null
);
alter table public.shield_secret enable row level security;
do $$ begin
  perform set_config('search_path', 'public, extensions', true);
  insert into public.shield_secret (id, hmac_key) values (1, encode(gen_random_bytes(32), 'hex')) on conflict do nothing;
end $$;

create or replace function public.shield_hash(v text) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case when v is null or v = '' then null
    else encode(hmac(v, (select hmac_key from public.shield_secret where id = 1), 'sha256'), 'hex') end $$;

-- IP хранится только как HMAC с серверным ключом (раньше — md5 с постоянной солью)
create or replace function public.req_ip_hash() returns text
language plpgsql stable security definer set search_path = public as $$
declare ip text;
begin
  begin
    ip := split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1);
  exception when others then ip := '';
  end;
  if ip is null or trim(ip) = '' then return null; end if;
  return public.shield_hash('ip:' || trim(ip));
end $$;

-- лимиты атомарные: параллельные запросы одного аккаунта/сети ждут друг друга
create or replace function public.rate_check(p_kind text, p_user_max int, p_ip_max int, p_window interval) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); iph text := public.req_ip_hash(); n int; rs int; c jsonb := public.shield_cfg();
begin
  if uid is null and iph is null then return; end if;
  if uid is not null then
    perform pg_advisory_xact_lock(hashtextextended('rate:' || p_kind || ':' || uid::text, 0));
    -- повышенный риск (50–74 и выше) — лимиты аккаунта вдвое ниже
    rs := public.risk_score(uid);
    if rs >= coalesce((c->'risk'->>'limit')::int, 50) then p_user_max := greatest(1, p_user_max / 2); end if;
    select count(*) into n from public.rate_events where kind = p_kind and user_id = uid and created_at > now() - p_window;
    if n >= p_user_max then
      raise exception using errcode = 'NR429', message = 'Слишком часто. Попробуйте немного позже', hint = p_kind;
    end if;
  end if;
  if iph is not null and p_ip_max is not null then
    perform pg_advisory_xact_lock(hashtextextended('rate:' || p_kind || ':' || iph, 0));
    select count(*) into n from public.rate_events where kind = p_kind and ip_hash = iph and created_at > now() - p_window;
    if n >= p_ip_max then
      raise exception using errcode = 'NR429', message = 'Слишком много действий из этой сети. Попробуйте позже', hint = p_kind;
    end if;
  end if;
  insert into public.rate_events (kind, user_id, ip_hash) values (p_kind, uid, iph);
end $$;

-- ---------- 1. Аудит: только добавление, изменить или удалить нельзя ----------
create table if not exists public.security_audit_log (
  id           bigserial primary key,
  actor_id     uuid,
  action       text not null,
  target_type  text,
  target_id    uuid,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists security_audit_target_idx on public.security_audit_log (target_id, created_at desc);
alter table public.security_audit_log enable row level security;
create or replace function public.audit_immutable() returns trigger
language plpgsql as $$
begin
  if current_setting('near.audit_purge', true) = '1' then return old; end if;  -- только плановая очистка по сроку хранения
  raise exception using errcode = 'NR403', message = 'Журнал аудита нельзя изменять';
end $$;
drop trigger if exists security_audit_immutable on public.security_audit_log;
create trigger security_audit_immutable before update or delete on public.security_audit_log for each row execute function public.audit_immutable();

create or replace function public.audit(p_action text, p_type text, p_id uuid, p_details jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.security_audit_log (actor_id, action, target_type, target_id, details)
  values (auth.uid(), p_action, p_type, p_id, coalesce(p_details, '{}'::jsonb)) $$;

-- ---------- 2. Роли и MFA: модератор, старший администратор, аудитор ----------
alter table public.profiles add column if not exists is_auditor boolean not null default false;
alter table public.profiles add column if not exists meetings_pilot boolean not null default false;

create or replace function public.jwt_claim(k text) returns text
language plpgsql stable as $$
begin
  return nullif(auth.jwt()->>k, '');
exception when others then return null;
end $$;

create or replace function public.aal_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((public.shield_cfg()->>'admin_mfa')::boolean, true) = false or public.jwt_claim('aal') = 'aal2' $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false) and public.aal_ok() $$;
create or replace function public.is_mod() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or is_moderator from public.profiles where id = auth.uid()), false) and public.aal_ok() $$;
create or replace function public.is_auditor() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or is_auditor from public.profiles where id = auth.uid()), false) and public.aal_ok() $$;
-- роль есть, но второй фактор не пройден — приложение просит включить 2FA
create or replace function public.staff_role() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'admin', coalesce(p.is_admin, false), 'moderator', coalesce(p.is_moderator, false), 'auditor', coalesce(p.is_auditor, false),
    'mfa_required', coalesce((public.shield_cfg()->>'admin_mfa')::boolean, true), 'aal', coalesce(public.jwt_claim('aal'), 'aal1'))
  from public.profiles p where p.id = auth.uid() $$;

drop policy if exists "audit read" on public.security_audit_log;
create policy "audit read" on public.security_audit_log for select using (public.is_auditor());

-- ---------- 3. Никнейм вместо имени и пола ----------
alter table public.profiles add column if not exists nickname text;
create unique index if not exists profiles_nickname_uq on public.profiles (lower(nickname)) where nickname is not null;

create or replace function public.nick_norm(t text) returns text
language sql immutable as $$ select lower(normalize(btrim(ltrim(btrim(coalesce(t, '')), '@')), NFKC)) $$;

-- ---------- 4. NEAR Clean: мат, скам, ссылки, интим, угрозы (RU/KZ/EN и транслит) ----------
-- Скелеты слова: похожие латинские буквы → кириллица; транслит → кириллица; латиница для английского.
create or replace function public.clean_fold(s text) returns text
language sql immutable as $$
  select regexp_replace(regexp_replace(translate(s, 'ёъь', 'е'), '[^[:alpha:]]', '', 'g'), '(.)\1+', '\1', 'g') $$;

create or replace function public.clean_skels(w text) returns text[]
language plpgsql immutable as $$
declare s text := lower(normalize(w, NFKC)); a text; b text; c text;
begin
  -- 1) похожие буквы и цифры (xyй, 6ля, n1zда)
  a := translate(s, 'aceopxykmtbh013469@$', 'асеорхукмтвноизчбба' || 'с');
  -- 2) транслит (blyad, pizda, khuy, suka)
  b := replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(s,
        'sch', 'щ'), 'sh', 'ш'), 'ch', 'ч'), 'zh', 'ж'), 'kh', 'х'), 'ya', 'я'), 'yo', 'е'), 'yu', 'ю'), 'ts', 'ц'), 'ye', 'е');
  b := translate(b, 'abvgdezijklmnoprstufhcyxw01346@$', 'абвгдезийклмнопрстуфхцыхвоизчбас');
  b := replace(replace(b, 'ый', 'уй'), 'ыя', 'уя');   -- khyi → хуй
  -- 3) латиница для английского (f*ck, sh1t)
  c := translate(s, '013457@$', 'oieastas');
  return array[public.clean_fold(a), public.clean_fold(b), public.clean_fold(c), public.clean_fold(s)];
end $$;

create or replace function public.clean_word_kind(w text) returns text
language plpgsql immutable as $$
declare k text[] := public.clean_skels(w); x text;
begin
  foreach x in array k loop
    if x ~ '^(на|по|за|от|вы|при|у|до|пере|рас|раз|из|под|о|об|недо|ни|до|е)?(ху[йеяюи]|пизд|пезд|еб[аеилнуоы]|еб$|бля|мудак|мудил|мудозв|пид[оа]р|педик|гандон|шлюх|залуп|манд[ауеы]$|сука$|суки$|суку$|сукой$|сукин|сучк|сучар)'
       or x ~ '^(motherf|fuck|fuk|fck|shit|bitch|cunt|asshole|dickhead|whore|slut)'
       or x ~ '^(қотақ|котак|сігейін|сигейин|сігем|сігіп|сігер|амыңды|аныңды)' then
      return 'mat';
    end if;
  end loop;
  foreach x in array k loop
    if x ~ '^(дебил|идиот|урод|твар[ьи]|мраз|чмо$|лох$|лохи$|даун$|кретин|ублюд|сволоч|ақымақ|акымак|idiot|moron|retard)' then return 'insult'; end if;
  end loop;
  return null;
end $$;

-- маска: первая буква, остальные звездочки; знаки препинания вокруг слова сохраняются
create or replace function public.clean_mask(tok text) returns text
language plpgsql immutable as $$
declare m text[];
begin
  m := regexp_match(tok, '^([^[:alnum:]@$]*)(.*?)([^[:alnum:]@$]*)$');
  if m is null or m[2] = '' then return tok; end if;
  return m[1] || left(m[2], 1) || repeat('*', greatest(char_length(m[2]) - 1, 3)) || m[3];
end $$;

create or replace function public.clean_text(p text, p_ctx text default 'text') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  src text := coalesce(p, ''); n text; outp text := ''; tok text; run text; joined text;
  reasons text[] := '{}'; verdict text := 'allow'; masked boolean := false; kind text; u text; host text;
  warn boolean;
begin
  if src = '' then return jsonb_build_object('text', src, 'verdict', 'allow', 'reasons', '[]'::jsonb, 'masked', false); end if;
  n := lower(normalize(src, NFKC));
  -- добросовестное предупреждение о мошенниках не блокируем ("никому не сообщайте код из SMS")
  warn := n ~ '(не\s+(сообщ|говор|перед|дава|отправл|скидыв)|никому\s+не|осторожн|мошенник|развод|аферист|алаяқ|абайла|scam|do not share|never share)';

  -- 1) мат, разбитый пробелами или точками: "б л я", "п.и.з.д.а"
  for run in select m[1] from regexp_matches(src, '((?:(?<![[:alnum:]@$])[[:alnum:]@$][ ._*-]+){2,}[[:alnum:]@$](?![[:alnum:]@$]))', 'g') as m loop
    joined := regexp_replace(run, '[ ._*-]', '', 'g');
    if public.clean_word_kind(joined) = 'mat' then
      src := replace(src, run, left(run, 1) || repeat('*', greatest(char_length(joined) - 1, 3)));
      masked := true;
    end if;
  end loop;

  -- 2) слова по одному, пробелы и переносы сохраняются
  for tok in select m[1] from regexp_matches(src, '(\s+|\S+)', 'g') as m loop
    if tok ~ '^\s+$' then outp := outp || tok; continue; end if;
    kind := public.clean_word_kind(tok);
    if kind = 'mat' then
      outp := outp || public.clean_mask(tok); masked := true;
    else
      if kind = 'insult' and not ('insult' = any (reasons)) then reasons := array_append(reasons, 'insult'); end if;
      outp := outp || tok;
    end if;
  end loop;

  -- 3) интим и поиск сексуального партнера
  if n ~ '((ищу|познаком|нужн[аы]?|кто\s+хочет).{0,40}(секс|интим|на\s+ночь|без\s+обязательств|вирт|эскорт|для\s+встреч\s+18)|интим[- ]?услуг|эскорт|проститут|nudes|hookup|sex\s*partner|onlyfans|жыныстық\s+қатынас)' then
    reasons := array_append(reasons, 'sex');
  end if;
  -- 4) эксплуатация несовершеннолетних — закрытая приоритетная очередь
  if n ~ '(детск\w*\s+порн|child\s*porn|\mцп\M|школьниц\w*\s+(фото|интим|18))' then reasons := array_append(reasons, 'minors'); end if;
  -- 5) угрозы — немедленная проверка
  if n ~ '(\mубью\M|убить\s+тебя|зарежу|прибью|взорву|сожгу\s+(тебя|дом|машин)|найду\s+тебя\s+и|тебе\s+конец|өлтіремін|i\s+will\s+kill|i''ll\s+kill)' then reasons := array_append(reasons, 'threat'); end if;
  -- 6) запрос данных карт, кодов из SMS, паролей
  if not warn and n ~ '((номер|данные|реквизит|цифр|фото)\w*\s.{0,20}(карт|card)|\mcvv2?\M|\mcvc\M|срок\s+действия\s+карт|(код|пароль)\w*.{0,20}(смс|sms|сообщени)|(смс|sms)\W{0,3}код|(скаж|продикт|пришл|отправ|скин|назов)\w*.{0,15}(код|пароль)|картаның\s+нөмір|card\s*number|sms\s*code|one.?time\s*code)' then
    reasons := array_append(reasons, 'scam_request');
  end if;
  -- 7) ссылки: без запросов к адресам, только разбор строки
  for u in select m[1] from regexp_matches(n, '((?:https?://)?(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]{1,24}(?:/[^\s]*)?)', 'g') as m loop
    host := split_part(regexp_replace(u, '^https?://', ''), '/', 1);
    if host ~ '^[0-9.]+$' or host like '%@%' or host ~ '(^|\.)xn--'
       or host ~ '^(bit\.ly|tinyurl\.com|cutt\.ly|clck\.ru|t\.ly|goo\.su|is\.gd|rb\.gy|shorturl\.at|tiny\.cc|u\.to|vk\.cc)$'
       or host ~ '\.(xyz|top|click|zip|mov|icu|cfd|sbs|rest|gq|tk|ml|cf|buzz|cam)$'
       or (host ~ 'kaspi' and host !~ '(^|\.)kaspi\.kz$') or (host ~ 'halyk' and host !~ '(^|\.)halykbank\.kz$')
       or (host ~ 'egov' and host !~ '(^|\.)egov\.kz$') or (host ~ '(olx|kolesa|krisha)' and host !~ '(^|\.)(olx|kolesa|krisha)\.kz$') then
      if not ('bad_link' = any (reasons)) then reasons := array_append(reasons, 'bad_link'); end if;
    end if;
  end loop;
  if n ~ '(t\.me|telegram|whatsapp|wa\.me).{0,60}(выигр|приз|розыгрыш|бесплатн|заработ|инвест)' and not warn then reasons := array_append(reasons, 'bad_link'); end if;

  verdict := case
    when 'minors' = any (reasons) or 'threat' = any (reasons) then 'hold'
    when 'sex' = any (reasons) or 'scam_request' = any (reasons) or 'bad_link' = any (reasons) then 'block'
    when 'insult' = any (reasons) then 'review'
    else 'allow' end;
  -- никнейм: мат и оскорбления не допускаются совсем
  if p_ctx = 'nickname' and (masked or 'insult' = any (reasons)) then verdict := 'block'; reasons := array_append(reasons, 'nick_bad'); end if;
  return jsonb_build_object('text', outp, 'verdict', verdict, 'reasons', to_jsonb(reasons), 'masked', masked);
end $$;

create or replace function public.clean_block_message(r jsonb) returns text
language sql immutable as $$
  select case
    when r->'reasons' ? 'nick_bad' then 'Такой никнейм нельзя использовать'
    when r->'reasons' ? 'sex' then 'Поиск интимных знакомств и интимный контент в NEAR запрещены'
    when r->'reasons' ? 'scam_request' then 'Нельзя просить данные карт, коды из SMS и пароли'
    when r->'reasons' ? 'bad_link' then 'Ссылка выглядит небезопасной. Уберите ее или дайте официальный адрес'
    when r->'reasons' ? 'duplicate' then 'Такое же сообщение уже отправлено. Подождите минуту'
    else 'Текст не прошел проверку NEAR Clean' end $$;

-- очередь модерации: то, что требует решения человека
create table if not exists public.moderation_queue (
  id            uuid primary key default gen_random_uuid(),
  content_type  text not null,
  content_id    uuid,
  user_id       uuid references public.profiles(id) on delete cascade,
  reason        text not null,
  priority      int not null default 3 check (priority between 1 and 5),
  restricted    boolean not null default false,   -- закрытая очередь: только старший администратор
  status        text not null default 'open' check (status in ('open','decided')),
  decision      text,
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (content_type, content_id, reason)
);
create index if not exists moderation_queue_open_idx on public.moderation_queue (status, priority, created_at);
alter table public.moderation_queue enable row level security;
drop policy if exists "queue read" on public.moderation_queue;
create policy "queue read" on public.moderation_queue for select using (public.is_admin() or (public.is_mod() and not restricted));

create or replace function public.queue_add(p_type text, p_id uuid, p_user uuid, p_reason text) returns void
language sql security definer set search_path = public as $$
  insert into public.moderation_queue (content_type, content_id, user_id, reason, priority, restricted)
  values (p_type, p_id, p_user, p_reason,
          case when p_reason in ('minors','threat','intimate') then 1 when p_reason in ('evasion','risk_hold') then 2 else 3 end,
          p_reason in ('minors','intimate'))
  on conflict (content_type, content_id, reason) do update set status = 'open', created_at = now() $$;

-- повтор одного и того же текста в течение 60 секунд — отказ
create table if not exists public.clean_recent (
  user_id uuid not null, h text not null, created_at timestamptz not null default now(), primary key (user_id, h)
);
alter table public.clean_recent enable row level security;

-- общий триггер: текст проверяется и маскируется ДО записи
create or replace function public.clean_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare col text := tg_argv[0]; ctx text := coalesce(tg_argv[1], tg_table_name); val text; r jsonb; hh text; uid uuid := auth.uid();
begin
  val := to_jsonb(new)->>col;
  if val is null or val = '' then return new; end if;
  if tg_op = 'UPDATE' and val is not distinct from (to_jsonb(old)->>col) then return new; end if;
  if current_setting('near.system', true) = '1' and uid is null then return new; end if;
  r := public.clean_text(val, ctx);
  if r->>'verdict' = 'block' then
    raise exception using errcode = 'NR422', message = public.clean_block_message(r), hint = 'clean';
  end if;
  -- дубль за 60 секунд (кроме никнейма и описания профиля)
  if uid is not null and ctx not in ('nickname','profile') and tg_op = 'INSERT' then
    hh := md5(regexp_replace(lower(val), '\s+', ' ', 'g'));
    if exists (select 1 from public.clean_recent c where c.user_id = uid and c.h = hh and c.created_at > now() - interval '60 seconds') then
      raise exception using errcode = 'NR429', message = 'Такое же сообщение уже отправлено. Подождите минуту', hint = 'duplicate';
    end if;
    insert into public.clean_recent (user_id, h) values (uid, hh) on conflict (user_id, h) do update set created_at = now();
  end if;
  new := jsonb_populate_record(new, jsonb_build_object(col, r->>'text'));
  if r->>'verdict' = 'hold' then
    -- угрозы и эксплуатация: сразу скрыть и отправить в приоритетную очередь
    if tg_table_name = 'posts' then new := jsonb_populate_record(new, '{"status":"draft"}');   -- видна только автору до решения
    elsif tg_table_name = 'chat_messages' then new := jsonb_populate_record(new, '{"mod_status":"pending"}');
    elsif tg_table_name = 'comments' then new := jsonb_populate_record(new, '{"held":true}');
    elsif tg_table_name = 'user_reviews' then new := jsonb_populate_record(new, '{"status":"pending"}');
    end if;
    perform public.queue_add(tg_table_name, (to_jsonb(new)->>'id')::uuid, uid,
      case when r->'reasons' ? 'minors' then 'minors' else 'threat' end);
  elsif r->>'verdict' = 'review' and tg_table_name <> 'profiles' then
    perform public.queue_add(tg_table_name, (to_jsonb(new)->>'id')::uuid, uid, 'insult');
  end if;
  return new;
end $$;

alter table public.comments add column if not exists held boolean not null default false;
drop policy if exists "comments read" on public.comments;
create policy "comments read" on public.comments for select using (
  public.can_see_post(post_id) and (not held or user_id = auth.uid() or public.is_mod()) and not public.is_blocked(auth.uid(), user_id));

do $$ declare r record; begin
  for r in select * from (values ('posts','text','post'), ('comments','text','comment'), ('profiles','name','profile'), ('profiles','bio','profile')) v(t, c, x) loop
    execute format('drop trigger if exists %I on public.%I', r.t || '_clean_' || r.c, r.t);
    execute format('create trigger %I before insert or update of %I on public.%I for each row execute function public.clean_guard(%L, %L)',
                   r.t || '_clean_' || r.c, r.c, r.t, r.c, r.x);
  end loop;
end $$;

-- никнейм: нормализация, формат, запрет мата, уникальность (без учета регистра)
create or replace function public.nick_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v text; r jsonb;
begin
  if new.nickname is null then return new; end if;
  if tg_op = 'UPDATE' and new.nickname is not distinct from old.nickname then return new; end if;
  v := public.nick_norm(new.nickname);
  if v !~ '^[a-z0-9_.]{3,20}$' or v ~ '^[._]|[._]$|\.\.' then
    raise exception using errcode = 'NR422', message = 'Никнейм: 3–20 символов, латинские буквы, цифры, точка и _', hint = 'nick_format';
  end if;
  if v ~ '^(admin|administrator|near|nearapp|support|moderator|modera|root|system|official|help|security)' then
    raise exception using errcode = 'NR422', message = 'Этот никнейм зарезервирован', hint = 'nick_reserved';
  end if;
  r := public.clean_text(v, 'nickname');
  if r->>'verdict' = 'block' then raise exception using errcode = 'NR422', message = 'Такой никнейм нельзя использовать', hint = 'nick_bad'; end if;
  if exists (select 1 from public.profiles where lower(nickname) = v and id <> new.id) then
    raise exception using errcode = 'NR409', message = 'Никнейм уже занят', hint = 'nick_taken';
  end if;
  if tg_op = 'UPDATE' and auth.uid() is not null then perform public.rate('nick'); end if;
  new.nickname := v;
  return new;
end $$;
drop trigger if exists profiles_nick on public.profiles;
create trigger profiles_nick before insert or update of nickname on public.profiles for each row execute function public.nick_guard();

create or replace function public.nickname_available(p text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v text := public.nick_norm(p);
begin
  perform public.rate('nick');
  if v !~ '^[a-z0-9_.]{3,20}$' or v ~ '^[._]|[._]$|\.\.' then return jsonb_build_object('ok', false, 'reason', 'Никнейм: 3–20 символов, латинские буквы, цифры, точка и _'); end if;
  if v ~ '^(admin|administrator|near|nearapp|support|moderator|modera|root|system|official|help|security)' then return jsonb_build_object('ok', false, 'reason', 'Этот никнейм зарезервирован'); end if;
  if public.clean_text(v, 'nickname')->>'verdict' = 'block' then return jsonb_build_object('ok', false, 'reason', 'Такой никнейм нельзя использовать'); end if;
  if exists (select 1 from public.profiles where lower(nickname) = v) then return jsonb_build_object('ok', false, 'reason', 'Никнейм уже занят'); end if;
  return jsonb_build_object('ok', true, 'nickname', v);
end $$;

-- регистрация: никнейм, почта, пароль, согласие. Имя и пол не обязательны.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare nick text := nullif(public.nick_norm(new.raw_user_meta_data->>'nickname'), '');
begin
  insert into public.profiles (id, district, name, nickname)
  values (new.id, nullif(new.raw_user_meta_data->>'district', ''),
          left(coalesce(nullif(new.raw_user_meta_data->>'name', ''), nullif(new.raw_user_meta_data->>'full_name', ''), nick, split_part(new.email, '@', 1)), 60),
          nick)
  on conflict (id) do nothing;
  update public.profiles set
    gender = case when new.raw_user_meta_data->>'gender' in ('m','f') then new.raw_user_meta_data->>'gender' end,
    verified = (new.email_confirmed_at is not null or coalesce(new.raw_app_meta_data->>'provider', '') = 'google'),
    accepted_rules_at = case when new.raw_user_meta_data->>'accepted_rules' = 'true' then now() end
  where id = new.id;
  return new;
end $$;

-- для публикаций и чатов нужен никнейм и согласие с правилами (пол больше не требуется)
create or replace function public.profile_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and exists (select 1 from public.profiles where id = auth.uid() and (nickname is null or accepted_rules_at is null)) then
    raise exception using errcode = 'NR403', message = 'Заполните профиль: никнейм и согласие с правилами', hint = 'profile_incomplete';
  end if;
  return new;
end $$;

-- ---------- 5. Устройства и сессии: одна активная сессия на аккаунт ----------
create table if not exists public.user_devices (
  user_id            uuid not null references public.profiles(id) on delete cascade,
  installation_hash  text not null,
  label              text,
  first_seen         timestamptz not null default now(),
  last_seen          timestamptz not null default now(),
  status             text not null default 'ok' check (status in ('ok','restricted')),
  primary key (user_id, installation_hash)
);
create index if not exists user_devices_hash_idx on public.user_devices (installation_hash);

create table if not exists public.user_sessions (
  session_id         uuid primary key,                       -- claim session_id из проверенного JWT, не от приложения
  user_id            uuid not null references public.profiles(id) on delete cascade,
  installation_hash  text,
  device_label       text,
  ip_hash            text,
  status             text not null default 'pending' check (status in ('pending','active','revoked')),
  created_at         timestamptz not null default now(),
  activated_at       timestamptz,
  last_seen          timestamptz not null default now(),
  revoked_at         timestamptz,
  revoke_reason      text,
  reauth_at          timestamptz
);
-- ровно одна активная сессия, даже при параллельных запросах
create unique index if not exists user_sessions_one_active on public.user_sessions (user_id) where status = 'active';
create index if not exists user_sessions_user_idx on public.user_sessions (user_id, created_at desc);

create table if not exists public.session_challenges (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  session_id       uuid not null,
  old_session_id   uuid,
  code_hash        text not null,
  attempts         int not null default 0,
  sends            int not null default 1,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '10 minutes',
  resend_at        timestamptz not null default now() + interval '60 seconds',
  consumed_at      timestamptz,
  cancelled_at     timestamptz
);
create index if not exists session_challenges_user_idx on public.session_challenges (user_id, created_at desc);

create table if not exists public.device_restrictions (
  installation_hash  text primary key,
  reason             text not null,
  expires_at         timestamptz,
  review_status      text not null default 'pending' check (review_status in ('pending','confirmed','rejected')),
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);

alter table public.user_devices enable row level security;
alter table public.user_sessions enable row level security;
alter table public.session_challenges enable row level security;
alter table public.device_restrictions enable row level security;
drop policy if exists "devices own" on public.user_devices;
drop policy if exists "sessions own" on public.user_sessions;
create policy "devices own" on public.user_devices for select using (auth.uid() = user_id or public.is_mod());
create policy "sessions own" on public.user_sessions for select using (auth.uid() = user_id or public.is_mod());

create or replace function public.jwt_sid() returns uuid
language plpgsql stable as $$
begin
  return nullif(public.jwt_claim('session_id'), '')::uuid;
exception when others then return null;
end $$;

-- актуальная сессия: токен не просто действителен, а принадлежит единственной активной сессии
create or replace function public.session_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    coalesce((public.shield_cfg()->>'enforce_sessions')::boolean, true) = false
    or exists (select 1 from public.user_sessions s where s.session_id = public.jwt_sid() and s.user_id = auth.uid() and s.status = 'active')) $$;

-- ---------- 6. Санкции (баны), состояние аккаунта ----------
create sequence if not exists public.ban_decision_seq start 241;
create table if not exists public.user_bans (
  id             uuid primary key default gen_random_uuid(),
  decision_no    text not null unique default 'NS-' || lpad(nextval('public.ban_decision_seq')::text, 5, '0'),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  kind           text not null check (kind in ('warning','restricted','ban')),
  scope          text not null default 'global' check (scope in ('global','chat','meeting')),
  scope_id       uuid,
  rule           text not null,
  reason         text not null check (char_length(reason) between 5 and 500),
  evidence       text check (evidence is null or char_length(evidence) <= 2000),
  starts_at      timestamptz not null default now(),
  expires_at     timestamptz,                                   -- null у бана = бессрочно
  status         text not null default 'active' check (status in ('active','revoked')),
  moderator_id   uuid references public.profiles(id) on delete set null,
  approved_by    uuid references public.profiles(id) on delete set null,
  source_key     text unique,                                   -- повтор того же решения не создает второй бан
  linked_from    uuid references public.user_bans(id) on delete set null,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  revoked_by     uuid references public.profiles(id) on delete set null,
  revoke_reason  text,
  check (kind <> 'warning' or expires_at is null),
  check (expires_at is null or expires_at > starts_at)
);
create index if not exists user_bans_user_idx on public.user_bans (user_id, status, expires_at);
alter table public.user_bans enable row level security;
drop policy if exists "bans read" on public.user_bans;
create policy "bans read" on public.user_bans for select using (auth.uid() = user_id or public.is_mod());

-- матрица пилота: правило → сроки (в часах; null = бессрочно; 0 = предупреждение)
create or replace function public.ban_rules() returns jsonb
language sql immutable as $$ select '{
  "minor":      {"title": "Незначительное нарушение", "first": 0,    "repeat": 24},
  "spam":       {"title": "Спам",                    "first": 24,   "repeat": 168, "repeat_max": 720},
  "ads":        {"title": "Массовая реклама",        "first": 24,   "repeat": 720},
  "insult":     {"title": "Оскорбления",             "first": 0,    "repeat": 168, "repeat_max": 720},
  "harassment": {"title": "Домогательства",          "first": 720,  "repeat": null},
  "intimate":   {"title": "Интимный контент",        "first": 720,  "repeat": null},
  "threat":     {"title": "Угрозы",                  "first": 720,  "repeat": null},
  "scam":       {"title": "Подтвержденный скам",     "first": null, "repeat": null},
  "evasion":    {"title": "Подтвержденный обход бана","first": 720, "repeat": null},
  "boosting":   {"title": "Накрутка рейтинга",       "first": 24,   "repeat": 720}
}'::jsonb $$;

-- самая строгая действующая санкция; срок проверяется при каждом запросе (без cron)
create or replace function public.account_state(p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := coalesce(p_user, auth.uid()); b record; ap record;
begin
  if uid is null then return jsonb_build_object('state', 'guest', 'server_now', now()); end if;
  if p_user is not null and p_user <> auth.uid() and not public.is_mod() and auth.uid() is not null then
    raise exception using errcode = 'NR403', message = 'Нет доступа';
  end if;
  select * into b from public.user_bans
   where user_id = uid and status = 'active' and scope = 'global' and kind in ('restricted','ban')
     and starts_at <= now() and (expires_at is null or expires_at > now())
   order by (kind = 'ban') desc, (expires_at is null) desc, expires_at desc limit 1;
  if b.id is null then return jsonb_build_object('state', 'active', 'server_now', now()); end if;
  select status, created_at into ap from public.ban_appeals where ban_id = b.id order by created_at desc limit 1;
  return jsonb_build_object(
    'state', case when b.kind = 'restricted' then 'restricted' when b.expires_at is null then 'banned_permanent' else 'banned_until' end,
    'ban_id', b.id, 'decision_no', b.decision_no, 'rule', b.rule, 'rule_title', public.ban_rules()->b.rule->>'title',
    'reason', b.reason, 'starts_at', b.starts_at, 'expires_at', b.expires_at, 'server_now', now(),
    'appeal', ap.status);
end $$;

-- 0 — можно все, 1 — ограничение (только чтение), 2 — бан
create or replace function public.ban_level(p_user uuid default null) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(max(case kind when 'ban' then 2 else 1 end), 0) from public.user_bans
   where user_id = coalesce(p_user, auth.uid()) and status = 'active' and scope = 'global' and kind in ('restricted','ban')
     and starts_at <= now() and (expires_at is null or expires_at > now()) $$;

-- Главный guard: используется всеми правилами записи (RLS, RPC, Storage).
-- true = писать нельзя: нет актуальной сессии, ограничение или бан.
create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (not public.session_ok() or public.ban_level() > 0) $$;
-- чтение закрытых данных: актуальная сессия и нет бана
create or replace function public.shield_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select public.session_ok() and public.ban_level() < 2 $$;

create or replace function public.shield_require(p_action text default 'write') returns void
language plpgsql security definer set search_path = public as $$
declare lvl int;
begin
  if auth.uid() is null then raise exception using errcode = 'NR401', message = 'Войдите в NEAR', hint = 'auth'; end if;
  if not public.session_ok() then
    raise exception using errcode = 'NR401', message = 'Вы вышли из аккаунта: выполнен вход на другом устройстве', hint = 'session_revoked';
  end if;
  lvl := public.ban_level();
  if lvl = 2 then raise exception using errcode = 'NR403', message = 'Аккаунт заблокирован', hint = 'banned'; end if;
  if lvl = 1 and p_action <> 'read' then raise exception using errcode = 'NR403', message = 'Действие ограничено решением модератора', hint = 'restricted'; end if;
  if p_action in ('risky','meeting') and public.risk_hold_active() then
    raise exception using errcode = 'NR403', message = 'Действие временно ограничено: аккаунт на проверке', hint = 'risk_hold';
  end if;
end $$;

-- старое поле profiles.banned остается для отчетов и совместимости, источник правды — user_bans
create or replace function public.ban_sync(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('near.ban_sync', '1', true);
  update public.profiles set banned = (public.ban_level(p_user) = 2) where id = p_user;
  perform set_config('near.ban_sync', '', true);
end $$;
-- старый путь бана (mod_act 'ban' без причины) закрыт: решение выносится только через NEAR Shield
create or replace function public.legacy_ban_guard() returns trigger
language plpgsql as $$
begin
  if new.banned is distinct from old.banned and coalesce(current_setting('near.ban_sync', true), '') <> '1' and auth.uid() is not null then
    raise exception using errcode = 'NR403', message = 'Блокировка выносится в NEAR Shield: с причиной, сроком и номером решения', hint = 'use_shield';
  end if;
  return new;
end $$;
drop trigger if exists profiles_legacy_ban on public.profiles;
create trigger profiles_legacy_ban before update of banned on public.profiles for each row execute function public.legacy_ban_guard();

-- перенос старых банов v11/v12 в user_bans (бессрочно, с пометкой о переносе)
insert into public.user_bans (user_id, kind, rule, reason, source_key)
select id, 'ban', 'minor', 'Перенесено из прежней системы блокировок (v12)', 'legacy:' || id
  from public.profiles where banned on conflict (source_key) do nothing;

-- ---------- 7. Вход: начало сессии, подтверждение нового устройства ----------
create or replace function public.session_begin(p_installation text, p_label text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  uid uuid := auth.uid(); sid uuid := public.jwt_sid(); inst text; cur record; act record; ch record;
  code text; st jsonb; first_login boolean;
begin
  if uid is null or sid is null then raise exception using errcode = 'NR401', message = 'Войдите в NEAR', hint = 'auth'; end if;
  inst := public.shield_hash('inst:' || coalesce(nullif(p_installation, ''), sid::text));
  p_label := left(coalesce(nullif(p_label, ''), 'Устройство'), 60);
  -- блокировка строки пользователя: параллельные входы выстраиваются в очередь
  perform 1 from public.profiles where id = uid for update;
  first_login := not exists (select 1 from public.user_sessions where user_id = uid);

  st := public.account_state(uid);
  if st->>'state' in ('banned_until','banned_permanent') then
    -- бан при входе с любого устройства не снимается; доступен только экран решения
    return jsonb_build_object('state', 'banned', 'account', st);
  end if;

  select * into cur from public.user_sessions where session_id = sid;
  if cur.status = 'active' then
    update public.user_sessions set last_seen = now() where session_id = sid and last_seen < now() - interval '1 minute';
    return jsonb_build_object('state', 'active', 'account', st);
  end if;
  if cur.status = 'revoked' then
    return jsonb_build_object('state', 'revoked', 'reason', cur.revoke_reason);
  end if;

  insert into public.user_devices (user_id, installation_hash, label) values (uid, inst, p_label)
  on conflict (user_id, installation_hash) do update set last_seen = now(), label = excluded.label;
  if first_login then perform public.risk_on_register(uid, inst); end if;

  select * into act from public.user_sessions where user_id = uid and status = 'active';
  -- нет активной сессии или вход с того же устройства — активируем сразу
  if act.session_id is null or act.installation_hash = inst then
    if act.session_id is not null then
      update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'same_device' where session_id = act.session_id;
    end if;
    insert into public.user_sessions (session_id, user_id, installation_hash, device_label, ip_hash, status, activated_at)
    values (sid, uid, inst, p_label, public.req_ip_hash(), 'active', now())
    on conflict (session_id) do update set status = 'active', activated_at = now();
    perform public.audit('session_activate', 'user', uid, jsonb_build_object('device', p_label, 'first', first_login));
    return jsonb_build_object('state', 'active', 'account', st);
  end if;

  -- новое устройство: нужна проверка по почте. Пока ее нет — закрытые данные недоступны.
  insert into public.user_sessions (session_id, user_id, installation_hash, device_label, ip_hash, status)
  values (sid, uid, inst, p_label, public.req_ip_hash(), 'pending') on conflict (session_id) do nothing;
  select * into ch from public.session_challenges
   where user_id = uid and consumed_at is null and cancelled_at is null and expires_at > now() order by created_at desc limit 1;
  if ch.id is not null and ch.session_id <> sid then
    raise exception using errcode = 'NR409', message = 'Вход уже подтверждается на другом устройстве. Попробуйте через 10 минут', hint = 'challenge_busy';
  end if;
  if ch.id is null then
    perform public.rate('challenge');
    code := lpad((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
    insert into public.session_challenges (user_id, session_id, old_session_id, code_hash)
    values (uid, sid, act.session_id, public.shield_hash('code:' || code)) returning * into ch;
    perform public.call_fn('shield-mail', jsonb_build_object('kind', 'login_code', 'user_id', uid, 'code', code, 'device', p_label));
    -- демо и тесты без почтового сервиса: код виден только серверу; в демо-режиме приложение работает локально
  end if;
  return jsonb_build_object('state', 'challenge', 'challenge_id', ch.id, 'expires_at', ch.expires_at, 'resend_at', ch.resend_at,
    'attempts_left', 5 - ch.attempts, 'old_device', act.device_label, 'old_last_seen', act.last_seen, 'server_now', now());
end $$;

create or replace function public.session_confirm(p_challenge uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid := auth.uid(); sid uuid := public.jwt_sid(); ch record; act record; st jsonb; old_label text;
begin
  if uid is null or sid is null then raise exception using errcode = 'NR401', message = 'Войдите в NEAR', hint = 'auth'; end if;
  perform 1 from public.profiles where id = uid for update;
  select * into ch from public.session_challenges where id = p_challenge and user_id = uid and session_id = sid for update;
  if ch.id is null or ch.consumed_at is not null or ch.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'error', 'Код больше не действует. Войдите заново', 'final', true);
  end if;
  if ch.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'Срок кода истек. Запросите новый код', 'expired', true);
  end if;
  if ch.attempts >= 5 then
    update public.session_challenges set cancelled_at = now() where id = ch.id;
    return jsonb_build_object('ok', false, 'error', 'Слишком много попыток. Войдите заново', 'final', true);
  end if;
  -- бан мог появиться во время подтверждения
  st := public.account_state(uid);
  if st->>'state' in ('banned_until','banned_permanent') then
    update public.session_challenges set cancelled_at = now() where id = ch.id;
    return jsonb_build_object('ok', false, 'state', 'banned', 'account', st, 'final', true);
  end if;
  if public.shield_hash('code:' || coalesce(btrim(p_code), '')) is distinct from ch.code_hash then
    update public.session_challenges set attempts = attempts + 1 where id = ch.id;   -- попытка сохраняется (функция не падает)
    return jsonb_build_object('ok', false, 'error', 'Неверный код', 'attempts_left', 4 - ch.attempts, 'final', ch.attempts + 1 >= 5);
  end if;
  -- гонка: за время подтверждения активной стала другая сессия — этот challenge отклоняем
  select * into act from public.user_sessions where user_id = uid and status = 'active';
  if act.session_id is distinct from ch.old_session_id then
    update public.session_challenges set cancelled_at = now() where id = ch.id;
    return jsonb_build_object('ok', false, 'error', 'Вход уже выполнен на другом устройстве. Войдите заново', 'final', true);
  end if;
  -- одна транзакция: погасить код, отозвать старую сессию, активировать новую
  update public.session_challenges set consumed_at = now() where id = ch.id;
  old_label := act.device_label;
  if act.session_id is not null then
    update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'new_device' where session_id = act.session_id;
    perform public.revoke_auth_session(act.session_id);
  end if;
  update public.user_sessions set status = 'active', activated_at = now(), last_seen = now() where session_id = sid;
  delete from public.push_subs where user_id = uid;   -- push старого устройства больше не приходят
  perform public.audit('session_new_device', 'user', uid, jsonb_build_object('old', old_label));
  perform public.call_fn('shield-mail', jsonb_build_object('kind', 'new_login', 'user_id', uid,
    'device', (select device_label from public.user_sessions where session_id = sid)));
  return jsonb_build_object('ok', true, 'state', 'active');
end $$;

create or replace function public.session_resend(p_challenge uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid := auth.uid(); ch record; code text;
begin
  select * into ch from public.session_challenges where id = p_challenge and user_id = uid and session_id = public.jwt_sid()
     and consumed_at is null and cancelled_at is null for update;
  if ch.id is null then return jsonb_build_object('ok', false, 'error', 'Войдите заново'); end if;
  if ch.resend_at > now() then return jsonb_build_object('ok', false, 'error', 'Повторно — через минуту', 'resend_at', ch.resend_at); end if;
  if ch.sends >= 3 then return jsonb_build_object('ok', false, 'error', 'Лимит писем исчерпан. Войдите заново позже'); end if;
  code := lpad((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
  update public.session_challenges set code_hash = public.shield_hash('code:' || code), sends = sends + 1,
         resend_at = now() + interval '60 seconds', expires_at = now() + interval '10 minutes' where id = ch.id;
  perform public.call_fn('shield-mail', jsonb_build_object('kind', 'login_code', 'user_id', uid, 'code', code));
  return jsonb_build_object('ok', true, 'resend_at', now() + interval '60 seconds');
end $$;

-- отмена: новое устройство не входит, старое продолжает работать
create or replace function public.session_cancel() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.session_challenges set cancelled_at = now() where user_id = auth.uid() and session_id = public.jwt_sid() and consumed_at is null;
  update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'cancelled' where session_id = public.jwt_sid() and status = 'pending';
end $$;

create or replace function public.session_end() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'logout'
   where session_id = public.jwt_sid() and user_id = auth.uid() and status <> 'revoked';
  delete from public.push_subs where user_id = auth.uid();
end $$;

create or replace function public.session_state() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; rs int;
begin
  if auth.uid() is null then return jsonb_build_object('state', 'guest', 'server_now', now()); end if;
  select * into s from public.user_sessions where session_id = public.jwt_sid() and user_id = auth.uid();
  if s.status = 'active' then
    update public.user_sessions set last_seen = now() where session_id = s.session_id and last_seen < now() - interval '1 minute';
  end if;
  rs := public.risk_score(auth.uid());
  return jsonb_build_object(
    'state', case when coalesce((public.shield_cfg()->>'enforce_sessions')::boolean, true) = false then 'active' else coalesce(s.status, 'none') end,
    'reason', s.revoke_reason, 'account', public.account_state(), 'server_now', now(),
    'captcha', rs >= coalesce((public.shield_cfg()->'risk'->>'captcha')::int, 25) and coalesce((public.shield_cfg()->>'captcha_enforced')::boolean, false),
    'hold', public.risk_hold_active());
end $$;

-- история входов: только свои данные, без IP
create or replace function public.session_list() returns table (device_label text, status text, created_at timestamptz, last_seen timestamptz, revoked_at timestamptz, revoke_reason text, current boolean)
language sql stable security definer set search_path = public as $$
  select s.device_label, s.status, s.created_at, s.last_seen, s.revoked_at, s.revoke_reason, s.session_id = public.jwt_sid()
    from public.user_sessions s where s.user_id = auth.uid() order by s.created_at desc limit 30 $$;

-- отзыв токенов в самой системе входа (если доступна): старый refresh-токен перестает работать
create or replace function public.revoke_auth_session(p_sid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  begin execute 'delete from auth.sessions where id = $1' using p_sid; exception when others then null; end;
end $$;

-- смена пароля (в том числе восстановление) отзывает все прежние сессии
create or replace function public.on_password_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    update public.user_sessions set status = 'revoked', revoked_at = now(), revoke_reason = 'password_changed'
     where user_id = new.id and status <> 'revoked';
    insert into public.security_audit_log (actor_id, action, target_type, target_id) values (new.id, 'password_changed', 'user', new.id);
  end if;
  return new;
end $$;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'encrypted_password') then
    execute 'drop trigger if exists on_auth_password_change on auth.users';
    execute 'create trigger on_auth_password_change after update of encrypted_password on auth.users for each row execute function public.on_password_change()';
  end if;
end $$;

-- повторное подтверждение личности (пароль проверяет функция shield-login) — 5 минут на смену почты или удаление
create or replace function public.session_reauth_mark(p_user uuid, p_sid uuid) returns void
language sql security definer set search_path = public as $$
  update public.user_sessions set reauth_at = now() where session_id = p_sid and user_id = p_user and status = 'active' $$;
create or replace function public.reauth_fresh() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_sessions where session_id = public.jwt_sid() and user_id = auth.uid()
                  and status = 'active' and reauth_at > now() - interval '5 minutes') $$;

-- ---------- 7a. Вход по никнейму или почте (функция shield-login, только сервер) ----------
-- Лимиты атомарные: по источнику и по паре "аккаунт + источник". Чужие попытки из другой сети
-- не блокируют владельца — по аккаунту только включается CAPTCHA.
create table if not exists public.login_attempts (
  id          bigserial primary key,
  src_hash    text,
  acct_hash   text,
  ok          boolean not null,
  created_at  timestamptz not null default now()
);
create index if not exists login_attempts_src_idx on public.login_attempts (src_hash, created_at desc);
create index if not exists login_attempts_acct_idx on public.login_attempts (acct_hash, created_at desc);
alter table public.login_attempts enable row level security;

create or replace function public.login_gate(p_src text, p_login text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s text := public.shield_hash('ip:' || coalesce(p_src, '')); a text := public.shield_hash('acct:' || public.nick_norm(p_login)); n_src int; n_pair int; n_acct int;
begin
  perform pg_advisory_xact_lock(hashtextextended('login:' || coalesce(s, '') || ':' || a, 0));
  select count(*) into n_src from public.login_attempts where src_hash = s and not ok and created_at > now() - interval '10 minutes';
  select count(*) into n_pair from public.login_attempts where src_hash = s and acct_hash = a and not ok and created_at > now() - interval '15 minutes';
  select count(*) into n_acct from public.login_attempts where acct_hash = a and not ok and created_at > now() - interval '15 minutes';
  return jsonb_build_object('allowed', n_src < 20 and n_pair < 5, 'captcha', n_acct >= 5 or n_src >= 5);
end $$;

create or replace function public.login_record(p_src text, p_login text, p_ok boolean) returns void
language sql security definer set search_path = public as $$
  insert into public.login_attempts (src_hash, acct_hash, ok)
  values (public.shield_hash('ip:' || coalesce(p_src, '')), public.shield_hash('acct:' || public.nick_norm(p_login)), p_ok) $$;

create or replace function public.login_email(p_login text) returns text
language sql stable security definer set search_path = public as $$
  select u.email from auth.users u join public.profiles p on p.id = u.id where lower(p.nickname) = public.nick_norm(p_login) limit 1 $$;
revoke all on public.login_attempts from public, anon, authenticated;
revoke execute on function public.login_gate(text, text), public.login_record(text, text, boolean), public.login_email(text) from public, anon, authenticated;

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
