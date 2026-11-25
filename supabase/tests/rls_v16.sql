-- NEAR v14.8 (ТЗ v14.8): общие комнаты, встречи, Host, готовность, посещение, отзывы, рейтинг, вход по нику.
-- Запуск после rls_v15.sql (sh supabase/tests/run_tests.sh).
reset role; select t.as_user(null); select t.aal(null);
update public.app_settings set meet_age_gate = true, mod_require_mfa = false,
  day_limits = '{"post":[50,50],"comment":[50,50],"meeting":[20,20]}'::jsonb;
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
 ('60000000-0000-0000-0000-000000000001', 'h@x.kz', '{"nickname":"Host_Alma","accepted_rules":"true"}', now()),
 ('60000000-0000-0000-0000-000000000002', 'a@x.kz', '{"nickname":"Player02","accepted_rules":"true"}', now()),
 ('60000000-0000-0000-0000-000000000003', 'b@x.kz', '{"nickname":"Player03","accepted_rules":"true"}', now()),
 ('60000000-0000-0000-0000-000000000004', 'c@x.kz', '{"nickname":"Player04","accepted_rules":"true"}', now()),
 ('60000000-0000-0000-0000-000000000005', 'd@x.kz', '{"nickname":"Newbie_05","accepted_rules":"true"}', now()),
 ('60000000-0000-0000-0000-000000000006', 'm@x.kz', '{"nickname":"Keeper_06","accepted_rules":"true"}', now()),
 ('60000000-0000-0000-0000-000000000007', 'e@x.kz', '{"nickname":"Player07","accepted_rules":"true"}', null);
update public.profiles set is_moderator = true where id = '60000000-0000-0000-0000-000000000006';
update public.profiles set created_at = now() - interval '30 days' where id in ('60000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002');
update public.profile_private set age_status = 'adult' where user_id in ('60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000003','60000000-0000-0000-0000-000000000004');

-- ===== 03: вход по нику — email не раскрывается клиенту =====
set role authenticated; select t.as_user('60000000-0000-0000-0000-000000000002');
select t.fail('AUTH resolver ника недоступен клиенту', $$select public.login_email('Host_Alma')$$, '42501');
select t.fail('AUTH журнал входов недоступен клиенту', $$select count(*) from public.login_attempts$$, '42501');
reset role;
select t.ok('AUTH resolver на сервере находит email по нику без учета регистра и похожих букв', (select public.login_email('host_аlma') = 'h@x.kz'));
select t.ok('AUTH неизвестный ник — пусто (одинаковая ошибка входа)', (select public.login_email('nobody_here') is null));
select public.login_note('Host_Alma', 'ip1', false) from generate_series(1, 5);
select t.ok('AUTH 5 неудачных попыток — пауза 15 минут', (select (public.login_gate('host_alma', 'ip2')->>'ok')::boolean = false));
select t.ok('AUTH другой ник с того же IP не блокируется сразу', (select (public.login_gate('Player02', 'ip1')->>'ok')::boolean));

-- ===== 08: комнаты города и районов =====
set role anon; select t.as_user(null);
select t.ok('ROOM гость видит городской и 8 районных чатов', (select count(*) = 9 from public.rooms where type in ('city','district')));
select t.ok('ROOM гость читает список "Рядом"', (select jsonb_array_length(public.rooms_list('near')) >= 9));
select t.fail('ROOM гость не пишет', $$select public.send_message((select id from public.rooms where type = 'city'), 'Привет', 'g1')$$, '42501');
set role authenticated; select t.as_user('60000000-0000-0000-0000-000000000002');
select set_config('t.city', (select id::text from public.rooms where type = 'city'), false);
select t.fail('ROOM писать можно после вступления', $$select public.send_message(current_setting('t.city')::uuid, 'Привет', 'c1')$$, 'NR403');
select public.join_room(current_setting('t.city')::uuid);
select t.ok('ROOM вступление: участник', (select public.room_role(current_setting('t.city')::uuid, auth.uid()) = 'member'));
select public.send_message(current_setting('t.city')::uuid, 'Всем привет, блять, где купить воду?', 'c1');
select t.ok('ROOM мат маскируется сервером', (select body_masked like '%б****%' and body_masked not like '%блять%' from public.room_messages where client_id = 'c1'));
select t.ok('ROOM повтор отправки с тем же ключом — один раз', (select (public.send_message(current_setting('t.city')::uuid, 'Всем привет, блять, где купить воду?', 'c1')->>'duplicate')::boolean
  and (select count(*) = 1 from public.room_messages where client_id = 'c1')));
