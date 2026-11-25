-- NEAR v11: автоматическая матрица прав и правил (гость, A, B, C, модератор, админ, сервис).
-- Каждая проверка печатает PASS или FAIL. Запуск: sh supabase/tests/run_tests.sh
create schema t;
grant usage on schema t to anon, authenticated;
create function t.ok(name text, cond boolean) returns void language plpgsql as $$
begin raise notice '%: %', case when coalesce(cond, false) then 'PASS' else 'FAIL' end, name; end $$;
create function t.fail(name text, q text, code text default null) returns void language plpgsql as $$
begin
  begin execute q;
  exception when others then
    if code is null or sqlstate = code then raise notice 'PASS: % (%: %)', name, sqlstate, sqlerrm;
    else raise notice 'FAIL: % (ожидали %, получили %: %)', name, code, sqlstate, sqlerrm; end if;
    return;
  end;
  raise notice 'FAIL: % (ошибки не было)', name;
end $$;
create function t.as_user(uid text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(uid, ''), false); end $$;
grant execute on all functions in schema t to anon, authenticated;

-- пользователи: A, B, C (обычные), M (модератор), Z (админ), N1..N3 (новые), O1..O3 (старые)
insert into auth.users (id, email, raw_user_meta_data) values
 ('aaaaaaaa-0000-0000-0000-00000000000a', 'a@x.kz', '{"name":"Айгерим"}'),
 ('bbbbbbbb-0000-0000-0000-00000000000b', 'b@x.kz', '{"name":"Бекзат"}'),
 ('cccccccc-0000-0000-0000-00000000000c', 'c@x.kz', '{"name":"Сауле"}'),
 ('dddddddd-0000-0000-0000-00000000000d', 'm@x.kz', '{"name":"Модератор"}'),
 ('eeeeeeee-0000-0000-0000-00000000000e', 'z@x.kz', '{"name":"Админ"}'),
 ('10000000-0000-0000-0000-000000000001', 'n1@x.kz', '{}'), ('10000000-0000-0000-0000-000000000002', 'n2@x.kz', '{}'),
 ('10000000-0000-0000-0000-000000000003', 'n3@x.kz', '{}'), ('20000000-0000-0000-0000-000000000001', 'o1@x.kz', '{}'),
 ('20000000-0000-0000-0000-000000000002', 'o2@x.kz', '{}'), ('20000000-0000-0000-0000-000000000003', 'o3@x.kz', '{}');
-- v12: публиковать могут только подтвердившие email и заполнившие профиль
update auth.users set email_confirmed_at = now();
update public.profiles set gender = 'f', accepted_rules_at = now(), verified = false;
update public.profiles set gender = null where id = 'aaaaaaaa-0000-0000-0000-00000000000a';
update public.profiles set is_moderator = true where id = 'dddddddd-0000-0000-0000-00000000000d';
update public.profiles set is_admin = true where id = 'eeeeeeee-0000-0000-0000-00000000000e';
update public.profiles set created_at = now() - interval '60 days' where id::text like '20000000%' or id::text like 'aaaa%' or id::text like 'bbbb%' or id::text like 'cccc%';
update public.app_settings set limits = limits || '{"comment":[3,100,"1 hour"],"post":[10,40,"1 hour"],"chat":[100,400,"1 minute"]}'::jsonb;
-- v14.9: проверки v11/v12 идут в режиме без обязательной сессии и MFA; Shield проверяется отдельно в rls_v14.sql
update public.app_settings set shield = shield || '{"enforce_sessions":false,"admin_mfa":false,"dm":true}'::jsonb;
update public.profiles set nickname = 'u' || left(md5(id::text), 12);

