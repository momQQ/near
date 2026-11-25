-- NEAR v14.9 Shield: проверки P0 (запускаются после rls_v11.sql и rls_v12.sql на той же базе)
reset role; select t.as_user(null);
create or replace function t.as_sess(uid text, sid text, aal text default 'aal1') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid, ''), false);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'session_id', sid, 'aal', aal)::text, false);
end $$;
create or replace function t.ch(sid text) returns uuid language sql security definer as $$ select id from public.session_challenges where session_id = sid::uuid order by created_at desc limit 1 $$;
create or replace function t.att(sid text) returns int language sql security definer as $$ select attempts from public.session_challenges where session_id = sid::uuid order by created_at desc limit 1 $$;
create or replace function t.links(uid text) returns int language sql security definer as $$ select count(*)::int from public.account_links where account_id = uid::uuid and review_status = 'pending' $$;
grant execute on all functions in schema t to anon, authenticated;
update public.app_settings set shield = shield || '{"enforce_sessions":true,"admin_mfa":true,"dm":false,"meetings_pilot_only":true}'::jsonb;
update public.app_settings set limits = limits || '{"chat":[10,40,"1 minute"],"post":[30,120,"10 minutes"]}'::jsonb;

-- пользователи: S1, S2, H (организатор), M1, M2 (участники), MD (модератор), AD (старший админ), N (новый)
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
 ('40000000-0000-0000-0000-000000000001', 's1@x.kz', '{"nickname":"@AlmatyUser","accepted_rules":"true"}', now()),
 ('40000000-0000-0000-0000-000000000002', 's2@x.kz', '{"nickname":"spam.king","accepted_rules":"true"}', now()),
 ('40000000-0000-0000-0000-000000000003', 'h@x.kz',  '{"nickname":"host_aru","accepted_rules":"true"}', now()),
 ('40000000-0000-0000-0000-000000000004', 'm1@x.kz', '{"nickname":"member_one","accepted_rules":"true"}', now()),
 ('40000000-0000-0000-0000-000000000005', 'm2@x.kz', '{"nickname":"member_two","accepted_rules":"true"}', now()),
 ('40000000-0000-0000-0000-000000000006', 'md@x.kz', '{"nickname":"mod_dana","accepted_rules":"true"}', now()),
 ('40000000-0000-0000-0000-000000000007', 'ad@x.kz', '{"nickname":"senior_admin","accepted_rules":"true"}', now());
update public.profiles set is_moderator = true where id = '40000000-0000-0000-0000-000000000006';
update public.profiles set is_admin = true where id = '40000000-0000-0000-0000-000000000007';
update public.profiles set meetings_pilot = true where id::text like '40000000%';

-- ===== AUTH-01: никнейм =====
select t.ok('AUTH-01 никнейм нормализован (без @, строчные)', (select nickname = 'almatyuser' from public.profiles where id = '40000000-0000-0000-0000-000000000001'));
select t.ok('AUTH-01 имя и пол не обязательны', (select gender is null and name is not null from public.profiles where id = '40000000-0000-0000-0000-000000000001'));
select t.fail('AUTH-01 никнейм уникален без учета регистра', $$insert into auth.users (id, email, raw_user_meta_data) values ('40000000-0000-0000-0000-000000000099', 'dup@x.kz', '{"nickname":"ALMATYUSER"}')$$, 'NR409');
select t.fail('AUTH-01 никнейм с матом отклоняется', $$update public.profiles set nickname = 'blyad_99' where id = '40000000-0000-0000-0000-000000000005'$$, 'NR422');
select t.fail('AUTH-01 зарезервированный никнейм', $$update public.profiles set nickname = 'admin_near' where id = '40000000-0000-0000-0000-000000000005'$$, 'NR422');
set role anon;
select t.ok('AUTH-01 проверка доступности никнейма', (select (public.nickname_available('AlmatyUser')->>'ok')::boolean = false and (public.nickname_available('new_user_7')->>'ok')::boolean));
reset role;

