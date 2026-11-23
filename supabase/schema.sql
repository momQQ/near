-- =====================================================
--  NEAR — схема базы данных для Supabase
--  Как применить: Supabase → SQL Editor → New query →
--  вставить ВЕСЬ этот файл → Run.
--  Скрипт можно запускать повторно: он ничего не сломает.
-- =====================================================

-- ---------- 1. Профили пользователей ----------
-- Логины и пароли Supabase хранит сам (auth.users).
-- Здесь — публичный профиль: имя, фото, район.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null default 'Пользователь',
  avatar_url  text,
  district    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Профиль создается автоматически при регистрации
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 2. Публикации ----------
create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  category    text not null check (category in ('incident','event','deal','lost','found','meetup','ad','talk')),
  text        text not null check (char_length(text) between 1 and 1000),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  status      text not null default 'active' check (status in ('active','closed','deleted')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists posts_geo_idx     on public.posts (lat, lng);
create index if not exists posts_created_idx on public.posts (created_at desc);
create index if not exists posts_user_idx    on public.posts (user_id);

-- ---------- 3. Фото и видео публикаций ----------
create table if not exists public.post_media (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  url         text not null,
  path        text,
  type        text not null default 'image' check (type in ('image','video')),
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists post_media_post_idx on public.post_media (post_id);

-- ---------- 4. Комментарии ----------
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  text        text not null check (char_length(text) between 1 and 500),
  created_at  timestamptz not null default now()
);
create index if not exists comments_post_idx on public.comments (post_id, created_at);

-- ---------- 5. Лайки ----------
create table if not exists public.likes (
  post_id     uuid not null references public.posts(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- ---------- 6. Сохраненное ----------
create table if not exists public.saved_posts (
  post_id     uuid not null references public.posts(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- ---------- 7. События (доп. поля для публикаций-событий) ----------
create table if not exists public.events (
  post_id     uuid primary key references public.posts(id) on delete cascade,
  starts_at   timestamptz not null,
  capacity    int check (capacity is null or capacity > 0)
);

create table if not exists public.event_members (
  post_id     uuid not null references public.posts(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id)
);


-- ---------- 8. Уведомления ----------
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  actor_id    uuid,
  type        text not null,
  post_id     uuid references public.posts(id) on delete cascade,
  text        text,
  read        boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint notifications_user_fkey  foreign key (user_id)  references public.profiles(id) on delete cascade,
  constraint notifications_actor_fkey foreign key (actor_id) references public.profiles(id) on delete set null
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- Уведомления создаются автоматически: лайк, комментарий, участие в событии
create or replace function public.notify_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare owner uuid; msg text;
begin
  select user_id into owner from public.posts where id = new.post_id;
  if owner is null or owner = new.user_id then return new; end if;
  if tg_table_name = 'comments' then
    msg := 'прокомментировал(а): ' || left(new.text, 60);
  elsif tg_table_name = 'likes' then
    msg := 'оценил(а) вашу публикацию';
  else
    msg := 'присоединился(ась) к вашему событию';
  end if;
  insert into public.notifications (user_id, actor_id, type, post_id, text)
  values (owner, new.user_id, tg_table_name, new.post_id, msg);
  return new;
end $$;

drop trigger if exists likes_notify on public.likes;
create trigger likes_notify after insert on public.likes for each row execute function public.notify_owner();
drop trigger if exists comments_notify on public.comments;
create trigger comments_notify after insert on public.comments for each row execute function public.notify_owner();
drop trigger if exists members_notify on public.event_members;
create trigger members_notify after insert on public.event_members for each row execute function public.notify_owner();

-- =====================================================
--  ПРАВА ДОСТУПА (Row Level Security)
--  Читать публикации могут все, менять — только автор.
-- =====================================================
alter table public.profiles      enable row level security;
alter table public.posts         enable row level security;
alter table public.post_media    enable row level security;
alter table public.comments      enable row level security;
alter table public.likes         enable row level security;
alter table public.saved_posts   enable row level security;
alter table public.events        enable row level security;
alter table public.event_members enable row level security;
alter table public.notifications enable row level security;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and tablename in ('profiles','posts','post_media','comments','likes','saved_posts','events','event_members','notifications')
  loop execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename); end loop;
end $$;

-- профили
create policy "profiles read"   on public.profiles for select using (true);
create policy "profiles insert" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles update" on public.profiles for update using (auth.uid() = id);
-- публикации
create policy "posts read"   on public.posts for select using (status <> 'deleted' or auth.uid() = user_id);
create policy "posts insert" on public.posts for insert with check (auth.uid() = user_id);
create policy "posts update" on public.posts for update using (auth.uid() = user_id);
create policy "posts delete" on public.posts for delete using (auth.uid() = user_id);
-- медиа
create policy "media read"   on public.post_media for select using (true);
create policy "media insert" on public.post_media for insert with check (
  auth.uid() = user_id and exists (select 1 from public.posts p where p.id = post_id and p.user_id = auth.uid()));
create policy "media delete" on public.post_media for delete using (auth.uid() = user_id);
-- комментарии
create policy "comments read"   on public.comments for select using (true);
create policy "comments insert" on public.comments for insert with check (auth.uid() = user_id);
create policy "comments delete" on public.comments for delete using (auth.uid() = user_id);
-- лайки
create policy "likes read"   on public.likes for select using (true);
create policy "likes insert" on public.likes for insert with check (auth.uid() = user_id);
create policy "likes delete" on public.likes for delete using (auth.uid() = user_id);
-- сохраненное (видит только владелец)
create policy "saved read"   on public.saved_posts for select using (auth.uid() = user_id);
create policy "saved insert" on public.saved_posts for insert with check (auth.uid() = user_id);
create policy "saved delete" on public.saved_posts for delete using (auth.uid() = user_id);
-- события
create policy "events read"  on public.events for select using (true);
create policy "events write" on public.events for all
  using (exists (select 1 from public.posts p where p.id = post_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.posts p where p.id = post_id and p.user_id = auth.uid()));
create policy "members read"   on public.event_members for select using (true);
create policy "members insert" on public.event_members for insert with check (auth.uid() = user_id);
create policy "members delete" on public.event_members for delete using (auth.uid() = user_id);
-- уведомления (видит только получатель)
create policy "notifs read"   on public.notifications for select using (auth.uid() = user_id);
create policy "notifs update" on public.notifications for update using (auth.uid() = user_id);

-- =====================================================
--  ХРАНИЛИЩЕ ФОТО И ВИДЕО
--  Бакет post-media: публичное чтение, загрузка только
--  в свою папку <user_id>/..., лимит 30 МБ.
-- =====================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-media', 'post-media', true, 31457280,
        array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "near media read"   on storage.objects;
drop policy if exists "near media upload" on storage.objects;
drop policy if exists "near media delete" on storage.objects;
create policy "near media read" on storage.objects for select using (bucket_id = 'post-media');
create policy "near media upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'post-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "near media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'post-media' and (storage.foldername(name))[1] = auth.uid()::text);

-- =====================================================
--  ОБНОВЛЕНИЯ В РЕАЛЬНОМ ВРЕМЕНИ
--  Новые публикации и уведомления приходят без перезагрузки.
-- =====================================================
do $$ begin
  begin alter publication supabase_realtime add table public.posts; exception when others then null; end;
  begin alter publication supabase_realtime add table public.notifications; exception when others then null; end;
end $$;

-- Готово ✅