-- ===== SEC-01: профиль =====
set role authenticated; select t.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
select t.fail('SEC-01 A не может создать профиль напрямую', $$insert into public.profiles (id, name) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'x')$$, '42501');
select t.fail('SEC-01 upsert профиля запрещен', $$insert into public.profiles (id, name, is_admin) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'x', true) on conflict (id) do update set is_admin = true$$, '42501');
update public.profiles set is_admin = true, is_moderator = true, verified = true, banned = false, name = 'Айгерим К.' where id = 'aaaaaaaa-0000-0000-0000-00000000000a';
select t.ok('SEC-01 A не назначил себе роль и значок', (select not is_admin and not is_moderator and not verified and name = 'Айгерим К.' from public.profiles where id = 'aaaaaaaa-0000-0000-0000-00000000000a'));
update public.profiles set name = 'Взлом' where id = 'bbbbbbbb-0000-0000-0000-00000000000b';
select t.ok('SEC-01 A не меняет чужой профиль', (select name = 'Бекзат' from public.profiles where id = 'bbbbbbbb-0000-0000-0000-00000000000b'));
update public.profiles set gender = 'f' where id = 'aaaaaaaa-0000-0000-0000-00000000000a';
update public.profiles set gender = 'm' where id = 'aaaaaaaa-0000-0000-0000-00000000000a';
select t.ok('SEC-01 пол задается один раз', (select gender = 'f' from public.profiles where id = 'aaaaaaaa-0000-0000-0000-00000000000a'));
reset role;
delete from public.profiles where id = '10000000-0000-0000-0000-000000000003';
set role authenticated; select t.as_user('10000000-0000-0000-0000-000000000003');
select public.ensure_profile();
select t.ok('SEC-01 ensure_profile создает профиль без привилегий', (select not is_admin and not verified from public.profiles where id = '10000000-0000-0000-0000-000000000003'));
reset role;

-- ===== публикации: черновик, приблизительное место, лимит вложений, ключ повтора =====
set role authenticated; select t.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
insert into public.posts (id, user_id, category, text, lat, lng, status, client_key)
values ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'talk', 'Привет, район', 43.23871, 76.94562, 'draft', 'key-12345678');
select t.ok('POST-01 место приблизительное по умолчанию', (select lat <> 43.23871 and abs(lat - 43.23871) < 0.0011 from public.posts where id = 'a0000000-0000-0000-0000-000000000001'));
select t.fail('POST-01 повтор с тем же ключом не создает дубль', $$insert into public.posts (user_id, category, text, lat, lng, status, client_key) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'talk', 'x', 43.2, 76.9, 'draft', 'key-12345678')$$, '23505');
insert into public.post_media (post_id, user_id, url, path) select 'a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'u' || g, 'aaaaaaaa-0000-0000-0000-00000000000a/a/' || g || '.jpg' from generate_series(1, 5) g;
select t.fail('POST-01 шестое вложение отклоняется', $$insert into public.post_media (post_id, user_id, url, path) values ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'u6', 'aaaaaaaa-0000-0000-0000-00000000000a/a/6.jpg')$$, 'NR422');
select t.fail('POST-01 чужая папка файла отклоняется', $$insert into public.post_media (post_id, user_id, url, path) values ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'u7', 'bbbbbbbb-0000-0000-0000-00000000000b/7.jpg')$$);
insert into public.posts (id, user_id, category, text, lat, lng, exact) values ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-00000000000a', 'event', 'Субботник', 43.23871, 76.94562, true);
select t.ok('POST-01 точное место — осознанный выбор', (select lat = 43.23871 from public.posts where id = 'a0000000-0000-0000-0000-000000000002'));
insert into public.events (post_id, starts_at, capacity) values ('a0000000-0000-0000-0000-000000000002', now() + interval '1 day', 1);
select t.ok('POST-02 срок события = начало + 6 ч', (select abs(extract(epoch from expires_at - (now() + interval '30 hours'))) < 5 from public.posts where id = 'a0000000-0000-0000-0000-000000000002'));
select t.fail('SEC-01 A не публикует от имени B', $$insert into public.posts (user_id, category, text, lat, lng) values ('bbbbbbbb-0000-0000-0000-00000000000b', 'talk', 'fake', 43.2, 76.9)$$, '42501');
select t.fail('SEC-01 A не создает пост сразу скрытым', $$insert into public.posts (user_id, category, text, lat, lng, status) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'talk', 'x', 43.2, 76.9, 'hidden')$$, '42501');

