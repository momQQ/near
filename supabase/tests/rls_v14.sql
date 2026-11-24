-- NEAR v14 (этап 1): никнейм, NEAR Clean, дневные лимиты, возрастной допуск, исправления v12.
-- Запускается после rls_v11.sql и rls_v12.sql на той же базе. Настройки v14 — по умолчанию (как в рабочей базе).
reset role; select t.as_user(null);
update public.app_settings set age_gate = true, media_requires_check = true, ai_moderation = false,
  day_limits = '{"post":[3,15],"comment":[20,100],"chat_request":[3,10],"meeting":[0,3]}'::jsonb;
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at, raw_app_meta_data) values
 ('40000000-0000-0000-0000-000000000001', 'v1@x.kz', '{"nickname":"Shadow","accepted_rules":"true","name":"Иван Петров","gender":"m"}', now(), '{}'),
 ('40000000-0000-0000-0000-000000000002', 'v2@x.kz', '{"nickname":"shadow","accepted_rules":"true"}', now(), '{}'),           -- тот же ник в другом регистре
 ('40000000-0000-0000-0000-000000000003', 'v3@x.kz', '{"full_name":"Google Name","accepted_rules":"true"}', now(), '{"provider":"google"}'),
 ('40000000-0000-0000-0000-000000000004', 'v4@x.kz', '{"nickname":"Ninja","accepted_rules":"true"}', now(), '{}'),
 ('40000000-0000-0000-0000-000000000005', 'v5@x.kz', '{"nickname":"Cake","accepted_rules":"true"}', now(), '{}');

-- ===== Q01: регистрация без имени, фамилии и пола =====
select t.ok('Q01 никнейм из регистрации сохранен, имя = никнейм', (select nickname = 'Shadow' and name = 'Shadow' from public.profiles where id = '40000000-0000-0000-0000-000000000001'));
select t.ok('Q01 имя и пол из метаданных не переносятся', (select gender is null and name not like '%Иван%' from public.profiles where id = '40000000-0000-0000-0000-000000000001'));
select t.ok('Q01 занятый ник (другой регистр) не выдается второму', (select nickname is null from public.profiles where id = '40000000-0000-0000-0000-000000000002'));
select t.ok('Q01 Google: full_name не становится именем', (select name = 'Новый пользователь' and nickname is null from public.profiles where id = '40000000-0000-0000-0000-000000000003'));
select t.ok('Q01 приватная строка создана, возраст неизвестен', (select age_status = 'unknown' from public.profile_private where user_id = '40000000-0000-0000-0000-000000000003'));

