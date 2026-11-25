-- Минимальная среда Supabase для локальных тестов (auth, storage, заглушка PostGIS).
-- Только для проверки логики схемы; на Supabase используется настоящий PostGIS.
create extension if not exists pgcrypto;
do $$ begin create role anon nologin; exception when others then null; end $$;
do $$ begin create role authenticated nologin; exception when others then null; end $$;
create schema auth; create schema storage; create schema extensions;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', email_confirmed_at timestamptz, last_sign_in_at timestamptz, deleted_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
create publication supabase_realtime;
grant usage on schema public, auth, storage, extensions to anon, authenticated;
grant all on storage.objects to authenticated; grant select on storage.objects to anon;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
-- заглушка PostGIS: точка/рамка как (w,s,e,n), расстояние по формуле гаверсинуса
create type extensions.geometry as (w float8, s float8, e float8, n float8, srid int);
create type extensions.geography as (w float8, s float8, e float8, n float8);
create function extensions.st_makepoint(x float8, y float8) returns extensions.geometry immutable language sql as $$ select row(x, y, x, y, 0)::extensions.geometry $$;
create function extensions.st_setsrid(g extensions.geometry, s int) returns extensions.geometry immutable language sql as $$ select row(g.w, g.s, g.e, g.n, s)::extensions.geometry $$;
create function extensions.st_makeenvelope(w float8, s float8, e float8, n float8, srid int) returns extensions.geometry immutable language sql as $$ select row(w, s, e, n, srid)::extensions.geometry $$;
create function extensions.to_geog(g extensions.geometry) returns extensions.geography immutable language sql as $$ select row(g.w, g.s, g.e, g.n)::extensions.geography $$;
create cast (extensions.geometry as extensions.geography) with function extensions.to_geog(extensions.geometry);
create function extensions.st_dwithin(a extensions.geography, b extensions.geography, r float8) returns boolean immutable language sql as $$
  select 2 * 6371008.8 * asin(sqrt(power(sin(radians(b.s - a.s) / 2), 2) + cos(radians(a.s)) * cos(radians(b.s)) * power(sin(radians(b.w - a.w) / 2), 2))) <= r $$;
create function extensions.st_distance(a extensions.geography, b extensions.geography) returns float8 immutable language sql as $$
  select 2 * 6371008.8 * asin(sqrt(power(sin(radians(b.s - a.s) / 2), 2) + cos(radians(a.s)) * cos(radians(b.s)) * power(sin(radians(b.w - a.w) / 2), 2))) $$;
create function extensions.geo_overlap(a extensions.geography, b extensions.geography) returns boolean immutable language sql as $$
  select a.w <= b.e and a.e >= b.w and a.s <= b.n and a.n >= b.s $$;
create operator extensions.&& (leftarg = extensions.geography, rightarg = extensions.geography, function = extensions.geo_overlap);
grant execute on all functions in schema extensions to anon, authenticated;