select t.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
select t.ok('SEC-02 B не видит черновик A', (select count(*) = 0 from public.posts where id = 'a0000000-0000-0000-0000-000000000001'));
select t.ok('SEC-02 B не видит файлы черновика A', (select count(*) = 0 from public.post_media where post_id = 'a0000000-0000-0000-0000-000000000001'));
insert into public.event_members (post_id, user_id) values ('a0000000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-00000000000b');
select t.as_user('cccccccc-0000-0000-0000-00000000000c');
select t.fail('POST-02 мест нет — второй участник не проходит', $$insert into public.event_members (post_id, user_id) values ('a0000000-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-00000000000c')$$, 'NR409');
select t.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
delete from public.event_members where post_id = 'a0000000-0000-0000-0000-000000000002' and user_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
select t.as_user('cccccccc-0000-0000-0000-00000000000c');
insert into public.event_members (post_id, user_id) values ('a0000000-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-00000000000c');
select t.ok('POST-02 отмена участия освобождает место', (select count(*) = 1 from public.event_members where post_id = 'a0000000-0000-0000-0000-000000000002'));

-- v14.9: файлы проверяет сервер; для этих проверок считаем их одобренными
reset role; select t.as_user(null); update public.post_media set state = 'approved' where post_id = 'a0000000-0000-0000-0000-000000000001'; set role authenticated;
-- ===== SEC-02: скрытый модератором пост =====
select t.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
update public.posts set status = 'active' where id = 'a0000000-0000-0000-0000-000000000001';
select t.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
insert into public.comments (post_id, user_id, text) values ('a0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-00000000000b', 'Комментарий');
insert into public.likes (post_id, user_id) values ('a0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-00000000000b');
select t.as_user('cccccccc-0000-0000-0000-00000000000c');
select t.fail('MOD обычный пользователь не модерирует', $$select public.mod_act('post', 'a0000000-0000-0000-0000-000000000001', 'hide')$$, 'NR403');
select t.as_user('dddddddd-0000-0000-0000-00000000000d');
select public.mod_act('post', 'a0000000-0000-0000-0000-000000000001', 'hide', 'проверка');
select t.fail('MOD модератор не банит (только админ)', $$select public.mod_act('user', 'bbbbbbbb-0000-0000-0000-00000000000b', 'ban')$$, 'NR403');
select t.as_user('cccccccc-0000-0000-0000-00000000000c');
select t.ok('SEC-02 третий аккаунт не видит скрытый пост', (select count(*) = 0 from public.posts where id = 'a0000000-0000-0000-0000-000000000001'));
select t.ok('SEC-02 третий аккаунт не видит комментарии скрытого', (select count(*) = 0 from public.comments where post_id = 'a0000000-0000-0000-0000-000000000001'));
select t.ok('SEC-02 третий аккаунт не видит файлы скрытого', (select count(*) = 0 from public.post_media where post_id = 'a0000000-0000-0000-0000-000000000001'));
select t.ok('SEC-02 третий аккаунт не видит лайки скрытого', (select count(*) = 0 from public.likes where post_id = 'a0000000-0000-0000-0000-000000000001'));
select t.fail('SEC-02 нельзя комментировать скрытый', $$insert into public.comments (post_id, user_id, text) values ('a0000000-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000000c', 'x')$$, '42501');
reset role; set role anon; select t.as_user(null);
select t.ok('SEC-02 гость не видит скрытый пост и комментарии', (select count(*) = 0 from public.posts where id = 'a0000000-0000-0000-0000-000000000001') and (select count(*) = 0 from public.comments where post_id = 'a0000000-0000-0000-0000-000000000001'));
reset role; set role authenticated; select t.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
update public.posts set status = 'active' where id = 'a0000000-0000-0000-0000-000000000001';
select t.ok('SEC-02 автор не снимает ограничение модератора', (select status = 'hidden' from public.posts where id = 'a0000000-0000-0000-0000-000000000001'));
select t.ok('SEC-02 автор видит свой скрытый пост', (select count(*) = 1 from public.posts where id = 'a0000000-0000-0000-0000-000000000001'));
insert into public.appeals (user_id, target_type, target_id, text) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'post', 'a0000000-0000-0000-0000-000000000001', 'Это обычный пост о районе');
select t.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
select t.fail('SEC-08 апелляция на чужой пост запрещена', $$insert into public.appeals (user_id, target_type, target_id, text) values ('bbbbbbbb-0000-0000-0000-00000000000b', 'post', 'a0000000-0000-0000-0000-000000000001', 'чужой пост')$$, '42501');
select t.as_user('dddddddd-0000-0000-0000-00000000000d');
select public.mod_act('appeal', (select id from public.appeals limit 1), 'accept', 'нарушений нет');
select t.ok('SEC-08 принятая апелляция возвращает пост', (select status = 'active' from public.posts where id = 'a0000000-0000-0000-0000-000000000001'));
select t.ok('SEC-08 история решений сохраняется', (select jsonb_array_length(public.mod_history('post', 'a0000000-0000-0000-0000-000000000001')->'actions') >= 1));