set role authenticated; select t.as_user('40000000-0000-0000-0000-000000000003');
select t.fail('Q01 без никнейма публиковать нельзя', $$insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000003', 'talk', 'Привет соседи', 43.2, 76.9)$$, 'NR403');
select t.fail('NICK короткий', $$select public.set_nickname('ab')$$, 'NR422');
select t.fail('NICK пробелы и ссылки', $$select public.set_nickname('t.me/spam')$$, 'NR422');
select t.fail('NICK смешанная раскладка', $$select public.set_nickname('Аdmin')$$, 'NR422');
select t.fail('NICK мат отклоняется (не маскируется)', $$select public.set_nickname('suka_2000')$$, 'NR422');
select t.fail('NICK похож на официальный', $$select public.set_nickname('NEAR_support')$$, 'NR422');
select t.fail('NICK похож на официальный (кириллица)', $$select public.set_nickname('Акимат_Алматы')$$, 'NR422');
select t.fail('NICK занят (регистр)', $$select public.set_nickname('SHADOW')$$, 'NR409');
select t.fail('NICK латиница с казахской і — смешанная раскладка', $$select public.set_nickname('Nіnja')$$, 'NR422');
select t.fail('NICK занят: "Саке" кириллицей выглядит как латинский "Cake"', $$select public.set_nickname('Саке')$$, 'NR409');
select t.ok('NICK подсказка: свободен', (select (public.nickname_check('Айдана_KZ')->>'ok')::boolean is false and (public.nickname_check('Айдана_92')->>'ok')::boolean));
select public.set_nickname('Айдана_92');
select t.ok('NICK установлен; имя = никнейм', (select nickname = 'Айдана_92' and name = 'Айдана_92' from public.profiles where id = '40000000-0000-0000-0000-000000000003'));
select public.set_nickname('айдана_92');
select t.ok('NICK смена регистра не считается сменой', (select nickname = 'айдана_92' from public.profiles where id = '40000000-0000-0000-0000-000000000003'));
select t.fail('NICK меняется не чаще 30 дней', $$select public.set_nickname('Aidana_new')$$, 'NR429');
select t.fail('NICK прямое изменение никнейма запрещено', $$update public.profiles set nickname = 'hack' where id = '40000000-0000-0000-0000-000000000003'$$, '42501');
select t.ok('NICK история не видна обычному пользователю', (select count(*) = 0 from public.nickname_history));
select t.fail('NICK приватные данные не видны через API', $$select * from public.profile_private$$, '42501');
select t.ok('NICK свой статус — через my_account', (select (public.my_account()->>'age_status') = 'unknown' and (public.my_account()->>'age_ok')::boolean = false));
insert into public.posts (id, user_id, category, text, lat, lng) values ('4f000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003', 'talk', 'Привет, соседи!', 43.2, 76.9);
select t.ok('Q01 старый аккаунт без пола публикует после выбора ника', (select count(*) = 1 from public.posts where id = '4f000000-0000-0000-0000-000000000001'));
reset role;
select t.ok('NICK история видна модератору', (select count(*) = 2 from public.nickname_history where user_id = '40000000-0000-0000-0000-000000000003'));

-- ===== Q02: NEAR Clean в публикациях, комментариях, сообщениях и описании =====
set role authenticated; select t.as_user('40000000-0000-0000-0000-000000000001');
insert into public.posts (id, user_id, category, text, lat, lng) values ('4f000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'incident', 'Блять, опять пробка на Абая', 43.2, 76.9);
select t.ok('Q02 публикация: "Б****, опять пробка"', (select text = 'Б****, опять пробка на Абая' from public.posts where id = '4f000000-0000-0000-0000-000000000002'));
select t.fail('Q02 угроза не публикуется', $$insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000001', 'talk', 'Найду и убью тебя', 43.2, 76.9)$$, 'NR422');
insert into public.comments (post_id, user_id, text) values ('4f000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'Fuck, shit happens');
select t.ok('Q02 комментарий: F*** / s***', (select text = 'F***, s*** happens' from public.comments where user_id = '40000000-0000-0000-0000-000000000001' order by created_at desc limit 1));
update public.posts set text = 'Обновил: сука, пробка' where id = '4f000000-0000-0000-0000-000000000002';
select t.ok('Q02 редактирование тоже маскируется', (select text = 'Обновил: с***, пробка' from public.posts where id = '4f000000-0000-0000-0000-000000000002'));
update public.profiles set bio = 'Люблю горы, пиздец как' where id = '40000000-0000-0000-0000-000000000001';
select t.ok('Q02 описание профиля маскируется', (select bio = 'Люблю горы, п***** как' from public.profiles where id = '40000000-0000-0000-0000-000000000001'));
select t.ok('Q02 обычные слова не трогаются', (select public.near_clean('Небо, хлеб, сукно, eBay, себе') = 'Небо, хлеб, сукно, eBay, себе'));
reset role;

-- ===== Q05: незнакомые — только при возрастном допуске обеих сторон =====
set role authenticated; select t.as_user('40000000-0000-0000-0000-000000000001');
select t.fail('Q05 чат с незнакомым при неизвестном возрасте закрыт', $$select public.get_or_create_conversation('40000000-0000-0000-0000-000000000004')$$, 'NR403');
reset role;
insert into public.friendships (requester_id, addressee_id, status) values ('40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000005', 'accepted');
set role authenticated; select t.as_user('40000000-0000-0000-0000-000000000001');
select t.ok('Q05 с другом переписка открывается', (select public.get_or_create_conversation('40000000-0000-0000-0000-000000000005') is not null));
select t.fail('Q05 пользователь не отмечает себе возраст', $$select public.admin_set_private('40000000-0000-0000-0000-000000000001', 'adult')$$, 'NR403');
select t.as_user('eeeeeeee-0000-0000-0000-00000000000e');
select public.admin_set_private('40000000-0000-0000-0000-000000000001', 'adult');
select public.admin_set_private('40000000-0000-0000-0000-000000000004', 'adult');
select t.as_user('40000000-0000-0000-0000-000000000001');
select t.ok('Q05 после проверки возраста обеих сторон — запрос в чат', (select public.get_or_create_conversation('40000000-0000-0000-0000-000000000004') is not null));
reset role;

-- ===== Q04/08: дневные лимиты, 429 + retry_after, повтор без двойного списания, дубликаты =====
set role authenticated; select t.as_user('40000000-0000-0000-0000-000000000004');
insert into public.posts (user_id, category, text, lat, lng, client_key) values ('40000000-0000-0000-0000-000000000004', 'talk', 'Первая публикация дня', 43.2, 76.9, 'key-0001-aaaa');
select t.fail('LIM одинаковый текст за сутки — повтор', $$insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000004', 'talk', 'ПЕРВАЯ публикация дня!!', 43.2, 76.9)$$, 'NR409');
insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000004', 'talk', 'Вторая публикация', 43.2, 76.9);
insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000004', 'talk', 'Третья публикация', 43.2, 76.9);
do $$ begin
  insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000004', 'talk', 'Четвертая публикация', 43.2, 76.9);
  raise notice 'FAIL: LIM 4-я публикация за день (ошибки не было)';
exception when others then
  declare h text; begin get stacked diagnostics h = pg_exception_hint;
    perform t.ok('LIM 4-я публикация нового аккаунта: 429 + retry_after', sqlstate = 'NR429' and h like 'retry_after=%action=post'); end;
end $$;
insert into public.posts (user_id, category, text, lat, lng, is_sos) values ('40000000-0000-0000-0000-000000000004', 'incident', 'SOS: нужна помощь', 43.2, 76.9, true);
select t.ok('LIM SOS не упирается в дневной лимит публикаций', (select count(*) = 1 from public.posts where user_id = '40000000-0000-0000-0000-000000000004' and is_sos));
select t.fail('LIM счетчики не видны пользователю', $$select * from public.rate_counters$$, '42501');
reset role;
select t.ok('LIM счетчик не превысил лимит', (select n = 3 from public.rate_counters where user_id = '40000000-0000-0000-0000-000000000004' and action = 'post'));
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000005', false);
select public.rate_take('meeting_t', 'idem-key-0001'); -- действие без лимита: не считается
update public.app_settings set day_limits = day_limits || '{"probe":[2,2]}'::jsonb;
select public.rate_take('probe', 'idem-key-0001'); select public.rate_take('probe', 'idem-key-0001'); select public.rate_take('probe', 'idem-key-0001');
select t.ok('LIM повтор с тем же ключом списан один раз', (select n = 1 from public.rate_counters where user_id = '40000000-0000-0000-0000-000000000005' and action = 'probe'));
select public.rate_take('probe', 'idem-key-0002');
select t.fail('LIM лимит probe исчерпан', $$select public.rate_take('probe', 'idem-key-0003')$$, 'NR429');
select t.ok('LIM неудачная попытка не оставила ключ', (select count(*) = 0 from public.rate_idem where key = 'idem-key-0003'));
select set_config('request.jwt.claim.sub', '', false);
reset role;
-- телефон подтвержден — лимит выше
select t.as_user('eeeeeeee-0000-0000-0000-00000000000e'); set role authenticated;
select public.admin_set_private('40000000-0000-0000-0000-000000000004', null, true);
select t.as_user('40000000-0000-0000-0000-000000000004');
insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000004', 'talk', 'С подтвержденным телефоном можно больше', 43.2, 76.9);
reset role;
select t.ok('LIM телефон подтвержден: лимит 15', (select n = 4 from public.rate_counters where user_id = '40000000-0000-0000-0000-000000000004' and action = 'post'));
set role authenticated; select t.as_user('40000000-0000-0000-0000-000000000004');
-- комментарии: одинаковый текст подряд
insert into public.comments (post_id, user_id, text) values ('4f000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', 'Отличная новость, спасибо!');
select t.fail('LIM одинаковый комментарий подряд', $$insert into public.comments (post_id, user_id, text) values ('4f000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000004', 'Отличная новость, спасибо')$$, 'NR409');
-- новые запросы в чат: 3 в день у нового аккаунта (возраст у всех подтверждаем)
reset role; select t.as_user(null);
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) select ('41000000-0000-0000-0000-00000000000' || g)::uuid, 'c' || g || '@x.kz', jsonb_build_object('nickname', 'chat_user_' || g, 'accepted_rules', 'true'), now() from generate_series(1, 5) g;
update public.profile_private set age_status = 'adult' where user_id::text like '41000000%';
set role authenticated; select t.as_user('41000000-0000-0000-0000-000000000001');
select public.get_or_create_conversation('41000000-0000-0000-0000-000000000002');
select public.get_or_create_conversation('41000000-0000-0000-0000-000000000003');
select public.get_or_create_conversation('41000000-0000-0000-0000-000000000004');
select t.ok('LIM повторное открытие той же переписки не списывает лимит', (select public.get_or_create_conversation('41000000-0000-0000-0000-000000000004') is not null));
select t.fail('LIM 4-й новый запрос в чат за день', $$select public.get_or_create_conversation('41000000-0000-0000-0000-000000000005')$$, 'NR429');
reset role;

-- ===== Q03/02: медиа без серверной проверки не принимаются =====
set role authenticated; select t.as_user('40000000-0000-0000-0000-000000000001');
select t.fail('MEDIA без ИИ-проверки файл в публикацию не принимается', $$insert into public.post_media (post_id, user_id, url, type, position, path) values ('4f000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'https://x/y.jpg', 'image', 0, '40000000-0000-0000-0000-000000000001/4f000000-0000-0000-0000-000000000002/0.jpg')$$, 'NR503');
select t.ok('MEDIA my_account сообщает, что файлы недоступны', (select (public.my_account()->>'media_ok')::boolean = false));
reset role;

-- ===== 02: исправления v12 =====
-- закрытый SOS не поднимается в "Для вас"
set role authenticated; select t.as_user('40000000-0000-0000-0000-000000000005');
insert into public.posts (id, user_id, category, text, lat, lng, is_sos) values ('4f000000-0000-0000-0000-000000000050', '40000000-0000-0000-0000-000000000005', 'incident', 'SOS: машина в кювете', 44.5, 78.5, true);
select t.ok('FEED действующий SOS поднят', (select sort_score >= 1000 from public.feed_sorted(44.5, 78.5, 3000, null, 'top') where post_id = '4f000000-0000-0000-0000-000000000050'));
update public.posts set status = 'closed' where id = '4f000000-0000-0000-0000-000000000050';
select t.ok('FEED закрытый SOS не поднимается', (select sort_score < 1000 from public.feed_sorted(44.5, 78.5, 3000, null, 'top') where post_id = '4f000000-0000-0000-0000-000000000050'));
reset role; select t.as_user(null);
-- "Для вас": снимок; новые лайки и публикации между страницами не дают дублей и пропусков
insert into public.posts (id, user_id, category, text, lat, lng, created_at)
select ('4e000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, '40000000-0000-0000-0000-000000000005', 'talk', 'Топ ' || g, 44.6 + g * 0.0005, 78.6, now() - (g || ' minutes')::interval from generate_series(1, 30) g;
create temp table seen_top (id uuid, pg int);
do $$ declare s double precision; i uuid; snap timestamptz; n int; r record; pg int := 0;
begin
  loop
    pg := pg + 1; n := 0;
    for r in select * from public.feed_sorted(44.6, 78.6, 10000, array['talk'], 'top', null, false, null, null, i, 0, 12, s, snap) loop
      insert into seen_top values (r.post_id, pg); n := n + 1; s := r.sort_score; i := r.post_id; snap := r.snapshot;
    end loop;
    if pg = 1 then
      -- между страницами: много лайков у публикации со 2-й страницы и новая публикация
      insert into public.likes (post_id, user_id) select '4e000000-0000-0000-0000-000000000025', id from public.profiles limit 20;
      insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000005', 'talk', 'Новая после снимка', 44.6, 78.6);
    end if;
    exit when n < 12 or pg > 10;
  end loop;
end $$;
select t.ok('FEED "Для вас": снимок без дублей и пропусков (30 из 30)', (select count(*) = count(distinct id) and count(*) filter (where id::text like '4e000000%') = 30 from seen_top));
select t.ok('FEED "Для вас": публикация после снимка не вклинилась', (select count(*) = 0 from seen_top s join public.posts p on p.id = s.id where p.text = 'Новая после снимка'));
-- карта: фильтр "друзья" до лимита — 600 свежих публикаций не друзей не прячут старую публикацию друга
insert into public.posts (id, user_id, category, text, lat, lng, created_at) values ('4d000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000005', 'lost', 'Потерялся кот', 45.0, 79.0, now() - interval '20 minutes');
insert into public.posts (user_id, category, text, lat, lng, created_at) select '40000000-0000-0000-0000-000000000004', 'talk', 'Шум ' || g, 45.0 + g * 0.00001, 79.0, now() - (g || ' seconds')::interval from generate_series(1, 600) g;
set role authenticated; select t.as_user('40000000-0000-0000-0000-000000000001');
select t.ok('MAP "друзья": 600 чужих точек не прячут публикацию друга', (select count(*) = 1 from public.map_posts2(78.9, 44.9, 79.1, 45.1, null, null, null, null, null, true) where id = '4d000000-0000-0000-0000-000000000001'));
select t.ok('MAP период "неделя" + друзья: фильтр до лимита', (select count(*) = 1 from public.map_posts2(78.9, 44.9, 79.1, 45.1, null, null, null, null, 'week', true) where id = '4d000000-0000-0000-0000-000000000001'));
reset role;
