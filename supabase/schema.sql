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
  -- согласие с правилами сообщества (колонка появляется в части 2 схемы)
  begin
    if new.raw_user_meta_data->>'accepted_rules' = 'true' then
      execute 'update public.profiles set accepted_rules_at = now() where id = $1' using new.id;
    end if;
  exception when undefined_column then null;
  end;
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
  status      text not null default 'active' check (status in ('active','closed','deleted','hidden')),
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
  mod_status  text not null default 'ok' check (mod_status in ('ok','pending','flagged')),
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
--  ЧАСТЬ 2: друзья, сообщения, блокировки, жалобы, модерация
-- =====================================================

-- обновление старых таблиц (если схема уже была установлена раньше)
alter table public.profiles add column if not exists instagram text;
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists banned boolean not null default false;
alter table public.profiles add column if not exists accepted_rules_at timestamptz;
alter table public.post_media add column if not exists mod_status text not null default 'ok';
alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check check (status in ('active','closed','deleted','hidden'));

-- ник Instagram: только буквы, цифры, точка и _
alter table public.profiles drop constraint if exists profiles_instagram_check;
alter table public.profiles add constraint profiles_instagram_check check (instagram is null or instagram ~ '^[A-Za-z0-9._]{1,30}$');

-- ---------- настройки приложения ----------
create table if not exists public.app_settings (
  id             int primary key default 1 check (id = 1),
  ai_moderation  boolean not null default false
);
insert into public.app_settings (id) values (1) on conflict do nothing;

-- ---------- вспомогательные функции ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;

create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select banned from public.profiles where id = auth.uid()), false) $$;

-- ---------- блокировки ----------
create table if not exists public.blocks (
  blocker_id  uuid not null references public.profiles(id) on delete cascade,
  blocked_id  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create or replace function public.is_blocked(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocks where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)) $$;

-- ---------- друзья ----------
create table if not exists public.friendships (
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted')),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
create unique index if not exists friendships_pair_uidx on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

-- при блокировке дружба и заявки удаляются
create or replace function public.on_block() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.friendships
   where (requester_id = new.blocker_id and addressee_id = new.blocked_id)
      or (requester_id = new.blocked_id and addressee_id = new.blocker_id);
  return new;
end $$;
drop trigger if exists blocks_after_insert on public.blocks;
create trigger blocks_after_insert after insert on public.blocks for each row execute function public.on_block();

-- уведомления о заявках в друзья
create or replace function public.notify_friend() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.notifications (user_id, actor_id, type, text) values (new.addressee_id, new.requester_id, 'friend_request', 'хочет добавить вас в друзья');
  elsif tg_op = 'UPDATE' and new.status = 'accepted' and old.status = 'pending' then
    insert into public.notifications (user_id, actor_id, type, text) values (new.requester_id, new.addressee_id, 'friend_accept', 'принял(а) вашу заявку в друзья');
  end if;
  return new;
end $$;
drop trigger if exists friendships_notify on public.friendships;
create trigger friendships_notify after insert or update on public.friendships for each row execute function public.notify_friend();

-- ---------- переписки и сообщения ----------
create table if not exists public.conversations (
  id               uuid primary key default gen_random_uuid(),
  user_a           uuid not null references public.profiles(id) on delete cascade,
  user_b           uuid not null references public.profiles(id) on delete cascade,
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);

create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  sender_id        uuid not null references public.profiles(id) on delete cascade,
  kind             text not null default 'text' check (kind in ('text','image','video','audio')),
  text             text check (text is null or char_length(text) <= 2000),
  media_url        text,
  media_path       text,
  duration         int,
  mod_status       text not null default 'ok' check (mod_status in ('ok','pending','flagged')),
  read_at          timestamptz,
  created_at       timestamptz not null default now(),
  check (kind <> 'text' or (text is not null and char_length(text) > 0)),
  check (kind = 'text' or media_url is not null)
);
create index if not exists messages_conv_idx on public.messages (conversation_id, created_at desc);

create or replace function public.is_participant(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversations c where c.id = conv and auth.uid() in (c.user_a, c.user_b)) $$;

-- найти или создать переписку с пользователем
create or replace function public.get_or_create_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid; b uuid; cid uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if other = me then raise exception 'Нельзя написать самому себе'; end if;
  if public.is_blocked(me, other) then raise exception 'Пользователь недоступен'; end if;
  if public.is_banned() then raise exception 'Аккаунт заблокирован модератором'; end if;
  a := least(me, other); b := greatest(me, other);
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is null then
    insert into public.conversations (user_a, user_b) values (a, b) returning id into cid;
  end if;
  return cid;
end $$;