-- ===== SEC-08: жалобы с весом доверия =====
select t.as_user('cccccccc-0000-0000-0000-00000000000c');
insert into public.posts (id, user_id, category, text, lat, lng) values ('c0000000-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000000c', 'talk', 'Пост для жалоб', 43.25, 76.95);
select t.as_user('10000000-0000-0000-0000-000000000001');
insert into public.reports (reporter_id, target_type, target_id, reason) values ('10000000-0000-0000-0000-000000000001', 'post', 'c0000000-0000-0000-0000-000000000001', 'spam');
select t.fail('SEC-08 повторная жалоба не засчитывается', $$insert into public.reports (reporter_id, target_type, target_id, reason) values ('10000000-0000-0000-0000-000000000001', 'post', 'c0000000-0000-0000-0000-000000000001', 'spam')$$, '23505');
select t.fail('SEC-08 нельзя подать жалобу от имени системы', $$insert into public.reports (reporter_id, target_type, target_id, reason, source) values ('10000000-0000-0000-0000-000000000001', 'comment', 'c0000000-0000-0000-0000-000000000001', 'spam', 'ai')$$, '42501');
select t.as_user('10000000-0000-0000-0000-000000000002');
insert into public.reports (reporter_id, target_type, target_id, reason) values ('10000000-0000-0000-0000-000000000002', 'post', 'c0000000-0000-0000-0000-000000000001', 'spam');
select t.as_user('10000000-0000-0000-0000-000000000003');
insert into public.reports (reporter_id, target_type, target_id, reason) values ('10000000-0000-0000-0000-000000000003', 'post', 'c0000000-0000-0000-0000-000000000001', 'spam');
reset role;
select t.ok('SEC-08 три новых аккаунта не скрывают пост (вес 1,5)', (select status = 'active' from public.posts where id = 'c0000000-0000-0000-0000-000000000001'));
set role authenticated;
select t.as_user('20000000-0000-0000-0000-000000000001');
insert into public.reports (reporter_id, target_type, target_id, reason) values ('20000000-0000-0000-0000-000000000001', 'post', 'c0000000-0000-0000-0000-000000000001', 'spam');
select t.as_user('20000000-0000-0000-0000-000000000002');
insert into public.reports (reporter_id, target_type, target_id, reason) values ('20000000-0000-0000-0000-000000000002', 'post', 'c0000000-0000-0000-0000-000000000001', 'spam');
reset role;
select t.ok('SEC-08 жалобы доверенных аккаунтов скрывают пост', (select status = 'hidden' from public.posts where id = 'c0000000-0000-0000-0000-000000000001'));
set role authenticated; select t.as_user('20000000-0000-0000-0000-000000000003');
select t.ok('SEC-08 обычный пользователь не видит чужие жалобы', (select count(*) = 0 from public.reports));