select t.fail('ROOM угроза блокируется, а не маскируется', $$select public.send_message(current_setting('t.city')::uuid, 'Я тебя убью, найду где живешь', 'c2')$$, 'NR422');
select t.fail('ROOM @all доступен только организатору', $$select public.send_message(current_setting('t.city')::uuid, '@all срочно', 'c3')$$, 'NR403');
select t.fail('ROOM клиент не пишет в таблицу напрямую', $$insert into public.room_messages (room_id, sender_id, body_masked) values (current_setting('t.city')::uuid, auth.uid(), 'обход')$$, '42501');
select t.fail('ROOM клиент не меняет свою роль', $$update public.room_members set role = 'moderator' where user_id = auth.uid()$$, '42501');
select public.send_message(current_setting('t.city')::uuid, 'Сообщение номер ' || g, 'burst' || g) from generate_series(1, 4) g;
select t.fail('ROOM частота: больше 5 сообщений за 10 секунд', $$select public.send_message(current_setting('t.city')::uuid, 'еще одно', 'burst9')$$, 'NR429');
select t.as_user('60000000-0000-0000-0000-000000000005');
select public.join_room(current_setting('t.city')::uuid);
select t.fail('ROOM ссылки — не для новых аккаунтов', $$select public.send_message(current_setting('t.city')::uuid, 'смотрите https://example.kz/sale', 'l1')$$, 'NR403');
select t.as_user('60000000-0000-0000-0000-000000000007');
select public.join_room(current_setting('t.city')::uuid);
select t.fail('ROOM без подтвержденной почты — только чтение', $$select public.send_message(current_setting('t.city')::uuid, 'Привет', 'p1')$$, 'NR403');
-- блокировка: сообщения заблокированного скрыты, упоминания от него не приходят
select t.as_user('60000000-0000-0000-0000-000000000003');
select public.join_room(current_setting('t.city')::uuid);
insert into public.blocks (blocker_id, blocked_id) values ('60000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000002');
select t.ok('BLOCK сообщения заблокированного скрыты', (select count(*) = 0 from public.room_messages where sender_id = '60000000-0000-0000-0000-000000000002'));
select t.as_user('60000000-0000-0000-0000-000000000004');
select public.join_room(current_setting('t.city')::uuid);
select t.ok('BLOCK другие видят сообщения', (select count(*) >= 1 from public.room_messages where sender_id = '60000000-0000-0000-0000-000000000002'));
reset role; select t.as_user(null);
update public.room_messages set created_at = created_at - interval '2 minutes' where sender_id = '60000000-0000-0000-0000-000000000002';
set role authenticated; select t.as_user('60000000-0000-0000-0000-000000000002');
select public.send_message(current_setting('t.city')::uuid, 'Привет @Player03 и @Player04', 'm1');
reset role;
select t.ok('MENTION упоминание по ID, заблокировавший не получает', (select count(*) = 1 from public.room_mentions rm join public.room_messages m on m.id = rm.message_id
  where m.client_id = 'm1' and rm.user_id = '60000000-0000-0000-0000-000000000004') and not exists (select 1 from public.outbox where dedup_key like 'mention:%:60000000-0000-0000-0000-000000000003'));
set role authenticated; select t.as_user('60000000-0000-0000-0000-000000000004');
select t.ok('MENTION упомянутый видит свое упоминание', (select count(*) = 1 from public.room_mentions));