-- отметить сообщения прочитанными
create or replace function public.mark_conversation_read(conv uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
   where conversation_id = conv and sender_id <> auth.uid() and read_at is null and public.is_participant(conv) $$;

create or replace function public.on_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end $$;
drop trigger if exists messages_after_insert on public.messages;
create trigger messages_after_insert after insert on public.messages for each row execute function public.on_message();

-- ---------- жалобы ----------
create table if not exists public.reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references public.profiles(id) on delete cascade,
  target_type  text not null check (target_type in ('post','user','message','comment')),
  target_id    uuid not null,
  target_user  uuid references public.profiles(id) on delete cascade,
  reason       text not null,
  details      text check (details is null or char_length(details) <= 500),
  status       text not null default 'open' check (status in ('open','resolved','dismissed')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  unique (reporter_id, target_type, target_id)
);
create index if not exists reports_status_idx on public.reports (status, created_at desc);

-- 3 жалобы от разных людей — публикация скрывается автоматически до проверки модератором
create or replace function public.on_report() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int; owner uuid;
begin
  if new.target_type = 'post' then
    select count(distinct reporter_id) into n from public.reports where target_type = 'post' and target_id = new.target_id and status = 'open';
    if n >= 3 then
      perform set_config('near.system', '1', true);
      update public.posts set status = 'hidden' where id = new.target_id and status = 'active' returning user_id into owner;
      if owner is not null then
        insert into public.notifications (user_id, type, post_id, text)
        values (owner, 'post_hidden', new.target_id, 'Ваша публикация скрыта по жалобам и ждет проверки модератора');
      end if;
      perform set_config('near.system', '', true);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists reports_after_insert on public.reports;
create trigger reports_after_insert after insert on public.reports for each row execute function public.on_report();

-- ---------- фильтр грубых слов (работает на сервере) ----------
create or replace function public.mask_bad(t text) returns text
language plpgsql immutable as $$
begin
  if t is null then return t; end if;
  return regexp_replace(t,
    '([а-яёa-z]*(хуй|хуе|хуё|хуя|пизд|ебан|ебат|ебал|еблан|ёбан|выеб|заеб|уеб|бляд|блят|сука|суки|сучк|мудак|мудил|гандон|пидор|пидар|шлюх|долбоеб|залуп|қотақ|сігей|сигей|шешеңді)[а-яёa-zқңғүұөһі]*)',
    '***', 'gi');
end $$;

create or replace function public.mask_text_trigger() returns trigger
language plpgsql as $$
begin
  new.text := public.mask_bad(new.text);
  return new;
end $$;
drop trigger if exists posts_mask on public.posts;
create trigger posts_mask before insert or update of text on public.posts for each row execute function public.mask_text_trigger();
drop trigger if exists comments_mask on public.comments;
create trigger comments_mask before insert or update of text on public.comments for each row execute function public.mask_text_trigger();
drop trigger if exists messages_mask on public.messages;
create trigger messages_mask before insert or update of text on public.messages for each row execute function public.mask_text_trigger();

-- ---------- ИИ-проверка фото: новые фото ждут проверки, если она включена ----------
create or replace function public.media_pending() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select ai_moderation from public.app_settings where id = 1) then
    if tg_table_name = 'post_media' and new.type = 'image' then new.mod_status := 'pending';
    elsif tg_table_name = 'messages' and new.kind in ('image','text') then new.mod_status := 'pending';
    else new.mod_status := 'ok'; end if;
  else
    new.mod_status := 'ok';
  end if;
  return new;
end $$;
drop trigger if exists post_media_pending on public.post_media;
create trigger post_media_pending before insert on public.post_media for each row execute function public.media_pending();
drop trigger if exists messages_pending on public.messages;
create trigger messages_pending before insert on public.messages for each row execute function public.media_pending();

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
alter table public.app_settings  enable row level security;
alter table public.blocks        enable row level security;
alter table public.friendships   enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
alter table public.reports       enable row level security;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and tablename in ('profiles','posts','post_media','comments','likes','saved_posts','events','event_members','notifications','app_settings','blocks','friendships','conversations','messages','reports')
  loop execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename); end loop;
end $$;

-- профили
create policy "profiles read"   on public.profiles for select using (true);
create policy "profiles insert" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles update" on public.profiles for update using (auth.uid() = id or public.is_admin());
-- обычный пользователь не может сам назначить себя админом или снять бан
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() пустой в SQL Editor и у сервисных функций: им можно
  if auth.uid() is not null and not public.is_admin() then
    new.is_admin := old.is_admin;
    new.banned := old.banned;
  end if;
  return new;