-- ===== SEC-07: лимиты =====
select t.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
insert into public.comments (post_id, user_id, text) values ('a0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-00000000000b', 'два');
insert into public.comments (post_id, user_id, text) values ('a0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-00000000000b', 'три');
select t.fail('SEC-07 лимит комментариев срабатывает', $$insert into public.comments (post_id, user_id, text) values ('a0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-00000000000b', 'четыре')$$, 'NR429');

-- ===== SOS =====
select t.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
select t.fail('SOS только для происшествия', $$insert into public.posts (user_id, category, text, lat, lng, is_sos) values ('bbbbbbbb-0000-0000-0000-00000000000b', 'talk', 'SOS', 43.2, 76.9, true)$$, 'NR422');
insert into public.posts (id, user_id, category, text, lat, lng, is_sos) values ('b0000000-0000-0000-0000-00000000005a', 'bbbbbbbb-0000-0000-0000-00000000000b', 'incident', 'Нужна помощь', 43.2, 76.9, true);
select t.fail('SOS второй активный не создается', $$insert into public.posts (user_id, category, text, lat, lng, is_sos) values ('bbbbbbbb-0000-0000-0000-00000000000b', 'incident', 'Еще', 43.2, 76.9, true)$$, 'NR409');
insert into public.posts (user_id, category, text, lat, lng) values ('bbbbbbbb-0000-0000-0000-00000000000b', 'incident', 'Обычный текст со словом SOS внутри', 43.2, 76.9);
select t.ok('SOS слово в тексте не делает пост экстренным', (select count(*) = 1 from public.posts where user_id = 'bbbbbbbb-0000-0000-0000-00000000000b' and is_sos));
select t.ok('SOS срок 3 часа', (select expires_at < now() + interval '3 hours 1 minute' from public.posts where id = 'b0000000-0000-0000-0000-00000000005a'));
update public.posts set is_sos = false where id = 'b0000000-0000-0000-0000-00000000005a';
select t.ok('SOS признак не меняется автором', (select is_sos from public.posts where id = 'b0000000-0000-0000-0000-00000000005a'));
update public.posts set status = 'closed' where id = 'b0000000-0000-0000-0000-00000000005a';
select t.ok('SOS закрытие ставит resolved_at', (select resolved_at is not null from public.posts where id = 'b0000000-0000-0000-0000-00000000005a'));

-- ===== CHAT-01: запросы на общение =====
select t.as_user('cccccccc-0000-0000-0000-00000000000c');
select set_config('t.conv', public.get_or_create_conversation('aaaaaaaa-0000-0000-0000-00000000000a')::text, false);
select t.ok('CHAT-01 незнакомцу — запрос', (select status = 'request' from public.conversations where id = current_setting('t.conv')::uuid));
select t.fail('CHAT-01 ссылка до принятия запрещена', format($$insert into public.messages (conversation_id, sender_id, text) values (%L, 'cccccccc-0000-0000-0000-00000000000c', 'смотри https://spam.kz')$$, current_setting('t.conv')), 'NR422');
insert into public.messages (conversation_id, sender_id, text) values (current_setting('t.conv')::uuid, 'cccccccc-0000-0000-0000-00000000000c', 'Здравствуйте, вы потеряли ключи?');
select t.fail('CHAT-01 второе сообщение до принятия запрещено', format($$insert into public.messages (conversation_id, sender_id, text) values (%L, 'cccccccc-0000-0000-0000-00000000000c', 'Ау')$$, current_setting('t.conv')), 'NR403');
select t.fail('CHAT-01 файл в переписку до принятия запрещен', format($$insert into storage.objects (bucket_id, name) values ('chat-media', 'cccccccc-0000-0000-0000-00000000000c/%s/1.jpg')$$, current_setting('t.conv')), '42501');
select t.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
select t.ok('CHAT-01 B не читает переписку A и C', (select count(*) = 0 from public.messages where conversation_id = current_setting('t.conv')::uuid));
select t.fail('CHAT-01 B не отвечает на чужой запрос', format($$select public.conversation_respond(%L, true)$$, current_setting('t.conv')), 'NR404');
select t.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
select public.conversation_respond(current_setting('t.conv')::uuid, false);
select t.as_user('cccccccc-0000-0000-0000-00000000000c');
select t.fail('CHAT-01 после отказа контакт прекращен', format($$insert into public.messages (conversation_id, sender_id, text) values (%L, 'cccccccc-0000-0000-0000-00000000000c', 'Ну пожалуйста')$$, current_setting('t.conv')), 'NR403');
select t.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
insert into public.messages (conversation_id, sender_id, text) values (current_setting('t.conv')::uuid, 'aaaaaaaa-0000-0000-0000-00000000000a', 'Да, мои! Спасибо');
select t.ok('CHAT-01 ответ получателя принимает запрос', (select status = 'accepted' from public.conversations where id = current_setting('t.conv')::uuid));
select t.as_user('cccccccc-0000-0000-0000-00000000000c');
insert into public.messages (conversation_id, sender_id, text) values (current_setting('t.conv')::uuid, 'cccccccc-0000-0000-0000-00000000000c', 'Где встретимся? https://2gis.kz');
select t.ok('CHAT-01 после принятия можно писать и ссылки', (select count(*) = 3 from public.messages where conversation_id = current_setting('t.conv')::uuid));
select t.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
insert into public.blocks (blocker_id, blocked_id) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'cccccccc-0000-0000-0000-00000000000c');
select t.as_user('cccccccc-0000-0000-0000-00000000000c');
select t.fail('CHAT-01 блокировка: сообщение через API не проходит', format($$insert into public.messages (conversation_id, sender_id, text) values (%L, 'cccccccc-0000-0000-0000-00000000000c', 'Ответь')$$, current_setting('t.conv')), 'NR403');
select t.fail('CHAT-01 блокировка: новую переписку не открыть', $$select public.get_or_create_conversation('aaaaaaaa-0000-0000-0000-00000000000a')$$, 'NR403');

