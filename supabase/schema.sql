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
  insert into public.profiles (id, district, name)
  values (new.id, nullif(new.raw_user_meta_data->>'district', ''), left(coalesce(nullif(new.raw_user_meta_data->>'name', ''), nullif(new.raw_user_meta_data->>'full_name', ''), split_part(new.email, '@', 1)), 60))
  on conflict (id) do nothing;
  -- пол и подтверждение аккаунта (колонки появляются в части 2 схемы)
  begin
    execute 'update public.profiles set gender = $2, verified = $3 where id = $1'
      using new.id,
            case when new.raw_user_meta_data->>'gender' in ('m','f') then new.raw_user_meta_data->>'gender' end,
            (new.email_confirmed_at is not null or coalesce(new.raw_app_meta_data->>'provider', '') = 'google');
  exception when undefined_column then null;
  end;
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
-- v7: пол, подтвержденный аккаунт (почта или Google), когда был в сети
alter table public.profiles add column if not exists gender text;
alter table public.profiles add column if not exists verified boolean not null default false;
alter table public.profiles add column if not exists last_seen_at timestamptz;
do $$ begin
  alter table public.profiles add constraint profiles_gender_chk check (gender in ('m','f'));
exception when duplicate_object then null; end $$;
-- v8: описание профиля, приватность "в сети", медиа с превью, ответы на комментарии
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists show_seen boolean not null default true;
do $$ begin
  alter table public.profiles add constraint profiles_bio_len check (char_length(bio) <= 160);
exception when duplicate_object then null; end $$;
alter table public.post_media add column if not exists thumb_url text;
alter table public.post_media add column if not exists poster_url text;
alter table public.post_media add column if not exists w int;
alter table public.post_media add column if not exists h int;
alter table public.post_media add column if not exists duration real;
alter table public.comments add column if not exists parent_id uuid references public.comments(id) on delete cascade;
create index if not exists comments_parent_idx on public.comments (parent_id);
-- уже подтвержденные аккаунты
update public.profiles p set verified = true from auth.users u
 where u.id = p.id and not p.verified
   and (u.email_confirmed_at is not null or coalesce(u.raw_app_meta_data->>'provider', '') = 'google');
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
    new.verified := old.verified;
    if new.show_seen = false then new.last_seen_at := null; end if;
    -- пол меняется только один раз: с пустого на выбранный
    if old.gender is not null then new.gender := old.gender; end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before update on public.profiles for each row execute function public.protect_profile();

-- ответы на комментарии: родитель из той же публикации, глубина один уровень
create or replace function public.comment_reply_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare par record;
begin
  if new.parent_id is null then return new; end if;
  select id, post_id, user_id, parent_id into par from public.comments where id = new.parent_id;
  if par.id is null or par.post_id <> new.post_id then raise exception 'Комментарий для ответа не найден'; end if;
  if par.parent_id is not null then new.parent_id := par.parent_id; end if; -- ответ на ответ — в ту же ветку
  return new;
end $$;
drop trigger if exists comments_reply_check on public.comments;
create trigger comments_reply_check before insert on public.comments for each row execute function public.comment_reply_check();

create or replace function public.notify_reply() returns trigger
language plpgsql security definer set search_path = public as $$
declare to_user uuid; owner uuid;
begin
  if new.parent_id is null then return new; end if;
  select user_id into to_user from public.comments where id = new.parent_id;
  select user_id into owner from public.posts where id = new.post_id;
  if to_user is not null and to_user <> new.user_id and to_user <> owner then
    insert into public.notifications (user_id, actor_id, type, post_id, text)
    values (to_user, new.user_id, 'reply', new.post_id, 'ответил(а) на ваш комментарий: ' || left(new.text, 60));
  end if;
  return new;
end $$;
drop trigger if exists comments_reply_notify on public.comments;
create trigger comments_reply_notify after insert on public.comments for each row execute function public.notify_reply();

-- почта подтверждена → значок "подтвержден"
create or replace function public.on_user_confirmed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    update public.profiles set verified = true where id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row execute function public.on_user_confirmed();

-- "был в сети": приложение отмечается раз в минуту, пока открыто
create or replace function public.touch_seen() returns void
language sql security definer set search_path = public as $$
  update public.profiles set last_seen_at = now()
   where id = auth.uid() and show_seen and (last_seen_at is null or last_seen_at < now() - interval '30 seconds') $$;
grant execute on function public.touch_seen() to authenticated;
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

-- SOS отменен автором: публикация остается в истории (status = closed),
-- всем, кто откликнулся (комментарий или лайк), приходит уведомление
create or replace function public.on_post_closed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'active' and new.status = 'closed' and new.category = 'incident' and new.text like '%SOS%' then
    insert into public.notifications (user_id, actor_id, type, post_id, text)
    select distinct x.uid, new.user_id, 'sos_closed', new.id, 'отменил(а) SOS: помощь больше не нужна'
      from (select user_id uid from public.comments where post_id = new.id
            union select user_id from public.likes where post_id = new.id) x
     where x.uid <> new.user_id;
  end if;
  return new;
end $$;
drop trigger if exists posts_after_close on public.posts;
create trigger posts_after_close after update of status on public.posts for each row execute function public.on_post_closed();
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
values ('post-media', 'post-media', true, 52428800,
        array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm','video/x-m4v'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Бакет chat-media ПРИВАТНЫЙ: файлы переписки открываются только
-- по временной подписанной ссылке и только участникам переписки
-- (путь файла: <user_id>/<conversation_id>/<файл>).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 31457280,
        array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm','audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/aac','audio/x-m4a'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- участник переписки, к которой относится файл
create or replace function public.chat_file_allowed(obj_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversations c
                  where c.id::text = (storage.foldername(obj_name))[2]
                    and auth.uid() in (c.user_a, c.user_b)) $$;

drop policy if exists "near media read"   on storage.objects;
drop policy if exists "near media upload" on storage.objects;
drop policy if exists "near media delete" on storage.objects;
drop policy if exists "near post media read" on storage.objects;
drop policy if exists "near chat media read" on storage.objects;
create policy "near post media read" on storage.objects for select using (bucket_id = 'post-media');
create policy "near chat media read" on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and (public.chat_file_allowed(name) or public.is_admin()));
create policy "near media upload" on storage.objects for insert to authenticated
  with check ((storage.foldername(name))[1] = auth.uid()::text and (
    bucket_id = 'post-media' or (bucket_id = 'chat-media' and public.chat_file_allowed(name))));
create policy "near media delete" on storage.objects for delete to authenticated
  using (bucket_id in ('post-media','chat-media') and (storage.foldername(name))[1] = auth.uid()::text);

-- старые сообщения: публичные ссылки больше не работают, храним только путь
update public.messages set media_url = 'private:' || media_path
 where media_path is not null and media_url like 'http%';

-- =====================================================
--  PUSH-УВЕДОМЛЕНИЯ (v9)
--  Подписки браузеров + вызов функции push при новом уведомлении,
--  сообщении или происшествии рядом. Работает через расширение pg_net.
-- =====================================================
do $$ begin
  begin create extension if not exists pg_net; exception when others then raise notice 'pg_net недоступен: push работать не будут'; end;
end $$;

create table if not exists public.push_subs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  prefs       jsonb not null default '{}'::jsonb,
  lat         double precision,
  lng         double precision,
  ua          text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subs (user_id);
alter table public.push_subs enable row level security;
drop policy if exists "push own read" on public.push_subs;
drop policy if exists "push own delete" on public.push_subs;
create policy "push own read" on public.push_subs for select using (auth.uid() = user_id);
create policy "push own delete" on public.push_subs for delete using (auth.uid() = user_id);

-- подписка: один браузер = одна строка; при входе другим аккаунтом строка переходит к нему
create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_prefs jsonb, p_lat double precision, p_lng double precision, p_ua text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Войдите, чтобы включить уведомления'; end if;
  if p_endpoint !~ '^https://' then raise exception 'Неверная подписка'; end if;
  insert into public.push_subs (user_id, endpoint, p256dh, auth, prefs, lat, lng, ua)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, coalesce(p_prefs, '{}'::jsonb), round(p_lat::numeric, 2), round(p_lng::numeric, 2), left(p_ua, 200))
  on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth,
    prefs = excluded.prefs,
    lat = case when push_subs.user_id = auth.uid() then coalesce(excluded.lat, push_subs.lat) else excluded.lat end,
    lng = case when push_subs.user_id = auth.uid() then coalesce(excluded.lng, push_subs.lng) else excluded.lng end,
    ua = excluded.ua, updated_at = now();
end $$;
create or replace function public.push_unsubscribe(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subs where endpoint = p_endpoint and user_id = auth.uid() $$;

-- адрес функции и секрет, которым база подписывает вызов (читает только сервер)
create table if not exists public.push_config (
  id      int primary key default 1 check (id = 1),
  url     text,
  secret  text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
alter table public.push_config enable row level security;
insert into public.push_config (id, url) values (1, 'https://aswcegzkbzuqwfpxwuqw.supabase.co/functions/v1/push') on conflict (id) do nothing;

create or replace function public.push_fire() returns trigger
language plpgsql security definer set search_path = public as $$
declare cfg record; k text;
begin
  if tg_table_name = 'posts' then
    if new.category <> 'incident' then return new; end if;
    k := 'near';
  elsif tg_table_name = 'messages' then k := 'msg';
  else k := 'notif'; end if;
  select url, secret into cfg from public.push_config where id = 1;
  if cfg.url is null or not exists (select 1 from public.push_subs limit 1) then return new; end if;
  begin
    perform net.http_post(url := cfg.url, body := jsonb_build_object('kind', k, 'id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-near-secret', cfg.secret), timeout_milliseconds := 5000);
  exception when others then null; -- без pg_net просто нет push, публикация все равно сохраняется
  end;
  return new;
end $$;
drop trigger if exists push_on_notification on public.notifications;
create trigger push_on_notification after insert on public.notifications for each row execute function public.push_fire();
drop trigger if exists push_on_message on public.messages;
create trigger push_on_message after insert on public.messages for each row execute function public.push_fire();
drop trigger if exists push_on_post on public.posts;
create trigger push_on_post after insert on public.posts for each row execute function public.push_fire();

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
--  NEAR v11 — миграция: безопасность, PostGIS, лимиты,
--  модерация, запросы на общение, SOS, события, аналитика.
--  Скрипт идемпотентный: повторный запуск ничего не ломает.
--  Коды ошибок для приложения (SQLSTATE):
--    NR403 — нет прав, NR404 — не найдено, NR409 — конфликт/повтор,
--    NR422 — неверные данные, NR429 — слишком часто.
-- =====================================================

create extension if not exists postgis with schema extensions;

-- ---------- роли: модератор отдельно от администратора ----------
alter table public.profiles add column if not exists is_moderator boolean not null default false;

create or replace function public.is_mod() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or is_moderator from public.profiles where id = auth.uid()), false) $$;

-- ---------- SEC-01: профиль создает только сервер ----------
drop policy if exists "profiles insert" on public.profiles;
drop policy if exists "profiles update" on public.profiles;
create policy "profiles update" on public.profiles for update
  using (auth.uid() = id or public.is_admin()) with check (auth.uid() = id or public.is_admin());

create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() пустой у сервера (регистрация, SQL Editor, сервисные функции)
  if auth.uid() is null or public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    new.is_admin := false; new.is_moderator := false; new.banned := false; new.verified := false;
    return new;
  end if;
  new.is_admin := old.is_admin;
  new.is_moderator := old.is_moderator;
  new.banned := old.banned;
  new.verified := old.verified;
  new.id := old.id;
  new.created_at := old.created_at;
  if new.show_seen = false then new.last_seen_at := null; end if;
  if old.gender is not null then new.gender := old.gender; end if;
  return new;
end $$;
drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before insert or update on public.profiles
  for each row execute function public.protect_profile();

-- если профиль почему-то не создался при регистрации — создаем его на сервере
create or replace function public.ensure_profile() returns void
language plpgsql security definer set search_path = public as $$
declare u record;
begin
  if auth.uid() is null then return; end if;
  if exists (select 1 from public.profiles where id = auth.uid()) then return; end if;
  select id, email, raw_user_meta_data m into u from auth.users where id = auth.uid();
  if u.id is null then return; end if;
  insert into public.profiles (id, name, district)
  values (u.id, left(coalesce(nullif(u.m->>'name', ''), nullif(u.m->>'full_name', ''), split_part(u.email, '@', 1), 'Пользователь'), 60),
          nullif(u.m->>'district', ''))
  on conflict (id) do nothing;
end $$;

-- ---------- публикации: новые поля ----------
alter table public.posts add column if not exists is_sos boolean not null default false;
alter table public.posts add column if not exists exact boolean not null default false;
alter table public.posts add column if not exists client_key text;
alter table public.posts add column if not exists expires_at timestamptz;
alter table public.posts add column if not exists resolved_at timestamptz;
alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check check (status in ('draft','active','closed','deleted','hidden'));
alter table public.posts drop constraint if exists posts_client_key_len;
alter table public.posts add constraint posts_client_key_len check (client_key is null or char_length(client_key) between 8 and 64);
create unique index if not exists posts_client_key_uidx on public.posts (user_id, client_key) where client_key is not null;
create index if not exists posts_created_id_idx on public.posts (created_at desc, id desc);
-- старые SOS (до v11 определялись по тексту) получают явный признак
update public.posts set is_sos = true where not is_sos and category = 'incident' and text like 'SOS%';

-- PostGIS: точка публикации для геозапросов
alter table public.posts add column if not exists geog extensions.geography(Point, 4326)
  generated always as (extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography) stored;
create index if not exists posts_geog_gix on public.posts using gist (geog);

-- кто может видеть публикацию (и все, что к ней относится)
create or replace function public.can_see_post(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.posts p where p.id = pid
    and (p.status in ('active','closed') or p.user_id = auth.uid() or public.is_mod())) $$;

