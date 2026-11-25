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


-- =====================================================================
-- NEAR v14.8 (ТЗ v14.8): общие чаты и встречи вместо личных сообщений и друзей.
-- Часть A: отключение личных сообщений и дружбы, вход по нику, состояния аккаунта.
-- Скрипт идемпотентный. Перед запуском — резервная копия (SETUP.md, шаг 19).
-- =====================================================================

-- ---------- 12: личные диалоги и друзья — контролируемый отказ ----------
alter table public.app_settings add column if not exists legacy_dm_closed_at timestamptz;
update public.app_settings set legacy_dm_closed_at = coalesce(legacy_dm_closed_at, now()) where id = 1;

create or replace function public.legacy_dm_refuse() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- сервер (service role, миграции) может чистить старые данные; пользователи ничего не создают
  if auth.uid() is null then return coalesce(new, old); end if;
  raise exception using errcode = 'NR410',
    message = 'Личные сообщения и друзья больше не поддерживаются. Общайтесь в общих чатах и встречах', hint = 'legacy_dm';
end $$;
drop trigger if exists legacy_dm_conv on public.conversations;
create trigger legacy_dm_conv before insert or update on public.conversations for each row execute function public.legacy_dm_refuse();
drop trigger if exists legacy_dm_msg on public.messages;
create trigger legacy_dm_msg before insert or update on public.messages for each row execute function public.legacy_dm_refuse();
drop trigger if exists legacy_dm_friend on public.friendships;
create trigger legacy_dm_friend before insert or update on public.friendships for each row execute function public.legacy_dm_refuse();

create or replace function public.get_or_create_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  raise exception using errcode = 'NR410',
    message = 'Личные сообщения больше не поддерживаются. Общайтесь в общих чатах и встречах', hint = 'legacy_dm';
end $$;
create or replace function public.conversation_respond(conv uuid, accept boolean) returns text
language plpgsql security definer set search_path = public as $$
begin
  raise exception using errcode = 'NR410', message = 'Личные сообщения больше не поддерживаются', hint = 'legacy_dm';
end $$;
-- старые данные: не читаются клиентом, не превращаются в публичные; удаление — по утвержденной политике хранения
revoke all on public.conversations, public.messages, public.friendships from anon, authenticated;
do $$ begin alter publication supabase_realtime drop table public.messages; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime drop table public.conversations; exception when others then null; end $$;
-- друзья больше ничего не открывают (в том числе обход возрастного допуска)
create or replace function public.are_friends(a uuid, b uuid) returns boolean language sql stable as $$ select false $$;

-- ---------- 03: вход по нику без раскрытия email ----------
-- Вызывается только Edge Function login (service role). Пользователь email чужого ника не получает никогда.
create or replace function public.login_email(p_login text) returns text
language sql stable security definer set search_path = public, auth as $$
  select u.email from auth.users u join public.profiles p on p.id = u.id
   where p.nickname_norm = public.nick_norm(btrim(p_login)) and u.deleted_at is null limit 1 $$;
revoke all on function public.login_email(text) from public, anon, authenticated;
do $$ begin grant execute on function public.login_email(text) to service_role; exception when undefined_object then null; end $$;