-- ===== FEED-01: геовыборка и курсор =====
reset role; select t.as_user(null);
-- 30 публикаций с одинаковым временем по кругу на разных расстояниях от центра (43.2, 76.9)
insert into public.posts (id, user_id, category, text, lat, lng, exact, created_at)
select ('f0000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'bbbbbbbb-0000-0000-0000-00000000000b', 'talk', 'Лента ' || g,
       43.2 + (g * 290.0 / 111195.0), 76.9, true, '2026-01-01 12:00:00+00'
  from generate_series(1, 30) g;
-- заблокированный автор, просроченный и черновик — не попадают в ленту
insert into public.posts (user_id, category, text, lat, lng, exact, created_at) values ('cccccccc-0000-0000-0000-00000000000c', 'talk', 'От заблокированного', 43.2001, 76.9, true, now());
insert into public.posts (user_id, category, text, lat, lng, exact, expires_at) values ('bbbbbbbb-0000-0000-0000-00000000000b', 'incident', 'Просрочено', 43.2002, 76.9, true, now() - interval '1 minute');
insert into public.posts (user_id, category, text, lat, lng, exact, status) values ('bbbbbbbb-0000-0000-0000-00000000000b', 'talk', 'Черновик', 43.2003, 76.9, true, 'draft');
set role authenticated; select t.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
create temp table seen (id uuid, page int);
do $$
declare cur_ts timestamptz; cur_id uuid; pg int := 0; n int; r record;
begin
  loop
    pg := pg + 1; n := 0;
    for r in select * from public.feed_page(43.2, 76.9, 10000, array['talk'], cur_ts, cur_id) loop
      insert into seen values (r.id, pg); n := n + 1; cur_ts := r.created_at; cur_id := r.id;
    end loop;
    if n > 12 then raise notice 'FAIL: FEED-01 больше 12 на странице'; end if;
    exit when n < 12 or pg > 10;
  end loop;
end $$;
select t.ok('FEED-01 одинаковое время: нет дублей', (select count(*) = count(distinct id) from seen));
select t.ok('FEED-01 одинаковое время: нет пропусков (30 из 30)', (select count(*) = 30 from seen where id::text like 'f0000000%'));
select t.ok('FEED-01 заблокированный автор скрыт', (select count(*) = 0 from public.feed_page(43.2, 76.9, 1000, null) where user_id = 'cccccccc-0000-0000-0000-00000000000c'));
select t.ok('FEED-01 просроченное и черновики скрыты', (select count(*) = 0 from public.feed_page(43.2, 76.9, 1000, null) where text in ('Просрочено', 'Черновик')));
select t.ok('FEED-01 радиус 500 м: 1 пост (290 м), 580 м — за границей', (select count(*) = 1 from public.feed_page(43.2, 76.9, 500, array['talk']) where id::text like 'f0000000%'));
select t.ok('FEED-01 радиус 1 км: 3 поста', (select count(*) = 3 from public.feed_page(43.2, 76.9, 1000, array['talk']) where id::text like 'f0000000%'));
select t.ok('FEED-01 радиус 3 км: 10 постов', (select count(*) from seen s join public.posts p on p.id = s.id where p.id::text like 'f0000000%'
   and extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(76.9, 43.2), 4326)::extensions.geography, 3000)) = 10);