-- ===== 07: создание встречи =====
select t.as_user('60000000-0000-0000-0000-000000000005');
select t.fail('MEET без допуска к встречам нельзя создать', $$select public.create_meeting('{"category":"games","title":"CS2 команда","description":"Собираем команду на вечер","starts_at":"2030-01-01T19:00:00+05","ends_at":"2030-01-01T21:00:00+05","capacity":5,"public_place":true,"lat":43.2,"lng":76.9}')$$, 'NR403');
select t.fail('MEET встречу нельзя создать обычной публикацией', $$insert into public.posts (user_id, category, text, lat, lng) values (auth.uid(), 'meetup', 'Обход формы встречи', 43.2, 76.9)$$, 'NR403');
select t.as_user('60000000-0000-0000-0000-000000000001');
select t.fail('MEET название от 5 символов', format($$select public.create_meeting(%L)$$, jsonb_build_object('category','games','title','CS','description','Собираем команду на вечер','starts_at',now()+interval '1 day','ends_at',now()+interval '1 day 2 hours','capacity',5,'public_place',true,'lat',43.2,'lng',76.9)), 'NR422');
select t.fail('MEET дата не дальше 90 дней', format($$select public.create_meeting(%L)$$, jsonb_build_object('category','games','title','CS2 команда','description','Собираем команду на вечер','starts_at',now()+interval '91 days','ends_at',now()+interval '91 days 2 hours','capacity',5,'public_place',true,'lat',43.2,'lng',76.9)), 'NR422');
select t.fail('MEET конец позже начала', format($$select public.create_meeting(%L)$$, jsonb_build_object('category','games','title','CS2 команда','description','Собираем команду на вечер','starts_at',now()+interval '1 day','ends_at',now()+interval '1 day','capacity',5,'public_place',true,'lat',43.2,'lng',76.9)), 'NR422');
select t.fail('MEET длительность до 24 часов', format($$select public.create_meeting(%L)$$, jsonb_build_object('category','mountains','title','Поход на Фурманова','description','Идем на пик Фурманова','starts_at',now()+interval '1 day','ends_at',now()+interval '2 days 1 hour','capacity',5,'public_place',true,'lat',43.2,'lng',76.9)), 'NR422');
select t.fail('MEET участников от 3 до 50', format($$select public.create_meeting(%L)$$, jsonb_build_object('category','games','title','CS2 команда','description','Собираем команду на вечер','starts_at',now()+interval '1 day','ends_at',now()+interval '1 day 2 hours','capacity',2,'public_place',true,'lat',43.2,'lng',76.9)), 'NR422');
select t.fail('MEET только публичное место', format($$select public.create_meeting(%L)$$, jsonb_build_object('category','cafe','title','Кофе с соседями','description','Обсудим двор и парковку','starts_at',now()+interval '1 day','ends_at',now()+interval '1 day 2 hours','capacity',5,'public_place',false,'lat',43.2,'lng',76.9)), 'NR422');
select t.fail('MEET сбор денег через организатора запрещен', format($$select public.create_meeting(%L)$$, jsonb_build_object('category','cinema','title','Кино в субботу','description','Скиньте на каспи 3000 за билет заранее','starts_at',now()+interval '1 day','ends_at',now()+interval '1 day 2 hours','capacity',5,'public_place',true,'lat',43.2,'lng',76.9)), 'NR422');
select set_config('t.m', public.create_meeting(jsonb_build_object('category','games','title','CS2 — собираем команду','description','Играем 5x5, любой уровень, клуб на Абая',
  'starts_at', now() + interval '1 day', 'ends_at', now() + interval '1 day 2 hours', 'capacity', 3, 'price_kzt', 1500, 'public_place', true,
  'lat', 43.2, 'lng', 76.9, 'place_name', 'Компьютерный клуб', 'client_key', 'meetkey-0001', 'details', '{"game":"CS2","mode":"5×5","club":"Arena"}'::jsonb))::text, false);
select t.ok('MEET повтор создания с тем же ключом — та же встреча', (select public.create_meeting(jsonb_build_object('client_key','meetkey-0001')) = current_setting('t.m')::uuid));
select t.ok('MEET атомарно: публикация, встреча, Host, комната, приветствие', (select
  exists (select 1 from public.posts where id = current_setting('t.m')::uuid and category = 'meetup')
  and exists (select 1 from public.meeting_members where meeting_id = current_setting('t.m')::uuid and role = 'host' and status = 'accepted')
  and exists (select 1 from public.room_messages r join public.meetings m on m.room_id = r.room_id where m.id = current_setting('t.m')::uuid and r.sender_id is null and r.body_masked like 'Всем привет! Напишите%')));
select t.ok('MEET закрепление строится из полей: CS2 • 5×5 • любой уровень', (select pin = 'CS2 • 5×5 • любой уровень' from public.meetings where id = current_setting('t.m')::uuid));
reset role;
select t.ok('MEET напоминания 24ч/1ч/15м поставлены Host (24ч уже прошло)', (select count(*) = 2 from public.outbox where dedup_key like 'remind:' || current_setting('t.m') || ':60000000-0000-0000-0000-000000000001:%' and status = 'pending'));