-- срок актуальности, приблизительное место, SOS
create or replace function public.post_prepare() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.is_sos and new.category <> 'incident' then
      raise exception using errcode = 'NR422', message = 'SOS бывает только у происшествия';
    end if;
    if new.is_sos and auth.uid() is not null and exists (select 1 from public.posts
        where user_id = new.user_id and is_sos and status in ('draft','active')
          and (expires_at is null or expires_at > now())) then
      raise exception using errcode = 'NR409', message = 'У вас уже есть активный SOS. Закройте его, чтобы отправить новый';
    end if;
    if new.expires_at is null then
      new.expires_at := now() + case
        when new.is_sos then interval '3 hours'
        when new.category = 'incident' then interval '24 hours'
        when new.category in ('lost','found') then interval '30 days'
        when new.category in ('deal','ad') then interval '14 days'
        when new.category = 'meetup' then interval '7 days'
        when new.category = 'event' then interval '30 days'
        else interval '90 days' end;
    end if;
  else
    if new.status = 'closed' and old.status <> 'closed' then new.resolved_at := now(); end if;
    if new.status = 'active' and old.status = 'closed' then new.resolved_at := null; end if;
    if auth.uid() is not null and not public.is_mod() and coalesce(current_setting('near.system', true), '') <> '1' then
      new.is_sos := old.is_sos; new.user_id := old.user_id; new.client_key := old.client_key; new.created_at := old.created_at;
      if new.expires_at is distinct from old.expires_at then new.expires_at := old.expires_at; end if;
    end if;
  end if;
  -- место по умолчанию приблизительное: точка привязывается к сетке ~200 м
  if not new.exact then
    new.lat := round((new.lat / 0.002)::numeric) * 0.002;
    new.lng := round((new.lng / 0.0026)::numeric) * 0.0026;
  end if;
  return new;
end $$;
drop trigger if exists posts_prepare on public.posts;
create trigger posts_prepare before insert or update on public.posts for each row execute function public.post_prepare();

-- автор не может сам вернуть скрытую модератором публикацию или скрыть ее "как модератор"
create or replace function public.protect_post() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_mod() or current_setting('near.system', true) = '1' then return new; end if;
  if old.status = 'hidden' and new.status not in ('hidden','deleted') then new.status := 'hidden'; end if;
  if new.status = 'hidden' and old.status <> 'hidden' then new.status := old.status; end if;
  if new.status = 'draft' and old.status <> 'draft' then new.status := old.status; end if;
  return new;
end $$;

-- ---------- SEC-02: скрытое не видно ни через API, ни по связанным таблицам ----------
drop policy if exists "posts read" on public.posts;
drop policy if exists "posts insert" on public.posts;
drop policy if exists "posts update" on public.posts;
drop policy if exists "posts delete" on public.posts;
create policy "posts read"   on public.posts for select using (status in ('active','closed') or auth.uid() = user_id or public.is_mod());
create policy "posts insert" on public.posts for insert with check (auth.uid() = user_id and not public.is_banned() and status in ('draft','active'));
create policy "posts update" on public.posts for update using (auth.uid() = user_id or public.is_mod()) with check (auth.uid() = user_id or public.is_mod());
create policy "posts delete" on public.posts for delete using (auth.uid() = user_id or public.is_admin());

drop policy if exists "media read" on public.post_media;
drop policy if exists "media insert" on public.post_media;
drop policy if exists "media delete" on public.post_media;
create policy "media read" on public.post_media for select using (
  public.can_see_post(post_id) and (mod_status = 'ok' or user_id = auth.uid() or public.is_mod()));
create policy "media insert" on public.post_media for insert with check (
  auth.uid() = user_id and exists (select 1 from public.posts p where p.id = post_id and p.user_id = auth.uid() and p.status in ('draft','active')));
create policy "media delete" on public.post_media for delete using (auth.uid() = user_id or public.is_mod());

alter table public.post_media add column if not exists bucket text not null default 'post-media';

-- не больше 5 вложений, только фото или видео
create or replace function public.media_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.post_media where post_id = new.post_id) >= 5 then
    raise exception using errcode = 'NR422', message = 'Не больше 5 вложений в публикации';
  end if;
  if new.path is not null and new.path !~ ('^' || new.user_id::text || '/') then
    raise exception using errcode = 'NR403', message = 'Файл должен лежать в вашей папке';
  end if;
  new.bucket := 'post-media';
  return new;
end $$;
drop trigger if exists post_media_limit on public.post_media;
create trigger post_media_limit before insert on public.post_media for each row execute function public.media_limit();

drop policy if exists "comments read" on public.comments;
drop policy if exists "comments insert" on public.comments;
create policy "comments read" on public.comments for select using (public.can_see_post(post_id));
create policy "comments insert" on public.comments for insert with check (
  auth.uid() = user_id and not public.is_banned() and exists (select 1 from public.posts p
    where p.id = post_id and p.status = 'active' and not public.is_blocked(auth.uid(), p.user_id)));

drop policy if exists "likes read" on public.likes;
drop policy if exists "likes insert" on public.likes;
create policy "likes read" on public.likes for select using (public.can_see_post(post_id));
create policy "likes insert" on public.likes for insert with check (auth.uid() = user_id and public.can_see_post(post_id) and not public.is_banned());

drop policy if exists "events read" on public.events;
drop policy if exists "members read" on public.event_members;
drop policy if exists "members insert" on public.event_members;
create policy "events read"  on public.events for select using (public.can_see_post(post_id));
create policy "members read" on public.event_members for select using (public.can_see_post(post_id));
create policy "members insert" on public.event_members for insert with check (auth.uid() = user_id and public.can_see_post(post_id) and not public.is_banned());

-- приватный бакет для скрытых модератором файлов (карантин)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-quarantine', 'post-quarantine', false, 52428800,
        array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm','video/x-m4v'])
on conflict (id) do update set public = false;
drop policy if exists "near quarantine read" on storage.objects;
create policy "near quarantine read" on storage.objects for select to authenticated
  using (bucket_id = 'post-quarantine' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_mod()));

-- лимит размера файлов публикаций: 20 МБ (видео на пилоте до 60 секунд)
update storage.buckets set file_size_limit = 20971520 where id = 'post-media';

-- ---------- общий вызов серверных функций из базы ----------
create or replace function public.call_fn(fn text, body jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare cfg record;
begin
  select url, secret into cfg from public.push_config where id = 1;
  if cfg.url is null then return; end if;
  begin
    perform net.http_post(url := regexp_replace(cfg.url, '/[^/]+$', '/' || fn), body := body,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-near-secret', cfg.secret), timeout_milliseconds := 5000);
  exception when others then null;
  end;
end $$;

-- скрыли/вернули/удалили публикацию → файлы переносятся в карантин, обратно или стираются
create or replace function public.on_post_visibility() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and (new.status in ('hidden','deleted') or old.status = 'hidden') then
    perform public.call_fn('moderate', jsonb_build_object('kind', 'quarantine', 'post_id', new.id, 'status', new.status));
  end if;
  return new;
end $$;
drop trigger if exists posts_visibility on public.posts;
create trigger posts_visibility after update of status on public.posts for each row execute function public.on_post_visibility();

-- SOS отменен: уведомляем откликнувшихся (теперь по явному признаку is_sos)
create or replace function public.on_post_closed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'active' and new.status = 'closed' and new.is_sos then
    insert into public.notifications (user_id, actor_id, type, post_id, text)
    select distinct x.uid, new.user_id, 'sos_closed', new.id, 'закрыл(а) SOS: помощь больше не нужна'
      from (select user_id uid from public.comments where post_id = new.id
            union select user_id from public.likes where post_id = new.id) x
     where x.uid <> new.user_id;
  end if;
  return new;
end $$;

-- ---------- POST-02: события — атомарная запись с лимитом мест ----------
create or replace function public.event_capacity() returns trigger
language plpgsql security definer set search_path = public as $$
declare ev record; n int;
begin
  select * into ev from public.events where post_id = new.post_id for update;
  if ev.post_id is null then raise exception using errcode = 'NR404', message = 'Это не событие'; end if;
  if ev.starts_at < now() - interval '3 hours' then raise exception using errcode = 'NR409', message = 'Событие уже прошло'; end if;
  if ev.capacity is not null then
    select count(*) into n from public.event_members where post_id = new.post_id;
    if n >= ev.capacity then raise exception using errcode = 'NR409', message = 'Мест больше нет'; end if;
  end if;
  return new;
end $$;
drop trigger if exists event_members_capacity on public.event_members;
create trigger event_members_capacity before insert on public.event_members for each row execute function public.event_capacity();

-- срок события: через 6 часов после начала
create or replace function public.on_event_set() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('near.system', '1', true);
  update public.posts set expires_at = new.starts_at + interval '6 hours' where id = new.post_id;
  perform set_config('near.system', '', true);
  return new;
end $$;
drop trigger if exists events_set_expiry on public.events;
create trigger events_set_expiry after insert or update of starts_at on public.events for each row execute function public.on_event_set();

-- ---------- FEED-01 / MAP-01: серверная геовыборка ----------
create or replace function public.feed_page(p_lat double precision, p_lng double precision, p_radius int,
  p_cats text[] default null, p_before_ts timestamptz default null, p_before_id uuid default null, p_limit int default 12)
returns setof public.posts language sql stable set search_path = public, extensions as $$
  select p.* from public.posts p
   where p.status in ('active','closed')
     and (p.expires_at is null or p.expires_at > now())
     and extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
                               least(greatest(coalesce(p_radius, 1000), 100), 50000))
     and (p_cats is null or p.category = any (p_cats))
     and (p_before_ts is null or (p.created_at, p.id) < (p_before_ts, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
     and not public.is_blocked(auth.uid(), p.user_id)
   order by p.created_at desc, p.id desc
   limit least(greatest(coalesce(p_limit, 12), 1), 12) $$;

-- новые публикации после известной (для обновления ленты), по возрастанию
create or replace function public.feed_new(p_lat double precision, p_lng double precision, p_radius int,
  p_cats text[], p_after_ts timestamptz, p_after_id uuid, p_limit int default 50)
returns setof public.posts language sql stable set search_path = public, extensions as $$
  select p.* from public.posts p
   where p.status in ('active','closed')
     and (p.expires_at is null or p.expires_at > now())
     and extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
                               least(greatest(coalesce(p_radius, 1000), 100), 50000))
     and (p_cats is null or p.category = any (p_cats))
     and (p.created_at, p.id) > (p_after_ts, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
     and not public.is_blocked(auth.uid(), p.user_id)
   order by p.created_at asc, p.id asc
   limit least(greatest(coalesce(p_limit, 50), 1), 50) $$;

-- карта: те же правила видимости, режим "в радиусе" (центр + радиус) или "на экране" (рамка)
create or replace function public.map_posts(p_w double precision, p_s double precision, p_e double precision, p_n double precision,
  p_cats text[] default null, p_lat double precision default null, p_lng double precision default null, p_radius int default null, p_limit int default 300)
returns setof public.posts language sql stable set search_path = public, extensions as $$
  select p.* from public.posts p
   where p.status in ('active','closed')
     and (p.expires_at is null or p.expires_at > now())
     and case when p_radius is not null and p_lat is not null
           then extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
                                      least(greatest(p_radius, 100), 50000))
           else p.geog operator(extensions.&&) extensions.st_makeenvelope(p_w, p_s, p_e, p_n, 4326)::extensions.geography end
     and (p_cats is null or p.category = any (p_cats))
     and not public.is_blocked(auth.uid(), p.user_id)
   order by p.created_at desc, p.id desc
   limit least(greatest(coalesce(p_limit, 300), 1), 500) $$;

-- сколько публикаций за последний час по категориям (для счетчиков)
create or replace function public.recent_stats(p_lat double precision, p_lng double precision, p_radius int, p_cats text[] default null)
returns table (category text, n bigint) language sql stable set search_path = public, extensions as $$
  select p.category, count(*) from public.posts p
   where p.status = 'active' and p.created_at > now() - interval '1 hour'
     and (p.expires_at is null or p.expires_at > now())
     and extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
                               least(greatest(coalesce(p_radius, 1000), 100), 50000))
     and (p_cats is null or p.category = any (p_cats))
     and not public.is_blocked(auth.uid(), p.user_id)
   group by p.category $$;

-- ---------- SEC-07: лимиты частоты (по аккаунту и по IP с запасом на NAT) ----------
create table if not exists public.rate_events (
  id          bigserial primary key,
  kind        text not null,
  user_id     uuid,
  ip_hash     text,
  created_at  timestamptz not null default now()
);
create index if not exists rate_events_user_idx on public.rate_events (kind, user_id, created_at desc);
create index if not exists rate_events_ip_idx   on public.rate_events (kind, ip_hash, created_at desc);
alter table public.rate_events enable row level security;

create or replace function public.req_ip_hash() returns text
language plpgsql stable as $$
declare ip text;
begin
  begin
    ip := split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1);
  exception when others then ip := '';
  end;
  if ip is null or ip = '' then return null; end if;
  return md5('near-ip:' || trim(ip));
end $$;

create or replace function public.rate_check(p_kind text, p_user_max int, p_ip_max int, p_window interval) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); iph text := public.req_ip_hash(); n int;
begin
  if uid is null and iph is null then return; end if; -- сервер и SQL Editor без лимитов
  if uid is not null then
    select count(*) into n from public.rate_events where kind = p_kind and user_id = uid and created_at > now() - p_window;
    if n >= p_user_max then
      raise exception using errcode = 'NR429', message = 'Слишком часто. Попробуйте немного позже', hint = p_kind;
    end if;
  end if;
  if iph is not null and p_ip_max is not null then
    select count(*) into n from public.rate_events where kind = p_kind and ip_hash = iph and created_at > now() - p_window;
    if n >= p_ip_max then
      raise exception using errcode = 'NR429', message = 'Слишком много действий из этой сети. Попробуйте позже', hint = p_kind;
    end if;
  end if;
  insert into public.rate_events (kind, user_id, ip_hash) values (p_kind, uid, iph);
  if random() < 0.01 then delete from public.rate_events where created_at < now() - interval '2 days'; end if;