select t.ok('FEED-01 радиус 5 км: 17 постов', (select count(*) = 17 from seen s join public.posts p on p.id = s.id where p.id::text like 'f0000000%'
   and extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(76.9, 43.2), 4326)::extensions.geography, 5000)));
select t.ok('FEED-01 обновление: новые после курсора', (select count(*) = 0 from public.feed_new(43.2, 76.9, 10000, array['talk'], '2026-01-01 12:00:00+00', 'f0000000-0000-0000-0000-000000000030')
   where id::text like 'f0000000%'));
select t.ok('MAP-01 карта и лента дают одинаковый набор в радиусе', (select array_agg(id order by id) from public.map_posts(0, 0, 0, 0, array['talk'], 43.2, 76.9, 1000))
   = (select array_agg(id order by id) from public.feed_page(43.2, 76.9, 1000, array['talk'])));
select t.ok('MAP-01 режим "на экране" по рамке', (select count(*) = 4 from public.map_posts(76.89, 43.199, 76.91, 43.2115, array['talk']) where id::text like 'f0000000%'));
reset role; set role anon; select t.as_user(null);
select t.ok('AUTH-01 гость видит ленту', (select count(*) > 0 from public.feed_page(43.2, 76.9, 3000, null)));

-- ===== SEC-03: минимальные права =====
select t.fail('SEC-03 гость не пишет посты', $$insert into public.posts (user_id, category, text, lat, lng) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'talk', 'x', 43.2, 76.9)$$, '42501');
select t.fail('SEC-03 гость не читает сообщения', $$select count(*) from public.messages$$, '42501');
select t.fail('SEC-03 гость не читает переписки', $$select count(*) from public.conversations$$, '42501');
select t.fail('SEC-03 гость не вызывает модерацию', $$select public.mod_act('post', 'a0000000-0000-0000-0000-000000000001', 'hide')$$, '42501');
select t.fail('SEC-03 гость не подписывается на push', $$select public.push_subscribe('https://fcm.googleapis.com/fcm/send/x', 'a', 'b', '{}', null, null, '')$$, '42501');
reset role; set role authenticated; select t.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
select t.fail('SEC-03 секрет push скрыт', $$select * from public.push_config$$, '42501');
select t.fail('SEC-03 журнал лимитов скрыт', $$select * from public.rate_events$$, '42501');
select t.fail('SEC-03 ошибки клиентов скрыты', $$select * from public.client_errors$$, '42501');
select t.fail('SEC-03 аналитика скрыта', $$select * from public.analytics_events$$, '42501');
select t.fail('SEC-03 задачи удаления скрыты', $$select * from public.deletion_jobs$$, '42501');
select t.fail('SEC-03 служебный вызов функций запрещен', $$select public.call_fn('push', '{}')$$, '42501');
select t.fail('SEC-03 уборка запрещена', $$select public.near_cleanup()$$, '42501');
select t.fail('SEC-03 обход лимитов запрещен', $$select public.rate_check('comment', 1000, 1000, '1 hour')$$, '42501');
select t.fail('SEC-03 KPI только админу', $$select public.kpi_summary()$$, 'NR403');
update public.app_settings set ai_moderation = true;
select t.ok('SEC-03 настройки не изменились', (select not ai_moderation from public.app_settings));

