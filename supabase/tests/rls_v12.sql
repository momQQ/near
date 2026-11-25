-- NEAR v12: дополнительные проверки (запускаются после rls_v11.sql на той же базе)
reset role; select t.as_user(null);
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
 ('30000000-0000-0000-0000-000000000001', 'u1@x.kz', '{"gender":"m","accepted_rules":"true"}', null),   -- не подтвердил email
 ('30000000-0000-0000-0000-000000000002', 'u2@x.kz', '{"accepted_rules":"true"}', now()),               -- без пола
 ('30000000-0000-0000-0000-000000000003', 'u3@x.kz', '{"gender":"f","accepted_rules":"true"}', now()),
 ('30000000-0000-0000-0000-000000000004', 'u4@x.kz', '{"gender":"m","accepted_rules":"true"}', now());
update public.profiles set created_at = now() - interval '60 days' where id::text like '30000000%';
update public.profiles set accepted_rules_at = now() where id::text like '30000000%';
update public.profiles set nickname = 'u' || right(id::text, 4) where id::text like '30000000%' and id <> '30000000-0000-0000-0000-000000000002';

-- ===== UX-01: email и профиль =====
set role authenticated; select t.as_user('30000000-0000-0000-0000-000000000001');
select t.fail('UX-01 без подтвержденного email публиковать нельзя', $$insert into public.posts (user_id, category, text, lat, lng) values ('30000000-0000-0000-0000-000000000001', 'talk', 'x', 43.2, 76.9)$$, 'NR403');
select t.as_user('30000000-0000-0000-0000-000000000002');
select t.fail('UX-01 без никнейма публиковать нельзя (v14.9: пол не нужен)', $$insert into public.posts (user_id, category, text, lat, lng) values ('30000000-0000-0000-0000-000000000002', 'talk', 'x', 43.2, 76.9)$$, 'NR403');