end $$;

-- значения лимитов — начальные, уточняются по логам (app_settings.limits)
alter table public.app_settings add column if not exists limits jsonb not null default '{
  "post":     [10, 40, "1 hour"],
  "post_day": [30, 120, "1 day"],
  "sos":      [2, 10, "1 hour"],
  "comment":  [60, 300, "1 hour"],
  "message":  [120, 600, "1 hour"],
  "report":   [20, 60, "1 day"],
  "friend":   [50, 150, "1 day"],
  "like":     [300, 1500, "1 hour"],
  "push_sub": [20, 60, "1 day"],
  "log":      [60, 300, "1 hour"]
}'::jsonb;
alter table public.app_settings add column if not exists report_hide_weight real not null default 3;

create or replace function public.rate(p_kind text) returns void
language plpgsql security definer set search_path = public as $$
declare l jsonb;
begin
  select limits->p_kind into l from public.app_settings where id = 1;
  if l is null then return; end if;
  perform public.rate_check(p_kind, (l->>0)::int, (l->>1)::int, (l->>2)::interval);
end $$;

create or replace function public.rate_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'posts' then
    perform public.rate('post'); perform public.rate('post_day');
    if new.is_sos then perform public.rate('sos'); end if;
  elsif tg_table_name = 'comments' then perform public.rate('comment');
  elsif tg_table_name = 'messages' then perform public.rate('message');
  elsif tg_table_name = 'reports' then perform public.rate('report');
  elsif tg_table_name = 'friendships' then perform public.rate('friend');
  elsif tg_table_name = 'likes' then perform public.rate('like');
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['posts','comments','messages','reports','friendships','likes'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_rate', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.rate_trigger()', t || '_rate', t);
  end loop;
end $$;

-- ---------- SEC-04: подписки push только у настоящих push-сервисов ----------
create or replace function public.push_endpoint_ok(p text) returns boolean
language sql immutable as $$
  select p ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/[A-Za-z0-9._~:/?#\[\]@!$&''()*+,;=%-]+$'
     and char_length(p) <= 1024 $$;

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_prefs jsonb, p_lat double precision, p_lng double precision, p_ua text)
returns void language plpgsql security definer set search_path = public as $$
declare ex record;
begin
  if auth.uid() is null then raise exception using errcode = 'NR403', message = 'Войдите, чтобы включить уведомления'; end if;
  if not public.push_endpoint_ok(p_endpoint) then raise exception using errcode = 'NR422', message = 'Этот браузер не поддерживается для уведомлений'; end if;
  if p_p256dh !~ '^[A-Za-z0-9_-]{86,88}={0,2}$' or p_auth !~ '^[A-Za-z0-9_-]{21,24}={0,2}$' then
    raise exception using errcode = 'NR422', message = 'Неверная подписка';
  end if;
  if octet_length(coalesce(p_prefs, '{}'::jsonb)::text) > 2000 then raise exception using errcode = 'NR422', message = 'Слишком большие настройки'; end if;
  perform public.rate('push_sub');
  select * into ex from public.push_subs where endpoint = p_endpoint;
  if ex.id is not null and ex.user_id <> auth.uid() then
    -- подписку другого аккаунта можно забрать только с тем же браузером (те же ключи)
    if ex.p256dh <> p_p256dh or ex.auth <> p_auth then
      raise exception using errcode = 'NR409', message = 'Подписка принадлежит другому аккаунту';
    end if;
    update public.push_subs set user_id = auth.uid(), prefs = coalesce(p_prefs, '{}'::jsonb),
      lat = round(p_lat::numeric, 2), lng = round(p_lng::numeric, 2), ua = left(p_ua, 200), updated_at = now()
     where id = ex.id;
    return;
  end if;
  if ex.id is null and (select count(*) from public.push_subs where user_id = auth.uid()) >= 10 then
    delete from public.push_subs where id = (select id from public.push_subs where user_id = auth.uid() order by updated_at limit 1);
  end if;
  insert into public.push_subs (user_id, endpoint, p256dh, auth, prefs, lat, lng, ua)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, coalesce(p_prefs, '{}'::jsonb), round(p_lat::numeric, 2), round(p_lng::numeric, 2), left(p_ua, 200))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, prefs = excluded.prefs,
    lat = coalesce(excluded.lat, push_subs.lat), lng = coalesce(excluded.lng, push_subs.lng), ua = excluded.ua, updated_at = now()
    where push_subs.user_id = auth.uid();
end $$;

-- push вызывается только для опубликованного (не черновика)
create or replace function public.push_fire() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if tg_table_name = 'posts' then
    if new.category <> 'incident' or new.status <> 'active' then return new; end if;
    if tg_op = 'UPDATE' and old.status <> 'draft' then return new; end if;
    k := 'near';
  elsif tg_table_name = 'messages' then k := 'msg';
  else k := 'notif'; end if;
  if not exists (select 1 from public.push_subs limit 1) then return new; end if;
  perform public.call_fn('push', jsonb_build_object('kind', k, 'id', new.id));
  return new;
end $$;
drop trigger if exists push_on_post on public.posts;
create trigger push_on_post after insert or update of status on public.posts for each row execute function public.push_fire();

create table if not exists public.push_log (
  id         bigserial primary key,
  kind       text not null,
  sent       int not null default 0,
  failed     int not null default 0,
  removed    int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.push_log enable row level security;

-- ---------- SEC-05: удаление аккаунта — задача с состояниями, сообщения у собеседника остаются ----------
create table if not exists public.deletion_jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  status      text not null default 'pending' check (status in ('pending','running','failed','done')),
  attempts    int not null default 0,
  error_code  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists deletion_jobs_active_uidx on public.deletion_jobs (user_id) where status <> 'done';
alter table public.deletion_jobs enable row level security;

alter table public.messages alter column sender_id drop not null;
alter table public.messages drop constraint if exists messages_sender_id_fkey;
alter table public.messages add constraint messages_sender_id_fkey foreign key (sender_id) references public.profiles(id) on delete set null;
alter table public.conversations alter column user_a drop not null;
alter table public.conversations alter column user_b drop not null;
alter table public.conversations drop constraint if exists conversations_user_a_fkey;
alter table public.conversations drop constraint if exists conversations_user_b_fkey;
alter table public.conversations add constraint conversations_user_a_fkey foreign key (user_a) references public.profiles(id) on delete set null;
alter table public.conversations add constraint conversations_user_b_fkey foreign key (user_b) references public.profiles(id) on delete set null;

-- ---------- CHAT-01: запросы на общение ----------
alter table public.conversations add column if not exists status text not null default 'accepted';
alter table public.conversations add column if not exists initiator uuid references public.profiles(id) on delete set null;
alter table public.conversations drop constraint if exists conversations_status_check;
alter table public.conversations add constraint conversations_status_check check (status in ('request','accepted','declined'));

create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships where status = 'accepted'
    and ((requester_id = a and addressee_id = b) or (requester_id = b and addressee_id = a))) $$;

create or replace function public.get_or_create_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid; b uuid; cid uuid;
begin
  if me is null then raise exception using errcode = 'NR403', message = 'Войдите, чтобы написать'; end if;
  if other is null or other = me then raise exception using errcode = 'NR422', message = 'Нельзя написать самому себе'; end if;
  if not exists (select 1 from public.profiles where id = other) then raise exception using errcode = 'NR404', message = 'Пользователь не найден'; end if;
  if public.is_blocked(me, other) then raise exception using errcode = 'NR403', message = 'Пользователь недоступен'; end if;
  if public.is_banned() then raise exception using errcode = 'NR403', message = 'Аккаунт заблокирован модератором'; end if;
  a := least(me, other); b := greatest(me, other);
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is null then
    insert into public.conversations (user_a, user_b, status, initiator)
    values (a, b, case when public.are_friends(me, other) then 'accepted' else 'request' end, me)
    returning id into cid;
  end if;
  return cid;
end $$;

-- принять или отклонить запрос (может только получатель)
create or replace function public.conversation_respond(conv uuid, accept boolean) returns text
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from public.conversations where id = conv;
  if c.id is null or auth.uid() not in (c.user_a, c.user_b) then raise exception using errcode = 'NR404', message = 'Переписка не найдена'; end if;
  if c.initiator = auth.uid() then raise exception using errcode = 'NR403', message = 'Ответить на запрос может только получатель'; end if;
  update public.conversations set status = case when accept then 'accepted' else 'declined' end where id = conv;
  return case when accept then 'accepted' else 'declined' end;
end $$;

-- проверка каждого сообщения на сервере: участник, блокировки, правила запроса
create or replace function public.message_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record; n int;
begin
  if auth.uid() is null then return new; end if;
  select * into c from public.conversations where id = new.conversation_id for update;
  if c.id is null or auth.uid() not in (c.user_a, c.user_b) then raise exception using errcode = 'NR403', message = 'Нет доступа к переписке'; end if;
  if c.user_a is null or c.user_b is null then raise exception using errcode = 'NR403', message = 'Собеседник удалил аккаунт'; end if;
  if public.is_blocked(c.user_a, c.user_b) then raise exception using errcode = 'NR403', message = 'Пользователь недоступен'; end if;
  if c.status = 'accepted' then return new; end if;
  if auth.uid() = c.initiator then
    if c.status = 'declined' then raise exception using errcode = 'NR403', message = 'Собеседник отклонил запрос'; end if;
    select count(*) into n from public.messages where conversation_id = c.id and sender_id = auth.uid();
    if n >= 1 then raise exception using errcode = 'NR403', message = 'Дождитесь, пока собеседник примет запрос'; end if;
    if new.kind <> 'text' or new.text ~* '(https?://|www\.|t\.me/|wa\.me/|[a-z0-9-]+\.(com|ru|kz|net|org|me|io)\b)' then
      raise exception using errcode = 'NR422', message = 'До принятия запроса нельзя отправлять файлы и ссылки';
    end if;
  else
    -- получатель ответил — запрос принят
    update public.conversations set status = 'accepted' where id = c.id;
  end if;
  return new;
end $$;
drop trigger if exists messages_guard on public.messages;
create trigger messages_guard before insert on public.messages for each row execute function public.message_guard();

-- стали друзьями — запрос принимается автоматически
create or replace function public.on_friend_accept_conv() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'accepted' then
    update public.conversations set status = 'accepted'
     where user_a = least(new.requester_id, new.addressee_id) and user_b = greatest(new.requester_id, new.addressee_id) and status <> 'accepted';
  end if;
  return new;
end $$;
drop trigger if exists friendships_conv on public.friendships;
create trigger friendships_conv after insert or update on public.friendships for each row execute function public.on_friend_accept_conv();

drop policy if exists "msg read" on public.messages;
drop policy if exists "msg insert" on public.messages;
create policy "msg read" on public.messages for select using (public.is_participant(conversation_id));
create policy "msg insert" on public.messages for insert with check (
  auth.uid() = sender_id and public.is_participant(conversation_id) and not public.is_banned());

-- файлы переписки: только участники, без блокировки, и не до принятия запроса
create or replace function public.chat_file_allowed(obj_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversations c
                  where c.id::text = (storage.foldername(obj_name))[2]
                    and auth.uid() in (c.user_a, c.user_b)
                    and c.status = 'accepted'
                    and not public.is_blocked(c.user_a, c.user_b)) $$;

-- ---------- SEC-08: жалобы с учетом доверия, журнал модерации, апелляции ----------
alter table public.reports alter column reporter_id drop not null;
alter table public.reports add column if not exists resolved_by uuid references public.profiles(id) on delete set null;
alter table public.reports add column if not exists resolution text;
alter table public.reports add column if not exists source text not null default 'user';
alter table public.reports drop constraint if exists reports_source_check;
alter table public.reports add constraint reports_source_check check (source in ('user','ai','system'));

create or replace function public.report_weight(rid uuid) returns real
language sql stable security definer set search_path = public as $$
  select case
    when rid is null then 0
    when p.banned then 0
    when (select count(*) from public.reports d where d.reporter_id = rid and d.status = 'dismissed' and d.created_at > now() - interval '30 days') >= 3 then 0
    when p.created_at > now() - interval '3 days' then 0.5
    else 1 end::real
  from public.profiles p where p.id = rid $$;

create or replace function public.on_report() returns trigger
language plpgsql security definer set search_path = public as $$
declare w real; owner uuid; th real;
begin
  if new.target_type = 'post' and new.source = 'user' then
    select coalesce(sum(public.report_weight(reporter_id)), 0) into w from public.reports
     where target_type = 'post' and target_id = new.target_id and status = 'open' and source = 'user';
    select report_hide_weight into th from public.app_settings where id = 1;
    if w >= coalesce(th, 3) then
      perform set_config('near.system', '1', true);
      update public.posts set status = 'hidden' where id = new.target_id and status = 'active' returning user_id into owner;
      if owner is not null then
        insert into public.notifications (user_id, type, post_id, text)
        values (owner, 'post_hidden', new.target_id, 'Ваша публикация скрыта по жалобам и ждет проверки модератора. Можно подать апелляцию');
        insert into public.mod_actions (moderator_id, target_type, target_id, action, note) values (null, 'post', new.target_id, 'auto_hide', 'вес жалоб ' || w);
      end if;
      perform set_config('near.system', '', true);
    end if;
  end if;
  return new;
end $$;

create table if not exists public.mod_actions (
  id            uuid primary key default gen_random_uuid(),
  moderator_id  uuid references public.profiles(id) on delete set null,
  target_type   text not null,
  target_id     uuid not null,
  action        text not null,
  note          text check (note is null or char_length(note) <= 500),
  created_at    timestamptz not null default now()
);
create index if not exists mod_actions_target_idx on public.mod_actions (target_type, target_id, created_at desc);
alter table public.mod_actions enable row level security;
drop policy if exists "mod actions read" on public.mod_actions;
create policy "mod actions read" on public.mod_actions for select using (public.is_mod());

