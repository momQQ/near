
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