-- журнал попыток входа: ограничение частоты по нику и по IP (хэш), без паролей
create table if not exists public.login_attempts (
  id         bigserial primary key,
  login_key  text not null,
  ip_hash    text,
  ok         boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_key_idx on public.login_attempts (login_key, created_at desc);
create index if not exists login_attempts_ip_idx on public.login_attempts (ip_hash, created_at desc);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;

create or replace function public.login_gate(p_login text, p_ip text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text := public.nick_norm(lower(btrim(p_login))); n_key int; n_ip int;
begin
  select count(*) into n_key from public.login_attempts where login_key = k and not ok and created_at > now() - interval '15 minutes';
  select count(*) into n_ip from public.login_attempts where ip_hash = p_ip and not ok and created_at > now() - interval '15 minutes';
  if n_key >= 5 or n_ip >= 20 then
    return jsonb_build_object('ok', false, 'retry_after', 900);
  end if;
  return jsonb_build_object('ok', true);
end $$;
create or replace function public.login_note(p_login text, p_ip text, p_ok boolean) returns void
language sql security definer set search_path = public as $$
  insert into public.login_attempts (login_key, ip_hash, ok) values (public.nick_norm(lower(btrim(p_login))), p_ip, p_ok);
  delete from public.login_attempts where created_at < now() - interval '2 days' and random() < 0.05 $$;
revoke all on function public.login_gate(text, text), public.login_note(text, text, boolean) from public, anon, authenticated;
do $$ begin
  grant execute on function public.login_gate(text, text), public.login_note(text, text, boolean) to service_role;
exception when undefined_object then null; end $$;

-- ---------- 03: допуск к встречам — отдельно от возраста для чатов ----------
alter table public.app_settings add column if not exists meet_age_gate boolean not null default true;
create or replace function public.meet_ok(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not coalesce((select meet_age_gate from public.app_settings where id = 1), true)
      or exists (select 1 from public.profile_private where user_id = u and age_status = 'adult') $$;

-- =====================================================================
-- Часть B (разделы 08, 09, 12): единая модель комнат — город, районы, темы, встречи.
-- rooms / room_members / room_messages / room_mentions / outbox. Без личных диалогов.
-- =====================================================================

create table if not exists public.rooms (
  id              uuid primary key default gen_random_uuid(),
  type            text not null check (type in ('city','district','topic','meeting')),
  scope_id        text,                    -- 'almaty', название района, тема или id встречи
  title           text not null check (char_length(title) between 2 and 80),
  about           text check (about is null or char_length(about) <= 300),
  rules           text check (rules is null or char_length(rules) <= 1000),
  pinned          text check (pinned is null or char_length(pinned) <= 300),
  status          text not null default 'active' check (status in ('active','readonly','archived','closed')),
  is_public       boolean not null default true,
  slow_mode_sec   int not null default 0 check (slow_mode_sec between 0 and 600),
  meeting_id      uuid unique,             -- UNIQUE(meeting_id): одна комната на встречу
  last_message_at timestamptz,
  members_count   int not null default 0,
  created_at      timestamptz not null default now(),
  unique (type, scope_id)
);
create index if not exists rooms_type_idx on public.rooms (type, status, last_message_at desc nulls last);

create table if not exists public.room_members (
  room_id       uuid not null references public.rooms(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  role          text not null default 'member' check (role in ('host','cohost','moderator','member')),
  status        text not null default 'active' check (status in ('active','left','removed')),
  muted_until   timestamptz,
  notify        text not null default 'mentions' check (notify in ('all','mentions','silent','off')),
  last_read_at  timestamptz not null default now(),
  active_until  timestamptz,               -- приложение открыто в этой комнате: push не дублируется
  joined_at     timestamptz not null default now(),
  primary key (room_id, user_id)           -- UNIQUE(room_id, user_id)
);
create index if not exists room_members_room_status_idx on public.room_members (room_id, status);
create index if not exists room_members_user_idx on public.room_members (user_id, status);

create table if not exists public.room_messages (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  sender_id   uuid references public.profiles(id) on delete set null,   -- null = системный автор
  kind        text not null default 'text' check (kind in ('text','system','action','checkin')),
  body_masked text not null check (char_length(body_masked) between 1 and 1000),
  client_id   text,
  reply_to    uuid references public.room_messages(id) on delete set null,
  meta        jsonb not null default '{}'::jsonb,
  status      text not null default 'ok' check (status in ('ok','hidden','deleted')),
  created_at  timestamptz not null default now(),
  unique (room_id, sender_id, client_id)   -- повтор отправки не создает дубль
);
create index if not exists room_messages_room_idx on public.room_messages (room_id, created_at desc, id desc);
create index if not exists room_messages_sender_idx on public.room_messages (sender_id, created_at desc);

create table if not exists public.room_mentions (
  message_id uuid not null references public.room_messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  primary key (message_id, user_id)
);
create index if not exists room_mentions_user_idx on public.room_mentions (user_id);

-- outbox: уведомления и напоминания с повтором и дедупликацией
create table if not exists public.outbox (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null,
  dedup_key   text not null unique,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  attempts    int not null default 0,
  next_retry  timestamptz not null default now(),
  last_error  text,
  created_at  timestamptz not null default now()
);
create index if not exists outbox_status_idx on public.outbox (status, next_retry);
alter table public.outbox enable row level security;
revoke all on public.outbox from anon, authenticated;

-- уведомления знают комнату и ссылку (deep link проверяет доступ при открытии)
alter table public.notifications add column if not exists room_id uuid references public.rooms(id) on delete cascade;
alter table public.notifications add column if not exists link text;

-- настройка push: все / упоминания и важное / без звука / отключить
alter table public.profiles add column if not exists notify_level text not null default 'important'
  check (notify_level in ('all','important','silent','off'));

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_messages enable row level security;
alter table public.room_mentions enable row level security;

create or replace function public.room_role(r uuid, u uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.room_members where room_id = r and user_id = u and status = 'active' $$;
create or replace function public.room_can_read(r uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.rooms x where x.id = r and x.status <> 'closed'
                   and ((x.is_public and x.type <> 'meeting') or public.room_role(r, auth.uid()) is not null))
      or public.is_mod() $$;

drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms for select using ((is_public and type <> 'meeting') or public.room_role(id, auth.uid()) is not null or public.is_mod());
drop policy if exists room_members_read on public.room_members;
-- состав видят участники комнаты; GPS, телефон и email в комнатах не хранятся
create policy room_members_read on public.room_members for select using (user_id = auth.uid() or public.room_role(room_id, auth.uid()) is not null or public.is_mod());
drop policy if exists room_messages_read on public.room_messages;
-- чтение: публичная комната (гость тоже) или участник; сообщения заблокированных скрыты; при кике доступ к истории сразу закрывается
create policy room_messages_read on public.room_messages for select using (
  public.room_can_read(room_id)
  and (status = 'ok' or public.is_mod() or (sender_id = auth.uid() and status <> 'deleted'))
  and (sender_id is null or auth.uid() is null or not exists (select 1 from public.blocks b where b.blocker_id = auth.uid() and b.blocked_id = room_messages.sender_id)));
drop policy if exists room_mentions_read on public.room_mentions;
create policy room_mentions_read on public.room_mentions for select using (user_id = auth.uid());
-- запись только через RPC: клиент не меняет роль, счетчики, статус
revoke insert, update, delete on public.rooms, public.room_members, public.room_messages, public.room_mentions from anon, authenticated;
grant select on public.rooms, public.room_members, public.room_messages, public.room_mentions to anon, authenticated;
do $$ begin alter publication supabase_realtime add table public.room_messages; exception when others then null; end $$;

-- ---------- города, районы ----------
insert into public.rooms (type, scope_id, title, about, rules, pinned) values
  ('city', 'almaty', 'Алматы — общий чат', 'Городские вопросы', 'Уважайте соседей. Без рекламы, ссылок на сборы денег и личных данных. Мат скрывается, угрозы и скам удаляются.', 'Правила: уважение, без личных данных и сборов денег')
on conflict (type, scope_id) do nothing;
insert into public.rooms (type, scope_id, title, about, rules)
select 'district', d, d || ' район', 'Новости соседей', 'Только о районе. Уважайте соседей, без рекламы и личных данных.'
from unnest(array['Алатауский','Алмалинский','Ауэзовский','Бостандыкский','Жетысуский','Медеуский','Наурызбайский','Турксибский']) d
on conflict (type, scope_id) do nothing;

-- ---------- outbox ----------
create or replace function public.outbox_put(p_user uuid, p_kind text, p_key text, p_payload jsonb, p_at timestamptz default now()) returns void
language sql security definer set search_path = public as $$
  insert into public.outbox (user_id, kind, dedup_key, payload, next_retry) values (p_user, p_kind, p_key, p_payload, p_at)
  on conflict (dedup_key) do nothing $$;

-- обработка: due → уведомление в приложении (push уходит триггером уведомлений). Повтор с паузой, без дублей.
create or replace function public.outbox_process(p_limit int default 200) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record; sent int := 0; skipped int := 0; failed int := 0; lvl text; mem record;
begin
  for o in select * from public.outbox where status = 'pending' and next_retry <= now() order by next_retry limit p_limit for update skip locked loop
    begin
      select notify_level into lvl from public.profiles where id = o.user_id;
      -- комната: участник ушел/исключен — уведомление не нужно; активный чат — не дублировать
      if o.payload ? 'room_id' then
        select * into mem from public.room_members where room_id = (o.payload->>'room_id')::uuid and user_id = o.user_id;
        if mem.status is distinct from 'active' or (o.kind = 'message' and mem.active_until > now()) then
          update public.outbox set status = 'skipped' where id = o.id; skipped := skipped + 1; continue;
        end if;
      end if;
      if lvl = 'off' or (lvl in ('important','silent') and o.kind = 'message') then
        update public.outbox set status = 'skipped' where id = o.id; skipped := skipped + 1; continue;
      end if;
      insert into public.notifications (user_id, actor_id, type, text, room_id, link, post_id)
      values (o.user_id, nullif(o.payload->>'actor', '')::uuid, o.kind, left(o.payload->>'text', 300),
              nullif(o.payload->>'room_id', '')::uuid, o.payload->>'link', nullif(o.payload->>'post_id', '')::uuid);
      update public.outbox set status = 'sent', attempts = attempts + 1 where id = o.id; sent := sent + 1;
    exception when others then
      update public.outbox set attempts = attempts + 1, last_error = left(sqlerrm, 200),
        status = case when attempts + 1 >= 5 then 'failed' else 'pending' end,
        next_retry = now() + (interval '1 minute' * power(2, attempts)) where id = o.id;
      failed := failed + 1;
    end;
  end loop;
  return jsonb_build_object('sent', sent, 'skipped', skipped, 'failed', failed);
end $$;
revoke all on function public.outbox_process(int) from public, anon, authenticated;

-- ---------- вступить / выйти / настройки комнаты ----------
create or replace function public.join_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.rooms;
begin
  if auth.uid() is null then raise exception using errcode = 'NR401', message = 'Войдите, чтобы вступить'; end if;
  select * into r from public.rooms where id = p_room;
  if r.id is null or r.status = 'closed' then raise exception using errcode = 'NR404', message = 'Комната не найдена'; end if;
  if r.type = 'meeting' then raise exception using errcode = 'NR403', message = 'Чат встречи открывается после принятия заявки', hint = 'meeting_room'; end if;
  insert into public.room_members (room_id, user_id) values (p_room, auth.uid())
  on conflict (room_id, user_id) do update set status = 'active', joined_at = now() where room_members.status = 'left';
  update public.rooms set members_count = (select count(*) from public.room_members where room_id = p_room and status = 'active') where id = p_room;
end $$;

create or replace function public.leave_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.rooms where id = p_room and type = 'meeting') then
    raise exception using errcode = 'NR409', message = 'Чтобы выйти из чата встречи, отмените участие во встрече', hint = 'meeting_room';
  end if;
  update public.room_members set status = 'left' where room_id = p_room and user_id = auth.uid() and status = 'active';
  update public.rooms set members_count = (select count(*) from public.room_members where room_id = p_room and status = 'active') where id = p_room;
end $$;

create or replace function public.room_settings(p_room uuid, p_notify text default null, p_read boolean default false, p_active boolean default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.room_members set
    notify = coalesce(p_notify, notify),
    last_read_at = case when p_read then now() else last_read_at end,
    active_until = case when p_active is true then now() + interval '90 seconds' when p_active is false then null else active_until end
  where room_id = p_room and user_id = auth.uid() and status = 'active';
end $$;

-- список: Рядом (город + районы + темы), Встречи (мои встречи), Мои (все, где я участник); с непрочитанными
create or replace function public.rooms_list(p_tab text default 'near', p_q text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.ord, x.last desc nulls last), '[]'::jsonb) from (
    select r.id, r.type, r.title, r.about, r.pinned, r.status, r.meeting_id, r.members_count,
           r.last_message_at as last,
           m.status = 'active' as joined, m.role, m.notify,
           case when m.status = 'active' then (select count(*) from public.room_messages x where x.room_id = r.id and x.created_at > m.last_read_at and x.status = 'ok' and x.sender_id is distinct from auth.uid()) else 0 end as unread,
           (select left(x.body_masked, 80) from public.room_messages x where x.room_id = r.id and x.status = 'ok' order by x.created_at desc limit 1) as preview,
           case r.type when 'city' then 0 when 'district' then 1 when 'meeting' then 2 else 3 end as ord
      from public.rooms r
      left join public.room_members m on m.room_id = r.id and m.user_id = auth.uid()
     where r.status <> 'closed'
       and case p_tab
             when 'near' then r.type in ('city','district','topic') and r.is_public
             when 'meet' then r.type = 'meeting' and m.status = 'active'
             else m.status = 'active' end
       and (p_q is null or r.title ilike '%' || replace(replace(btrim(p_q), '%', ''), '_', '') || '%')
     limit 100) x $$;

-- ---------- отправка сообщения: маска, блок опасного, лимиты, slow mode, упоминания ----------
create or replace function public.send_message(p_room uuid, p_body text, p_client_id text, p_reply_to uuid default null,
                                               p_kind text default 'text', p_action text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); r public.rooms; m public.room_members; s public.user_sanctions; body text; why text;
        mid uuid; ts timestamptz; n10 int; n60 int; links int; trusted boolean; all_mention boolean := false;
        meet record; t text; target uuid; host uuid; v_meta jsonb := '{}'::jsonb;
begin
  if uid is null then raise exception using errcode = 'NR401', message = 'Войдите, чтобы писать'; end if;
  if p_client_id is null or char_length(p_client_id) > 64 then raise exception using errcode = 'NR422', message = 'Нет ключа отправки'; end if;
  -- повтор того же ключа — тот же результат (идемпотентность)
  select id, created_at into mid, ts from public.room_messages where room_id = p_room and sender_id = uid and client_id = p_client_id;
  if mid is not null then return jsonb_build_object('id', mid, 'created_at', ts, 'duplicate', true); end if;

  select * into r from public.rooms where id = p_room;
  if r.id is null or r.status = 'closed' then raise exception using errcode = 'NR404', message = 'Комната не найдена'; end if;
  select * into m from public.room_members where room_id = p_room and user_id = uid;
  if m.status is distinct from 'active' then
    raise exception using errcode = 'NR403', message = case when r.type = 'meeting' then 'Писать могут только участники встречи' else 'Вступите в комнату, чтобы писать' end, hint = 'not_member';
  end if;
  if exists (select 1 from public.profiles where id = uid and (nickname is null or accepted_rules_at is null)) then
    raise exception using errcode = 'NR403', message = 'Заполните профиль: никнейм и согласие с правилами', hint = 'profile_incomplete';
  end if;
  if not exists (select 1 from public.profiles where id = uid and verified) then
    raise exception using errcode = 'NR403', message = 'Подтвердите почту, чтобы писать', hint = 'pending_email';
  end if;
  s := public.active_sanction(uid, 'chat');
  if s.id is not null then
    raise exception using errcode = 'NR403', hint = 'restricted',
      message = 'Сообщения ограничены модератором' || case when s.until is null then '' else ' до ' || to_char(s.until at time zone 'Asia/Almaty', 'DD.MM HH24:MI') end || '. Причина: ' || s.reason;
  end if;
  if m.muted_until > now() then
    raise exception using errcode = 'NR403', hint = 'muted', message = 'Вам временно нельзя писать в этой комнате до ' || to_char(m.muted_until at time zone 'Asia/Almaty', 'DD.MM HH24:MI');
  end if;
  -- архив встречи: только чтение через 7 дней после окончания; отмененная встреча — только чтение
  if r.type = 'meeting' then
    select mt.* into meet from public.meetings mt where mt.id = r.meeting_id;
    if meet.status = 'cancelled' or meet.ends_at < now() - interval '7 days' or r.status <> 'active' then
      raise exception using errcode = 'NR403', message = 'Чат встречи в архиве: только чтение', hint = 'archived';
    end if;
  elsif r.status <> 'active' then
    raise exception using errcode = 'NR403', message = 'Комната только для чтения', hint = 'readonly';
  end if;

  body := btrim(coalesce(p_body, ''));
  if p_kind = 'action' then
    if p_action is null then raise exception using errcode = 'NR422', message = 'Неизвестное действие'; end if;
    v_meta := jsonb_build_object('action', left(p_action, 40));
  elsif p_kind <> 'text' then raise exception using errcode = 'NR422', message = 'Недопустимый тип сообщения';
  end if;
  if body = '' then raise exception using errcode = 'NR422', message = 'Пустое сообщение'; end if;
  if char_length(body) > 1000 then raise exception using errcode = 'NR422', message = 'Сообщение длиннее 1000 символов'; end if;
  why := public.near_block_reason(body);
  if why is not null then raise exception using errcode = 'NR422', message = public.near_block_message(why), hint = why; end if;

  -- частота: 5 за 10 секунд, 30 в минуту; slow mode комнаты
  if not public.is_mod() then
    select count(*) filter (where created_at > now() - interval '10 seconds'), count(*) into n10, n60
      from public.room_messages where sender_id = uid and created_at > now() - interval '1 minute';
    if n10 >= 5 or n60 >= 30 then
      raise exception using errcode = 'NR429', message = 'Слишком часто. Подождите немного', hint = 'retry_after=' || case when n10 >= 5 then 10 else 60 end || ';action=chat';
    end if;
    if r.slow_mode_sec > 0 and m.role not in ('host','cohost','moderator') and exists (
         select 1 from public.room_messages where room_id = p_room and sender_id = uid and created_at > now() - make_interval(secs => r.slow_mode_sec)) then
      raise exception using errcode = 'NR429', message = 'В комнате медленный режим: одно сообщение в ' || r.slow_mode_sec || ' с', hint = 'retry_after=' || r.slow_mode_sec || ';action=slow';
    end if;
    -- ссылки: только доверенным (телефон или 7 дней в NEAR), не больше 3 в час
    if body ~* '(https?://|www\.|[a-z0-9-]+\.(kz|ru|com|net|org|me|io|ly|link)\y)' then
      select exists (select 1 from public.profile_private where user_id = uid and phone_verified_at is not null)
          or exists (select 1 from public.profiles where id = uid and created_at < now() - interval '7 days') into trusted;
      if not trusted then raise exception using errcode = 'NR403', message = 'Ссылки можно отправлять через 7 дней после регистрации', hint = 'links'; end if;
      select count(*) into links from public.room_messages where sender_id = uid and created_at > now() - interval '1 hour' and (room_messages.meta->>'link')::boolean;
      if links >= 3 then raise exception using errcode = 'NR429', message = 'Не больше 3 ссылок в час', hint = 'retry_after=3600;action=links'; end if;
      v_meta := v_meta || '{"link":true}';
    end if;
  end if;

  -- @all: Host, co-host или модератор комнаты, не чаще 1 раза в 5 минут
  if body ~* '(^|\s)@all\y' then
    if m.role not in ('host','cohost','moderator') and not public.is_mod() then
      raise exception using errcode = 'NR403', message = '@all доступен только организатору и модераторам', hint = 'mention_all';
    end if;
    if exists (select 1 from public.room_messages where room_id = p_room and (room_messages.meta->>'all')::boolean and created_at > now() - interval '5 minutes') then
      raise exception using errcode = 'NR429', message = '@all можно использовать раз в 5 минут', hint = 'retry_after=300;action=mention_all';
    end if;
    all_mention := true; v_meta := v_meta || '{"all":true}';
  end if;
  if p_reply_to is not null and not exists (select 1 from public.room_messages where id = p_reply_to and room_id = p_room) then p_reply_to := null; end if;

  insert into public.room_messages (room_id, sender_id, kind, body_masked, client_id, reply_to, meta)
  values (p_room, uid, p_kind, public.near_clean(body), p_client_id, p_reply_to, v_meta)
  on conflict (room_id, sender_id, client_id) do nothing
  returning id, created_at into mid, ts;
  if mid is null then
    select id, created_at into mid, ts from public.room_messages where room_id = p_room and sender_id = uid and client_id = p_client_id;
    return jsonb_build_object('id', mid, 'created_at', ts, 'duplicate', true);
  end if;
  update public.rooms set last_message_at = ts where id = p_room;
  update public.room_members set last_read_at = ts where room_id = p_room and user_id = uid;

  -- упоминания по ID; заблокировавшие отправителя не получают прямых упоминаний
  if r.type = 'meeting' then select host_id into host from public.meetings where id = r.meeting_id; end if;
  for target in
    select distinct rm.user_id from public.room_members rm
      left join public.profiles p on p.id = rm.user_id
     where rm.room_id = p_room and rm.status = 'active' and rm.user_id <> uid
       and (all_mention
            or (host is not null and rm.user_id = host and body ~* '(^|\s)@host\y')
            or (p.nickname_norm is not null and public.nick_norm(body) ~ ('(^|[^[:alnum:]_])@' || p.nickname_norm || '($|[^[:alnum:]_])')))
       and not exists (select 1 from public.blocks b where b.blocker_id = rm.user_id and b.blocked_id = uid)
  loop
    insert into public.room_mentions (message_id, user_id) values (mid, target) on conflict do nothing;
    perform public.outbox_put(target, 'mention', 'mention:' || mid || ':' || target,
      jsonb_build_object('room_id', p_room, 'actor', uid, 'text', case when all_mention then 'Сообщение для всех в "' || r.title || '"' else 'Вас упомянули в "' || r.title || '"' end,
                         'link', '#room=' || p_room));
  end loop;
  -- сообщение для тех, кто включил "все" (кроме упомянутых и автора)
  if r.type = 'meeting' then
    insert into public.outbox (user_id, kind, dedup_key, payload)
    select rm.user_id, 'message', 'msg:' || mid || ':' || rm.user_id,
           jsonb_build_object('room_id', p_room, 'actor', uid, 'text', 'Новое сообщение в "' || r.title || '"', 'link', '#room=' || p_room)
      from public.room_members rm
     where rm.room_id = p_room and rm.status = 'active' and rm.user_id <> uid and rm.notify = 'all'
       and not exists (select 1 from public.room_mentions x where x.message_id = mid and x.user_id = rm.user_id)
    on conflict (dedup_key) do nothing;
  end if;
  return jsonb_build_object('id', mid, 'created_at', ts);
end $$;

-- системное сообщение (шаблон RU + ключ для перевода в приложении)
create or replace function public.room_system(p_room uuid, p_body text, p_meta jsonb default '{}'::jsonb, p_kind text default 'system') returns uuid
language sql security definer set search_path = public as $$
  with i as (insert into public.room_messages (room_id, sender_id, kind, body_masked, meta) values (p_room, null, p_kind, left(p_body, 1000), p_meta) returning id, created_at)
  , u as (update public.rooms set last_message_at = (select created_at from i) where id = p_room)
  select id from i $$;
revoke all on function public.room_system(uuid, text, jsonb, text) from public, anon, authenticated;

-- лента сообщений комнаты, по 40, курсором (created_at, id)
create or replace function public.room_feed(p_room uuid, p_before timestamptz default null, p_before_id uuid default null, p_limit int default 40) returns setof public.room_messages
language sql stable security invoker set search_path = public as $$
  select * from public.room_messages
   where room_id = p_room
     and (p_before is null or (created_at, id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
   order by created_at desc, id desc
   limit least(greatest(coalesce(p_limit, 40), 1), 50) $$;

-- модерация комнаты: скрыть сообщение, мут, медленный режим
create or replace function public.room_hide_message(p_msg uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid; role text := '';
begin
  select room_id into r from public.room_messages where id = p_msg;
  role := coalesce(public.room_role(r, auth.uid()), '');
  if not (public.is_mod() or role in ('host','cohost','moderator')) then raise exception using errcode = 'NR403', message = 'Нет прав'; end if;
  update public.room_messages set status = 'hidden', meta = meta || jsonb_build_object('hidden_by', auth.uid(), 'reason', left(p_reason, 200)) where id = p_msg;
end $$;

create or replace function public.set_mute(p_room uuid, p_user uuid, p_minutes int, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare my text := coalesce(public.room_role(p_room, auth.uid()), ''); their text := coalesce(public.room_role(p_room, p_user), ''); mt uuid;
begin
  if not (public.is_mod() or my in ('host','cohost','moderator')) then raise exception using errcode = 'NR403', message = 'Мутить может организатор или модератор'; end if;
  if their = '' then raise exception using errcode = 'NR404', message = 'Участник не найден'; end if;
  if their = 'host' or (their in ('cohost','moderator') and my not in ('host') and not public.is_mod()) then
    raise exception using errcode = 'NR403', message = 'Нельзя ограничить организатора';
  end if;
  if p_minutes is null or p_minutes < 0 or p_minutes > 10080 then raise exception using errcode = 'NR422', message = 'Срок от 0 до 7 дней'; end if;
  update public.room_members set muted_until = case when p_minutes = 0 then null else now() + make_interval(mins => p_minutes) end where room_id = p_room and user_id = p_user;
  select meeting_id into mt from public.rooms where id = p_room;
  if mt is not null then
    insert into public.meeting_audit (meeting_id, actor_id, action, target_id, reason) values (mt, auth.uid(), case when p_minutes = 0 then 'unmute' else 'mute' end, p_user, left(p_reason, 300));
  end if;
end $$;

create or replace function public.room_slow_mode(p_room uuid, p_sec int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_mod() or coalesce(public.room_role(p_room, auth.uid()), '') in ('host','cohost','moderator')) then raise exception using errcode = 'NR403', message = 'Нет прав'; end if;
  update public.rooms set slow_mode_sec = greatest(0, least(coalesce(p_sec, 0), 600)) where id = p_room;
end $$;

-- тематическая комната создается модератором по спросу
create or replace function public.mod_create_room(p_title text, p_about text, p_rules text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только модератор'; end if;
  insert into public.rooms (type, scope_id, title, about, rules) values ('topic', public.nick_norm(p_title), public.near_clean(btrim(p_title)), public.near_clean(p_about), public.near_clean(p_rules))
  on conflict (type, scope_id) do update set status = 'active' returning rooms.id into v_id;
  return v_id;
end $$;

-- жалоба на сообщение комнаты: в общую очередь модерации
alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check check (target_type in ('post','user','message','comment','room_message','meeting','review'));

-- =====================================================================
-- Часть C (разделы 07, 09, 12): встречи, заявки, Host, готовность, напоминания, посещение.
-- Встреча — это публикация категории meetup (лента и карта) + запись meetings + комната.
-- =====================================================================

create table if not exists public.meetings (
  id           uuid primary key references public.posts(id) on delete cascade,
  host_id      uuid references public.profiles(id) on delete set null,
  category     text not null check (category in ('games','cinema','board','sport','cafe','walk','mountains','study','other')),
  title        text not null check (char_length(title) between 5 and 80),
  details      jsonb not null default '{}'::jsonb,
  pin          text,
  place_name   text check (place_name is null or char_length(place_name) <= 120),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  capacity     int not null check (capacity between 3 and 50),          -- включая Host
  price_kzt    int check (price_kzt is null or price_kzt >= 0),         -- null = неизвестно
  rules        text check (rules is null or char_length(rules) <= 500),
  status       text not null default 'open' check (status in ('open','closed','cancelled','finished')),
  cancel_reason text,
  room_id      uuid references public.rooms(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '24 hours')
);
create index if not exists meetings_starts_idx on public.meetings (status, starts_at);
create index if not exists meetings_cat_idx on public.meetings (category, starts_at);

create table if not exists public.meeting_members (
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        text not null default 'member' check (role in ('host','cohost','member')),
  status      text not null default 'requested' check (status in ('requested','waitlist','accepted','declined','removed','left','left_late')),
  note        text check (note is null or char_length(note) <= 200),
  reason      text,
  attended    text check (attended in ('claimed','confirmed','noshow','disputed')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  primary key (meeting_id, user_id)
);
create index if not exists meeting_members_user_idx on public.meeting_members (user_id, status);
create index if not exists meeting_members_status_idx on public.meeting_members (meeting_id, status);

create table if not exists public.meeting_checkins (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  created_by  uuid references public.profiles(id) on delete set null,
  for_start   timestamptz not null,       -- время встречи на момент запроса; перенос закрывает запрос
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);
create unique index if not exists meeting_checkins_open_uidx on public.meeting_checkins (meeting_id) where closed_at is null;
create table if not exists public.checkin_answers (
  checkin_id  uuid not null references public.meeting_checkins(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  answer      text not null check (answer in ('ready','late','cant')),
  updated_at  timestamptz not null default now(),
  primary key (checkin_id, user_id)        -- один изменяемый ответ на запрос
);

create table if not exists public.meeting_audit (
  id          bigserial primary key,
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null,
  target_id   uuid,
  reason      text,
  created_at  timestamptz not null default now()
);
create index if not exists meeting_audit_idx on public.meeting_audit (meeting_id, created_at desc);

alter table public.meetings enable row level security;
alter table public.meeting_members enable row level security;
alter table public.meeting_checkins enable row level security;
alter table public.checkin_answers enable row level security;
alter table public.meeting_audit enable row level security;

create or replace function public.meet_role(mt uuid, u uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.meeting_members where meeting_id = mt and user_id = u and status = 'accepted' $$;

drop policy if exists meetings_read on public.meetings;
create policy meetings_read on public.meetings for select using (
  exists (select 1 from public.posts p where p.id = meetings.id and p.status in ('active','closed')) or host_id = auth.uid() or public.is_mod());
drop policy if exists meeting_members_read on public.meeting_members;
-- свою заявку видит заявитель; состав — участники; заявки — Host и co-host
create policy meeting_members_read on public.meeting_members for select using (
  user_id = auth.uid() or public.is_mod()
  or (status = 'accepted' and public.meet_role(meeting_id, auth.uid()) is not null)
  or public.meet_role(meeting_id, auth.uid()) in ('host','cohost'));
drop policy if exists checkins_read on public.meeting_checkins;
create policy checkins_read on public.meeting_checkins for select using (public.meet_role(meeting_id, auth.uid()) is not null or public.is_mod());
drop policy if exists checkin_answers_read on public.checkin_answers;
create policy checkin_answers_read on public.checkin_answers for select using (
  exists (select 1 from public.meeting_checkins c where c.id = checkin_id and (public.meet_role(c.meeting_id, auth.uid()) is not null or public.is_mod())));
drop policy if exists meeting_audit_read on public.meeting_audit;
create policy meeting_audit_read on public.meeting_audit for select using (public.meet_role(meeting_id, auth.uid()) in ('host','cohost') or public.is_mod());
revoke insert, update, delete on public.meetings, public.meeting_members, public.meeting_checkins, public.checkin_answers, public.meeting_audit from anon, authenticated;
grant select on public.meetings to anon, authenticated;
grant select on public.meeting_members, public.meeting_checkins, public.checkin_answers, public.meeting_audit to authenticated;

-- ---------- справочник категорий: поля, закрепление, приветствие ----------
create or replace function public.meet_fields(cat text) returns text[] language sql immutable as $$
  select case cat
    when 'games'     then array['game','mode','level','club','booking','price_hour']
    when 'cinema'    then array['film','cinema','session','lang','format','price']
    when 'board'     then array['game','level','club','inventory','duration']
    when 'sport'     then array['sport','format','level','venue','inventory','rent']
    when 'cafe'      then array['goal','cafe','budget','table','topic']
    when 'walk'      then array['route','meet_point','distance','pace','duration']
    when 'mountains' then array['route','difficulty','distance','elevation','gear','return_time','weather']
    when 'study'     then array['topic','level','format','place','materials','duration']
    when 'other'     then array['goal','place','materials','cost']
  end $$;

create or replace function public.meet_greeting(cat text) returns text language sql immutable as $$
  select case cat
    when 'games'     then 'Всем привет! Напишите, кто на какой позиции играет.'
    when 'cinema'    then 'Обсудим покупку билетов и места в зале. Каждый покупает билет сам.'
    when 'board'     then 'Новичкам объясним правила.'
    when 'sport'     then 'Напишите позицию и подтвердите участие.'
    when 'cafe'      then 'Обсудим время и бронирование столика.'
    when 'walk'      then 'Маршрут и время закреплены в чате.'
    when 'mountains' then 'Проверьте снаряжение, прогноз и маршрут. Подтвердите готовность.'
    when 'study'     then 'Подготовьте материалы. Распределим задания заранее.'
    else 'Обсудим организацию и необходимые материалы.' end $$;

-- закрепление строится сервером из полей категории
create or replace function public.meet_pin(cat text, d jsonb, st timestamptz, en timestamptz, cap int) returns text
language sql immutable as $$
  select left(case cat
    when 'games'     then concat_ws(' • ', nullif(d->>'game',''), nullif(d->>'mode',''), coalesce(nullif(d->>'level',''), 'любой уровень'))
    when 'cinema'    then 'Кино • сеанс ' || coalesce(nullif(d->>'session',''), to_char(st at time zone 'Asia/Almaty', 'HH24:MI'))
    when 'board'     then concat_ws(' • ', coalesce(nullif(d->>'game',''), 'Настольные игры'), cap || ' участников', coalesce(nullif(d->>'duration',''), round(extract(epoch from en - st) / 3600.0, 1) || ' ч'))
    when 'sport'     then concat_ws(' • ', coalesce(nullif(d->>'sport',''), 'Спорт'), nullif(d->>'format',''), round(extract(epoch from en - st) / 60) || ' минут')
    when 'cafe'      then coalesce(nullif(d->>'goal',''), 'Кофе') || ' • каждый платит за себя'
    when 'walk'      then concat_ws(' • ', nullif(d->>'distance',''), coalesce(nullif(d->>'pace',''), 'спокойный темп'))
    when 'mountains' then concat_ws(' • ', nullif(d->>'distance',''), coalesce(nullif(d->>'difficulty',''), 'сложность уточняется'))
    when 'study'     then concat_ws(' • ', coalesce(nullif(d->>'topic',''), 'Обучение'), nullif(d->>'format',''), nullif(d->>'duration',''))
    else coalesce(nullif(d->>'goal',''), 'Совместное мероприятие') end, 120) $$;

create or replace function public.meet_details_clean(cat text, d jsonb) returns jsonb
language plpgsql as $$
declare k text; v text; o jsonb := '{}'::jsonb; why text;
begin
  if public.meet_fields(cat) is null then raise exception using errcode = 'NR422', message = 'Неизвестная категория встречи'; end if;
  foreach k in array public.meet_fields(cat) loop
    v := btrim(coalesce(d->>k, ''));
    if v = '' then continue; end if;
    if char_length(v) > 60 then raise exception using errcode = 'NR422', message = 'Поле слишком длинное (до 60 символов)'; end if;
    why := public.near_block_reason(v);
    if why is not null then raise exception using errcode = 'NR422', message = public.near_block_message(why), hint = why; end if;
    o := o || jsonb_build_object(k, public.near_clean(v));
  end loop;
  return o;
end $$;

-- напоминания 24 ч / 1 ч / 15 мин без дублей
create or replace function public.meet_schedule(mt uuid, u uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; x record;
begin
  select * into m from public.meetings where id = mt;
  for x in select * from (values ('24h', interval '24 hours'), ('1h', interval '1 hour'), ('15m', interval '15 minutes')) v(k, d) loop
    if m.starts_at - x.d > now() then
      perform public.outbox_put(u, 'meeting_reminder', 'remind:' || mt || ':' || u || ':' || x.k || ':' || extract(epoch from m.starts_at)::bigint,
        jsonb_build_object('room_id', m.room_id, 'post_id', mt, 'text', 'Скоро встреча "' || m.title || '"', 'link', '#meet=' || mt), m.starts_at - x.d);
    end if;
  end loop;
end $$;
create or replace function public.meet_unschedule(mt uuid, u uuid) returns void
language sql security definer set search_path = public as $$
  update public.outbox set status = 'skipped' where status = 'pending' and dedup_key like 'remind:' || mt || ':' || coalesce(u::text, '') || '%' $$;

create or replace function public.meet_notify(mt uuid, u uuid, p_kind text, p_text text, p_key text) returns void
language sql security definer set search_path = public as $$
  select public.outbox_put(u, p_kind, p_key, jsonb_build_object('post_id', mt, 'text', left(p_text, 300), 'link', '#meet=' || mt,
    'room_id', (select room_id from public.meetings where id = mt))) $$;

create or replace function public.meet_accepted_count(mt uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.meeting_members where meeting_id = mt and status = 'accepted' $$;

-- ---------- создание: атомарно публикация + встреча + Host + комната + приветствие ----------
create or replace function public.create_meeting(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); cat text := p->>'category'; title text := btrim(coalesce(p->>'title', ''));
        descr text := btrim(coalesce(p->>'description', '')); st timestamptz; en timestamptz; cap int; price int; d jsonb;
        pid uuid; rid uuid; why text; ck text := left(p->>'client_key', 64);
begin
  if uid is null then raise exception using errcode = 'NR401', message = 'Войдите, чтобы создать встречу'; end if;
  -- повтор с тем же ключом — та же встреча
  if ck is not null then
    select id into pid from public.posts where user_id = uid and client_key = ck and category = 'meetup';
    if pid is not null then return pid; end if;
  end if;
  if not public.meet_ok(uid) then
    raise exception using errcode = 'NR403', message = 'Встречи пока доступны только после проверки возраста', hint = 'meet_age';
  end if;
  if char_length(title) not between 5 and 80 then raise exception using errcode = 'NR422', message = 'Название: от 5 до 80 символов'; end if;
  if char_length(descr) not between 10 and 1000 then raise exception using errcode = 'NR422', message = 'Описание: от 10 до 1000 символов'; end if;
  begin st := (p->>'starts_at')::timestamptz; en := (p->>'ends_at')::timestamptz;
  exception when others then raise exception using errcode = 'NR422', message = 'Укажите дату и время'; end;
  if st is null or en is null then raise exception using errcode = 'NR422', message = 'Укажите начало и конец'; end if;
  if st < now() + interval '15 minutes' then raise exception using errcode = 'NR422', message = 'Начало — не раньше чем через 15 минут'; end if;
  if st > now() + interval '90 days' then raise exception using errcode = 'NR422', message = 'Дата — не дальше 90 дней вперед'; end if;
  if en <= st then raise exception using errcode = 'NR422', message = 'Конец должен быть позже начала'; end if;
  if en > st + interval '24 hours' then raise exception using errcode = 'NR422', message = 'Длительность — до 24 часов'; end if;
  cap := (p->>'capacity')::int;
  if cap is null or cap not between 3 and 50 then raise exception using errcode = 'NR422', message = 'Участников: от 3 до 50, включая организатора'; end if;
  price := nullif(p->>'price_kzt', '')::int;
  if price < 0 then raise exception using errcode = 'NR422', message = 'Цена не может быть отрицательной'; end if;
  if coalesce((p->>'public_place')::boolean, false) is not true then
    raise exception using errcode = 'NR422', message = 'Встречи проводятся только в публичных местах', hint = 'public_place';
  end if;
  why := coalesce(public.near_block_reason(title), public.near_block_reason(descr), public.near_block_reason(p->>'rules'));
  if why is not null then raise exception using errcode = 'NR422', message = public.near_block_message(why), hint = why; end if;
  -- сборы денег через организатора запрещены (ТЗ 07: не принимать платежи через Host)
  if (descr || ' ' || coalesce(p->>'rules', '')) ~* '(переведите|перевод на карту|скиньте на (карту|kaspi|каспи)|оплата организатору|предоплат)' then
    raise exception using errcode = 'NR422', message = 'Нельзя собирать деньги через организатора. Каждый платит сам на месте или на сайте площадки', hint = 'payment';
  end if;
  d := public.meet_details_clean(cat, coalesce(p->'details', '{}'::jsonb));

  perform set_config('near.meeting', '1', true);
  insert into public.posts (user_id, category, text, lat, lng, exact, meta, client_key)
  values (uid, 'meetup', descr, (p->>'lat')::float8, (p->>'lng')::float8, coalesce((p->>'exact')::boolean, true),
          jsonb_build_object('title', title, 'mcat', cat), ck)
  returning id into pid;
  perform set_config('near.meeting', '', true);

  insert into public.rooms (type, scope_id, title, is_public, meeting_id, pinned, rules)
  values ('meeting', pid::text, public.near_clean(title), false, pid, public.meet_pin(cat, d, st, en, cap), nullif(public.near_clean(btrim(coalesce(p->>'rules', ''))), ''))
  returning id into rid;
  insert into public.meetings (id, host_id, category, title, details, pin, place_name, starts_at, ends_at, capacity, price_kzt, rules, room_id)
  values (pid, uid, cat, public.near_clean(title), d, public.meet_pin(cat, d, st, en, cap), nullif(public.near_clean(left(btrim(coalesce(p->>'place_name', '')), 120)), ''),
          st, en, cap, price, nullif(public.near_clean(btrim(coalesce(p->>'rules', ''))), ''), rid);
  update public.posts set expires_at = en + interval '1 hour' where id = pid;
  insert into public.meeting_members (meeting_id, user_id, role, status, decided_at) values (pid, uid, 'host', 'accepted', now());
  insert into public.room_members (room_id, user_id, role, notify) values (rid, uid, 'host', 'all');
  update public.rooms set members_count = 1 where id = rid;
  perform public.room_system(rid, public.meet_greeting(cat), jsonb_build_object('tpl', 'greet.' || cat));
  if cat = 'mountains' then
    perform public.room_system(rid, 'Горы — это риск. Проверьте прогноз погоды, снаряжение и время возврата. Сообщите близким маршрут. В экстренной ситуации звоните 112.', '{"tpl":"warn.mountains"}');
  end if;
  insert into public.meeting_audit (meeting_id, actor_id, action) values (pid, uid, 'create');
  perform public.meet_schedule(pid, uid);
  return pid;
end $$;

-- публикацию "встреча" можно создать только через create_meeting; лимит — свой
create or replace function public.meetup_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.category = 'meetup' and auth.uid() is not null and current_setting('near.meeting', true) is distinct from '1' then
    raise exception using errcode = 'NR403', message = 'Встречи создаются через форму встречи', hint = 'use_create_meeting';
  end if;
  return new;
end $$;
drop trigger if exists posts_meetup_guard on public.posts;
create trigger posts_meetup_guard before insert on public.posts for each row execute function public.meetup_guard();
update public.app_settings set day_limits = jsonb_set(day_limits, '{meeting}', '[1,3]') where id = 1 and day_limits->'meeting' = '[0,3]'::jsonb;

-- лимит публикаций: встреча расходует свой лимит "meeting", а не "post"
create or replace function public.rate_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'posts' then
    perform public.rate('post'); perform public.rate('post_day');
    if new.is_sos then perform public.rate('sos');
    elsif new.category = 'meetup' then perform public.rate_take('meeting', new.client_key);
    else
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
  elsif tg_table_name = 'reports' then perform public.rate('report');
  elsif tg_table_name = 'likes' then perform public.rate('like');
  end if;
  return new;
end $$;

-- ---------- заявка участника ----------
create or replace function public.request_join(p_meeting uuid, p_note text default null) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); m public.meetings; cur text; st text;
begin
  if uid is null then raise exception using errcode = 'NR401', message = 'Войдите, чтобы подать заявку'; end if;
  if not public.meet_ok(uid) then raise exception using errcode = 'NR403', message = 'Встречи пока доступны только после проверки возраста', hint = 'meet_age'; end if;
  if exists (select 1 from public.profiles where id = uid and (nickname is null or accepted_rules_at is null or not verified)) then
    raise exception using errcode = 'NR403', message = 'Подтвердите почту и заполните никнейм', hint = 'profile_incomplete';
  end if;
  select * into m from public.meetings where id = p_meeting for update;
  if m.id is null then raise exception using errcode = 'NR404', message = 'Встреча не найдена'; end if;
  if m.status <> 'open' or m.starts_at <= now() then raise exception using errcode = 'NR409', message = 'Набор закрыт', hint = 'closed'; end if;
  if public.is_blocked(uid, m.host_id) then raise exception using errcode = 'NR403', message = 'Заявка недоступна'; end if;
  select status into cur from public.meeting_members where meeting_id = p_meeting and user_id = uid;
  if cur in ('accepted','requested','waitlist') then return cur; end if;
  if cur = 'removed' then raise exception using errcode = 'NR403', message = 'Организатор исключил вас из этой встречи', hint = 'removed'; end if;
  st := case when public.meet_accepted_count(p_meeting) >= m.capacity then 'waitlist' else 'requested' end;
  if p_note is not null and public.near_block_reason(p_note) is not null then raise exception using errcode = 'NR422', message = public.near_block_message(public.near_block_reason(p_note)); end if;
  insert into public.meeting_members (meeting_id, user_id, status, note) values (p_meeting, uid, st, nullif(public.near_clean(left(btrim(coalesce(p_note, '')), 200)), ''))
  on conflict (meeting_id, user_id) do update set status = excluded.status, note = excluded.note, created_at = now(), decided_at = null, reason = null;
  perform public.meet_notify(p_meeting, m.host_id, 'meeting_request', 'Новая заявка на "' || m.title || '"', 'req:' || p_meeting || ':' || uid || ':' || extract(epoch from now())::bigint);
  return st;
end $$;

-- ---------- решение Host: транзакция с блокировкой встречи и проверкой мест ----------
create or replace function public.decide_request(p_meeting uuid, p_user uuid, p_accept boolean, p_reason text default null) returns text
language plpgsql security definer set search_path = public as $$
declare m public.meetings; my text := coalesce(public.meet_role(p_meeting, auth.uid()), ''); cur text; nick text;
begin
  if my not in ('host','cohost') then raise exception using errcode = 'NR403', message = 'Решать заявки может организатор'; end if;
  select * into m from public.meetings where id = p_meeting for update;      -- два решения на последнее место: одно успешно
  select status into cur from public.meeting_members where meeting_id = p_meeting and user_id = p_user for update;
  if cur not in ('requested','waitlist') then raise exception using errcode = 'NR409', message = 'Заявка уже рассмотрена', hint = 'decided'; end if;
  if m.status in ('cancelled','finished') or m.ends_at < now() then raise exception using errcode = 'NR409', message = 'Встреча уже завершена или отменена'; end if;
  if not p_accept then
    update public.meeting_members set status = 'declined', decided_at = now(), reason = left(p_reason, 300) where meeting_id = p_meeting and user_id = p_user;
    insert into public.meeting_audit (meeting_id, actor_id, action, target_id, reason) values (p_meeting, auth.uid(), 'decline', p_user, left(p_reason, 300));
    perform public.meet_notify(p_meeting, p_user, 'meeting_declined', 'Заявка на "' || m.title || '" отклонена', 'dec:' || p_meeting || ':' || p_user || ':' || extract(epoch from now())::bigint);
    return 'declined';
  end if;
  if public.meet_accepted_count(p_meeting) >= m.capacity then
    raise exception using errcode = 'NR409', message = 'Свободных мест нет', hint = 'full';
  end if;
  update public.meeting_members set status = 'accepted', decided_at = now(), reason = null where meeting_id = p_meeting and user_id = p_user;
  insert into public.room_members (room_id, user_id, role, notify) values (m.room_id, p_user, 'member', 'all')
  on conflict (room_id, user_id) do update set status = 'active', role = 'member', joined_at = now();
  update public.rooms set members_count = public.meet_accepted_count(p_meeting) where id = m.room_id;
  select nickname into nick from public.profiles where id = p_user;
  perform public.room_system(m.room_id, '@' || coalesce(nick, 'участник') || ' присоединился', jsonb_build_object('tpl', 'joined', 'user', p_user));
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id) values (p_meeting, auth.uid(), 'accept', p_user);
  perform public.meet_notify(p_meeting, p_user, 'meeting_accepted', 'Вас приняли во встречу "' || m.title || '". Чат открыт', 'acc:' || p_meeting || ':' || p_user);
  perform public.meet_schedule(p_meeting, p_user);
  return 'accepted';
end $$;

-- место освободилось: лист ожидания получает уведомление и снова становится заявкой
create or replace function public.meet_free_place(p_meeting uuid) returns void
language plpgsql security definer set search_path = public as $$
declare w record; m public.meetings;
begin
  select * into m from public.meetings where id = p_meeting;
  update public.rooms set members_count = public.meet_accepted_count(p_meeting) where id = m.room_id;
  for w in update public.meeting_members set status = 'requested' where meeting_id = p_meeting and status = 'waitlist' returning user_id loop
    perform public.meet_notify(p_meeting, w.user_id, 'meeting_place', 'Освободилось место во встрече "' || m.title || '"', 'free:' || p_meeting || ':' || w.user_id || ':' || extract(epoch from now())::bigint);
    perform public.meet_notify(p_meeting, m.host_id, 'meeting_request', 'Заявка из листа ожидания на "' || m.title || '"', 'req:' || p_meeting || ':' || w.user_id || ':' || extract(epoch from now())::bigint);
  end loop;
end $$;

-- ---------- исключение: атомарно членство, история, подписка Realtime (RLS) и будущие push ----------
create or replace function public.remove_member(p_meeting uuid, p_user uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; my text := coalesce(public.meet_role(p_meeting, auth.uid()), ''); their text := coalesce(public.meet_role(p_meeting, p_user), '');
begin
  if my not in ('host','cohost') and not public.is_mod() then raise exception using errcode = 'NR403', message = 'Исключать может организатор'; end if;
  if their = '' then raise exception using errcode = 'NR404', message = 'Участник не найден'; end if;
  if their = 'host' or (their = 'cohost' and my <> 'host' and not public.is_mod()) then raise exception using errcode = 'NR403', message = 'Нельзя исключить организатора'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception using errcode = 'NR422', message = 'Укажите причину'; end if;
  select * into m from public.meetings where id = p_meeting for update;
  update public.meeting_members set status = 'removed', role = 'member', reason = left(p_reason, 300), decided_at = now() where meeting_id = p_meeting and user_id = p_user;
  update public.room_members set status = 'removed', muted_until = null where room_id = m.room_id and user_id = p_user;
  update public.outbox set status = 'skipped' where status = 'pending' and user_id = p_user and payload->>'room_id' = m.room_id::text;
  perform public.meet_unschedule(p_meeting, p_user);
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id, reason) values (p_meeting, auth.uid(), 'remove', p_user, left(p_reason, 300));
  perform public.room_system(m.room_id, 'Участник исключен организатором', jsonb_build_object('tpl', 'removed'));
  perform public.meet_notify(p_meeting, p_user, 'meeting_removed', 'Организатор исключил вас из встречи "' || m.title || '". Причина: ' || left(p_reason, 200), 'rm:' || p_meeting || ':' || p_user);
  perform public.meet_free_place(p_meeting);
end $$;

-- отказ участника: за 2 часа и раньше — без штрафа, позже — учитывается как неявка
create or replace function public.leave_meeting(p_meeting uuid) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); m public.meetings; cur text; st text;
begin
  select * into m from public.meetings where id = p_meeting for update;
  select status into cur from public.meeting_members where meeting_id = p_meeting and user_id = uid;
  if cur is null then raise exception using errcode = 'NR404', message = 'Вы не участвуете'; end if;
  if m.host_id = uid then raise exception using errcode = 'NR409', message = 'Организатор не может выйти: передайте роль или отмените встречу', hint = 'host'; end if;
  if cur in ('requested','waitlist') then
    delete from public.meeting_members where meeting_id = p_meeting and user_id = uid; return 'withdrawn';
  end if;
  if cur <> 'accepted' then return cur; end if;
  st := case when m.starts_at - now() >= interval '2 hours' then 'left' else 'left_late' end;
  update public.meeting_members set status = st, role = 'member', decided_at = now() where meeting_id = p_meeting and user_id = uid;
  update public.room_members set status = 'left' where room_id = m.room_id and user_id = uid;
  perform public.meet_unschedule(p_meeting, uid);
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id) values (p_meeting, uid, st, uid);
  perform public.room_system(m.room_id, 'Участник отказался от участия', jsonb_build_object('tpl', 'left'));
  perform public.meet_free_place(p_meeting);
  return st;
end $$;

-- ---------- роли: co-host и передача Host ----------
create or replace function public.set_cohost(p_meeting uuid, p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  if public.meet_role(p_meeting, auth.uid()) <> 'host' then raise exception using errcode = 'NR403', message = 'Назначать co-host может только Host'; end if;
  if coalesce(public.meet_role(p_meeting, p_user), '') not in ('member','cohost') then raise exception using errcode = 'NR404', message = 'Участник не найден'; end if;
  select * into m from public.meetings where id = p_meeting;
  update public.meeting_members set role = case when p_on then 'cohost' else 'member' end where meeting_id = p_meeting and user_id = p_user;
  update public.room_members set role = case when p_on then 'cohost' else 'member' end where room_id = m.room_id and user_id = p_user;
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id) values (p_meeting, auth.uid(), case when p_on then 'cohost_on' else 'cohost_off' end, p_user);
end $$;

create or replace function public.transfer_host(p_meeting uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; old uuid := auth.uid();
begin
  select * into m from public.meetings where id = p_meeting for update;
  if m.host_id is distinct from old then raise exception using errcode = 'NR403', message = 'Передать роль может только Host'; end if;
  if coalesce(public.meet_role(p_meeting, p_user), '') not in ('member','cohost') then raise exception using errcode = 'NR404', message = 'Новый Host должен быть участником встречи'; end if;
  if not public.meet_ok(p_user) then raise exception using errcode = 'NR403', message = 'У участника нет допуска к организации встреч'; end if;
  update public.meetings set host_id = p_user, updated_at = now() where id = p_meeting;
  update public.posts set user_id = p_user where id = p_meeting;
  update public.meeting_members set role = 'host' where meeting_id = p_meeting and user_id = p_user;
  update public.meeting_members set role = 'cohost' where meeting_id = p_meeting and user_id = old;
  update public.room_members set role = 'host' where room_id = m.room_id and user_id = p_user;
  update public.room_members set role = 'cohost' where room_id = m.room_id and user_id = old;
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id) values (p_meeting, old, 'transfer_host', p_user);
  perform public.room_system(m.room_id, 'Организатор передал роль Host', jsonb_build_object('tpl', 'host_changed', 'user', p_user));
end $$;

-- ---------- изменение места/времени, закрыть набор, отменить, завершить ----------
create or replace function public.update_meeting(p_meeting uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; st timestamptz; en timestamptz; moved boolean; u record; why text; nt text;
begin
  if public.meet_role(p_meeting, auth.uid()) not in ('host','cohost') then raise exception using errcode = 'NR403', message = 'Менять встречу может организатор'; end if;
  select * into m from public.meetings where id = p_meeting for update;
  if m.status in ('cancelled','finished') then raise exception using errcode = 'NR409', message = 'Встреча уже завершена или отменена'; end if;
  st := coalesce((p->>'starts_at')::timestamptz, m.starts_at); en := coalesce((p->>'ends_at')::timestamptz, m.ends_at);
  if en <= st or en > st + interval '24 hours' then raise exception using errcode = 'NR422', message = 'Конец позже начала, длительность до 24 часов'; end if;
  if st <> m.starts_at and (st < now() + interval '15 minutes' or st > now() + interval '90 days') then raise exception using errcode = 'NR422', message = 'Новое время: от 15 минут до 90 дней вперед'; end if;
  if p ? 'capacity' and ((p->>'capacity')::int not between 3 and 50 or (p->>'capacity')::int < public.meet_accepted_count(p_meeting)) then
    raise exception using errcode = 'NR422', message = 'Мест не меньше, чем уже принято, и от 3 до 50';
  end if;
  nt := btrim(coalesce(p->>'place_name', ''));
  why := public.near_block_reason(nt);
  if why is not null then raise exception using errcode = 'NR422', message = public.near_block_message(why); end if;
  moved := st <> m.starts_at or en <> m.ends_at or (p ? 'lat');
  update public.meetings set starts_at = st, ends_at = en,
    capacity = coalesce((p->>'capacity')::int, capacity),
    place_name = case when p ? 'place_name' then nullif(public.near_clean(left(nt, 120)), '') else place_name end,
    pin = public.meet_pin(category, details, st, en, coalesce((p->>'capacity')::int, capacity)), updated_at = now()
  where id = p_meeting;
  if p ? 'lat' then update public.posts set lat = (p->>'lat')::float8, lng = (p->>'lng')::float8, expires_at = en + interval '1 hour' where id = p_meeting;
  else update public.posts set expires_at = en + interval '1 hour' where id = p_meeting; end if;
  update public.rooms set pinned = (select pin from public.meetings where id = p_meeting) where id = m.room_id;
  if moved then
    update public.meeting_checkins set closed_at = now() where meeting_id = p_meeting and closed_at is null;   -- перенос закрывает старый запрос готовности
    for u in select user_id from public.meeting_members where meeting_id = p_meeting and status = 'accepted' loop
      perform public.meet_unschedule(p_meeting, u.user_id);
      perform public.meet_schedule(p_meeting, u.user_id);
      if u.user_id <> auth.uid() then
        perform public.meet_notify(p_meeting, u.user_id, 'meeting_changed', 'Встреча "' || m.title || '" изменена: проверьте место и время', 'chg:' || p_meeting || ':' || u.user_id || ':' || extract(epoch from now())::bigint);
      end if;
    end loop;
    perform public.room_system(m.room_id, 'Организатор изменил место или время встречи', jsonb_build_object('tpl', 'moved', 'starts_at', st));
  end if;
  insert into public.meeting_audit (meeting_id, actor_id, action, reason) values (p_meeting, auth.uid(), 'update', left(p::text, 300));
  if p ? 'capacity' then perform public.meet_free_place(p_meeting); end if;
end $$;

create or replace function public.close_recruiting(p_meeting uuid, p_closed boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.meet_role(p_meeting, auth.uid()) not in ('host','cohost') then raise exception using errcode = 'NR403', message = 'Нет прав'; end if;
  update public.meetings set status = case when p_closed then 'closed' else 'open' end, updated_at = now() where id = p_meeting and status in ('open','closed');
  insert into public.meeting_audit (meeting_id, actor_id, action) values (p_meeting, auth.uid(), case when p_closed then 'close' else 'reopen' end);
end $$;

create or replace function public.cancel_meeting(p_meeting uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; u record;
begin
  select * into m from public.meetings where id = p_meeting for update;
  if m.host_id is distinct from auth.uid() and not public.is_mod() then raise exception using errcode = 'NR403', message = 'Отменить может Host'; end if;
  if m.status in ('cancelled','finished') then return; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception using errcode = 'NR422', message = 'Укажите причину отмены'; end if;
  update public.meetings set status = 'cancelled', cancel_reason = left(p_reason, 300), updated_at = now() where id = p_meeting;
  update public.posts set status = 'closed' where id = p_meeting;
  update public.meeting_checkins set closed_at = now() where meeting_id = p_meeting and closed_at is null;
  for u in select user_id from public.meeting_members where meeting_id = p_meeting and status in ('accepted','requested','waitlist') loop
    perform public.meet_unschedule(p_meeting, u.user_id);
    if u.user_id <> m.host_id then
      perform public.meet_notify(p_meeting, u.user_id, 'meeting_cancelled', 'Встреча "' || m.title || '" отменена: ' || left(p_reason, 200), 'cancel:' || p_meeting || ':' || u.user_id);
    end if;
  end loop;
  perform public.room_system(m.room_id, 'Встреча отменена. Причина: ' || left(public.near_clean(p_reason), 200), jsonb_build_object('tpl', 'cancelled'));
  insert into public.meeting_audit (meeting_id, actor_id, action, reason) values (p_meeting, auth.uid(), 'cancel', left(p_reason, 300));
end $$;

create or replace function public.finish_meeting(p_meeting uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  select * into m from public.meetings where id = p_meeting for update;
  if public.meet_role(p_meeting, auth.uid()) not in ('host','cohost') then raise exception using errcode = 'NR403', message = 'Нет прав'; end if;
  if m.starts_at > now() then raise exception using errcode = 'NR409', message = 'Встреча еще не началась'; end if;
  update public.meetings set status = 'finished', ends_at = least(ends_at, now()), updated_at = now() where id = p_meeting and status in ('open','closed');
  update public.meeting_checkins set closed_at = now() where meeting_id = p_meeting and closed_at is null;
  perform public.room_system(m.room_id, 'Встреча завершена. Отметьте посещение и оцените участников в течение 7 дней', jsonb_build_object('tpl', 'finished'));
  insert into public.meeting_audit (meeting_id, actor_id, action) values (p_meeting, auth.uid(), 'finish');
end $$;

-- ---------- готовность: запрос Host/co-host, один изменяемый ответ ----------
create or replace function public.request_checkin(p_meeting uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare m public.meetings; cid uuid; u record;
begin
  if public.meet_role(p_meeting, auth.uid()) not in ('host','cohost') then raise exception using errcode = 'NR403', message = 'Запросить готовность может организатор'; end if;
  select * into m from public.meetings where id = p_meeting for update;
  if m.status in ('cancelled','finished') or m.ends_at < now() then raise exception using errcode = 'NR409', message = 'Встреча уже прошла'; end if;
  if exists (select 1 from public.meeting_checkins where meeting_id = p_meeting and created_at > now() - interval '5 minutes') then
    raise exception using errcode = 'NR429', message = 'Запрос готовности — не чаще раза в 5 минут', hint = 'retry_after=300;action=checkin';
  end if;
  update public.meeting_checkins set closed_at = now() where meeting_id = p_meeting and closed_at is null;
  insert into public.meeting_checkins (meeting_id, created_by, for_start) values (p_meeting, auth.uid(), m.starts_at) returning id into cid;
  insert into public.checkin_answers (checkin_id, user_id, answer) values (cid, auth.uid(), 'ready');
  insert into public.room_messages (room_id, sender_id, kind, body_masked, meta)
  values (m.room_id, auth.uid(), 'checkin', '@all • Подтвердите готовность', jsonb_build_object('checkin_id', cid, 'all', true, 'tpl', 'checkin'));
  update public.rooms set last_message_at = now() where id = m.room_id;
  for u in select user_id from public.meeting_members where meeting_id = p_meeting and status = 'accepted' and user_id <> auth.uid() loop
    perform public.meet_notify(p_meeting, u.user_id, 'meeting_checkin', 'Подтвердите готовность: "' || m.title || '"', 'chk:' || cid || ':' || u.user_id);
  end loop;
  return cid;
end $$;

create or replace function public.answer_checkin(p_checkin uuid, p_answer text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.meeting_checkins;
begin
  select * into c from public.meeting_checkins where id = p_checkin;
  if c.id is null or public.meet_role(c.meeting_id, auth.uid()) is null then raise exception using errcode = 'NR403', message = 'Вы не участник встречи'; end if;
  if c.closed_at is not null then raise exception using errcode = 'NR409', message = 'Запрос закрыт: время встречи изменилось', hint = 'closed'; end if;
  if p_answer not in ('ready','late','cant') then raise exception using errcode = 'NR422', message = 'Неизвестный ответ'; end if;
  insert into public.checkin_answers (checkin_id, user_id, answer) values (p_checkin, auth.uid(), p_answer)
  on conflict (checkin_id, user_id) do update set answer = excluded.answer, updated_at = now();
end $$;

-- ---------- посещение: участник отмечается, Host подтверждает после окончания; спор — ручная проверка ----------
create or replace function public.mark_attended(p_meeting uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  select * into m from public.meetings where id = p_meeting;
  if public.meet_role(p_meeting, auth.uid()) is null then raise exception using errcode = 'NR403', message = 'Вы не участник встречи'; end if;
  if m.starts_at > now() then raise exception using errcode = 'NR409', message = 'Отметиться можно после начала встречи'; end if;
  if m.ends_at < now() - interval '7 days' then raise exception using errcode = 'NR409', message = 'Срок отметки прошел'; end if;
  update public.meeting_members set attended = case when attended = 'noshow' then 'disputed' else coalesce(attended, 'claimed') end
   where meeting_id = p_meeting and user_id = auth.uid() and coalesce(attended, '') <> 'confirmed';
end $$;

create or replace function public.confirm_attendance(p_meeting uuid, p_user uuid, p_came boolean) returns void
language plpgsql security definer set search_path = public as $$
declare m public.meetings; cur text;
begin
  select * into m from public.meetings where id = p_meeting;
  if m.host_id is distinct from auth.uid() then raise exception using errcode = 'NR403', message = 'Подтверждает Host'; end if;
  if m.ends_at > now() and m.status <> 'finished' then raise exception using errcode = 'NR409', message = 'Подтвердить можно после окончания встречи'; end if;
  if m.ends_at < now() - interval '7 days' then raise exception using errcode = 'NR409', message = 'Срок подтверждения прошел'; end if;
  select attended into cur from public.meeting_members where meeting_id = p_meeting and user_id = p_user and status in ('accepted','left_late');
  if not found then raise exception using errcode = 'NR404', message = 'Участник не найден'; end if;
  update public.meeting_members set attended = case
      when p_came then 'confirmed'
      when cur = 'claimed' or cur = 'disputed' then 'disputed'     -- участник говорит "был", Host — "нет": ручная проверка
      else 'noshow' end
   where meeting_id = p_meeting and user_id = p_user;
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id) values (p_meeting, auth.uid(), case when p_came then 'attend_yes' else 'attend_no' end, p_user);
end $$;

-- Host считается пришедшим, если встреча не отменена
create or replace function public.meet_attended(mt uuid, u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.meeting_members mm join public.meetings m on m.id = mm.meeting_id
                  where mm.meeting_id = mt and mm.user_id = u and m.status <> 'cancelled'
                    and (mm.attended = 'confirmed' or (mm.role = 'host' and mm.status = 'accepted'))) $$;

create or replace function public.mod_resolve_attendance(p_meeting uuid, p_user uuid, p_came boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только модератор'; end if;
  update public.meeting_members set attended = case when p_came then 'confirmed' else 'noshow' end where meeting_id = p_meeting and user_id = p_user and attended = 'disputed';
  insert into public.meeting_audit (meeting_id, actor_id, action, target_id, reason) values (p_meeting, auth.uid(), 'attend_resolved', p_user, left(p_note, 300));
end $$;


-- =====================================================================
-- Часть D (раздел 10): отзывы, рейтинг с журналом (ledger), публичный профиль, состояния аккаунта.
-- Score = round(0.30R + 0.25A + 0.25S + 0.10U + 0.10H). Веса — проектные, калибруются по данным пилота.
-- =====================================================================

create table if not exists public.reviews (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.meetings(id) on delete cascade,
  reviewer_id  uuid not null references public.profiles(id) on delete cascade,
  target_id    uuid not null references public.profiles(id) on delete cascade,
  target_role  text not null check (target_role in ('host','member')),
  stars        int not null check (stars between 1 and 5),
  punctual     boolean, respectful boolean, organized boolean,
  comment      text check (comment is null or char_length(comment) <= 500),
  status       text not null default 'ok' check (status in ('ok','hidden')),
  created_at   timestamptz not null default now(),
  unique (reviewer_id, target_id, meeting_id),
  check (reviewer_id <> target_id)          -- без самооценки
);
create index if not exists reviews_target_idx on public.reviews (target_id, target_role);
alter table public.reviews enable row level security;
revoke all on public.reviews from anon, authenticated;
grant select on public.reviews to authenticated;
-- автор видит свой отзыв; цель — только опубликованные (после взаимного отзыва или окончания окна 7 дней)
create or replace function public.review_published(r public.reviews) returns boolean
language sql stable security definer set search_path = public as $$
  select r.status = 'ok' and (
    exists (select 1 from public.reviews x where x.meeting_id = r.meeting_id and x.reviewer_id = r.target_id and x.target_id = r.reviewer_id)
    or (select ends_at from public.meetings where id = r.meeting_id) < now() - interval '7 days') $$;
drop policy if exists reviews_read on public.reviews;
create policy reviews_read on public.reviews for select using (reviewer_id = auth.uid() or public.is_mod() or public.review_published(reviews));

create or replace function public.submit_review(p_meeting uuid, p_target uuid, p_stars int, p_punctual boolean default null,
                                                p_respectful boolean default null, p_organized boolean default null, p_comment text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); m public.meetings; v_id uuid; why text;
begin
  select * into m from public.meetings where id = p_meeting;
  if m.id is null then raise exception using errcode = 'NR404', message = 'Встреча не найдена'; end if;
  if uid = p_target then raise exception using errcode = 'NR422', message = 'Себя оценить нельзя'; end if;
  if m.status = 'cancelled' or (m.ends_at > now() and m.status <> 'finished') then raise exception using errcode = 'NR409', message = 'Оценить можно после окончания встречи'; end if;
  if m.ends_at < now() - interval '7 days' then raise exception using errcode = 'NR409', message = 'Окно отзывов (7 дней) закрыто'; end if;
  if not public.meet_attended(p_meeting, uid) or not public.meet_attended(p_meeting, p_target) then
    raise exception using errcode = 'NR403', message = 'Отзывы оставляют только подтвержденные участники', hint = 'not_attended';
  end if;
  if p_stars is null or p_stars not between 1 and 5 then raise exception using errcode = 'NR422', message = 'Оценка от 1 до 5'; end if;
  if p_comment is not null then
    why := public.near_block_reason(p_comment);
    if why is not null then raise exception using errcode = 'NR422', message = public.near_block_message(why); end if;
  end if;
  insert into public.reviews (meeting_id, reviewer_id, target_id, target_role, stars, punctual, respectful, organized, comment)
  values (p_meeting, uid, p_target, case when p_target = m.host_id then 'host' else 'member' end, p_stars, p_punctual, p_respectful, p_organized,
          nullif(public.near_clean(left(btrim(coalesce(p_comment, '')), 500)), ''))
  on conflict (reviewer_id, target_id, meeting_id) do nothing returning reviews.id into v_id;
  if v_id is null then raise exception using errcode = 'NR409', message = 'Вы уже оценили этого участника', hint = 'duplicate'; end if;
  return v_id;
end $$;

-- ---------- журнал рейтинга: только безопасность (S); идемпотентный ключ, апелляция компенсирует ----------
create table if not exists public.rating_ledger (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  component   text not null default 'S' check (component in ('S')),
  kind        text not null check (kind in ('spam','insult','scam','reversal')),
  delta       int not null,
  decays      boolean not null default true,
  source_key  text not null unique,
  reason      text,
  reverses    bigint references public.rating_ledger(id),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists rating_ledger_user_idx on public.rating_ledger (user_id);
alter table public.rating_ledger enable row level security;
revoke all on public.rating_ledger from anon, authenticated;   -- сырые числа видит только модератор (через RPC)

-- подтвержденное нарушение (решение модератора, а не сама жалоба)
create or replace function public.rating_penalty(p_user uuid, p_kind text, p_source text, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только модератор'; end if;
  if p_kind not in ('spam','insult','scam') then raise exception using errcode = 'NR422', message = 'Тип: spam, insult или scam'; end if;
  insert into public.rating_ledger (user_id, kind, delta, decays, source_key, reason, created_by)
  values (p_user, p_kind, case p_kind when 'spam' then -10 when 'insult' then -15 else -40 end, p_kind <> 'scam', p_source, left(p_reason, 300), auth.uid())
  on conflict (source_key) do nothing returning rating_ledger.id into v_id;
  if p_kind = 'scam' and v_id is not null then
    perform public.mod_restrict(p_user, 'all', 30, 'Мошенничество: ' || left(p_reason, 200));    -- скам: штраф плюс санкция
  end if;
  return v_id;
end $$;
create or replace function public.rating_reverse(p_ledger bigint, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare l public.rating_ledger; v_id bigint;
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только модератор'; end if;
  select * into l from public.rating_ledger where rating_ledger.id = p_ledger and kind <> 'reversal';
  if l.id is null then raise exception using errcode = 'NR404', message = 'Запись не найдена'; end if;
  insert into public.rating_ledger (user_id, kind, delta, decays, source_key, reason, reverses, created_by)
  values (l.user_id, 'reversal', -l.delta, false, 'reverse:' || l.id, left(p_reason, 300), l.id, auth.uid())
  on conflict (source_key) do nothing returning rating_ledger.id into v_id;
  return v_id;
end $$;

-- компоненты 0–100
create or replace function public.rating_parts(u uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with rv as (select r.* from public.reviews r where r.target_id = u and public.review_published(r)),
       mm as (select mm.*, m.status ms, m.ends_at from public.meeting_members mm join public.meetings m on m.id = mm.meeting_id
               where mm.user_id = u and m.status <> 'cancelled' and m.ends_at < now()),
       att as (select count(*) filter (where attended = 'confirmed' or (role = 'host' and status = 'accepted')) ok,
                      count(*) filter (where status = 'left_late' or attended = 'noshow') bad,
                      count(*) filter (where (attended = 'confirmed' or (role = 'host' and status = 'accepted'))) meetings
                 from mm where status in ('accepted','left_late')),
       s as (select coalesce(sum(case when l.reverses is not null then 0
                                      when exists (select 1 from public.rating_ledger x where x.reverses = l.id) then 0
                                      when l.decays then l.delta * greatest(0, 1 - extract(epoch from now() - l.created_at) / (90 * 86400))
                                      else l.delta end), 0) d
               from public.rating_ledger l where l.user_id = u),
       lk as (select count(*) n from public.likes k join public.posts p on p.id = k.post_id where p.user_id = u and k.user_id <> u),
       pr as (select created_at from public.profiles where id = u)
  select jsonb_build_object(
    'R', case when (select count(*) from rv) = 0 then null else round((((select avg(stars) from rv) - 1) / 4.0 * 100)::numeric) end,
    'A', case when (select ok + bad from att) = 0 then null else round(100.0 * (select ok from att) / (select ok + bad from att)) end,
    'S', greatest(0, least(100, round(100 + (select d from s)))),
    'U', least(100, round(20 * ln(1 + (select n from lk)))),
    'H', least(100, round(extract(epoch from now() - (select created_at from pr)) / 86400 / 3 + 5 * (select meetings from att))),
    'meetings', (select meetings from att),
    'reviewers', (select count(distinct reviewer_id) from rv)) $$;

-- публичный рейтинг: Host и участник отдельно с количеством отзывов; общий балл — только при ≥5 встреч и ≥3 независимых отзывов
create or replace function public.user_rating(u uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with p as (select public.rating_parts(u) j),
       rv as (select r.* from public.reviews r where r.target_id = u and public.review_published(r))
  select jsonb_build_object(
    'host', jsonb_build_object('avg', (select round(avg(stars)::numeric, 1) from rv where target_role = 'host'), 'count', (select count(*) from rv where target_role = 'host')),
    'member', jsonb_build_object('avg', (select round(avg(stars)::numeric, 1) from rv where target_role = 'member'), 'count', (select count(*) from rv where target_role = 'member')),
    'meetings', (p.j->>'meetings')::int,
    'score', case when (p.j->>'meetings')::int >= 5 and (p.j->>'reviewers')::int >= 3 then
      round(0.30 * coalesce((p.j->>'R')::numeric, 0) + 0.25 * coalesce((p.j->>'A')::numeric, 100) + 0.25 * (p.j->>'S')::numeric
          + 0.10 * (p.j->>'U')::numeric + 0.10 * (p.j->>'H')::numeric) end,
    'enough', (p.j->>'meetings')::int >= 5 and (p.j->>'reviewers')::int >= 3)
  from p $$;

create or replace function public.mod_rating_raw(u uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_mod() then raise exception using errcode = 'NR403', message = 'Только модератор'; end if;
  return public.rating_parts(u) || jsonb_build_object('ledger', (select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb) from public.rating_ledger l where l.user_id = u));
end $$;

-- публичный профиль: ник, аватар, подтверждение, лайки, публикации, встречи, рейтинги. Без личных сообщений и дружбы.
create or replace function public.profile_public(u uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', p.id, 'nickname', p.nickname, 'avatar_url', p.avatar_url, 'verified', p.verified, 'bio', p.bio, 'district', p.district,
    'interests', p.interests, 'created_at', p.created_at, 'instagram', public.profile_instagram(p.id),
    'likes', (select count(*) from public.likes k join public.posts x on x.id = k.post_id where x.user_id = p.id and k.user_id <> p.id),
    'posts', (select count(*) from public.posts x where x.user_id = p.id and x.status in ('active','closed') and x.category <> 'meetup'),
    'meetings', (select count(*) from public.meeting_members mm join public.meetings m on m.id = mm.meeting_id
                   where mm.user_id = p.id and m.status <> 'cancelled' and (mm.attended = 'confirmed' or (mm.role = 'host' and mm.status = 'accepted'))),
    'rating', public.user_rating(p.id),
    'blocked', exists (select 1 from public.blocks b where b.blocker_id = auth.uid() and b.blocked_id = p.id))
  from public.profiles p where p.id = u and not p.banned $$;

-- состояние аккаунта: + deleted (запрошено удаление), встречи — отдельный допуск, лимит встреч
create or replace function public.my_account() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p record; pp record; st text; sa public.user_sanctions; can jsonb;
begin
  if auth.uid() is null then return null; end if;
  select * into p from public.profiles where id = auth.uid();
  if p.id is null or exists (select 1 from public.deletion_jobs where user_id = auth.uid() and status <> 'done') then return jsonb_build_object('state', 'deleted'); end if;
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
    'chat', st in ('active','restricted') and public.active_sanction(auth.uid(), 'chat') is null,
    'meet', st = 'active' and public.meet_ok(auth.uid()),
    'report', st <> 'suspended');
  return jsonb_build_object(
    'state', st, 'can', can,
    'age_status', coalesce(pp.age_status, 'unknown'), 'meet_ok', public.meet_ok(auth.uid()),
    'phone_verified', pp.phone_verified_at is not null,
    'nickname_next_change', case when p.nickname_changed_at > now() - interval '30 days' then p.nickname_changed_at + interval '30 days' end,
    'instagram', p.instagram, 'instagram_public', p.instagram_public, 'accepted_rules', p.accepted_rules_at is not null,
    'notify_level', p.notify_level,
    'mod_role', p.is_admin or p.is_moderator, 'mfa_ok', public.mfa_ok(),
    'sanction', case when sa.id is not null then jsonb_build_object('until', sa.until, 'reason', sa.reason) end,
    'limits', jsonb_build_object('post', public.limit_status('post'), 'comment', public.limit_status('comment'), 'meeting', public.limit_status('meeting')),
    'clean_version', (select clean_version from public.app_settings where id = 1),
    'media_ok', true);
end $$;

create or replace function public.set_notify_level(p_level text) returns void
language sql security definer set search_path = public as $$
  update public.profiles set notify_level = p_level where id = auth.uid() and p_level in ('all','important','silent','off') $$;
-- ---------- данные для экранов ----------
-- карточка встречи: без точного GPS при скрытом месте (точку дает posts), участники — только ники
create or replace function public.meeting_get(p_meeting uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', m.id, 'category', m.category, 'title', m.title, 'details', m.details, 'pin', m.pin, 'place_name', m.place_name,
    'starts_at', m.starts_at, 'ends_at', m.ends_at, 'capacity', m.capacity, 'price_kzt', m.price_kzt, 'rules', m.rules,
    'status', case when m.status in ('cancelled','finished') then m.status when m.ends_at < now() then 'finished' when m.starts_at <= now() then 'live' else m.status end,
    'cancel_reason', m.cancel_reason, 'room_id', case when public.meet_role(m.id, auth.uid()) is not null or public.is_mod() then m.room_id end,
    'accepted', public.meet_accepted_count(m.id),
    'host', (select jsonb_build_object('id', p.id, 'nickname', p.nickname, 'avatar_url', p.avatar_url, 'verified', p.verified, 'rating', public.user_rating(p.id))
               from public.profiles p where p.id = m.host_id),
    'my_status', (select status from public.meeting_members where meeting_id = m.id and user_id = auth.uid()),
    'my_role', public.meet_role(m.id, auth.uid()),
    'my_attended', (select attended from public.meeting_members where meeting_id = m.id and user_id = auth.uid()),
    'members', case when public.meet_role(m.id, auth.uid()) is not null or public.is_mod() then
      (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nickname', p.nickname, 'avatar_url', p.avatar_url, 'role', mm.role, 'attended', mm.attended,
                                                    'muted_until', rm.muted_until) order by mm.role = 'host' desc, mm.decided_at), '[]'::jsonb)
         from public.meeting_members mm join public.profiles p on p.id = mm.user_id
         left join public.room_members rm on rm.room_id = m.room_id and rm.user_id = mm.user_id
        where mm.meeting_id = m.id and mm.status = 'accepted') end,
    'requests', case when public.meet_role(m.id, auth.uid()) in ('host','cohost') then
      (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nickname', p.nickname, 'avatar_url', p.avatar_url, 'status', mm.status, 'note', mm.note,
                                                    'rating', public.user_rating(p.id)) order by mm.created_at), '[]'::jsonb)
         from public.meeting_members mm join public.profiles p on p.id = mm.user_id
        where mm.meeting_id = m.id and mm.status in ('requested','waitlist')) end,
    'checkin', case when public.meet_role(m.id, auth.uid()) is not null then
      (select jsonb_build_object('id', c.id, 'created_at', c.created_at,
              'answers', (select coalesce(jsonb_object_agg(a.user_id, a.answer), '{}'::jsonb) from public.checkin_answers a where a.checkin_id = c.id))
         from public.meeting_checkins c where c.meeting_id = m.id and c.closed_at is null) end)
  from public.meetings m
  where m.id = p_meeting and (exists (select 1 from public.posts p where p.id = m.id and p.status in ('active','closed')) or public.meet_role(m.id, auth.uid()) is not null or public.is_mod()) $$;

-- список встреч рядом: категория, дата, радиус, стоимость, свободные места
create or replace function public.meetings_near(p_lat float8, p_lng float8, p_radius int default 10000, p_cats text[] default null,
                                                p_from timestamptz default null, p_to timestamptz default null,
                                                p_free_only boolean default false, p_max_price int default null, p_limit int default 30) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.starts_at), '[]'::jsonb) from (
    select m.id, m.category, m.title, m.pin, m.place_name, m.starts_at, m.ends_at, m.capacity, m.price_kzt, p.lat, p.lng,
           public.meet_accepted_count(m.id) as accepted,
           (select nickname from public.profiles where id = m.host_id) as host,
           (select status from public.meeting_members where meeting_id = m.id and user_id = auth.uid()) as my_status,
           round((6371000 * 2 * asin(sqrt(power(sin(radians(p.lat - p_lat) / 2), 2) + cos(radians(p_lat)) * cos(radians(p.lat)) * power(sin(radians(p.lng - p_lng) / 2), 2))))::numeric) as dist
      from public.meetings m join public.posts p on p.id = m.id
     where m.status = 'open' and m.starts_at > now() and p.status = 'active'
       and (p_cats is null or m.category = any (p_cats))
       and (p_from is null or m.starts_at >= p_from) and (p_to is null or m.starts_at < p_to)
       and (p_max_price is null or coalesce(m.price_kzt, 0) <= p_max_price)
       and (not p_free_only or public.meet_accepted_count(m.id) < m.capacity)
       and p.lat between p_lat - p_radius / 111000.0 and p_lat + p_radius / 111000.0
       and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = m.host_id) or (b.blocker_id = m.host_id and b.blocked_id = auth.uid()))
     order by m.starts_at
     limit least(coalesce(p_limit, 30), 50)) x
  where x.dist <= p_radius $$;

-- мои встречи (создатель, участник, заявки, архив)
create or replace function public.my_meetings() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'category', m.category, 'starts_at', m.starts_at, 'ends_at', m.ends_at,
    'status', case when m.status in ('cancelled','finished') then m.status when m.ends_at < now() then 'finished' else m.status end,
    'my_status', mm.status, 'my_role', mm.role, 'room_id', case when mm.status = 'accepted' then m.room_id end,
    'review_due', mm.status = 'accepted' and m.ends_at < now() and m.ends_at > now() - interval '7 days') order by m.starts_at desc), '[]'::jsonb)
  from public.meeting_members mm join public.meetings m on m.id = mm.meeting_id
  where mm.user_id = auth.uid() and mm.status not in ('declined') $$;

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

-- =====================================================================
-- Часть F: права. Service role — только сервер; клиент — только RPC и чтение по RLS.
-- =====================================================================
do $$ declare f text; begin
  -- внутренние функции: не вызываются клиентом
  foreach f in array array[
    'public.outbox_put(uuid, text, text, jsonb, timestamptz)', 'public.outbox_process(int)', 'public.room_system(uuid, text, jsonb, text)',
    'public.meet_schedule(uuid, uuid)', 'public.meet_unschedule(uuid, uuid)', 'public.meet_notify(uuid, uuid, text, text, text)',
    'public.meet_free_place(uuid)', 'public.legacy_dm_refuse()', 'public.meetup_guard()', 'public.rating_parts(uuid)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
  end loop;
  -- для всех, включая гостя: чтение городских данных
  foreach f in array array[
    'public.rooms_list(text, text)', 'public.room_feed(uuid, timestamptz, uuid, int)', 'public.meetings_near(float8, float8, int, text[], timestamptz, timestamptz, boolean, int, int)',
    'public.meeting_get(uuid)', 'public.profile_public(uuid)', 'public.user_rating(uuid)', 'public.meet_pin(text, jsonb, timestamptz, timestamptz, int)',
    'public.room_can_read(uuid)', 'public.room_role(uuid, uuid)', 'public.meet_role(uuid, uuid)', 'public.review_published(public.reviews)'] loop
    execute 'grant execute on function ' || f || ' to anon, authenticated';
  end loop;
  -- действия: только вошедшие
  foreach f in array array[
    'public.join_room(uuid)', 'public.leave_room(uuid)', 'public.room_settings(uuid, text, boolean, boolean)',
    'public.send_message(uuid, text, text, uuid, text, text)', 'public.room_hide_message(uuid, text)', 'public.set_mute(uuid, uuid, int, text)',
    'public.room_slow_mode(uuid, int)', 'public.mod_create_room(text, text, text)',
    'public.create_meeting(jsonb)', 'public.request_join(uuid, text)', 'public.decide_request(uuid, uuid, boolean, text)',
    'public.remove_member(uuid, uuid, text)', 'public.leave_meeting(uuid)', 'public.set_cohost(uuid, uuid, boolean)', 'public.transfer_host(uuid, uuid)',
    'public.update_meeting(uuid, jsonb)', 'public.close_recruiting(uuid, boolean)', 'public.cancel_meeting(uuid, text)', 'public.finish_meeting(uuid)',
    'public.request_checkin(uuid)', 'public.answer_checkin(uuid, text)', 'public.mark_attended(uuid)', 'public.confirm_attendance(uuid, uuid, boolean)',
    'public.mod_resolve_attendance(uuid, uuid, boolean, text)', 'public.submit_review(uuid, uuid, int, boolean, boolean, boolean, text)',
    'public.rating_penalty(uuid, text, text, text)', 'public.rating_reverse(bigint, text)', 'public.mod_rating_raw(uuid)',
    'public.my_meetings()', 'public.set_notify_level(text)', 'public.my_account()'] loop
    execute 'revoke all on function ' || f || ' from public, anon';
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $$;
grant select (notify_level) on public.profiles to authenticated;
grant update (notify_level) on public.profiles to authenticated;

-- уборка: напоминания и уведомления из outbox (каждую минуту — отдельное задание pg_cron, см. SETUP шаг 19)
create or replace function public.near_minutely() returns jsonb
language sql security definer set search_path = public as $$ select public.outbox_process(500) $$;
revoke all on function public.near_minutely() from public, anon, authenticated;
do $$ begin
  perform cron.schedule('near-minutely', '* * * * *', 'select public.near_minutely()');
exception when others then null;   -- без pg_cron: задание добавляется вручную (SETUP, шаг 19)
end $$;

-- ---------- 06: метрики пилота (только админ): непустые ленты, возврат, полезные публикации, жалобы, реакция ----------
create or replace function public.kpi_city(p_days int default 7) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)));
begin
  if not public.is_admin() then raise exception using errcode = 'NR403', message = 'Только администратор'; end if;
  return jsonb_build_object(
    'nonempty_feed_share', (select round(100.0 * count(*) filter (where coalesce((props->>'count')::int, 0) > 0) / nullif(count(*), 0), 1)
                              from public.analytics_events where name = 'feed_loaded' and created_at > since),
    'useful_posts_share', (select round(100.0 * count(*) filter (where likes_count + comments_count > 0) / nullif(count(*), 0), 1)
                              from public.posts where created_at > since and status in ('active','closed') and not official),
    'official_posts', (select count(*) from public.posts where official and created_at > since),
    'meetings_created', (select count(*) from public.meetings where created_at > since),
    'meetings_held', (select count(*) from public.meetings where ends_at between since and now() and status <> 'cancelled'),
    'room_messages', (select count(*) from public.room_messages where created_at > since and sender_id is not null),
    'reports', (select count(*) from public.reports where created_at > since),
    'report_reaction_hours_median', (select round((percentile_cont(0.5) within group (order by extract(epoch from resolved_at - created_at) / 3600))::numeric, 1)
                              from public.reports where created_at > since and resolved_at is not null),
    'retention', (select jsonb_build_object('d1', s->'d1', 'd7', s->'d7') from (select public.kpi_summary() s) x));
exception when undefined_function then
  return jsonb_build_object('error', 'kpi_summary недоступна');
end $$;
revoke all on function public.kpi_city(int) from public, anon;
grant execute on function public.kpi_city(int) to authenticated;