create table if not exists public.appeals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  target_type  text not null check (target_type in ('post','user')),
  target_id    uuid not null,
  text         text not null check (char_length(text) between 5 and 1000),
  status       text not null default 'open' check (status in ('open','accepted','rejected')),
  decided_by   uuid references public.profiles(id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (user_id, target_type, target_id)
);
alter table public.appeals enable row level security;
drop policy if exists "appeals read" on public.appeals;
drop policy if exists "appeals insert" on public.appeals;
create policy "appeals read" on public.appeals for select using (auth.uid() = user_id or public.is_mod());
create policy "appeals insert" on public.appeals for insert with check (
  auth.uid() = user_id and status = 'open' and (
    (target_type = 'user' and target_id = auth.uid())
    or (target_type = 'post' and exists (select 1 from public.posts p where p.id = target_id and p.user_id = auth.uid() and p.status = 'hidden'))));

drop policy if exists "reports read" on public.reports;
drop policy if exists "reports update" on public.reports;
drop policy if exists "reports insert" on public.reports;
create policy "reports insert" on public.reports for insert with check (auth.uid() = reporter_id and source = 'user' and status = 'open');
create policy "reports read" on public.reports for select using (auth.uid() = reporter_id or public.is_mod());

-- все действия модератора — одной функцией, с проверкой роли и журналом
create or replace function public.mod_act(p_kind text, p_id uuid, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); ap record; tgt uuid;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  if p_action in ('ban','unban','make_mod','remove_mod') and not public.is_admin() then
    raise exception using errcode = 'NR403', message = 'Только для администратора';
  end if;
  perform set_config('near.system', '1', true);
  if p_kind = 'post' then
    if p_action not in ('hide','restore','delete') then raise exception using errcode = 'NR422', message = 'Неизвестное действие'; end if;
    update public.posts set status = case p_action when 'hide' then 'hidden' when 'restore' then 'active' else 'deleted' end where id = p_id;
    if not found then raise exception using errcode = 'NR404', message = 'Публикация не найдена'; end if;
    if p_action = 'restore' then update public.post_media set mod_status = 'ok' where post_id = p_id; end if;
  elsif p_kind = 'comment' and p_action = 'delete' then
    delete from public.comments where id = p_id;
  elsif p_kind = 'message' and p_action = 'delete' then
    if not exists (select 1 from public.reports where target_type = 'message' and target_id = p_id) then
      raise exception using errcode = 'NR403', message = 'Личные сообщения доступны модератору только по жалобе';
    end if;
    delete from public.messages where id = p_id;
  elsif p_kind = 'user' and p_action in ('ban','unban','make_mod','remove_mod') then
    update public.profiles set
      banned = case p_action when 'ban' then true when 'unban' then false else banned end,
      is_moderator = case p_action when 'make_mod' then true when 'remove_mod' then false else is_moderator end
     where id = p_id;
  elsif p_kind = 'report' and p_action = 'dismiss' then
    select target_id into tgt from public.reports where id = p_id;
    update public.reports set status = 'dismissed', resolved_at = now(), resolved_by = me, resolution = p_note
     where status = 'open' and (target_type, target_id) = (select target_type, target_id from public.reports where id = p_id);
  elsif p_kind = 'appeal' and p_action in ('accept','reject') then
    select * into ap from public.appeals where id = p_id and status = 'open';
    if ap.id is null then raise exception using errcode = 'NR404', message = 'Апелляция не найдена'; end if;
    update public.appeals set status = case when p_action = 'accept' then 'accepted' else 'rejected' end, decided_by = me, decided_at = now() where id = p_id;
    if p_action = 'accept' and ap.target_type = 'post' then update public.posts set status = 'active' where id = ap.target_id and status = 'hidden'; end if;
    if p_action = 'accept' and ap.target_type = 'user' then update public.profiles set banned = false where id = ap.target_id; end if;
    insert into public.notifications (user_id, type, post_id, text)
    values (ap.user_id, 'appeal', case when ap.target_type = 'post' then ap.target_id end,
            case when p_action = 'accept' then 'Апелляция принята' else 'Апелляция отклонена' end || coalesce(': ' || left(p_note, 120), ''));
  else
    raise exception using errcode = 'NR422', message = 'Неизвестное действие';
  end if;
  -- решение по объекту закрывает открытые жалобы на него
  if p_kind in ('post','comment','message','user') then
    update public.reports set status = 'resolved', resolved_at = now(), resolved_by = me, resolution = p_action || coalesce(': ' || p_note, '')
     where status = 'open' and target_id = p_id and target_type = p_kind;
  end if;
  insert into public.mod_actions (moderator_id, target_type, target_id, action, note)
  values (me, p_kind, coalesce(tgt, p_id), p_action, left(p_note, 500));
  perform set_config('near.system', '', true);
end $$;

-- содержимое жалобы на личное сообщение: модератор видит только его, каждый просмотр в журнале
create or replace function public.mod_report_content(p_report uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; m record;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только для модераторов'; end if;
  select * into r from public.reports where id = p_report;
  if r.id is null then raise exception using errcode = 'NR404', message = 'Жалоба не найдена'; end if;
  if r.target_type <> 'message' then return null; end if;
  select id, kind, text, media_path, sender_id, created_at into m from public.messages where id = r.target_id;
  insert into public.mod_actions (moderator_id, target_type, target_id, action) values (auth.uid(), 'message', r.target_id, 'view');
  return to_jsonb(m);
end $$;

-- история по объекту: жалобы и решения
create or replace function public.mod_history(p_type text, p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_mod() then jsonb_build_object(
    'reports', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'status', status, 'source', source, 'created_at', created_at, 'resolution', resolution) order by created_at desc)
                 from public.reports where target_type = p_type and target_id = p_id), '[]'::jsonb),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('action', a.action, 'note', a.note, 'created_at', a.created_at, 'by', pr.name) order by a.created_at desc)
                 from public.mod_actions a left join public.profiles pr on pr.id = a.moderator_id
                where a.target_type = p_type and a.target_id = p_id), '[]'::jsonb)) end $$;

-- ИИ-проверка: если включена, новое фото и текст ждут ее; при сбое — очередь модератора
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

-- ИИ-проверка запускается сервером (не клиентом): новая запись "на проверке" → функция moderate
create or replace function public.ai_fire() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.mod_status = 'pending' then
    perform public.call_fn('moderate', jsonb_build_object('table', tg_table_name, 'id', new.id));
  end if;
  return new;
end $$;
drop trigger if exists post_media_ai on public.post_media;
create trigger post_media_ai after insert on public.post_media for each row execute function public.ai_fire();
drop trigger if exists messages_ai on public.messages;
create trigger messages_ai after insert on public.messages for each row execute function public.ai_fire();

-- ---------- наблюдаемость и аналитика (без токенов, текстов сообщений и точных координат) ----------
create table if not exists public.client_errors (
  id              bigserial primary key,
  kind            text not null,
  message         text,
  stack           text,
  correlation_id  text,
  app_version     text,
  route           text,
  ua              text,
  created_at      timestamptz not null default now()
);
create index if not exists client_errors_created_idx on public.client_errors (created_at desc);
alter table public.client_errors enable row level security;