-- ===== SOS-01: срок назначает сервер, закрытый не открывается =====
select t.as_user('30000000-0000-0000-0000-000000000003');
insert into public.posts (id, user_id, category, text, lat, lng, is_sos, expires_at)
values ('50500000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'incident', 'SOS: помогите', 43.2, 76.9, true, now() + interval '10 days');
select t.ok('SOS-01 срок от приложения игнорируется — ровно 3 часа', (select expires_at between now() + interval '2 hours 59 minutes' and now() + interval '3 hours 1 minute' from public.posts where id = '50500000-0000-0000-0000-000000000001'));
update public.posts set status = 'closed' where id = '50500000-0000-0000-0000-000000000001';
update public.posts set status = 'closed' where id = '50500000-0000-0000-0000-000000000001';
select t.ok('SOS-01 завершение идемпотентно', (select status = 'closed' and resolved_at is not null from public.posts where id = '50500000-0000-0000-0000-000000000001'));
update public.posts set status = 'active' where id = '50500000-0000-0000-0000-000000000001';
select t.ok('SOS-01 закрытый SOS не открывается снова', (select status = 'closed' from public.posts where id = '50500000-0000-0000-0000-000000000001'));
insert into public.posts (user_id, category, text, lat, lng, expires_at) values ('30000000-0000-0000-0000-000000000003', 'talk', 'Вопрос', 43.2, 76.9, now() + interval '5 years');
select t.ok('SOS-01 срок обычной публикации тоже считает сервер', (select expires_at < now() + interval '91 days' from public.posts where text = 'Вопрос' and user_id = '30000000-0000-0000-0000-000000000003'));

-- ===== POST-01: скрытое место не раскрывает исходные координаты =====
insert into public.posts (id, user_id, category, text, lat, lng) values ('50500000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'talk', 'Где я', 43.238713, 76.945621);
update public.posts set lat = 43.238713, lng = 76.945621, exact = true where id = '50500000-0000-0000-0000-000000000002';
select t.ok('POST-01 точку и режим "точно" нельзя поменять после публикации', (select not exact and lat <> 43.238713 from public.posts where id = '50500000-0000-0000-0000-000000000002'));

-- ===== избранные места =====
insert into public.saved_places (user_id, name, lat, lng, radius) values ('30000000-0000-0000-0000-000000000003', 'Дом', 43.238713, 76.945621, 1000);
select t.ok('PLACES точка округлена (~100 м)', (select lat = 43.239 and lng = 76.946 from public.saved_places where user_id = '30000000-0000-0000-0000-000000000003'));
insert into public.saved_places (user_id, name, lat, lng) select '30000000-0000-0000-0000-000000000003', 'М' || g, 43.2, 76.9 from generate_series(1, 4) g;
select t.fail('PLACES не больше 5 мест', $$insert into public.saved_places (user_id, name, lat, lng) values ('30000000-0000-0000-0000-000000000003', 'Шестое', 43.2, 76.9)$$, 'NR422');
select t.as_user('30000000-0000-0000-0000-000000000004');
select t.ok('PLACES чужие места не видны', (select count(*) = 0 from public.saved_places));
select t.fail('PLACES нельзя создать место другому', $$insert into public.saved_places (user_id, name, lat, lng) values ('30000000-0000-0000-0000-000000000002', 'Чужое', 43.2, 76.9)$$, '42501');

-- ===== UX-02: сортировки ленты =====
reset role; select t.as_user(null);
insert into public.posts (id, user_id, category, text, lat, lng, exact, created_at) values
 ('5f000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004', 'incident', 'Свежее ДТП далеко', 43.2 + 2000.0/111195, 77.5, true, now() - interval '10 minutes'),
 ('5f000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000004', 'talk', 'Старое рядом', 43.2 + 100.0/111195, 77.5, true, now() - interval '5 days'),
 ('5f000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'talk', 'Новое среднее', 43.2 + 900.0/111195, 77.5, true, now() - interval '1 minute');
insert into public.friendships (requester_id, addressee_id, status) values ('30000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'accepted');
set role authenticated; select t.as_user('30000000-0000-0000-0000-000000000003');
select t.ok('UX-02 "Рядом" — по расстоянию', (select array_agg(post_id order by sort_dist) = array['5f000000-0000-0000-0000-000000000002','5f000000-0000-0000-0000-000000000003','5f000000-0000-0000-0000-000000000001']::uuid[]
   from public.feed_sorted(43.2, 77.5, 3000, null, 'near')));
select t.ok('UX-02 "Для вас" — срочное происшествие первым, даже если дальше', (select post_id = '5f000000-0000-0000-0000-000000000001' from public.feed_sorted(43.2, 77.5, 3000, null, 'top') limit 1));
select t.ok('UX-02 "Новое" — по времени', (select post_id = '5f000000-0000-0000-0000-000000000003' from public.feed_sorted(43.2, 77.5, 3000, null, 'new') limit 1));
select t.ok('UX-02 период "сегодня" скрывает старое', (select count(*) = 0 from public.feed_sorted(43.2, 77.5, 3000, null, 'new', 'today') where post_id = '5f000000-0000-0000-0000-000000000002'));
select t.ok('UX-02 "Друзья" — только публикации друзей', (select count(*) = 3 from public.feed_sorted(43.2, 77.5, 3000, null, 'new', null, true)));
select t.as_user('30000000-0000-0000-0000-000000000002');
select t.ok('UX-02 "Друзья" у человека без друзей пусто', (select count(*) = 0 from public.feed_sorted(43.2, 77.5, 3000, null, 'new', null, true)));
-- курсор "Рядом" без пропусков и дублей на 30 постах из v11 (одинаковое время)
create temp table seen2 (id uuid);
do $$ declare d double precision; i uuid; n int; r record; pg int := 0;
begin
  loop
    pg := pg + 1; n := 0;
    for r in select * from public.feed_sorted(43.2, 76.9, 10000, array['talk'], 'near', null, false, null, d, i) loop
      insert into seen2 values (r.post_id); n := n + 1; d := r.sort_dist; i := r.post_id;
    end loop;
    exit when n < 12 or pg > 10;
  end loop;
end $$;
select t.ok('UX-02 "Рядом": курсор без дублей и пропусков', (select count(*) = count(distinct id) and count(*) filter (where id::text like 'f0000000%') = 30 from seen2));

-- ===== поддержка и аналитика =====
reset role; set role anon; select t.as_user(null);
select public.send_feedback('Не открывается карта', '/app.html#map?x=1', '12.0');
reset role; set role authenticated; select t.as_user('30000000-0000-0000-0000-000000000003');
select t.ok('SUPPORT обычный пользователь не читает обращения', (select count(*) = 0 from public.feedback));
select t.ok('SUPPORT список обращений только администратору', (select public.feedback_list() is null));
select t.as_user('eeeeeeee-0000-0000-0000-00000000000e');
select t.ok('SUPPORT администратор видит обращение без параметров адреса', (select (public.feedback_list()->0->>'route') = '/app.html' ));
select public.track('filter_changed', '{"sort":"near","lat":43.2,"text":"секрет"}'::jsonb);
reset role;
select t.ok('ANALYTICS filter_changed без координат и текста', (select props = '{"sort":"near"}'::jsonb from public.analytics_events where name = 'filter_changed' order by id desc limit 1));

-- ===== PRIV-01: переписка удаленного аккаунта =====
reset role; select t.as_user('30000000-0000-0000-0000-000000000003');
select public.get_or_create_conversation('30000000-0000-0000-0000-000000000004');
reset role;
delete from auth.users where id = '30000000-0000-0000-0000-000000000004';
select t.ok('PRIV-01 у переписки удаленного отмечена дата (удаление через 30 дней)', (select orphaned_at is not null from public.conversations where user_a = '30000000-0000-0000-0000-000000000003' or user_b = '30000000-0000-0000-0000-000000000003'));