-- ===== SEC-04: push =====
select t.fail('SEC-04 внутренний адрес отклоняется', $$select public.push_subscribe('https://169.254.169.254/latest', repeat('A', 87), repeat('B', 22), '{}', null, null, '')$$, 'NR422');
select t.fail('SEC-04 http отклоняется', $$select public.push_subscribe('http://fcm.googleapis.com/fcm/send/x', repeat('A', 87), repeat('B', 22), '{}', null, null, '')$$, 'NR422');
select t.fail('SEC-04 похожий домен отклоняется', $$select public.push_subscribe('https://fcm.googleapis.com.evil.kz/x', repeat('A', 87), repeat('B', 22), '{}', null, null, '')$$, 'NR422');
select public.push_subscribe('https://fcm.googleapis.com/fcm/send/abc123', repeat('A', 87), repeat('B', 22), '{"msg":true}', 43.2, 76.9, 'test');
select t.ok('SEC-04 корректная подписка сохранена', (select count(*) = 1 from public.push_subs));
select t.as_user('cccccccc-0000-0000-0000-00000000000c');
select t.fail('SEC-04 чужая подписка не перезаписывается', $$select public.push_subscribe('https://fcm.googleapis.com/fcm/send/abc123', repeat('C', 87), repeat('D', 22), '{}', null, null, '')$$, 'NR409');
select public.push_subscribe('https://fcm.googleapis.com/fcm/send/abc123', repeat('A', 87), repeat('B', 22), '{}', null, null, 'same browser');
reset role;
select t.ok('SEC-04 тот же браузер после смены аккаунта переходит владельцу', (select user_id = 'cccccccc-0000-0000-0000-00000000000c' and lat is null from public.push_subs where endpoint like '%abc123'));

-- ===== SEC-05: удаление аккаунта — сообщения у собеседника остаются =====
delete from auth.users where id = 'cccccccc-0000-0000-0000-00000000000c';
select t.ok('SEC-05 сообщения удаленного остаются у собеседника', (select count(*) = 3 from public.messages where conversation_id = current_setting('t.conv')::uuid));
select t.ok('SEC-05 автор показан как удаленный', (select count(*) = 2 from public.messages where conversation_id = current_setting('t.conv')::uuid and sender_id is null));
set role authenticated; select t.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
select t.ok('SEC-05 собеседник видит переписку', (select count(*) = 1 from public.conversations where id = current_setting('t.conv')::uuid));
select t.fail('SEC-05 удаленному нельзя написать', format($$insert into public.messages (conversation_id, sender_id, text) values (%L, 'aaaaaaaa-0000-0000-0000-00000000000a', 'Ты тут?')$$, current_setting('t.conv')), 'NR403');

-- ===== аналитика и журнал ошибок =====
reset role; set role anon;
select public.track('app_open', '{"lang":"ru","email":"secret@x.kz"}', 'install-1');
select public.log_client_error('js', 'Ошибка у user@mail.kz токен eyJhbGciOiJIUzI1NiJ9xx', 'stack', 'corr-1', '11.0', '/app.html#post=1?x=y');
reset role;
select t.ok('ANALYTICS лишние свойства не сохраняются', (select props = '{"lang":"ru"}'::jsonb from public.analytics_events limit 1));
select t.ok('LOGS email и токены скрыты, адрес без параметров', (select message !~ '@' and message !~ 'eyJ' and route = '/app.html' from public.client_errors limit 1));
set role authenticated; select t.as_user('eeeeeeee-0000-0000-0000-00000000000e');
select t.ok('KPI админ получает сводку', (select public.kpi_summary() ? 'dau'));
select t.fail('MOD v14.9: бан без причины закрыт — только NEAR Shield', $$select public.mod_act('user', 'bbbbbbbb-0000-0000-0000-00000000000b', 'ban', 'тест')$$, 'NR403');
reset role;