create or replace function public.log_client_error(p_kind text, p_message text, p_stack text, p_corr text, p_version text, p_route text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.rate('log');
  insert into public.client_errors (kind, message, stack, correlation_id, app_version, route, ua)
  values (left(p_kind, 40), left(regexp_replace(coalesce(p_message, ''), '(eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)', '[скрыто]', 'g'), 500),
          left(p_stack, 2000), left(p_corr, 64), left(p_version, 20), left(regexp_replace(coalesce(p_route, ''), '[?#].*$', ''), 100),
          left(current_setting('request.headers', true)::json->>'user-agent', 200));
exception when others then
  if sqlstate = 'NR429' then return; end if; raise;
end $$;

create table if not exists public.analytics_events (
  id          bigserial primary key,
  name        text not null,
  user_hash   text,
  install_id  text,
  props       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists analytics_events_name_idx on public.analytics_events (name, created_at desc);
create index if not exists analytics_events_user_idx on public.analytics_events (user_hash, created_at);
alter table public.analytics_events enable row level security;

-- псевдонимизированное событие: вместо id пользователя — хэш, свойства только из разрешенного списка
create or replace function public.track(p_name text, p_props jsonb default '{}'::jsonb, p_install text default null) returns void
language plpgsql security definer set search_path = public as $$
declare clean jsonb := '{}'::jsonb; k text;
begin
  if p_name not in ('app_open','signup','activation','feed_loaded','post_created','comment_created','message_sent',
                    'push_opened','report_sent','sos_sent','onboarding_skipped','onboarding_done','error_shown') then return; end if;
  perform public.rate('log');
  foreach k in array array['ms','count','category','radius','page','error','theme','lang','source','ok'] loop
    if p_props ? k then clean := clean || jsonb_build_object(k, left(p_props->>k, 40)); end if;
  end loop;
  insert into public.analytics_events (name, user_hash, install_id, props)
  values (p_name, case when auth.uid() is null then null else md5('near-u:' || auth.uid()::text) end, left(p_install, 40), clean);
exception when others then
  if sqlstate = 'NR429' then return; end if; raise;
end $$;

-- KPI пилота (только администратор)
create or replace function public.kpi_summary(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not public.is_admin() then raise exception using errcode = 'NR403', message = 'Только для администратора'; end if;
  with users as (
    select user_hash, min(created_at) first_at from public.analytics_events where user_hash is not null group by user_hash
  ), cohort as (
    select * from users where first_at > now() - make_interval(days => p_days)
  ), active as (
    select distinct user_hash, created_at::date d from public.analytics_events where user_hash is not null
  )
  select jsonb_build_object(
    'new_users', (select count(*) from cohort),
    'activation', (select round(100.0 * count(distinct e.user_hash) / nullif((select count(*) from cohort), 0), 1)
                     from public.analytics_events e join cohort c using (user_hash) where e.name = 'activation'),
    'd1', (select round(100.0 * count(distinct a.user_hash) / nullif(count(distinct c.user_hash), 0), 1)
             from cohort c left join active a on a.user_hash = c.user_hash and a.d = (c.first_at::date + 1)
            where c.first_at < now() - interval '1 day'),
    'd7', (select round(100.0 * count(distinct a.user_hash) / nullif(count(distinct c.user_hash), 0), 1)
             from cohort c left join active a on a.user_hash = c.user_hash and a.d = (c.first_at::date + 7)
            where c.first_at < now() - interval '7 days'),
    'd30', (select round(100.0 * count(distinct a.user_hash) / nullif(count(distinct c.user_hash), 0), 1)
             from cohort c left join active a on a.user_hash = c.user_hash and a.d = (c.first_at::date + 30)
            where c.first_at < now() - interval '30 days'),
    'dau', (select count(distinct user_hash) from active where d = current_date),
    'mau', (select count(distinct user_hash) from active where d > current_date - 30),
    'posts', (select count(*) from public.posts where created_at > now() - make_interval(days => p_days) and status <> 'draft'),
    'reports_open', (select count(*) from public.reports where status = 'open'),
    'report_median_hours', (select round((percentile_cont(0.5) within group (order by extract(epoch from resolved_at - created_at)) / 3600)::numeric, 1)
                              from public.reports where resolved_at is not null and created_at > now() - make_interval(days => p_days)),
    'time_to_first_reply_min', (select round((percentile_cont(0.5) within group (order by extract(epoch from r.created_at - f.created_at)) / 60)::numeric, 1)
       from (select conversation_id, min(created_at) created_at, (array_agg(sender_id order by created_at))[1] first_sender
               from public.messages where created_at > now() - make_interval(days => p_days) group by conversation_id) f
       join lateral (select min(created_at) created_at from public.messages m
                      where m.conversation_id = f.conversation_id and m.sender_id is distinct from f.first_sender) r on r.created_at is not null),
    'push_sent', (select coalesce(sum(sent), 0) from public.push_log where created_at > now() - make_interval(days => p_days)),
    'push_failed', (select coalesce(sum(failed), 0) from public.push_log where created_at > now() - make_interval(days => p_days)),
    'push_opened', (select count(*) from public.analytics_events where name = 'push_opened' and created_at > now() - make_interval(days => p_days)),
    'errors_24h', (select count(*) from public.client_errors where created_at > now() - interval '24 hours'),
    'mod_queue', (select count(*) from public.reports where status = 'open') + (select count(*) from public.appeals where status = 'open'),
    'storage_mb', (select round(coalesce(sum((metadata->>'size')::bigint), 0) / 1048576.0, 1) from storage.objects where bucket_id in ('post-media','chat-media','post-quarantine'))
  ) into res;
  return res;
end $$;

-- уборка старых служебных данных (вызывать раз в день через pg_cron, см. SETUP.md)
create or replace function public.near_cleanup() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a int; b int; c int;
begin
  delete from public.rate_events where created_at < now() - interval '2 days';
  delete from public.client_errors where created_at < now() - interval '30 days'; get diagnostics a = row_count;
  delete from public.analytics_events where created_at < now() - interval '180 days'; get diagnostics b = row_count;
  delete from public.push_log where created_at < now() - interval '90 days';
  select count(*) into c from public.posts where status = 'draft' and created_at < now() - interval '24 hours';
  -- черновики старше суток стирает функция moderate (файлы + строки)
  perform public.call_fn('moderate', jsonb_build_object('kind', 'cleanup'));
  return jsonb_build_object('errors_removed', a, 'events_removed', b, 'stale_drafts', c);
end $$;

-- ---------- обновления в реальном времени: список переписок ----------
do $$ begin
  begin alter publication supabase_realtime add table public.conversations; exception when others then null; end;
end $$;

-- =====================================================
--  NEAR v12 — миграция: атомарный SOS, подтвержденный email,
--  хранение переписки удаленного аккаунта 30 дней, сортировка ленты,
--  фильтры карты, избранные места, обратная связь, события аналитики.
--  Скрипт идемпотентный. Коды ошибок те же: NR403/NR404/NR409/NR422/NR429.
-- =====================================================

-- ---------- SOS-01: срок назначает только сервер; второй активный SOS невозможен даже при параллельной отправке ----------
create or replace function public.post_ttl(cat text, sos boolean) returns interval
language sql immutable as $$
  select case when sos then interval '3 hours'
    when cat = 'incident' then interval '24 hours'
    when cat in ('lost','found') then interval '30 days'
    when cat in ('deal','ad') then interval '14 days'
    when cat = 'meetup' then interval '7 days'
    when cat = 'event' then interval '30 days'
    else interval '90 days' end $$;

create or replace function public.post_prepare() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.is_sos and new.category <> 'incident' then
      raise exception using errcode = 'NR422', message = 'SOS бывает только у происшествия';
    end if;
    if new.is_sos then
      -- одна блокировка на автора: параллельные запросы выстраиваются в очередь и видят уже созданный SOS
      perform pg_advisory_xact_lock(hashtextextended('near-sos:' || new.user_id::text, 0));
      if exists (select 1 from public.posts where user_id = new.user_id and is_sos and status in ('draft','active')
                  and (expires_at is null or expires_at > now())) then
        raise exception using errcode = 'NR409', message = 'У вас уже есть активный SOS. Закройте его, чтобы отправить новый';
      end if;
    end if;
    -- срок актуальности всегда считает сервер (значение от приложения игнорируется)
    if auth.uid() is not null or new.expires_at is null or new.is_sos then
      new.expires_at := now() + public.post_ttl(new.category, new.is_sos);
    end if;
  else
    if new.status = 'closed' and old.status <> 'closed' then new.resolved_at := now(); end if;
    if new.status = 'active' and old.status = 'closed' then
      -- закрытый SOS повторно не открывается
      if old.is_sos then new.status := 'closed'; else new.resolved_at := null; end if;
    end if;
    if auth.uid() is not null and not public.is_mod() and coalesce(current_setting('near.system', true), '') <> '1' then
      new.is_sos := old.is_sos; new.user_id := old.user_id; new.client_key := old.client_key; new.created_at := old.created_at;
      new.expires_at := old.expires_at; new.exact := old.exact;
      if old.status <> 'draft' then new.lat := old.lat; new.lng := old.lng; end if;
    end if;
  end if;
  -- место по умолчанию приблизительное: точка привязывается к сетке ~200 м, исходные координаты не сохраняются
  if not new.exact then
    new.lat := round((new.lat / 0.002)::numeric) * 0.002;
    new.lng := round((new.lng / 0.0026)::numeric) * 0.0026;
  end if;
  return new;
end $$;

-- ---------- UX-01: публикации, комментарии и сообщения — только с подтвержденным email ----------
create or replace function public.is_verified() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users u where u.id = auth.uid()
    and (u.email_confirmed_at is not null or coalesce(u.raw_app_meta_data->>'provider', 'email') <> 'email')) $$;

create or replace function public.verified_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_verified() then
    raise exception using errcode = 'NR403', message = 'Подтвердите email: откройте письмо от NEAR и нажмите ссылку', hint = 'email_unconfirmed';
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['posts','comments','messages'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_verified', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.verified_guard()', t || '_verified', t);
  end loop;
end $$;

-- пол обязателен (решение владельца продукта): после регистрации без пола приложение просит дозаполнить профиль;
-- публикации и сообщения недоступны, пока пол не указан
create or replace function public.profile_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and exists (select 1 from public.profiles where id = auth.uid() and (gender is null or accepted_rules_at is null)) then
    raise exception using errcode = 'NR403', message = 'Заполните профиль: пол и согласие с правилами', hint = 'profile_incomplete';
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['posts','comments','messages'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_profile', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.profile_guard()', t || '_profile', t);
  end loop;
end $$;

-- ---------- PRIV-01: переписка удаленного аккаунта хранится у собеседника 30 дней ----------
alter table public.conversations add column if not exists orphaned_at timestamptz;
create or replace function public.conv_orphan() returns trigger
language plpgsql as $$
begin
  if (new.user_a is null or new.user_b is null) and new.orphaned_at is null then new.orphaned_at := now(); end if;
  return new;
end $$;
drop trigger if exists conversations_orphan on public.conversations;
create trigger conversations_orphan before update on public.conversations for each row execute function public.conv_orphan();
update public.conversations set orphaned_at = now() where (user_a is null or user_b is null) and orphaned_at is null;

-- ---------- избранные места: приватные, уведомления только по согласию ----------
create table if not exists public.saved_places (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  radius      int not null default 1000 check (radius between 300 and 5000),
  notify      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists saved_places_user_idx on public.saved_places (user_id);
alter table public.saved_places enable row level security;
drop policy if exists "places own" on public.saved_places;
create policy "places own" on public.saved_places for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create or replace function public.places_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and (select count(*) from public.saved_places where user_id = new.user_id) >= 5 then
    raise exception using errcode = 'NR422', message = 'Не больше 5 избранных мест';
  end if;
  -- точку храним с точностью ~100 м: этого достаточно для "что рядом"
  new.lat := round(new.lat::numeric, 3); new.lng := round(new.lng::numeric, 3);
  return new;
end $$;
drop trigger if exists saved_places_guard on public.saved_places;
create trigger saved_places_guard before insert or update on public.saved_places for each row execute function public.places_guard();

-- ---------- UX-02: лента — "Новое", "Рядом", "Для вас"; фильтры "Друзья" и период ----------
create or replace function public.feed_sorted(p_lat double precision, p_lng double precision, p_radius int,
  p_cats text[] default null, p_sort text default 'new', p_period text default null, p_friends boolean default false,
  p_after_ts timestamptz default null, p_after_dist double precision default null, p_after_id uuid default null,
  p_offset int default 0, p_limit int default 12)
returns table (post_id uuid, sort_ts timestamptz, sort_dist double precision, sort_score double precision)
language sql stable set search_path = public, extensions as $$
  with me as (select extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography g),
  base as (
    select p.id, p.created_at, p.category, p.is_sos, p.expires_at,
           extensions.st_distance(p.geog, me.g) dist,
           (select count(*) from public.comments c where c.post_id = p.id) nc,
           (select count(*) from public.likes l where l.post_id = p.id) nl
      from public.posts p, me
     where p.status in ('active','closed')
       and (p.expires_at is null or p.expires_at > now())
       and extensions.st_dwithin(p.geog, me.g, least(greatest(coalesce(p_radius, 1000), 100), 50000))
       and (p_cats is null or p.category = any (p_cats))
       and (p_period is null or (p_period = 'today' and p.created_at > date_trunc('day', now() at time zone 'Asia/Almaty') at time zone 'Asia/Almaty')
                             or (p_period = 'week' and p.created_at > now() - interval '7 days'))
       and (not coalesce(p_friends, false) or public.are_friends(auth.uid(), p.user_id))
       and not public.is_blocked(auth.uid(), p.user_id)
  ), scored as (
    select b.*,
      -- срочное (SOS и свежие происшествия) всегда наверху; дальше — свежесть, близость и полезность (ответы)
      (case when b.is_sos or (b.category = 'incident' and b.created_at > now() - interval '3 hours') then 1000 else 0 end)
      + 100 * exp(-extract(epoch from now() - b.created_at) / 86400.0)
      + 40 * exp(-b.dist / 1500.0)
      + 8 * ln(1 + b.nc) + 3 * ln(1 + b.nl) score
    from base b
  )
  select id, created_at, dist, score from scored s
   where case coalesce(p_sort, 'new')
           when 'near' then p_after_dist is null or (s.dist, s.id) > (p_after_dist, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
           when 'new' then p_after_ts is null or (s.created_at, s.id) < (p_after_ts, coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
           else true end
   order by case when p_sort = 'near' then s.dist end asc,
            case when p_sort = 'top' then s.score end desc,
            s.created_at desc, s.id desc
   offset case when p_sort = 'top' then greatest(coalesce(p_offset, 0), 0) else 0 end
   limit least(greatest(coalesce(p_limit, 12), 1), 12) $$;

-- карта: те же правила + период и "друзья"
create or replace function public.map_posts2(p_w double precision, p_s double precision, p_e double precision, p_n double precision,
  p_cats text[] default null, p_lat double precision default null, p_lng double precision default null, p_radius int default null,
  p_period text default null, p_friends boolean default false, p_limit int default 300)
returns setof public.posts language sql stable set search_path = public, extensions as $$
  select p.* from public.map_posts(p_w, p_s, p_e, p_n, p_cats, p_lat, p_lng, p_radius, 500) p
   where (p_period is null or (p_period = 'today' and p.created_at > date_trunc('day', now() at time zone 'Asia/Almaty') at time zone 'Asia/Almaty')
                         or (p_period = 'week' and p.created_at > now() - interval '7 days'))
     and (not coalesce(p_friends, false) or public.are_friends(auth.uid(), p.user_id))
   limit least(greatest(coalesce(p_limit, 300), 1), 500) $$;

-- ---------- поддержка: сообщение об ошибке из приложения ----------
create table if not exists public.feedback (
  id          bigserial primary key,
  user_id     uuid references public.profiles(id) on delete set null,
  text        text not null check (char_length(text) between 3 and 1000),
  route       text,
  app_version text,
  ua          text,
  status      text not null default 'new' check (status in ('new','done')),
  created_at  timestamptz not null default now()
);
alter table public.feedback enable row level security;
drop policy if exists "feedback admin" on public.feedback;
create policy "feedback admin" on public.feedback for select using (public.is_admin());
create or replace function public.send_feedback(p_text text, p_route text, p_version text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.rate('log');
  insert into public.feedback (user_id, text, route, app_version, ua)
  values (auth.uid(), left(trim(p_text), 1000), left(regexp_replace(coalesce(p_route, ''), '[?#].*$', ''), 100), left(p_version, 20),
          left(current_setting('request.headers', true)::json->>'user-agent', 200));
end $$;
create or replace function public.feedback_list() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_admin() then coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'text', f.text, 'route', f.route, 'version', f.app_version,
      'created_at', f.created_at, 'name', pr.name) order by f.created_at desc)
    from (select * from public.feedback where status = 'new' order by created_at desc limit 50) f left join public.profiles pr on pr.id = f.user_id), '[]'::jsonb) end $$;

-- ---------- аналитика: события из ТЗ v12 (без текстов, email, токенов и координат) ----------
create or replace function public.track(p_name text, p_props jsonb default '{}'::jsonb, p_install text default null) returns void
language plpgsql security definer set search_path = public as $$
declare clean jsonb := '{}'::jsonb; k text;
begin
  if p_name not in ('app_open','signup','activation','feed_loaded','post_created','comment_created','message_sent','first_reply',
                    'push_opened','push_opt_in','report_sent','sos_sent','onboarding_skip','onboarding_complete','onboarding_skipped','onboarding_done',
                    'location_permission','filter_changed','chat_request_accepted','error','error_shown') then return; end if;
  perform public.rate('log');
  foreach k in array array['ms','count','category','radius','page','error','theme','lang','source','ok','sort','period','filter','state'] loop
    if p_props ? k then clean := clean || jsonb_build_object(k, left(p_props->>k, 40)); end if;
  end loop;
  insert into public.analytics_events (name, user_hash, install_id, props)
  values (p_name, case when auth.uid() is null then null else md5('near-u:' || auth.uid()::text) end, left(p_install, 40), clean);
exception when others then
  if sqlstate = 'NR429' then return; end if; raise;
end $$;

-- ---------- уборка: + переписки удаленных аккаунтов старше 30 дней (файлы стирает функция moderate) ----------
create or replace function public.near_cleanup() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int;
begin
  delete from public.rate_events where created_at < now() - interval '2 days';
  delete from public.client_errors where created_at < now() - interval '30 days'; get diagnostics a = row_count;
  delete from public.analytics_events where created_at < now() - interval '180 days'; get diagnostics b = row_count;
  delete from public.push_log where created_at < now() - interval '90 days';
  select count(*) into c from public.posts where status = 'draft' and created_at < now() - interval '24 hours';
  select count(*) into d from public.conversations where orphaned_at < now() - interval '30 days';
  perform public.call_fn('moderate', jsonb_build_object('kind', 'cleanup'));
  return jsonb_build_object('errors_removed', a, 'events_removed', b, 'stale_drafts', c, 'orphaned_conversations', d);
end $$;

-- ---------- MEDIA-01: каждый загруженный файл проверяет сервер (сигнатура, размер, GPS в видео) ----------
alter table public.post_media add column if not exists checked_at timestamptz;
create or replace function public.media_check_fire() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.call_fn('moderate', jsonb_build_object('kind', 'media_check', 'id', new.id));
  return new;
end $$;
drop trigger if exists post_media_check on public.post_media;
create trigger post_media_check after insert on public.post_media for each row execute function public.media_check_fire();

-- =====================================================
--  SEC-03: МИНИМАЛЬНЫЕ ПРАВА
--  Гость (anon) — только чтение публичного; вошедший (authenticated) — только нужные таблицы.
--  Все остальное — через функции с проверкой роли и владельца.
-- =====================================================
grant usage on schema public to anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant select on public.posts, public.post_media, public.comments, public.likes, public.events, public.event_members,
                public.profiles, public.app_settings to anon, authenticated;
grant insert, update, delete on public.posts to authenticated;
grant insert, delete on public.post_media, public.comments, public.likes, public.event_members to authenticated;
grant insert, update, delete on public.events to authenticated;
grant update on public.profiles to authenticated;
grant select, insert, delete on public.saved_posts, public.blocks to authenticated;
grant select, insert, update, delete on public.friendships to authenticated;
grant select on public.conversations to authenticated;
grant select, insert, delete on public.messages to authenticated;
grant select, insert on public.reports to authenticated;
grant select, update on public.notifications to authenticated;
grant select, delete on public.push_subs to authenticated;
grant select, insert on public.appeals to authenticated;
grant select on public.mod_actions to authenticated;
grant select, insert, update, delete on public.saved_places to authenticated;
grant select on public.feedback to authenticated;
grant update (ai_moderation, limits, report_hide_weight) on public.app_settings to authenticated;

-- функции, которые вызываются в правилах RLS, и публичные RPC
grant execute on function public.is_admin(), public.is_mod(), public.is_banned(), public.is_blocked(uuid, uuid),
  public.is_participant(uuid), public.can_see_post(uuid), public.chat_file_allowed(text), public.are_friends(uuid, uuid)
  to anon, authenticated;
grant execute on function public.feed_page(double precision, double precision, int, text[], timestamptz, uuid, int),
  public.feed_new(double precision, double precision, int, text[], timestamptz, uuid, int),
  public.map_posts(double precision, double precision, double precision, double precision, text[], double precision, double precision, int, int),
  public.recent_stats(double precision, double precision, int, text[]),
  public.log_client_error(text, text, text, text, text, text),
  public.track(text, jsonb, text),
  public.feed_sorted(double precision, double precision, int, text[], text, text, boolean, timestamptz, double precision, uuid, int, int),
  public.map_posts2(double precision, double precision, double precision, double precision, text[], double precision, double precision, int, text, boolean, int),
  public.send_feedback(text, text, text), public.is_verified()
  to anon, authenticated;
grant execute on function public.feedback_list() to authenticated;
grant execute on function public.ensure_profile(), public.touch_seen(), public.get_or_create_conversation(uuid),
  public.conversation_respond(uuid, boolean), public.mark_conversation_read(uuid),
  public.push_subscribe(text, text, text, jsonb, double precision, double precision, text), public.push_unsubscribe(text),
  public.mod_act(text, uuid, text, text), public.mod_report_content(uuid), public.mod_history(text, uuid), public.kpi_summary(int)
  to authenticated;
-- безопасные чистые функции, которые вызываются внутри триггеров с правами вызывающего
grant execute on function public.mask_bad(text), public.push_endpoint_ok(text), public.req_ip_hash() to anon, authenticated;
-- служебные функции — только серверу
revoke execute on function public.push_fire(), public.ai_fire(), public.media_check_fire(), public.verified_guard(), public.profile_guard(), public.call_fn(text, jsonb), public.near_cleanup(), public.rate_check(text, int, int, interval),
  public.rate(text) from public, anon, authenticated;

-- Готово ✅ v12


-- =====================================================
--  Миграция v14 (этап 1 из ТЗ v14.4). Для базы, где уже стоит v12 (schema.sql уже включает этот блок).
--  Запуск: Supabase → SQL Editor → вставить файл целиком → Run. Скрипт идемпотентный.
--
--  Что внутри:
--   02 — исправления v12: лента (SOS, "Рядом", снимок "Для вас"), карта (фильтры до лимита), 5 мест (блокировка),
--        медиа только при включенной серверной проверке;
--   04 — никнейм вместо имени, фамилии и пола; приватный возрастной допуск; личные чаты с незнакомыми — только при допуске;
--   05 — NEAR Clean: маскирование мата (первая буква + звездочки), угрозы не публикуются;
--   08 — дневные лимиты (атомарно, 429 + retry_after, ключ идемпотентности), дубликаты текста.
--  Старые имя/фамилия/пол удаляются ОТДЕЛЬНО: 014b_purge_legacy.sql (после решения владельца).
--
--  Откат (данные не трогаются): вернуть клиент v12 и выполнить 012_v12.sql повторно — он вернет feed_sorted, map_posts2,
--  places_guard, profile_guard. Новые таблицы (profile_private, nickname_history, rate_counters, rate_idem) можно оставить.
--  Перед миграцией — резервная копия (SETUP.md, шаг 16).
-- =====================================================

-- ---------- 05 / NEAR Clean v1: маскирование мата (тот же алгоритм, что js/clean.src.js) ----------
-- Первая буква слова остается, каждая следующая графема → "*". Проверка до записи публичного текста.
-- Оригинал не сохраняется. Словарь версионируется: app_settings.clean_version.
create or replace function public.nc_is_w(k int) returns boolean language sql immutable as $$
  select (k between 48 and 57) or (k between 65 and 90) or (k between 97 and 122) or (k between 192 and 591 and k not in (215, 247))
      or (k between 1024 and 1279) or (k between 768 and 879) or (k between 8203 and 8205) or k in (8288, 65279, 173, 64, 36) $$;
create or replace function public.nc_is_sep(k int) returns boolean language sql immutable as $$ select k in (46, 45, 95, 42, 39, 8217, 96) $$;
create or replace function public.nc_is_zw(k int) returns boolean language sql immutable as $$ select (k between 8203 and 8205) or k in (8288, 65279, 173) $$;
create or replace function public.nc_is_mark(k int) returns boolean language sql immutable as $$ select k between 768 and 879 $$;

create or replace function public.nc_translit(s text) returns text language plpgsql immutable as $$
declare out text := ''; i int := 1; n int := char_length(s); g text; c text; L int; hit text;
begin
  while i <= n loop
    hit := null;
    foreach L in array array[4, 3, 2] loop
      g := substr(s, i, L);
      if char_length(g) = L then
        hit := case g when 'shch' then 'щ' when 'sch' then 'щ' when 'sh' then 'ш' when 'ch' then 'ч' when 'zh' then 'ж' when 'kh' then 'х'
          when 'ts' then 'ц' when 'ya' then 'я' when 'yu' then 'ю' when 'yo' then 'е' when 'ye' then 'е' when 'ja' then 'я' when 'ju' then 'ю' when 'jo' then 'е' end;
        if hit is not null then out := out || hit; i := i + L; exit; end if;
      end if;
    end loop;
    continue when hit is not null;
    c := substr(s, i, 1);
    if c = 'y' then out := out || case when out ~ '[аеиоуыэюя]$' then 'й' else 'ы' end;
    elsif c = 'x' then out := out || 'кс';
    else out := out || translate(c, 'abcdefghijklmnopqrstuvwz', 'абкдефгхийклмнопкрстуввз');
    end if;
    i := i + 1;
  end loop;
  return regexp_replace(out, '(.)\1+', '\1', 'g');
end $$;

create or replace function public.nc_bad_token(tok text) returns boolean language plpgsql immutable as $$
declare s text := ''; c text; k int; en text; hg text; kk text;
  pre constant text := '(вы|за|на|по|от|до|у|раз|рас|при|об|о|пере|под|недо|про|из|ис|без|бес|вз|съ|разъ|объ|подъ|отъ|изъ|въ|взъ)?';
  ru_full text; ru_strict text;
  en_re constant text := '^(mother|motha|mutha|holy)?(fuck.*|fuk.*|fck.*|phuck.*|shit.*|bitch.*|cunt.*|asshole.*|bullshit.*|dickhead.*|whore.*|slut.*)$';
  exc constant text[] := array['shiitake','shitake','shiite','shiites','fukuoka','fukushima','hue','hues','huey','hui','ebay','ebola','ebony','ebook','ebooks','suki','sukiyaki','scunthorpe'];
begin
  ru_full := '^(' || pre || '(ху[йяеёию].*|пизд.*|еб[аулнышиоеё].*|бля[дт].*|бля|долбоеб.*|мудак.*|мудил.*|мудо[хз].*|мудач.*|гандон.*|пид[оа]р.*|шлюх.*|залуп.*)'
    || '|сук(а|и|е|у|ой|ою|ам|ами|ах|ин.*)|суч(к|ар|ий|ья|ье).*|котак.*|қотақ.*|сиг(ей|ейин|ем|у|ип).*|шешеңди.*)$';
  ru_strict := '^(' || pre || '(хуй.*|хуя.*|хуе[втлн].*|хую.*|пизд.*|еба[лнт].*|ебл.*|ебу.*|еби.*|ебн.*|ебош.*|бля[дт].*|бля|долбоеб.*|мудак.*|мудил.*|гандон.*|пид[оа]р.*|шлюх.*|залуп.*)'
    || '|сук(а|и|е|у|ой|ам|ами|ах|ин.*))$';
  kk := lower(translate(normalize(tok, NFKC), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯӘҒҚҢӨҰҮҺІ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһі'));
  foreach c in array regexp_split_to_array(kk, '') loop
    k := ascii(c);
    if not (public.nc_is_zw(k) or public.nc_is_mark(k) or public.nc_is_sep(k)) then s := s || c; end if;
  end loop;
  if s = '' or s = any (exc) then return false; end if;
  if s ~ '[Ѐ-ӿ]' then
    hg := regexp_replace(translate(translate(s, 'aceopxykmthiunr0346@$', 'асеорхукмтниипгозчбас'), 'ёі', 'еи'), '(.)\1+', '\1', 'g');
    return hg ~ ru_full;
  end if;
  if s !~ '[a-zA-Z]' and s !~ '[À-ɏ]' then return false; end if;
  en := regexp_replace(translate(s, '013457@$', 'oieastas'), '(.)\1+', '\1', 'g');
  if en = any (exc) then return false; end if;
  if en ~ en_re then return true; end if;
  if public.nc_translit(en) ~ ru_strict then return true; end if;
  hg := regexp_replace(translate(s, 'aceopxykmthiunr0346@$', 'асеорхукмтниипгозчбас'), '(.)\1+', '\1', 'g');
  return hg !~ '[a-zA-ZÀ-ɏ]' and hg ~ ru_full;
end $$;

-- маскирование: возвращает текст и число найденных слов
create or replace function public.near_clean_x(t text, out txt text, out hits int) language plpgsql immutable as $$
declare ch text[]; o text[]; n int; i int; j int; k int; q int; a int; b int; ts int[] := '{}'; te int[] := '{}'; done boolean[]; w text; first boolean; m text; nt int;
begin
  hits := 0;
  if t is null or t = '' then txt := t; return; end if;
  ch := regexp_split_to_array(t, ''); o := ch; n := array_length(ch, 1);
  -- слова: буквы/цифры, внутри допускаются разделители
  i := 1;
  while i <= n loop
    if not public.nc_is_w(ascii(ch[i])) then i := i + 1; continue; end if;
    j := i;
    loop
      while j <= n and public.nc_is_w(ascii(ch[j])) loop j := j + 1; end loop;
      if j <= n and public.nc_is_sep(ascii(ch[j])) then
        k := j; while k <= n and public.nc_is_sep(ascii(ch[k])) loop k := k + 1; end loop;
        if k <= n and public.nc_is_w(ascii(ch[k])) then j := k; continue; end if;
      end if;
      exit;
    end loop;
    ts := ts || i; te := te || j; i := j;
  end loop;
  nt := coalesce(array_length(ts, 1), 0);
  if nt = 0 then txt := t; return; end if;
  done := array_fill(false, array[nt]);
  -- "х у й": три и больше одиночных букв через один пробел
  a := 1;
  while a <= nt loop
    b := a;
    while b + 1 <= nt and te[b] - ts[b] = 1 and te[b + 1] - ts[b + 1] = 1 and ts[b + 1] = te[b] + 1 and ch[te[b]] = ' ' loop b := b + 1; end loop;
    if b - a >= 2 and te[a] - ts[a] = 1 then
      w := ''; for q in a..b loop w := w || ch[ts[q]]; end loop;
      if public.nc_bad_token(w) then
        for q in a + 1..b loop o[ts[q]] := '*'; end loop;
        for q in a..b loop done[q] := true; end loop;
        hits := hits + 1; a := b + 1; continue;
      end if;
    end if;
    a := a + 1;
  end loop;
  for q in 1..nt loop
    continue when done[q];
    w := array_to_string(ch[ts[q]:te[q] - 1], '');
    if public.nc_bad_token(w) then
      hits := hits + 1; m := ch[ts[q]]; first := true;
      for i in ts[q] + 1..te[q] - 1 loop
        k := ascii(ch[i]);
        if public.nc_is_mark(k) then if first then m := m || ch[i]; end if;
        elsif public.nc_is_zw(k) then null;
        else m := m || '*'; first := false;
        end if;
      end loop;
      o[ts[q]] := m;
      for i in ts[q] + 1..te[q] - 1 loop o[i] := ''; end loop;
    end if;
  end loop;
  txt := array_to_string(o, '');
end $$;

create or replace function public.near_clean(t text) returns text language sql immutable as $$ select (public.near_clean_x(t)).txt $$;
create or replace function public.near_has_bad(t text) returns boolean language sql immutable as $$ select coalesce((public.near_clean_x(t)).hits, 0) > 0 $$;
-- старое имя: триггеры posts_mask, comments_mask, messages_mask вызывают mask_bad
create or replace function public.mask_bad(t text) returns text language sql immutable as $$ select public.near_clean(t) $$;

-- явные угрозы: не маскируются, а не публикуются
create or replace function public.near_is_threat(t text) returns boolean language sql immutable as $$
  select coalesce(replace(lower(translate(t, 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя')), 'ё', 'е')
    ~ '(^|[^а-яa-z])(убью (тебя|вас|его|ее|тебе)|зарежу|пристрелю|задушу (тебя|вас)|урою|тебе конец|найду тебя и|сожгу (тебя|вас|твой|твою|ваш)|i will kill you|i''ll kill you|kill you|өлтіремін)([^а-яa-z]|$)', false) $$;

create or replace function public.mask_text_trigger() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.text is distinct from old.text then
    if public.near_is_threat(new.text) then
      raise exception using errcode = 'NR422', message = 'Угрозы запрещены правилами NEAR. Текст не опубликован', hint = 'threat';
    end if;
    new.text := public.near_clean(new.text);
  end if;
  return new;
end $$;
-- описание профиля тоже проходит NEAR Clean
create or replace function public.mask_bio_trigger() returns trigger
language plpgsql as $$
begin
  if new.bio is distinct from old.bio and new.bio is not null then
    if public.near_is_threat(new.bio) then raise exception using errcode = 'NR422', message = 'Угрозы запрещены правилами NEAR'; end if;
    new.bio := public.near_clean(new.bio);
  end if;
  return new;
end $$;
drop trigger if exists profiles_bio_mask on public.profiles;
create trigger profiles_bio_mask before update of bio on public.profiles for each row execute function public.mask_bio_trigger();

-- =====================================================
--  02 / Исправления v12
-- =====================================================

-- ---------- лента: закрытый SOS без подъема; "Рядом" — порядок и курсор по одним полям;
--            "Для вас" — снимок на момент первой страницы (p_snapshot) и курсор (score, id) вместо OFFSET ----------
drop function if exists public.feed_sorted(double precision, double precision, int, text[], text, text, boolean, timestamptz, double precision, uuid, int, int);
create or replace function public.feed_sorted(p_lat double precision, p_lng double precision, p_radius int,
  p_cats text[] default null, p_sort text default 'new', p_period text default null, p_friends boolean default false,
  p_after_ts timestamptz default null, p_after_dist double precision default null, p_after_id uuid default null,
  p_offset int default 0, p_limit int default 12, p_after_score double precision default null, p_snapshot timestamptz default null)
returns table (post_id uuid, sort_ts timestamptz, sort_dist double precision, sort_score double precision, snapshot timestamptz)
language sql stable set search_path = public, extensions as $$
  with prm as (select least(coalesce(p_snapshot, now()), now()) t0),
  me as (select extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography g),
  base as (
    select p.id, p.created_at, p.category, p.is_sos, p.status,
           extensions.st_distance(p.geog, me.g) dist,
           -- счетчики на момент снимка: новые лайки не двигают уже показанные страницы
           (select count(*) from public.comments c where c.post_id = p.id and c.created_at <= prm.t0) nc,
           (select count(*) from public.likes l where l.post_id = p.id and l.created_at <= prm.t0) nl
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
  ), scored as (
    select b.*,
      -- подъем только у действующего SOS и свежего происшествия; закрытые не поднимаются
      (case when b.status = 'active' and (b.is_sos or (b.category = 'incident' and b.created_at > prm.t0 - interval '3 hours')) then 1000 else 0 end)
      + 100 * exp(-greatest(extract(epoch from prm.t0 - b.created_at), 0) / 86400.0)
      + 40 * exp(-b.dist / 1500.0)
      + 8 * ln(1 + b.nc) + 3 * ln(1 + b.nl) score
    from base b, prm
  )
  select s.id, s.created_at, s.dist, s.score, (select t0 from prm) from scored s
   where case coalesce(p_sort, 'new')
           when 'near' then p_after_dist is null or (s.dist, s.id) > (p_after_dist, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
           when 'top' then p_after_score is null or (s.score, s.id) < (p_after_score, coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
           else p_after_ts is null or (s.created_at, s.id) < (p_after_ts, coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)) end
   order by case when p_sort = 'near' then s.dist end asc,
            case when p_sort = 'near' then s.id end asc,
            case when p_sort = 'top' then s.score end desc,
            case when p_sort = 'top' then s.id end desc,
            s.created_at desc, s.id desc
   limit least(greatest(coalesce(p_limit, 12), 1), 12) $$;

-- ---------- карта: период и "друзья" фильтруются ДО лимита (раньше — после 500 строк, редкая категория пропадала) ----------
create or replace function public.map_posts2(p_w double precision, p_s double precision, p_e double precision, p_n double precision,
  p_cats text[] default null, p_lat double precision default null, p_lng double precision default null, p_radius int default null,
  p_period text default null, p_friends boolean default false, p_limit int default 300)
returns setof public.posts language sql stable set search_path = public, extensions as $$
  select p.* from public.posts p
   where p.status in ('active','closed')
     and (p.expires_at is null or p.expires_at > now())
     and case when p_radius is not null and p_lat is not null
           then extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
                                      least(greatest(p_radius, 100), 50000))
           else p.geog operator(extensions.&&) extensions.st_makeenvelope(p_w, p_s, p_e, p_n, 4326)::extensions.geography end
     and (p_cats is null or p.category = any (p_cats))
     and (p_period is null or (p_period = 'today' and p.created_at > date_trunc('day', now() at time zone 'Asia/Almaty') at time zone 'Asia/Almaty')
                           or (p_period = 'week' and p.created_at > now() - interval '7 days'))
     and (not coalesce(p_friends, false) or public.are_friends(auth.uid(), p.user_id))
     and not public.is_blocked(auth.uid(), p.user_id)
   order by p.created_at desc, p.id desc
   limit least(greatest(coalesce(p_limit, 300), 1), 500) $$;

-- ---------- избранные места: блокировка по автору, 5 мест даже при параллельных вставках ----------
create or replace function public.places_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('near-places:' || new.user_id::text, 0));
    if (select count(*) from public.saved_places where user_id = new.user_id) >= 5 then
      raise exception using errcode = 'NR422', message = 'Не больше 5 избранных мест';
    end if;
  end if;
  new.lat := round(new.lat::numeric, 3); new.lng := round(new.lng::numeric, 3);
  return new;
end $$;

-- ---------- медиа: без серверной проверки публикация файлов закрыта ----------
-- Решение ТЗ v14.4: "Включить серверную проверку; без нее публикация медиа недоступна".
-- media_requires_check = true (по умолчанию): файл принимается, только если включена ИИ-проверка (ai_moderation).
alter table public.app_settings add column if not exists media_requires_check boolean not null default true;
create or replace function public.media_gate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_mod()
     and (select media_requires_check and not ai_moderation from public.app_settings where id = 1) then
    raise exception using errcode = 'NR503', message = 'Фото и видео временно недоступны: на сервере не включена проверка файлов. Опубликуйте текст без файлов', hint = 'media_check_off';
  end if;
  return new;
end $$;
drop trigger if exists post_media_gate on public.post_media;
create trigger post_media_gate before insert on public.post_media for each row execute function public.media_gate();

-- =====================================================
--  04 / Никнейм вместо имени, фамилии и пола; возрастной допуск — приватно
-- =====================================================
alter table public.profiles add column if not exists nickname text;
alter table public.profiles add column if not exists nickname_norm text;
alter table public.profiles add column if not exists nickname_changed_at timestamptz;
create unique index if not exists profiles_nickname_norm_uidx on public.profiles (nickname_norm) where nickname_norm is not null;
-- пол больше не обязателен и не принимается (колонка удаляется в 014b после перехода всех клиентов)
alter table public.profiles drop constraint if exists profiles_gender_chk;

-- приватные данные аккаунта: видит только сам пользователь (через my_account) и администратор
create table if not exists public.profile_private (
  user_id           uuid primary key references public.profiles(id) on delete cascade,
  age_status        text not null default 'unknown' check (age_status in ('unknown','adult','minor')),
  age_checked_at    timestamptz,
  age_checked_by    uuid references public.profiles(id) on delete set null,
  phone_verified_at timestamptz,
  updated_at        timestamptz not null default now()
);
alter table public.profile_private enable row level security;
drop policy if exists "private admin" on public.profile_private;
create policy "private admin" on public.profile_private for select using (public.is_admin());

-- история никнеймов: только модераторы
create table if not exists public.nickname_history (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  old_nick    text,
  new_nick    text not null,
  changed_at  timestamptz not null default now()
);
create index if not exists nickname_history_user_idx on public.nickname_history (user_id, changed_at desc);
alter table public.nickname_history enable row level security;
drop policy if exists "nick history mod" on public.nickname_history;
create policy "nick history mod" on public.nickname_history for select using (public.is_mod());

alter table public.app_settings add column if not exists age_gate boolean not null default true;
alter table public.app_settings add column if not exists clean_version text not null default 'clean-1';
update public.app_settings set clean_version = 'clean-1' where id = 1;

-- нормализация для уникальности: регистр, NFKC, похожие кириллические и латинские буквы — одна форма
create or replace function public.nick_norm(t text) returns text language sql immutable as $$
  select translate(lower(translate(normalize(t, NFKC), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯӘҒҚҢӨҰҮҺІ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһі')),
                   'аеёорсухкмтнві', 'aeeopcyxkmthbi') $$;

-- проверка никнейма: пустая строка — можно, иначе текст ошибки
create or replace function public.nick_problem(t text) returns text language plpgsql immutable as $$
declare n text := coalesce(t, ''); l text := lower(translate(coalesce(t, ''), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'));
begin
  if char_length(n) < 3 or char_length(n) > 20 then return 'Никнейм: от 3 до 20 символов'; end if;
  if n !~ '^[A-Za-z0-9_А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]+$' then return 'Никнейм: только буквы, цифры и _ (без пробелов и ссылок)'; end if;
  if n !~ '[A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]' then return 'В никнейме нужна хотя бы одна буква'; end if;
  if n ~ '[A-Za-z]' and n ~ '[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]' then return 'Никнейм: используйте одну раскладку — только латиницу или только кириллицу'; end if;
  if public.near_has_bad(n) or public.near_has_bad(regexp_replace(n, '[_0-9]+', ' ', 'g')) then return 'Никнейм содержит недопустимые слова. Выберите другой'; end if;
  if l ~ '(near|admin|moder|support|official|offical|akimat|police|mvd|админ|модер|поддержк|официал|акимат|полици|мвд)' or l ~ '^(112|101|102|103|104)'
     or public.nick_norm(n) ~ '(near|admin|moder|support|official|akimat|police)' then
    return 'Такой никнейм похож на официальный аккаунт. Выберите другой';
  end if;
  return '';
end $$;

create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() пустой у сервера (регистрация, SQL Editor, сервисные функции)
  if auth.uid() is null or public.is_admin() or coalesce(current_setting('near.system', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    new.is_admin := false; new.is_moderator := false; new.banned := false; new.verified := false;
    new.nickname := null; new.nickname_norm := null; new.name := 'Новый пользователь';
    return new;
  end if;
  new.is_admin := old.is_admin;
  new.is_moderator := old.is_moderator;
  new.banned := old.banned;
  new.verified := old.verified;
  new.id := old.id;
  new.created_at := old.created_at;
  -- имя на экране = никнейм; меняется только через set_nickname (проверки и лимит 30 дней)
  new.name := old.name; new.nickname := old.nickname; new.nickname_norm := old.nickname_norm; new.nickname_changed_at := old.nickname_changed_at;
  if new.show_seen = false then new.last_seen_at := null; end if;
  return new;
end $$;

-- установка и смена никнейма
create or replace function public.set_nickname(p_nick text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); p record; prob text; nn text; nick text := btrim(coalesce(p_nick, '')); wait int;
begin
  if me is null then raise exception using errcode = 'NR403', message = 'Войдите, чтобы выбрать никнейм'; end if;
  prob := public.nick_problem(nick);
  if prob <> '' then raise exception using errcode = 'NR422', message = prob, hint = 'nickname'; end if;
  nn := public.nick_norm(nick);
  select * into p from public.profiles where id = me for update;
  if p.id is null then raise exception using errcode = 'NR404', message = 'Профиль не найден'; end if;
  if p.nickname is not null and p.nickname_norm <> nn and p.nickname_changed_at > now() - interval '30 days' and not public.is_admin() then
    wait := ceil(extract(epoch from p.nickname_changed_at + interval '30 days' - now()) / 86400);
    raise exception using errcode = 'NR429', message = format('Никнейм можно менять раз в 30 дней. Следующая смена через %s дн.', wait), hint = 'retry_after=' || (wait * 86400);
  end if;
  if exists (select 1 from public.profiles where nickname_norm = nn and id <> me) then
    raise exception using errcode = 'NR409', message = 'Этот никнейм уже занят. Попробуйте другой', hint = 'nickname_taken';
  end if;
  perform set_config('near.system', '1', true);
  -- вместе с никнеймом стираются старые имя/фамилия и пол
  update public.profiles set nickname = nick, nickname_norm = nn, name = nick,
         nickname_changed_at = case when p.nickname_norm is distinct from nn then now() else p.nickname_changed_at end, updated_at = now()
   where id = me;
  begin execute 'update public.profiles set gender = null where id = $1' using me; exception when undefined_column then null; end;
  perform set_config('near.system', '', true);
  if p.nickname is distinct from nick then insert into public.nickname_history (user_id, old_nick, new_nick) values (me, p.nickname, nick); end if;
  return jsonb_build_object('nickname', nick);
exception when unique_violation then
  raise exception using errcode = 'NR409', message = 'Этот никнейм уже занят. Попробуйте другой', hint = 'nickname_taken';
end $$;

-- свободен ли никнейм (для подсказки в форме; окончательно проверяет set_nickname)
create or replace function public.nickname_check(p_nick text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare prob text := public.nick_problem(btrim(coalesce(p_nick, '')));
begin
  if prob <> '' then return jsonb_build_object('ok', false, 'error', prob); end if;
  if exists (select 1 from public.profiles where nickname_norm = public.nick_norm(btrim(p_nick)) and id is distinct from auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'Этот никнейм уже занят');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- регистрация: имя, фамилия и пол из метаданных (в том числе Google) больше не переносятся
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare nick text := btrim(coalesce(new.raw_user_meta_data->>'nickname', ''));
begin
  insert into public.profiles (id, district, name)
  values (new.id, nullif(new.raw_user_meta_data->>'district', ''), 'Новый пользователь')
  on conflict (id) do nothing;
  begin
    update public.profiles set verified = (new.email_confirmed_at is not null or coalesce(new.raw_app_meta_data->>'provider', '') = 'google') where id = new.id;
    if new.raw_user_meta_data->>'accepted_rules' = 'true' then update public.profiles set accepted_rules_at = now() where id = new.id; end if;
    -- никнейм из формы регистрации: если подходит и свободен; иначе приложение попросит выбрать после входа
    if nick <> '' and public.nick_problem(nick) = '' and not exists (select 1 from public.profiles where nickname_norm = public.nick_norm(nick)) then
      update public.profiles set nickname = nick, nickname_norm = public.nick_norm(nick), name = nick, nickname_changed_at = now() where id = new.id;
    end if;
  exception when undefined_column or unique_violation then null;
  end;
  insert into public.profile_private (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create or replace function public.ensure_profile() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  insert into public.profiles (id, name) select u.id, 'Новый пользователь' from auth.users u where u.id = auth.uid() on conflict (id) do nothing;
  insert into public.profile_private (user_id) select auth.uid() where exists (select 1 from public.profiles where id = auth.uid()) on conflict do nothing;
end $$;

-- публиковать и писать можно с никнеймом и согласием с правилами (пол больше не нужен)
create or replace function public.profile_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and exists (select 1 from public.profiles where id = auth.uid() and (nickname is null or accepted_rules_at is null)) then
    raise exception using errcode = 'NR403', message = 'Заполните профиль: никнейм и согласие с правилами', hint = 'profile_incomplete';
  end if;
  return new;
end $$;

-- возрастной допуск: по умолчанию неизвестен; рискованные функции (личные чаты с незнакомыми, встречи) — только "adult"
create or replace function public.age_ok(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not coalesce((select age_gate from public.app_settings where id = 1), true)
      or exists (select 1 from public.profile_private where user_id = u and age_status = 'adult') $$;

create or replace function public.my_account() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'age_status', coalesce(pp.age_status, 'unknown'),
    'age_ok', public.age_ok(auth.uid()),
    'phone_verified', pp.phone_verified_at is not null,
    'nickname_next_change', case when p.nickname_changed_at > now() - interval '30 days' then p.nickname_changed_at + interval '30 days' end,
    'clean_version', (select clean_version from public.app_settings where id = 1),
    'media_ok', (select not media_requires_check or ai_moderation from public.app_settings where id = 1))
  end
  from public.profiles p left join public.profile_private pp on pp.user_id = p.id where p.id = auth.uid() $$;

-- администратор отмечает проверку возраста или телефона (документы NEAR не хранит)
create or replace function public.admin_set_private(p_user uuid, p_age text default null, p_phone boolean default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception using errcode = 'NR403', message = 'Только для администратора'; end if;
  if p_age is not null and p_age not in ('unknown','adult','minor') then raise exception using errcode = 'NR422', message = 'Неверный статус возраста'; end if;
  insert into public.profile_private (user_id) values (p_user) on conflict do nothing;
  update public.profile_private set
    age_status = coalesce(p_age, age_status),
    age_checked_at = case when p_age is not null then now() else age_checked_at end,
    age_checked_by = case when p_age is not null then auth.uid() else age_checked_by end,
    phone_verified_at = case when p_phone is null then phone_verified_at when p_phone then coalesce(phone_verified_at, now()) else null end,
    updated_at = now()
   where user_id = p_user;
  insert into public.mod_actions (moderator_id, target_type, target_id, action, note)
  values (auth.uid(), 'user', p_user, 'set_private', concat_ws(' ', 'age=' || p_age, 'phone=' || p_phone::text));
end $$;
insert into public.profile_private (user_id) select id from public.profiles on conflict do nothing;

-- личная переписка с незнакомым — только при возрастном допуске обеих сторон; новые запросы — в дневном лимите
create or replace function public.get_or_create_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid; b uuid; cid uuid; fr boolean;
begin
  if me is null then raise exception using errcode = 'NR403', message = 'Войдите, чтобы написать'; end if;
  if other is null or other = me then raise exception using errcode = 'NR422', message = 'Нельзя написать самому себе'; end if;
  if not exists (select 1 from public.profiles where id = other) then raise exception using errcode = 'NR404', message = 'Пользователь не найден'; end if;
  if public.is_blocked(me, other) then raise exception using errcode = 'NR403', message = 'Пользователь недоступен'; end if;
  if public.is_banned() then raise exception using errcode = 'NR403', message = 'Аккаунт заблокирован модератором'; end if;
  a := least(me, other); b := greatest(me, other);
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is null then
    fr := public.are_friends(me, other);
    if not fr and not (public.age_ok(me) and public.age_ok(other)) then
      raise exception using errcode = 'NR403', message = 'Личные сообщения незнакомым пока недоступны. Добавьте человека в друзья — после принятия заявки можно писать', hint = 'age_gate';
    end if;
    if not fr then perform public.rate_take('chat_request', null); end if;
    insert into public.conversations (user_a, user_b, status, initiator)
    values (a, b, case when fr then 'accepted' else 'request' end, me)
    returning id into cid;
  end if;
  return cid;
end $$;

-- =====================================================
--  08 / Anti-Spam: дневные лимиты (атомарные счетчики), 429 + retry_after, повторы без двойного списания, дубликаты
-- =====================================================
-- лимиты на сутки (по времени Алматы): [новый аккаунт, телефон подтвержден]; часовые лимиты v11 (rate) остаются как burst
alter table public.app_settings add column if not exists day_limits jsonb not null default '{
  "post":         [3, 15],
  "comment":      [20, 100],
  "chat_request": [3, 10],
  "meeting":      [0, 3]
}'::jsonb;

create table if not exists public.rate_counters (
  user_id  uuid not null,
  action   text not null,
  day      date not null,
  n        int  not null default 0,
  primary key (user_id, action, day)
);
alter table public.rate_counters enable row level security;
create table if not exists public.rate_idem (
  user_id    uuid not null,
  action     text not null,
  key        text not null check (char_length(key) between 8 and 64),
  created_at timestamptz not null default now(),
  primary key (user_id, action, key)
);
alter table public.rate_idem enable row level security;

create or replace function public.ru_plural(n int, a text, b text, c text) returns text language sql immutable as $$
  select n || ' ' || case when n % 10 = 1 and n % 100 <> 11 then a when n % 10 between 2 and 4 and (n % 100 < 10 or n % 100 >= 20) then b else c end $$;

-- списать одно действие из дневного лимита. Ключ идемпотентности: повтор того же запроса не списывает дважды.
-- Атомарно: insert ... on conflict do update ... where n < лимит — параллельные запросы не проходят сверх лимита.
create or replace function public.rate_take(p_action text, p_key text default null) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); l jsonb; lim int; d date := (now() at time zone 'Asia/Almaty')::date; got int; secs int; ok boolean;
begin
  if uid is null or public.is_mod() then return; end if;
  select day_limits->p_action into l from public.app_settings where id = 1;
  if l is null then return; end if;
  lim := (l->>(case when exists (select 1 from public.profile_private where user_id = uid and phone_verified_at is not null) then 1 else 0 end))::int;
  if p_key is not null then
    insert into public.rate_idem (user_id, action, key) values (uid, p_action, left(p_key, 64)) on conflict do nothing returning true into ok;
    if ok is null then return; end if; -- уже списано этим ключом
  end if;
  insert into public.rate_counters as rc (user_id, action, day, n) values (uid, p_action, d, 1)
  on conflict (user_id, action, day) do update set n = rc.n + 1 where rc.n < lim
  returning n into got;
  if got is null or got > lim then
    secs := greatest(60, ceil(extract(epoch from ((d + 1)::timestamp at time zone 'Asia/Almaty') - now())));
    raise exception using errcode = 'NR429',
      message = format('Лимит на сегодня исчерпан: %s. Снова можно через %s',
        case p_action when 'post' then public.ru_plural(lim, 'публикация', 'публикации', 'публикаций')
          when 'comment' then public.ru_plural(lim, 'комментарий', 'комментария', 'комментариев')
          when 'chat_request' then public.ru_plural(lim, 'новый запрос в чат', 'новых запроса в чат', 'новых запросов в чат')
          when 'meeting' then public.ru_plural(lim, 'встреча', 'встречи', 'встреч') else public.ru_plural(lim, 'действие', 'действия', 'действий') end,
        case when secs >= 3600 then (secs / 3600) || ' ч ' || ((secs % 3600) / 60) || ' мин' else ceil(secs / 60.0) || ' мин' end),
      hint = 'retry_after=' || secs || ';action=' || p_action;
  end if;
end $$;

-- ключ текста для поиска дублей: регистр, пробелы и знаки не важны
create or replace function public.text_key(t text) returns text language sql immutable as $$
  select md5(regexp_replace(lower(translate(coalesce(t, ''), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеежзийклмнопрстуфхцчшщъыьэюя')), '[^a-zа-яәғқңөұүһі0-9]+', '', 'g')) $$;

alter table public.comments add column if not exists client_key text;
create unique index if not exists comments_client_key_uidx on public.comments (user_id, client_key) where client_key is not null;

create or replace function public.rate_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'posts' then
    perform public.rate('post'); perform public.rate('post_day');
    if new.is_sos then perform public.rate('sos');
    else
      -- одинаковый текст от одного автора за сутки — повтор, а не новая публикация
      if auth.uid() is not null and char_length(coalesce(new.text, '')) >= 10 and exists (
           select 1 from public.posts where user_id = new.user_id and created_at > now() - interval '24 hours'
              and status in ('draft','active','closed','hidden') and client_key is distinct from new.client_key
              and public.text_key(text) = public.text_key(new.text)) then
        raise exception using errcode = 'NR409', message = 'Вы уже публиковали такой же текст сегодня', hint = 'duplicate';
      end if;
      perform public.rate_take('post', new.client_key);
    end if;
  elsif tg_table_name = 'comments' then
    perform public.rate('comment');
    if auth.uid() is not null and char_length(coalesce(new.text, '')) >= 10 and exists (
         select 1 from public.comments where user_id = new.user_id and created_at > now() - interval '10 minutes' and public.text_key(text) = public.text_key(new.text)) then
      raise exception using errcode = 'NR409', message = 'Такой же комментарий вы уже отправляли. Напишите по-другому', hint = 'duplicate';
    end if;
    perform public.rate_take('comment', new.client_key);
  elsif tg_table_name = 'messages' then perform public.rate('message');
  elsif tg_table_name = 'reports' then perform public.rate('report');
  elsif tg_table_name = 'friendships' then perform public.rate('friend');
  elsif tg_table_name = 'likes' then perform public.rate('like');
  end if;
  return new;
end $$;

-- медиа в переписке: те же условия, что в публикациях (фото и видео — только при включенной проверке)
create or replace function public.message_media_gate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('image','video') and auth.uid() is not null and not public.is_mod()
     and (select media_requires_check and not ai_moderation from public.app_settings where id = 1) then
    raise exception using errcode = 'NR503', message = 'Фото и видео временно недоступны: на сервере не включена проверка файлов', hint = 'media_check_off';
  end if;
  return new;
end $$;
drop trigger if exists messages_media_gate on public.messages;
create trigger messages_media_gate before insert on public.messages for each row execute function public.message_media_gate();

-- уборка: старые счетчики и ключи
create or replace function public.near_cleanup() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int;
begin
  delete from public.rate_events where created_at < now() - interval '2 days';
  delete from public.rate_counters where day < (now() at time zone 'Asia/Almaty')::date - 2;
  delete from public.rate_idem where created_at < now() - interval '3 days';
  delete from public.client_errors where created_at < now() - interval '30 days'; get diagnostics a = row_count;
  delete from public.analytics_events where created_at < now() - interval '180 days'; get diagnostics b = row_count;
  delete from public.push_log where created_at < now() - interval '90 days';
  select count(*) into c from public.posts where status = 'draft' and created_at < now() - interval '24 hours';
  select count(*) into d from public.conversations where orphaned_at < now() - interval '30 days';
  perform public.call_fn('moderate', jsonb_build_object('kind', 'cleanup'));
  return jsonb_build_object('errors_removed', a, 'events_removed', b, 'stale_drafts', c, 'orphaned_conversations', d);
end $$;

-- =====================================================
--  Права v14: новые функции и таблицы (общий revoke v12 остается в силе)
-- =====================================================
revoke all on public.profile_private, public.nickname_history, public.rate_counters, public.rate_idem from anon, authenticated;
grant select on public.nickname_history to authenticated; -- RLS: только модераторы
-- профиль: пользователь меняет только эти поля; имя/никнейм — через set_nickname, роли и пол — никогда
revoke update on public.profiles from authenticated;
grant update (avatar_url, district, instagram, bio, show_seen, accepted_rules_at, updated_at) on public.profiles to authenticated;
revoke execute on function public.feed_sorted(double precision, double precision, int, text[], text, text, boolean, timestamptz, double precision, uuid, int, int, double precision, timestamptz) from public;
grant execute on function public.feed_sorted(double precision, double precision, int, text[], text, text, boolean, timestamptz, double precision, uuid, int, int, double precision, timestamptz),
  public.nickname_check(text), public.age_ok(uuid)
  to anon, authenticated;
grant execute on function public.set_nickname(text), public.my_account(), public.admin_set_private(uuid, text, boolean) to authenticated;
-- чистые функции NEAR Clean: можно вызывать для предпросмотра
grant execute on function public.near_clean(text), public.near_has_bad(text), public.near_is_threat(text), public.near_clean_x(text),
  public.nc_bad_token(text), public.nc_translit(text), public.nc_is_w(int), public.nc_is_sep(int), public.nc_is_zw(int), public.nc_is_mark(int),
  public.nick_norm(text), public.nick_problem(text), public.text_key(text), public.ru_plural(int, text, text, text)
  to anon, authenticated;
-- служебные — только сервер
revoke execute on function public.rate_take(text, text), public.media_gate(), public.message_media_gate(), public.mask_bio_trigger(),
  public.handle_new_user(), public.protect_profile(), public.profile_guard()
  from public, anon, authenticated;

-- Готово ✅ v14 (этап 1)
