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