-- ===== AUTH-02: одна активная сессия, подтверждение нового устройства =====
set role authenticated;
select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000a');
select t.ok('AUTH-02 первый вход активирует сессию сразу', (select public.session_begin('inst-phone-a', 'iPhone · Safari')->>'state' = 'active'));
insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000001', 'talk', 'Привет с телефона', 43.2, 76.9);
select t.ok('AUTH-02 с активной сессией можно публиковать', (select count(*) = 1 from public.posts where user_id = '40000000-0000-0000-0000-000000000001'));
select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000b');
select t.ok('AUTH-02 новое устройство требует подтверждения', (select public.session_begin('inst-laptop-b', 'Windows · Chrome')->>'state' = 'challenge'));
select t.fail('AUTH-02 до подтверждения новая сессия не пишет', $$insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000001', 'talk', 'с ноутбука', 43.2, 76.9)$$, '42501');
select t.ok('AUTH-02 до подтверждения закрытые данные недоступны', (select not public.shield_ok()));
-- параллельный вход третьего устройства: второй challenge отклоняется
select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000c');
select t.fail('AUTH-02 второй параллельный challenge отклонен', $$select public.session_begin('inst-tablet-c', 'iPad')$$, 'NR409');
select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000b');
select t.ok('AUTH-02 неверный код: попытка учтена', (select (public.session_confirm(t.ch('41000000-0000-0000-0000-00000000000b'), '000000')->>'attempts_left')::int = 4));
select t.ok('AUTH-02 попытка сохранилась в базе', (select t.att('41000000-0000-0000-0000-00000000000b') = 1));
reset role; select t.as_user(null);
update public.session_challenges set code_hash = public.shield_hash('code:123456') where session_id = '41000000-0000-0000-0000-00000000000b';
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000b');
select t.ok('AUTH-02 верный код активирует новую сессию', (select (public.session_confirm(t.ch('41000000-0000-0000-0000-00000000000b'), '123456')->>'ok')::boolean));
select t.ok('AUTH-02 код одноразовый', (select (public.session_confirm(t.ch('41000000-0000-0000-0000-00000000000b'), '123456')->>'ok')::boolean = false));
select t.ok('AUTH-02 активна ровно одна сессия', (select count(*) = 1 from public.user_sessions where user_id = '40000000-0000-0000-0000-000000000001' and status = 'active'));
select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000a');
select t.fail('AUTH-02 старый JWT не может продолжать действия', $$insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000001', 'talk', 'со старого', 43.2, 76.9)$$, '42501');
select t.ok('AUTH-02 старый JWT не читает уведомления', (select count(*) = 0 from public.notifications));
select t.fail('AUTH-02 старый JWT не вызывает защищенные RPC', $$select public.chat_send((select id from public.group_chats where kind = 'city'), 'привет', null)$$, 'NR401');
select t.ok('AUTH-02 старое устройство узнает причину', (select public.session_state()->>'reason' = 'new_device'));
-- истекший код и лимит попыток
select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000d');
select public.session_begin('inst-old-d', 'Android');
reset role; select t.as_user(null);
update public.session_challenges set expires_at = now() - interval '1 second' where session_id = '41000000-0000-0000-0000-00000000000d';
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000d');
select t.ok('AUTH-02 истекший код не принимается', (select (public.session_confirm(t.ch('41000000-0000-0000-0000-00000000000d'), '123456')->>'expired')::boolean));
select public.session_cancel();
select t.ok('AUTH-02 отмена: старая сессия продолжает работать', (select count(*) = 1 from public.user_sessions where session_id = '41000000-0000-0000-0000-00000000000b' and status = 'active'));
-- гонка: пока шло подтверждение, активной стала другая сессия
select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000e');
select public.session_begin('inst-e', 'Mac');
reset role; select t.as_user(null);
update public.session_challenges set code_hash = public.shield_hash('code:111111'), old_session_id = '41000000-0000-0000-0000-0000000000ff' where session_id = '41000000-0000-0000-0000-00000000000e';
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000e');
select t.ok('AUTH-02 гонка подтверждений: challenge отклонен', (select (public.session_confirm(t.ch('41000000-0000-0000-0000-00000000000e'), '111111')->>'ok')::boolean = false));
select t.ok('AUTH-02 после гонки активна прежняя сессия', (select count(*) = 1 from public.user_sessions where user_id = '40000000-0000-0000-0000-000000000001' and status = 'active' and session_id = '41000000-0000-0000-0000-00000000000b'));
reset role; select t.as_user(null);
select t.fail('AUTH-02 две активные сессии невозможны даже напрямую', $$insert into public.user_sessions (session_id, user_id, status) values ('41000000-0000-0000-0000-0000000000aa', '40000000-0000-0000-0000-000000000001', 'active')$$, '23505');

-- активные сессии остальных (первый вход)
do $$ declare i int; begin
  for i in 2..7 loop
    perform t.as_sess('40000000-0000-0000-0000-00000000000' || i, '42000000-0000-0000-0000-00000000000' || i, case when i in (6, 7) then 'aal2' else 'aal1' end);
    perform public.session_begin('inst-user-' || i, 'Телефон ' || i);
  end loop;
end $$;

-- ===== MOD-01: NEAR Clean =====
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000004', '42000000-0000-0000-0000-000000000004');
select t.ok('MOD-01 обычный мат → первая буква и звездочки', (select public.clean_text('Ну бля, опять пробки')->>'text' = 'Ну б***, опять пробки'));
select t.ok('MOD-01 мат с пробелами', (select public.clean_text('ты б л я д ь')->>'text' !~ 'л я'));
select t.ok('MOD-01 транслит и похожие буквы', (select (public.clean_text('blyad')->>'masked')::boolean and (public.clean_text('xyй')->>'masked')::boolean and (public.clean_text('п1зда')->>'masked')::boolean));
select t.ok('MOD-01 казахский и английский', (select (public.clean_text('қотақ')->>'masked')::boolean and (public.clean_text('fuck this')->>'masked')::boolean));
select t.ok('MOD-01 обычные слова не трогаются', (select public.clean_text('хлеб небо мандарин сукно себе команда употреблять хуже')->>'masked' = 'false'));
select t.ok('MOD-01 запрос кода из SMS блокируется', (select public.clean_text('Скиньте код из смс, я верну деньги')->>'verdict' = 'block'));
select t.ok('MOD-01 предупреждение о скаме разрешено', (select public.clean_text('Осторожно, мошенники просят код из SMS — никому не сообщайте')->>'verdict' = 'allow'));
select t.ok('MOD-01 короткие и поддельные ссылки', (select public.clean_text('бонус тут bit.ly/abc')->>'verdict' = 'block' and public.clean_text('kaspi-bonus.xyz/pay')->>'verdict' = 'block' and public.clean_text('оплата на kaspi.kz')->>'verdict' = 'allow'));
select t.ok('MOD-01 поиск интим-партнера запрещен', (select public.clean_text('ищу девушку для секса без обязательств')->>'verdict' = 'block'));
insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000004', 'talk', 'Ну бля, опять пробки на Абая', 43.2, 76.9);
select t.ok('MOD-01 в базе хранится только замаскированный текст', (select text = 'Ну б***, опять пробки на Абая' from public.posts where user_id = '40000000-0000-0000-0000-000000000004'));
select t.fail('MOD-01 скам не публикуется', $$insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000004', 'deal', 'Назовите номер карты и cvv для выплаты', 43.2, 76.9)$$, 'NR422');
insert into public.posts (id, user_id, category, text, lat, lng) values ('43000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', 'talk', 'Найду тебя и убью', 43.2, 76.9);
select t.ok('MOD-01 угроза скрыта до проверки', (select status = 'draft' from public.posts where id = '43000000-0000-0000-0000-000000000001'));
reset role; select t.as_user(null);
select t.ok('MOD-01 угроза — в приоритетной очереди', (select priority = 1 from public.moderation_queue where content_id = '43000000-0000-0000-0000-000000000001'));
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000004', '42000000-0000-0000-0000-000000000004');
select public.chat_send((select id from public.group_chats where kind = 'city'), 'Там ремонт дороги, лучше объехать', null);
select t.fail('MOD-01 повтор того же текста за 60 секунд', $$select public.chat_send((select id from public.group_chats where kind = 'city'), 'Там ремонт дороги, лучше объехать', null)$$, 'NR429');
select t.ok('MOD-01 повтор с тем же ключом не создает дубль', (select (public.chat_send((select id from public.group_chats where kind = 'city'), 'Сообщение с ключом', '44000000-0000-0000-0000-000000000001')).id
  = (public.chat_send((select id from public.group_chats where kind = 'city'), 'Сообщение с ключом', '44000000-0000-0000-0000-000000000001')).id));
do $$ declare i int; begin for i in 1..8 loop perform public.chat_send((select id from public.group_chats where kind = 'city'), 'сообщение номер ' || i, null); end loop; end $$;
select t.fail('MOD-01 лимит 10 сообщений в минуту', $$select public.chat_send((select id from public.group_chats where kind = 'city'), 'одиннадцатое', null)$$, 'NR429');

-- ===== ADMIN-01 / BAN-01: санкции =====
select t.as_sess('40000000-0000-0000-0000-000000000003', '42000000-0000-0000-0000-000000000003');
select t.fail('ADMIN-01 организатор не может выдать глобальный бан', $$select public.shield_sanction('40000000-0000-0000-0000-000000000002', 'spam', 'ban', 24, 'Спам в чате встречи')$$, 'NR403');
select t.as_sess('40000000-0000-0000-0000-000000000006', '42000000-0000-0000-0000-000000000006', 'aal1');
select t.fail('ADMIN-01 модератор без второго фактора — без прав', $$select public.shield_sanction('40000000-0000-0000-0000-000000000002', 'spam', 'ban', 24, 'Спам в чате')$$, 'NR403');
select t.as_sess('40000000-0000-0000-0000-000000000006', '42000000-0000-0000-0000-000000000006', 'aal2');
select t.fail('ADMIN-01 причина обязательна', $$select public.shield_sanction('40000000-0000-0000-0000-000000000002', 'spam', 'ban', 24, '')$$, 'NR422');
select t.fail('ADMIN-01 бессрочно — только старший администратор', $$select public.shield_sanction('40000000-0000-0000-0000-000000000002', 'scam', 'ban', null, 'Подтвержденный скам')$$, 'NR403');
select t.fail('ADMIN-01 модератор — не больше 30 дней', $$select public.shield_sanction('40000000-0000-0000-0000-000000000002', 'spam', 'ban', 1000, 'Систематический спам')$$, 'NR403');
select public.shield_sanction('40000000-0000-0000-0000-000000000002', 'spam', 'ban', 720, 'Систематическая рассылка спама', 'скриншоты', 'case-1');
select t.ok('BAN-01 повтор того же решения не создает второй бан', (select (public.shield_sanction('40000000-0000-0000-0000-000000000002', 'spam', 'ban', 720, 'Систематическая рассылка спама', null, 'case-1')->>'repeat')::boolean));
reset role; select t.as_user(null);
select t.ok('BAN-01 30 дней = 720 часов от серверного starts_at', (select expires_at - starts_at = interval '720 hours' from public.user_bans where source_key = 'case-1'));
select t.ok('BAN-01 бан отзывает все сессии', (select count(*) = 0 from public.user_sessions where user_id = '40000000-0000-0000-0000-000000000002' and status = 'active'));
select t.ok('ADMIN-01 решение записано в аудит', (select count(*) = 1 from public.security_audit_log where action = 'sanction' and target_id = '40000000-0000-0000-0000-000000000002'));
select t.fail('ADMIN-01 аудит нельзя изменить', $$delete from public.security_audit_log$$, 'NR403');
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000022');
select t.ok('BAN-01 вход с нового устройства бан не снимает', (select public.session_begin('inst-new-phone', 'Новый телефон')->>'state' = 'banned'));
select t.ok('BAN-01 очистка браузера (новая установка) — тот же бан', (select public.account_state()->>'state' = 'banned_until'));
select t.ok('BAN-01 таймер по серверному времени', (select abs(extract(epoch from (public.account_state()->>'server_now')::timestamptz - now())) < 2));
select t.fail('BAN-01 заблокированный не пишет', $$insert into public.posts (user_id, category, text, lat, lng) values ('40000000-0000-0000-0000-000000000002', 'talk', 'я вернулся', 43.2, 76.9)$$, '42501');
select t.ok('BAN-01 апелляция доступна заблокированному', (select (public.appeal_submit((select id from public.user_bans where source_key = 'case-1'), 'Это был не спам, а объявление о потере собаки')->>'status') = 'pending'));
-- несколько санкций: действует самая строгая; после истечения бана — ограничение
select t.as_sess('40000000-0000-0000-0000-000000000006', '42000000-0000-0000-0000-000000000006', 'aal2');
select public.shield_sanction('40000000-0000-0000-0000-000000000005', 'insult', 'restricted', 168, 'Оскорбления в общем чате', null, 'case-2');
select public.shield_sanction('40000000-0000-0000-0000-000000000005', 'spam', 'ban', 24, 'Спам после ограничения', null, 'case-3');
select t.ok('BAN-01 несколько санкций — самая строгая', (select public.account_state('40000000-0000-0000-0000-000000000005')->>'state' = 'banned_until'));
reset role; select t.as_user(null);
update public.user_bans set starts_at = now() - interval '2 days', expires_at = now() - interval '1 second' where source_key = 'case-3';
select t.ok('BAN-01 временный бан снят автоматически (без cron), остается ограничение', (select public.account_state('40000000-0000-0000-0000-000000000005')->>'state' = 'restricted'));
-- апелляция: независимый проверяющий, отмена восстанавливает права и сторнирует штраф
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000006', '42000000-0000-0000-0000-000000000006', 'aal2');
select t.fail('ADMIN-01 апелляцию не решает автор решения', $$select public.appeal_decide((select id from public.ban_appeals limit 1), true, 'Пересмотрено')$$, 'NR403');
select t.as_sess('40000000-0000-0000-0000-000000000007', '42000000-0000-0000-0000-000000000007', 'aal2');
select public.appeal_decide((select id from public.ban_appeals limit 1), true, 'Объявление о потере, не спам');
reset role; select t.as_user(null);
select t.ok('ADMIN-01 отмена восстанавливает права', (select public.ban_level('40000000-0000-0000-0000-000000000002') = 0));
select t.ok('REP-01 отмена сторнирует штраф', (select sum(points) = 0 from public.reputation_events where user_id = '40000000-0000-0000-0000-000000000002'));
select t.ok('ADMIN-01 пользователь уведомлен о результате', (select count(*) >= 1 from public.notifications where user_id = '40000000-0000-0000-0000-000000000002' and text like '%отменено%'));

-- ===== RISK-01 / RISK-02 =====
-- общий IP (семья, Wi-Fi): только сигнал риска, никакого автоматического бана
select set_config('request.headers', '{"x-forwarded-for":"5.76.1.1"}', false);
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
 ('45000000-0000-0000-0000-000000000001', 'f1@x.kz', '{"nickname":"family_1","accepted_rules":"true"}', now()),
 ('45000000-0000-0000-0000-000000000002', 'f2@x.kz', '{"nickname":"family_2","accepted_rules":"true"}', now()),
 ('45000000-0000-0000-0000-000000000003', 'f3@x.kz', '{"nickname":"family_3","accepted_rules":"true"}', now()),
 ('45000000-0000-0000-0000-000000000004', 'f4@x.kz', '{"nickname":"family_4","accepted_rules":"true"}', now());
set role authenticated;
do $$ declare i int; begin
  for i in 1..4 loop perform t.as_sess('45000000-0000-0000-0000-00000000000' || i, '46000000-0000-0000-0000-00000000000' || i); perform public.session_begin('inst-family-' || i, 'Телефон'); end loop;
end $$;
reset role; select t.as_user(null);
select t.ok('RISK-01 общий IP не вызывает бан семьи', (select bool_and(public.ban_level(id) = 0) from public.profiles where id::text like '45000000%'));
select t.ok('RISK-02 массовая регистрация — вес 20, без ограничений', (select public.risk_score('45000000-0000-0000-0000-000000000004') = 20 and not public.risk_hold_active('45000000-0000-0000-0000-000000000004')));
select set_config('request.headers', '', false);
-- обход бана: та же установка, что у заблокированного (S2 снова забанен бессрочно админом)
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000007', '42000000-0000-0000-0000-000000000007', 'aal2');
select public.shield_sanction('40000000-0000-0000-0000-000000000002', 'scam', 'ban', null, 'Подтвержденный скам', null, 'case-4');
reset role; select t.as_user(null);
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ('47000000-0000-0000-0000-000000000001', 'ev@x.kz', '{"nickname":"fresh_start","accepted_rules":"true"}', now());
update public.profiles set meetings_pilot = true where id = '47000000-0000-0000-0000-000000000001';
set role authenticated; select t.as_sess('47000000-0000-0000-0000-000000000001', '48000000-0000-0000-0000-000000000001');
select public.session_begin('inst-user-2', 'Телефон');
select t.ok('RISK-01 подозрение на обход отправлено на проверку', (select t.links('47000000-0000-0000-0000-000000000001') = 1));
select t.ok('RISK-01 пользователь не видит связи аккаунтов', (select count(*) = 0 from public.account_links));
select t.ok('RISK-01 без автоматического бана', (select public.account_state()->>'state' = 'active'));
select t.fail('RISK-01 ограниченная регистрация: встречи до решения модератора', $$insert into public.posts (user_id, category, text, lat, lng) values ('47000000-0000-0000-0000-000000000001', 'meetup', 'Встреча', 43.2, 76.9)$$, 'NR403');
reset role; select t.as_user(null);
select t.ok('RISK-02 ограничение риска — не дольше 24 часов', (select until <= now() + interval '24 hours 1 minute' from public.risk_holds where user_id = '47000000-0000-0000-0000-000000000001'));
set role authenticated; select t.as_sess('47000000-0000-0000-0000-000000000001', '48000000-0000-0000-0000-000000000001');
select t.ok('RISK-02 пользователь не читает свои события риска', (select count(*) = 0 from public.risk_events));
select t.as_sess('40000000-0000-0000-0000-000000000006', '42000000-0000-0000-0000-000000000006', 'aal2');
select t.fail('RISK-01 связь с бессрочным баном подтверждает старший админ', $$select public.shield_link_decide((select id from public.account_links where account_id = '47000000-0000-0000-0000-000000000001'), true, 'Совпадает установка')$$, 'NR403');
select t.as_sess('40000000-0000-0000-0000-000000000007', '42000000-0000-0000-0000-000000000007', 'aal2');
select public.shield_link_decide((select id from public.account_links where account_id = '47000000-0000-0000-0000-000000000001'), true, 'Совпадает установка и стиль сообщений');
select t.ok('RISK-01 подтвержденная связь: применен срок исходного бана', (select public.account_state('47000000-0000-0000-0000-000000000001')->>'state' = 'banned_permanent'));

-- ===== Встречи, отзывы, репутация =====
reset role; select t.as_user(null);
select t.ok('REP-01 формула: 95, 96, 100, 70, 75 → 92', (select public.rep_formula(95, 96, 100, 70, 75) = 92));
select t.ok('REP-01 перенормировка без компонента', (select public.rep_formula(100, null, 100, null, null) = 100));
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000003', '42000000-0000-0000-0000-000000000003');
insert into public.posts (id, user_id, category, text, lat, lng) values ('49000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003', 'meetup', 'CS2 — собираем команду', 43.2, 76.9);
insert into public.events (post_id, starts_at, capacity, meet_cat) values ('49000000-0000-0000-0000-000000000001', now() + interval '1 day', 10, 'games');
select t.ok('MEET у встречи есть Host и свой чат', (select host_id = '40000000-0000-0000-0000-000000000003' and chat_id is not null from public.events where post_id = '49000000-0000-0000-0000-000000000001'));
select t.as_sess('40000000-0000-0000-0000-000000000004', '42000000-0000-0000-0000-000000000004');
select public.meeting_join('49000000-0000-0000-0000-000000000001');
-- после бана сессии M2 отозваны: новый вход с того же устройства активируется сразу
select t.as_sess('40000000-0000-0000-0000-000000000005', '42000000-0000-0000-0000-000000000055');
select t.ok('BAN-01 после окончания бана — повторный вход', (select public.session_begin('inst-user-5', 'Телефон 5')->>'state' = 'active'));
select t.fail('MEET ограниченный пользователь не вступает', $$select public.meeting_join('49000000-0000-0000-0000-000000000001')$$, 'NR403');
reset role; select t.as_user(null);
update public.user_bans set status = 'revoked' where user_id = '40000000-0000-0000-0000-000000000005';
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000005', '42000000-0000-0000-0000-000000000055');
select public.meeting_join('49000000-0000-0000-0000-000000000001');
select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000b');
select t.fail('CHAT чат встречи — только участникам', $$select public.chat_send((select chat_id from public.events where post_id = '49000000-0000-0000-0000-000000000001'), 'можно к вам?', null)$$, 'NR404');
select t.as_sess('40000000-0000-0000-0000-000000000003', '42000000-0000-0000-0000-000000000003');
select public.chat_restrict((select chat_id from public.events where post_id = '49000000-0000-0000-0000-000000000001'), '40000000-0000-0000-0000-000000000005', 24);
select t.as_sess('40000000-0000-0000-0000-000000000005', '42000000-0000-0000-0000-000000000055');
select t.fail('CHAT организатор ограничил только в своем чате', $$select public.chat_send((select chat_id from public.events where post_id = '49000000-0000-0000-0000-000000000001'), 'а я все равно напишу', null)$$, 'NR403');
select t.ok('CHAT ограничение в чате ≠ глобальный бан', (select public.account_state()->>'state' = 'active'));
select t.fail('REP-02 до окончания встречи отзыв недоступен', $$select public.review_submit('49000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003', 5, '{punctual}', 'Отлично')$$, 'NR403');
-- встреча прошла: отметки посещаемости
reset role; select t.as_user(null);
update public.events set starts_at = now() - interval '5 hours', ends_at = now() - interval '2 hours' where post_id = '49000000-0000-0000-0000-000000000001';
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000003', '42000000-0000-0000-0000-000000000003');
select public.meeting_mark('49000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', true);
select t.ok('REP-02 Host не подтверждает спорную посещаемость в одиночку', (select public.meeting_mark('49000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000005', true) = 'attended'));
select t.as_sess('40000000-0000-0000-0000-000000000005', '42000000-0000-0000-0000-000000000055');
select t.ok('REP-02 участник не согласен — статус disputed', (select public.meeting_mark('49000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000005', false) = 'disputed'));
select t.fail('REP-02 спорный участник не оставляет отзыв', $$select public.review_submit('49000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003', 1, '{}', 'Плохо')$$, 'NR403');
select t.as_sess('40000000-0000-0000-0000-000000000004', '42000000-0000-0000-0000-000000000004');
select public.review_submit('49000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003', 5, '{punctual,organized,hack}', 'Отличная игра, все по описанию');
select t.ok('REP-02 повторный отзыв идемпотентен', (select (public.review_submit('49000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003', 1, '{}', 'передумал')->>'repeat')::boolean));
select t.ok('REP-02 один отзыв на встречу, теги из списка', (select count(*) = 1 and bool_and(tags = '{punctual,organized}') from public.user_reviews where target_id = '40000000-0000-0000-0000-000000000003'));
select t.fail('REP-02 самооценка невозможна', $$select public.review_submit('49000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', 5, '{}', 'я молодец')$$, 'NR403');
select t.as_sess('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-00000000000b');
select t.fail('REP-02 отзывы только участникам встречи', $$select public.review_submit('49000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003', 1, '{}', 'не был, но скажу')$$, 'NR403');
reset role; select t.as_user(null);
select t.ok('REP-01 новый участник: балл скрыт (меньше 3 отзывов и встреч)', (select (public.reputation('40000000-0000-0000-0000-000000000003')->>'score') is null));
insert into public.reports (reporter_id, target_type, target_id, target_user, reason) values ('40000000-0000-0000-0000-000000000005', 'user', '40000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', 'spam');
select public.rep_recalc('40000000-0000-0000-0000-000000000003');
select t.ok('REP-01 неподтвержденные жалобы не снижают рейтинг', (select (components->>'S')::int = 100 from public.user_reputation where user_id = '40000000-0000-0000-0000-000000000003'));
-- накрутка: один аккаунт лайкает один раз; взаимные серии не дают бонусов
select t.fail('REP-01 лайк от одного аккаунта учитывается один раз', $$insert into public.likes (post_id, user_id) select id, '40000000-0000-0000-0000-000000000004' from public.posts where user_id = '40000000-0000-0000-0000-000000000004' limit 1; insert into public.likes (post_id, user_id) select id, '40000000-0000-0000-0000-000000000004' from public.posts where user_id = '40000000-0000-0000-0000-000000000004' limit 1$$, '23505');

-- ===== Медиа: staging → проверка → публикация =====
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000004', '42000000-0000-0000-0000-000000000004');
insert into public.posts (id, user_id, category, text, lat, lng, status) values ('4a000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', 'talk', 'Закат над Кок-Тобе', 43.2, 76.9, 'draft');
insert into public.post_media (post_id, user_id, url, path, type) values
 ('4a000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', 'x', '40000000-0000-0000-0000-000000000004/a/1.mp4', 'video'),
 ('4a000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', 'x', '40000000-0000-0000-0000-000000000004/a/2.jpg', 'image');
select t.fail('MEDIA клиент не может сам поставить approved', $$update public.post_media set state = 'approved', url = 'https://evil.example/x.mp4' where post_id = '4a000000-0000-0000-0000-000000000001'$$, '42501');
select t.ok('MEDIA статус клиента не принимается', (select bool_and(state = 'processing' and url like 'private:%') from public.post_media where post_id = '4a000000-0000-0000-0000-000000000001'));
update public.posts set status = 'active' where id = '4a000000-0000-0000-0000-000000000001';
select t.ok('MEDIA публикация ждет проверки всех вложений', (select status = 'draft' and publish_requested from public.posts where id = '4a000000-0000-0000-0000-000000000001'));
select t.as_sess('40000000-0000-0000-0000-000000000005', '42000000-0000-0000-0000-000000000055');
select t.ok('MEDIA непроверенный файл недоступен другим', (select count(*) = 0 from public.post_media where post_id = '4a000000-0000-0000-0000-000000000001'));
reset role; select t.as_user(null);
select t.ok('MEDIA задания созданы по одному на файл', (select count(*) = 2 from public.media_jobs j join public.post_media m on m.id = j.media_id where m.post_id = '4a000000-0000-0000-0000-000000000001'));
select t.ok('MEDIA worker берет только видео-задание', (select public.media_job_claim('w1', 'video')->>'type' = 'video'));
select t.ok('MEDIA второй worker не берет то же задание', (select public.media_job_claim('w2', 'video') is null));
select public.media_job_done((select id from public.media_jobs where worker = 'w1'), 'retry', '{"error":"ffmpeg timeout"}');
select t.ok('MEDIA сбой worker: повтор, не публикация', (select j.status = 'queued' and p.status = 'draft' from public.media_jobs j join public.post_media m on m.id = j.media_id join public.posts p on p.id = m.post_id where j.worker = 'w1'));
select public.media_job_claim('w1', 'video');
select public.media_job_done((select id from public.media_jobs where worker = 'w1'), 'approved', '{"url":"https://cdn/x.mp4","bucket":"post-media","duration":12.4,"w":720,"h":1280}');
select t.ok('MEDIA одно вложение одобрено — пост еще не виден', (select status = 'draft' from public.posts where id = '4a000000-0000-0000-0000-000000000001'));
update public.post_media set state = 'approved', url = 'https://cdn/2.jpg', bucket = 'post-media' where post_id = '4a000000-0000-0000-0000-000000000001' and type = 'image';
select t.ok('MEDIA все вложения одобрены — публикация атомарно', (select status = 'active' from public.posts where id = '4a000000-0000-0000-0000-000000000001'));
select public.media_job_done((select id from public.media_jobs where worker = 'w1'), 'rejected', '{}');
select t.ok('MEDIA повторный отчет worker ничего не меняет', (select state = 'approved' from public.post_media where post_id = '4a000000-0000-0000-0000-000000000001' and type = 'video'));

-- ===== прочее =====
set role authenticated; select t.as_sess('40000000-0000-0000-0000-000000000004', '42000000-0000-0000-0000-000000000004');
select t.fail('DM личные сообщения отключены', $$select public.get_or_create_conversation('40000000-0000-0000-0000-000000000003')$$, 'NR403');
insert into public.blocks (blocker_id, blocked_id) values ('40000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000003');
select t.as_sess('40000000-0000-0000-0000-000000000003', '42000000-0000-0000-0000-000000000003');
select public.chat_send((select id from public.group_chats where kind = 'city'), 'Сообщение от заблокированного', null);
select t.as_sess('40000000-0000-0000-0000-000000000004', '42000000-0000-0000-0000-000000000004');
select t.ok('ADMIN-01 блокировка скрывает сообщения и превью в общем чате', (select count(*) = 0 from public.chat_messages where sender_id = '40000000-0000-0000-0000-000000000003')
  and (select coalesce(last_nick, '') <> 'host_aru' from public.chat_list() where kind = 'city'));
select t.as_sess('40000000-0000-0000-0000-000000000004', '42000000-0000-0000-0000-000000000004');
select t.ok('UI-01 история входов — только свои', (select count(*) >= 1 and bool_and(true) from public.session_list()));
select t.fail('UI-01 чужие сессии не видны', $$select 1/(select count(*) from public.user_sessions where user_id <> '40000000-0000-0000-0000-000000000004')$$, '22012');

-- ===== Чаты: ответы и реакции =====
select t.as_sess('40000000-0000-0000-0000-000000000004', '42000000-0000-0000-0000-000000000004');
select t.ok('CHAT реакция ставится и снимается', (select public.chat_react((select id from public.chat_messages where text = 'Там ремонт дороги, лучше объехать' limit 1), '👍')
  and not public.chat_react((select id from public.chat_messages where text = 'Там ремонт дороги, лучше объехать' limit 1), '👍')));
select t.ok('CHAT страница: сообщения с никами, без заблокированных', (select count(*) > 0 and bool_and(nickname is not null and sender_id <> '40000000-0000-0000-0000-000000000003') from public.chat_page((select id from public.group_chats where kind = 'city'))));