-- ===== 07: заявки, последнее место, лист ожидания =====
reset role; set role anon; select t.as_user(null);
select t.ok('MEET гость видит карточку встречи без чата и состава', (select (public.meeting_get(current_setting('t.m')::uuid)->>'room_id') is null and public.meeting_get(current_setting('t.m')::uuid)->'members' = 'null'::jsonb));
set role authenticated; select t.as_user('60000000-0000-0000-0000-000000000005');
select t.fail('MEET заявка без допуска', $$select public.request_join(current_setting('t.m')::uuid)$$, 'NR403');
select t.as_user('60000000-0000-0000-0000-000000000002'); select public.request_join(current_setting('t.m')::uuid, 'Играю на AWP');
select t.as_user('60000000-0000-0000-0000-000000000003'); select public.request_join(current_setting('t.m')::uuid);
select t.as_user('60000000-0000-0000-0000-000000000004'); select public.request_join(current_setting('t.m')::uuid);
select t.as_user('60000000-0000-0000-0000-000000000002');
select t.fail('MEET участник не принимает заявки', $$select public.decide_request(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000003', true)$$, 'NR403');
select t.fail('MEET чат встречи закрыт до принятия', $$select public.send_message((select room_id from public.meetings where id = current_setting('t.m')::uuid), 'Привет', 'x1')$$, 'NR403');
select t.ok('MEET заявитель не читает чат встречи', (select count(*) = 0 from public.room_messages r join public.meetings m on m.room_id = r.room_id where m.id = current_setting('t.m')::uuid));
select t.as_user('60000000-0000-0000-0000-000000000001');
select t.ok('MEET Host видит заявки с рейтингом', (select jsonb_array_length(public.meeting_get(current_setting('t.m')::uuid)->'requests') = 3));
select public.decide_request(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000002', true);
select public.decide_request(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000003', true);
select t.fail('MEET последнее место: второй не проходит', $$select public.decide_request(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000004', true)$$, 'NR409');
select t.ok('MEET принятый — в чате, системное "присоединился"', (select count(*) = 2 from public.room_messages r join public.meetings m on m.room_id = r.room_id where m.id = current_setting('t.m')::uuid and r.meta->>'tpl' = 'joined'));
select t.as_user('60000000-0000-0000-0000-000000000005');
select t.ok('MEET посторонний не видит закрытую комнату', (select count(*) = 0 from public.rooms where meeting_id = current_setting('t.m')::uuid));
select t.as_user('60000000-0000-0000-0000-000000000003');
select public.send_message((select room_id from public.meetings where id = current_setting('t.m')::uuid), 'Я на месте', 'act:here', null, 'action', 'here');
select public.send_message((select room_id from public.meetings where id = current_setting('t.m')::uuid), 'Я на месте', 'act:here', null, 'action', 'here');
select t.ok('MEET быстрое действие идемпотентно', (select count(*) = 1 from public.room_messages where client_id = 'act:here'));
select t.fail('MEET @all участнику недоступен', $$select public.send_message((select room_id from public.meetings where id = current_setting('t.m')::uuid), '@all идем?', 'a1')$$, 'NR403');
select t.as_user('60000000-0000-0000-0000-000000000001');
select public.send_message((select room_id from public.meetings where id = current_setting('t.m')::uuid), '@all клуб забронирован', 'all1');
reset role; select t.ok('MEET @all Host: упоминание всем участникам', (select count(*) = 2 from public.room_mentions rm join public.room_messages m on m.id = rm.message_id where m.client_id = 'all1')); set role authenticated;
select t.fail('MEET @all не чаще раза в 5 минут', $$select public.send_message((select room_id from public.meetings where id = current_setting('t.m')::uuid), '@all еще раз', 'all2')$$, 'NR429');
select public.send_message((select room_id from public.meetings where id = current_setting('t.m')::uuid), '@Player03 возьми мышь', 'h2');
reset role; select t.ok('MEET @nickname — только этому участнику', (select count(*) = 1 from public.room_mentions rm join public.room_messages m on m.id = rm.message_id where m.client_id = 'h2' and rm.user_id = '60000000-0000-0000-0000-000000000003')); set role authenticated;

-- ===== 09: мут, исключение, лист ожидания =====
select public.set_mute((select room_id from public.meetings where id = current_setting('t.m')::uuid), '60000000-0000-0000-0000-000000000002', 30, 'флуд');
select t.as_user('60000000-0000-0000-0000-000000000002');
select t.fail('HOST мут: участник временно не пишет', $$select public.send_message((select room_id from public.meetings where id = current_setting('t.m')::uuid), 'Почему?', 'mu1')$$, 'NR403');
select t.fail('HOST участник не мутит Host', $$select public.set_mute((select room_id from public.meetings where id = current_setting('t.m')::uuid), '60000000-0000-0000-0000-000000000001', 30)$$, 'NR403');
select t.as_user('60000000-0000-0000-0000-000000000001');
select t.fail('HOST исключение требует причину', $$select public.remove_member(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000002', '')$$, 'NR422');
select public.remove_member(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000002', 'Оскорбления в чате');
select t.as_user('60000000-0000-0000-0000-000000000002');
select t.ok('HOST кик: история чата сразу недоступна', (select count(*) = 0 from public.room_messages r join public.rooms x on x.id = r.room_id where x.meeting_id = current_setting('t.m')::uuid));
select t.fail('HOST кик: писать нельзя', $$select public.send_message((select room_id from public.meetings where id = current_setting('t.m')::uuid), 'Эй', 'k1')$$, 'NR403');
select t.fail('HOST кик: повторная заявка запрещена', $$select public.request_join(current_setting('t.m')::uuid)$$, 'NR403');
reset role; select t.as_user(null);
select t.ok('HOST кик: будущие напоминания отменены', (select count(*) = 0 from public.outbox where user_id = '60000000-0000-0000-0000-000000000002' and status = 'pending' and dedup_key like 'remind:' || current_setting('t.m') || '%'));
select t.ok('HOST кик: место освободилось, лист ожидания уведомлен', (select status = 'requested' from public.meeting_members where meeting_id = current_setting('t.m')::uuid and user_id = '60000000-0000-0000-0000-000000000004')
  or (select status = 'requested' from public.meeting_members where meeting_id = current_setting('t.m')::uuid and user_id = '60000000-0000-0000-0000-000000000004'));
select t.ok('HOST кик: Host не меняет глобальный рейтинг (журнал пуст)', (select count(*) = 0 from public.rating_ledger where user_id = '60000000-0000-0000-0000-000000000002'));
select t.ok('HOST журнал действий ведется', (select count(*) >= 4 from public.meeting_audit where meeting_id = current_setting('t.m')::uuid));
set role authenticated; select t.as_user('60000000-0000-0000-0000-000000000001');
select public.decide_request(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000004', true);

-- ===== 09: готовность и перенос =====
select set_config('t.chk', public.request_checkin(current_setting('t.m')::uuid)::text, false);
select t.fail('READY запрос готовности не чаще раза в 5 минут', $$select public.request_checkin(current_setting('t.m')::uuid)$$, 'NR429');
select t.as_user('60000000-0000-0000-0000-000000000003');
select public.answer_checkin(current_setting('t.chk')::uuid, 'ready');
select public.answer_checkin(current_setting('t.chk')::uuid, 'late');
select t.ok('READY один изменяемый ответ на запрос', (select count(*) = 1 and min(answer) = 'late' from public.checkin_answers where checkin_id = current_setting('t.chk')::uuid and user_id = auth.uid()));
select t.as_user('60000000-0000-0000-0000-000000000005');
select t.fail('READY посторонний не отвечает', $$select public.answer_checkin(current_setting('t.chk')::uuid, 'ready')$$, 'NR403');
select t.as_user('60000000-0000-0000-0000-000000000001');
select public.update_meeting(current_setting('t.m')::uuid, jsonb_build_object('starts_at', now() + interval '2 days', 'ends_at', now() + interval '2 days 2 hours'));
select t.as_user('60000000-0000-0000-0000-000000000003');
select t.fail('READY перенос встречи закрывает старый запрос', $$select public.answer_checkin(current_setting('t.chk')::uuid, 'ready')$$, 'NR409');
reset role; select t.as_user(null);
select t.ok('READY перенос: напоминания пересозданы без дублей', (select count(*) = 3 from public.outbox where dedup_key like 'remind:' || current_setting('t.m') || ':60000000-0000-0000-0000-000000000003:%' and status = 'pending'));
-- outbox: уведомления создаются один раз, исключенным не уходят
update public.outbox set next_retry = now() where status = 'pending' and kind <> 'meeting_reminder';
select t.ok('OUTBOX обработка создает уведомления', (select (public.outbox_process()->>'sent')::int > 0));
select t.ok('OUTBOX повторная обработка не дублирует', (select (public.outbox_process()->>'sent')::int = 0));

-- ===== 09: co-host, передача Host, отказ участника =====
set role authenticated; select t.as_user('60000000-0000-0000-0000-000000000001');
select public.set_cohost(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000003', true);
select t.as_user('60000000-0000-0000-0000-000000000003');
select t.fail('HOST co-host не исключает Host', $$select public.remove_member(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000001', 'просто так')$$, 'NR403');
select t.fail('HOST co-host не передает роль Host', $$select public.transfer_host(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000003')$$, 'NR403');
select t.as_user('60000000-0000-0000-0000-000000000004');
select t.ok('LEAVE отказ заранее (≥2 ч) — без штрафа', (select public.leave_meeting(current_setting('t.m')::uuid) = 'left'));
select t.as_user('60000000-0000-0000-0000-000000000001');
select t.fail('HOST Host не выходит без передачи роли', $$select public.leave_meeting(current_setting('t.m')::uuid)$$, 'NR409');
select public.transfer_host(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000003');
select t.ok('HOST роль передана, прежний Host — co-host', (select host_id = '60000000-0000-0000-0000-000000000003' from public.meetings where id = current_setting('t.m')::uuid)
  and public.meet_role(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000001') = 'cohost');

-- ===== 10: посещение, отзывы, рейтинг =====
reset role; select t.as_user(null);
-- встреча прошла вчера (перенос в прошлое — только для теста)
update public.meetings set starts_at = now() - interval '1 day 3 hours', ends_at = now() - interval '1 day' where id = current_setting('t.m')::uuid;
set role authenticated; select t.as_user('60000000-0000-0000-0000-000000000001');
select public.mark_attended(current_setting('t.m')::uuid);
select t.as_user('60000000-0000-0000-0000-000000000003');
select t.fail('REVIEW неподтвержденного участника не оценить', $$select public.submit_review(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000001', 5)$$, 'NR403');
select public.confirm_attendance(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000001', true);
select t.fail('REVIEW без самооценки', $$select public.submit_review(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000003', 5)$$, 'NR422');
select public.submit_review(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000001', 5, true, true, null, 'Пришел вовремя');
select t.fail('REVIEW один отзыв на пару', $$select public.submit_review(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000001', 4)$$, 'NR409');
select t.as_user('60000000-0000-0000-0000-000000000001');
select t.ok('REVIEW до взаимного отзыва не опубликован', (select count(*) = 0 from public.reviews where target_id = auth.uid()));
select public.submit_review(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000003', 4, true, null, true, null);
select t.ok('REVIEW после взаимного отзыва опубликован', (select count(*) = 1 from public.reviews where target_id = auth.uid()));
select t.as_user('60000000-0000-0000-0000-000000000005');
select t.fail('REVIEW посторонний не оценивает', $$select public.submit_review(current_setting('t.m')::uuid, '60000000-0000-0000-0000-000000000001', 1)$$, 'NR403');
select t.ok('RATING мало данных — "Недостаточно данных" (балла нет)', (select public.user_rating('60000000-0000-0000-0000-000000000003')->'score' = 'null'::jsonb
  and not (public.user_rating('60000000-0000-0000-0000-000000000003')->>'enough')::boolean));
select t.ok('RATING Host и участник раздельно с количеством', (select (public.user_rating('60000000-0000-0000-0000-000000000003')->'host'->>'count')::int = 1
  and (public.user_rating('60000000-0000-0000-0000-000000000003')->'member'->>'count')::int = 0));
select t.fail('RATING сырые числа — только модератору', $$select public.mod_rating_raw('60000000-0000-0000-0000-000000000003')$$, 'NR403');
select t.fail('RATING журнал недоступен пользователю', $$select count(*) from public.rating_ledger$$, '42501');
select t.as_user('60000000-0000-0000-0000-000000000006');
select public.rating_penalty('60000000-0000-0000-0000-000000000004', 'spam', 'report:1', 'Спам ссылками');
select t.ok('RATING штраф идемпотентен по ключу', (select public.rating_penalty('60000000-0000-0000-0000-000000000004', 'spam', 'report:1', 'Повтор') is null));
select t.ok('RATING S: спам −10', (select (public.mod_rating_raw('60000000-0000-0000-0000-000000000004')->>'S')::int = 90));
select public.rating_reverse((public.mod_rating_raw('60000000-0000-0000-0000-000000000004')->'ledger'->0->>'id')::bigint, 'Апелляция принята');
select t.ok('RATING апелляция компенсирует штраф', (select (public.mod_rating_raw('60000000-0000-0000-0000-000000000004')->>'S')::int = 100));
-- 5 встреч и 3 независимых отзыва — балл появляется
reset role; select t.as_user(null);
insert into public.posts (id, user_id, category, text, lat, lng) select ('6e000000-0000-0000-0000-00000000000' || g)::uuid, '60000000-0000-0000-0000-000000000001', 'talk', 'Прошедшая встреча ' || g, 43.2, 76.9 from generate_series(1, 5) g;
update public.posts set category = 'meetup' where id::text like '6e000000%';
insert into public.meetings (id, host_id, category, title, starts_at, ends_at, capacity)
  select ('6e000000-0000-0000-0000-00000000000' || g)::uuid, '60000000-0000-0000-0000-000000000001', 'walk', 'Прогулка ' || g, now() - interval '3 days', now() - interval '3 days' + interval '2 hours', 5 from generate_series(1, 5) g;
insert into public.meeting_members (meeting_id, user_id, role, status) select ('6e000000-0000-0000-0000-00000000000' || g)::uuid, '60000000-0000-0000-0000-000000000001', 'host', 'accepted' from generate_series(1, 5) g;
insert into public.meeting_members (meeting_id, user_id, role, status, attended) select ('6e000000-0000-0000-0000-00000000000' || g)::uuid, u::uuid, 'member', 'accepted', 'confirmed'
  from generate_series(1, 3) g, unnest(array['60000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000004']) u;
insert into public.reviews (meeting_id, reviewer_id, target_id, target_role, stars) values
  ('6e000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001', 'host', 5),
  ('6e000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002', 'member', 5),
  ('6e000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000004', '60000000-0000-0000-0000-000000000001', 'host', 4),
  ('6e000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000004', 'member', 5);
select t.ok('RATING ≥5 встреч и ≥3 независимых отзыва — балл 0–100', (select (public.user_rating('60000000-0000-0000-0000-000000000001')->>'score')::int between 0 and 100
  and (public.user_rating('60000000-0000-0000-0000-000000000001')->>'enough')::boolean));
set role authenticated; select t.as_user('60000000-0000-0000-0000-000000000005');
select t.ok('PROFILE публично: ник, лайки, публикации, встречи, рейтинг; без email', (select p ? 'nickname' and p ? 'likes' and p ? 'meetings' and p ? 'rating' and not p ? 'email'
  from (select public.profile_public('60000000-0000-0000-0000-000000000001') p) x));

-- ===== 04: поля форм =====
select t.as_user('60000000-0000-0000-0000-000000000002');
select t.fail('FORM время происшествия не в будущем', $$insert into public.posts (user_id, category, text, lat, lng, meta) values (auth.uid(), 'incident', 'ДТП на Абая', 43.2, 76.9, jsonb_build_object('itype','dtp','occurred_at', now() + interval '2 hours'))$$, 'NR422');
insert into public.posts (user_id, category, text, lat, lng, meta) values ('60000000-0000-0000-0000-000000000002', 'talk', 'Вопрос соседям про парковку во дворе', 43.2, 76.9, '{"kind":"announcement"}');
select t.ok('FORM публикация: обсуждение или объявление', (select meta->>'kind' = 'announcement' from public.posts where text = 'Вопрос соседям про парковку во дворе'));
reset role; select t.as_user(null);
update public.app_settings set day_limits = '{"post":[3,15],"comment":[20,100],"meeting":[1,3]}'::jsonb, meet_age_gate = true;