end $$;
drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before update on public.profiles for each row execute function public.protect_profile();
-- публикации
create policy "posts read"   on public.posts for select using (status not in ('deleted','hidden') or auth.uid() = user_id or public.is_admin());
create policy "posts insert" on public.posts for insert with check (auth.uid() = user_id and not public.is_banned());
create policy "posts update" on public.posts for update using (auth.uid() = user_id or public.is_admin());
create policy "posts delete" on public.posts for delete using (auth.uid() = user_id or public.is_admin());
-- автор не может сам вернуть скрытую модератором публикацию
create or replace function public.protect_post() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() or current_setting('near.system', true) = '1' then return new; end if;
  if old.status = 'hidden' and new.status <> 'hidden' then new.status := 'hidden'; end if;
  if new.status = 'hidden' and old.status <> 'hidden' then new.status := old.status; end if;
  return new;
end $$;
drop trigger if exists posts_protect on public.posts;
create trigger posts_protect before update on public.posts for each row execute function public.protect_post();
-- медиа
create policy "media read"   on public.post_media for select using (true);
create policy "media insert" on public.post_media for insert with check (
  auth.uid() = user_id and exists (select 1 from public.posts p where p.id = post_id and p.user_id = auth.uid()));
create policy "media delete" on public.post_media for delete using (auth.uid() = user_id);
-- комментарии
create policy "comments read"   on public.comments for select using (true);
create policy "comments insert" on public.comments for insert with check (auth.uid() = user_id and not public.is_banned());
create policy "comments delete" on public.comments for delete using (auth.uid() = user_id or public.is_admin());
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

-- настройки: читают все, меняет админ
create policy "settings read"   on public.app_settings for select using (true);
create policy "settings update" on public.app_settings for update using (public.is_admin());
-- блокировки: видит и меняет только тот, кто блокирует
create policy "blocks read"   on public.blocks for select using (auth.uid() = blocker_id);
create policy "blocks insert" on public.blocks for insert with check (auth.uid() = blocker_id);
create policy "blocks delete" on public.blocks for delete using (auth.uid() = blocker_id);
-- друзья
create policy "friends read"   on public.friendships for select using (auth.uid() in (requester_id, addressee_id));
create policy "friends insert" on public.friendships for insert with check (
  auth.uid() = requester_id and status = 'pending' and not public.is_blocked(requester_id, addressee_id) and not public.is_banned());
create policy "friends accept" on public.friendships for update using (auth.uid() = addressee_id) with check (status = 'accepted');
create policy "friends delete" on public.friendships for delete using (auth.uid() in (requester_id, addressee_id));
-- переписки и сообщения: только участники
create policy "conv read" on public.conversations for select using (auth.uid() in (user_a, user_b));
create policy "msg read"  on public.messages for select using (public.is_participant(conversation_id)
  or (public.is_admin() and exists (select 1 from public.reports r where r.target_type = 'message' and r.target_id = messages.id)));
create policy "msg insert" on public.messages for insert with check (
  auth.uid() = sender_id and public.is_participant(conversation_id) and not public.is_banned()
  and not exists (select 1 from public.conversations c where c.id = conversation_id and public.is_blocked(c.user_a, c.user_b)));
create policy "msg delete" on public.messages for delete using (auth.uid() = sender_id);
-- жалобы: пишет любой вошедший, читает автор жалобы и админ
create policy "reports insert" on public.reports for insert with check (auth.uid() = reporter_id);
create policy "reports read"   on public.reports for select using (auth.uid() = reporter_id or public.is_admin());
create policy "reports update" on public.reports for update using (public.is_admin());

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

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', true, 31457280,
        array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm','audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/aac','audio/x-m4a'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "near media read"   on storage.objects;
drop policy if exists "near media upload" on storage.objects;
drop policy if exists "near media delete" on storage.objects;
create policy "near media read" on storage.objects for select using (bucket_id in ('post-media','chat-media'));
create policy "near media upload" on storage.objects for insert to authenticated
  with check (bucket_id in ('post-media','chat-media') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "near media delete" on storage.objects for delete to authenticated
  using (bucket_id in ('post-media','chat-media') and (storage.foldername(name))[1] = auth.uid()::text);

-- =====================================================
--  ОБНОВЛЕНИЯ В РЕАЛЬНОМ ВРЕМЕНИ
--  Новые публикации и уведомления приходят без перезагрузки.
-- =====================================================
do $$ begin
  begin alter publication supabase_realtime add table public.posts; exception when others then null; end;
  begin alter publication supabase_realtime add table public.notifications; exception when others then null; end;
  begin alter publication supabase_realtime add table public.messages; exception when others then null; end;
end $$;

-- =====================================================
--  ДОСТУП К API (на случай, если автодоступ к таблицам выключен)
--  Защиту обеспечивают правила RLS выше.
-- =====================================================
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant execute on all functions in schema public to anon, authenticated;

-- Готово ✅
