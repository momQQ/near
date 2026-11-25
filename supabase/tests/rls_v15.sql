-- NEAR v14.2 (ТЗ v14.6, этап 1.2): MFA модераторов, Instagram, санкции, блокировка опасного, поля форм,
-- закрытые медиа, NEAR City, счетчики, лента одним запросом, легкая карта. Запуск после rls_v14.sql.
reset role; select t.as_user(null);
update public.app_settings set mod_require_mfa = true, age_gate = true, media_requires_check = true, ai_moderation = false,
  day_limits = '{"post":[50,50],"comment":[50,50],"chat_request":[3,10],"meeting":[0,3]}'::jsonb;
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
 ('50000000-0000-0000-0000-000000000001', 'w1@x.kz', '{"nickname":"Writer_1","accepted_rules":"true"}', now()),
 ('50000000-0000-0000-0000-000000000002', 'w2@x.kz', '{"nickname":"Reader_2","accepted_rules":"true"}', now()),
 ('50000000-0000-0000-0000-000000000003', 'w3@x.kz', '{"nickname":"Keeper_3x","accepted_rules":"true"}', now());
update public.profiles set is_moderator = true where id = '50000000-0000-0000-0000-000000000003';
create function t.aal(a text) returns void language sql as $$ select set_config('request.jwt.claims', case when a is null then '' else json_build_object('aal', a)::text end, false) $$;
grant execute on function t.aal(text) to authenticated;

-- ===== 45/60: MFA модератора =====
set role authenticated; select t.as_user('50000000-0000-0000-0000-000000000003'); select t.aal('aal1');
select t.ok('MFA роль есть, но без второго фактора прав модератора нет', (select public.has_mod_role() and not public.is_mod()));
select t.fail('MFA модераторское действие без второго фактора', $$select public.mod_restrict('50000000-0000-0000-0000-000000000001', 'comment', 1, 'спам')$$, 'NR403');
select t.ok('MFA my_account сообщает о необходимости второго фактора', (select (public.my_account()->>'mod_role')::boolean and not (public.my_account()->>'mfa_ok')::boolean));
select t.aal('aal2');
select t.ok('MFA вход с вторым фактором дает права модератора', (select public.is_mod()));

-- ===== 45/60: санкции по функциям и сроку =====
select public.mod_restrict('50000000-0000-0000-0000-000000000001', 'comment', 1, 'Повторный спам в комментариях');
select t.fail('SANCTION бессрочно может только администратор', $$select public.mod_restrict('50000000-0000-0000-0000-000000000001', 'all', null, 'тяжелое нарушение')$$, 'NR403');
select t.fail('SANCTION срок больше 30 дней', $$select public.mod_restrict('50000000-0000-0000-0000-000000000001', 'chat', 31, 'травля')$$, 'NR422');
select t.aal(null);
select t.as_user('50000000-0000-0000-0000-000000000001');
insert into public.posts (id, user_id, category, text, lat, lng) values ('5f000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'talk', 'Публикация во время ограничения комментариев', 43.2, 76.9);
select t.ok('SANCTION ограничение комментариев не мешает публикациям', (select count(*) = 1 from public.posts where id = '5f000000-0000-0000-0000-000000000001'));
do $$ begin
  insert into public.comments (post_id, user_id, text) values ('5f000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'Комментарий нарушителя');
  raise notice 'FAIL: SANCTION комментарий при ограничении (ошибки не было)';
exception when others then
  declare h text; begin get stacked diagnostics h = pg_exception_hint; perform t.ok('SANCTION комментарий запрещен, причина и срок в ответе', sqlstate = 'NR403' and h = 'restricted' and sqlerrm like '%Повторный спам%'); end;
end $$;
select t.ok('SANCTION состояние аккаунта "restricted", разрешенные действия с сервера', (select public.my_account()->>'state' = 'restricted' and not (public.my_account()->'can'->>'comment')::boolean and (public.my_account()->'can'->>'post')::boolean));
select t.ok('SANCTION пользователь видит свое ограничение', (select count(*) = 1 from public.user_sanctions));
select t.as_user('50000000-0000-0000-0000-000000000002');
select t.ok('SANCTION чужие ограничения не видны', (select count(*) = 0 from public.user_sanctions));
select t.as_user('50000000-0000-0000-0000-000000000003'); select t.aal('aal2');
select public.mod_unrestrict((select id from public.user_sanctions where user_id = '50000000-0000-0000-0000-000000000001' and revoked_at is null), 'Апелляция принята');
select t.aal(null); select t.as_user('50000000-0000-0000-0000-000000000001');
insert into public.comments (post_id, user_id, text) values ('5f000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'После снятия ограничения');
select t.ok('SANCTION после снятия комментарий проходит', (select count(*) = 1 from public.comments where text = 'После снятия ограничения'));

-- ===== 38: Instagram скрыт по умолчанию =====
update public.profiles set instagram = 'writer.one', interests = array['games','mountains'] where id = '50000000-0000-0000-0000-000000000001';
select t.ok('INSTA владелец видит свой Instagram', (select public.profile_instagram('50000000-0000-0000-0000-000000000001') = 'writer.one'));
select t.fail('INSTA интересы — только из списка', $$update public.profiles set interests = array['dating'] where id = '50000000-0000-0000-0000-000000000001'$$, '23514');
select t.as_user('50000000-0000-0000-0000-000000000002');
select t.fail('INSTA колонка instagram не читается напрямую', $$select instagram from public.profiles limit 1$$, '42501');
select t.ok('INSTA скрыт от других по умолчанию', (select public.profile_instagram('50000000-0000-0000-0000-000000000001') is null));
select t.as_user('50000000-0000-0000-0000-000000000001');
update public.profiles set instagram_public = true where id = '50000000-0000-0000-0000-000000000001';
select t.as_user('50000000-0000-0000-0000-000000000002');
select t.ok('INSTA виден, когда владелец включил', (select public.profile_instagram('50000000-0000-0000-0000-000000000001') = 'writer.one'));

-- ===== 45/60/07: опасное блокируется независимо от маскирования =====
select t.fail('BLOCK интим-услуги', $$insert into public.posts (user_id, category, text, lat, lng) values ('50000000-0000-0000-0000-000000000002', 'ad', 'Интим услуги недорого, пиши', 43.2, 76.9)$$, 'NR422');
select t.fail('BLOCK просьба кода из SMS', $$insert into public.comments (post_id, user_id, text) values ('5f000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', 'Скиньте код из смс, я проверю заказ')$$, 'NR422');
select t.fail('BLOCK сокращенная ссылка', $$insert into public.posts (user_id, category, text, lat, lng) values ('50000000-0000-0000-0000-000000000002', 'talk', 'Подробнее тут bit.ly/abc123', 43.2, 76.9)$$, 'NR422');
insert into public.posts (id, user_id, category, text, lat, lng) values ('5f000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', 'talk', 'Напоминаю: никому не сообщайте код из смс', 43.2, 76.9);
select t.ok('BLOCK предупреждение о мошенниках публикуется', (select count(*) = 1 from public.posts where id = '5f000000-0000-0000-0000-000000000002'));
insert into public.posts (id, user_id, category, text, lat, lng) values ('5f000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000002', 'ad', 'Продам велосипед, нужна предоплата 50%', 43.2, 76.9);
insert into public.posts (id, user_id, category, text, lat, lng) values ('5f000000-0000-0000-0000-000000000004', '50000000-0000-0000-0000-000000000002', 'ad', 'Отдам стол, без предоплаты', 43.2, 76.9);
reset role; select t.as_user(null);
select t.ok('FLAG "предоплата" — публикуется и уходит модератору', (select count(*) = 1 from public.reports where target_id = '5f000000-0000-0000-0000-000000000003' and source = 'rules'));
select t.ok('FLAG "без предоплаты" — без жалобы', (select count(*) = 0 from public.reports where target_id = '5f000000-0000-0000-0000-000000000004'));

-- ===== 40/52: поля форм и сроки =====
set role authenticated; select t.as_user('50000000-0000-0000-0000-000000000002');
insert into public.posts (id, user_id, category, text, lat, lng, meta) values ('5f000000-0000-0000-0000-000000000010', '50000000-0000-0000-0000-000000000002', 'incident', 'Нет воды в доме', 43.2, 76.9, '{"itype":"water","ttl_h":3,"evil":"<script>"}');
select t.ok('FORM происшествие: срок актуальности 3 ч, лишние поля отброшены', (select expires_at <= now() + interval '3 hours 1 minute' and meta = '{"itype":"water","ttl_h":3}'::jsonb from public.posts where id = '5f000000-0000-0000-0000-000000000010'));
insert into public.posts (id, user_id, category, text, lat, lng, meta) values ('5f000000-0000-0000-0000-000000000011', '50000000-0000-0000-0000-000000000002', 'event', 'Описание события', 43.2, 76.9, '{"title":"Блять, концерт во дворе","price_kzt":"free","source_url":"http://evil.example"}');
select t.ok('FORM событие: название маскируется, бесплатно = 0, ссылка не https отброшена', (select meta->>'title' = 'Б****, концерт во дворе' and (meta->>'price_kzt')::int = 0 and not meta ? 'source_url' from public.posts where id = '5f000000-0000-0000-0000-000000000011'));
select t.fail('FORM акция дольше 14 дней', $$insert into public.posts (user_id, category, text, lat, lng, meta) values ('50000000-0000-0000-0000-000000000002', 'deal', 'Скидка', 43.2, 76.9, jsonb_build_object('org', 'Кафе', 'until', now() + interval '20 days'))$$, 'NR422');
insert into public.posts (id, user_id, category, text, lat, lng, meta) values ('5f000000-0000-0000-0000-000000000012', '50000000-0000-0000-0000-000000000002', 'help', 'Нужна помощь донести шкаф', 43.2, 76.9, '{"hkind":"need"}');
select t.ok('FORM новая категория "Помощь" со сроком 7 дней', (select expires_at <= now() + interval '7 days 1 minute' and meta->>'hkind' = 'need' from public.posts where id = '5f000000-0000-0000-0000-000000000012'));

-- ===== 55: NEAR City — официальное только у редактора =====
insert into public.posts (id, user_id, category, text, lat, lng, official, source_name) values ('5f000000-0000-0000-0000-000000000020', '50000000-0000-0000-0000-000000000002', 'incident', 'Якобы официально', 43.2, 76.9, true, 'Акимат');
select t.ok('CITY пользователь не может выдать публикацию за официальную', (select not official and source_name is null from public.posts where id = '5f000000-0000-0000-0000-000000000020'));
select t.fail('CITY редакторская функция недоступна пользователю', $$select public.city_upsert('{"source_name":"Алматы Су","text":"Отключение воды","lat":43.2,"lng":76.9}')$$, 'NR403');
select t.as_user('50000000-0000-0000-0000-000000000003'); select t.aal('aal2');
select public.city_upsert('{"source_id":"almatysu:2026-11-24-1","source_name":"Алматы Су","source_url":"https://almatysu.kz/news/1","category":"incident","itype":"water","title":"Временное отключение воды","text":"Ремонт на сетях в Бостандыкском районе","lat":43.21,"lng":76.9}');
select public.city_upsert('{"source_id":"almatysu:2026-11-24-1","source_name":"Алматы Су","category":"incident","itype":"water","title":"Временное отключение воды","text":"Обновлено: подача восстановится к 18:00","lat":43.21,"lng":76.9}');
select t.aal(null);
reset role; select t.as_user(null);
select t.ok('CITY повторный импорт обновляет ту же карточку, версия 2 в журнале', (select count(*) = 1 from public.posts where source_id = 'almatysu:2026-11-24-1')
  and (select max(version) = 2 from public.city_log l join public.posts p on p.id = l.post_id where p.source_id = 'almatysu:2026-11-24-1'));
select t.ok('CITY карточка официальная, с источником и временем проверки', (select official and source_name = 'Алматы Су' and verified_at is not null and text like 'Обновлено%' from public.posts where source_id = 'almatysu:2026-11-24-1'));

-- ===== 06/60: закрытые медиа =====
set role authenticated; select t.as_user('50000000-0000-0000-0000-000000000001');
insert into public.post_media (id, post_id, user_id, url, type, position, path) values ('5c000000-0000-0000-0000-000000000001', '5f000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'https://public/x.jpg', 'image', 0, '50000000-0000-0000-0000-000000000001/5f000000-0000-0000-0000-000000000001/0.jpg');
select t.ok('MEDIA новый файл — приватный, ждет проверки', (select bucket = 'post-private' and url = 'private:50000000-0000-0000-0000-000000000001/5f000000-0000-0000-0000-000000000001/0.jpg' and mod_status = 'review' from public.post_media where id = '5c000000-0000-0000-0000-000000000001'));
select t.ok('MEDIA автор видит свой непроверенный файл', (select public.storage_media_visible('50000000-0000-0000-0000-000000000001/5f000000-0000-0000-0000-000000000001/0.jpg')));
select t.fail('MEDIA загрузка в публичный post-media закрыта', $$insert into storage.objects (bucket_id, name) values ('post-media', '50000000-0000-0000-0000-000000000001/x.jpg')$$, '42501');
insert into storage.objects (bucket_id, name) values ('post-private', '50000000-0000-0000-0000-000000000001/5f000000-0000-0000-0000-000000000001/1.jpg');
select t.ok('MEDIA загрузка в свою папку приватного бакета', true);
select t.fail('MEDIA чужая папка приватного бакета', $$insert into storage.objects (bucket_id, name) values ('post-private', '50000000-0000-0000-0000-000000000002/x.jpg')$$, '42501');
select t.as_user('50000000-0000-0000-0000-000000000002');
select t.ok('MEDIA другой пользователь не получает непроверенный файл', (select not public.storage_media_visible('50000000-0000-0000-0000-000000000001/5f000000-0000-0000-0000-000000000001/0.jpg')));
select t.ok('MEDIA строка непроверенного файла не видна другим', (select count(*) = 0 from public.post_media where id = '5c000000-0000-0000-0000-000000000001'));
select t.as_user('50000000-0000-0000-0000-000000000003'); select t.aal('aal2');
select t.ok('MEDIA модератор видит очередь', (select jsonb_array_length(public.mod_media_queue()) >= 1));
select public.mod_media('5c000000-0000-0000-0000-000000000001', true);
select t.aal(null); select t.as_user('50000000-0000-0000-0000-000000000002');
select t.ok('MEDIA после одобрения файл доступен по подписанной ссылке', (select public.storage_media_visible('50000000-0000-0000-0000-000000000001/5f000000-0000-0000-0000-000000000001/0.jpg')));
reset role; select t.as_user(null);
update public.posts set status = 'hidden' where id = '5f000000-0000-0000-0000-000000000001';
set role authenticated; select t.as_user('50000000-0000-0000-0000-000000000002');
select t.ok('MEDIA скрытая публикация — доступ к файлу отозван', (select not public.storage_media_visible('50000000-0000-0000-0000-000000000001/5f000000-0000-0000-0000-000000000001/0.jpg')));
reset role; select t.as_user(null); update public.posts set status = 'active' where id = '5f000000-0000-0000-0000-000000000001';

-- ===== 57: счетчики =====
set role authenticated; select t.as_user('50000000-0000-0000-0000-000000000002');
insert into public.likes (post_id, user_id) values ('5f000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002');
select t.ok('COUNT лайк увеличивает счетчик', (select likes_count = 1 and comments_count = 1 from public.posts where id = '5f000000-0000-0000-0000-000000000001'));
delete from public.likes where post_id = '5f000000-0000-0000-0000-000000000001' and user_id = '50000000-0000-0000-0000-000000000002';
select t.ok('COUNT снятие лайка уменьшает счетчик', (select likes_count = 0 from public.posts where id = '5f000000-0000-0000-0000-000000000001'));
select t.as_user('50000000-0000-0000-0000-000000000001');
update public.posts set likes_count = 999 where id = '5f000000-0000-0000-0000-000000000001';
select t.ok('COUNT автор не меняет счетчик напрямую', (select likes_count = 0 from public.posts where id = '5f000000-0000-0000-0000-000000000001'));
reset role; select t.as_user(null);
update public.posts set likes_count = 77 where id = '5f000000-0000-0000-0000-000000000001';
select t.ok('COUNT сверка находит расхождение', (select public.counters_reconcile() >= 1));
select t.ok('COUNT сверка исправляет расхождение', (select likes_count = 0 from public.posts where id = '5f000000-0000-0000-0000-000000000001'));

-- ===== 57: лента одним запросом — курсор по id без дублей и пропусков (новые / рядом / для вас) =====
insert into public.posts (id, user_id, category, text, lat, lng, created_at)
select ('5e000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, '50000000-0000-0000-0000-000000000002', 'talk', 'Лента ' || g, 46.0 + g * 0.0004, 80.0, now() - (g || ' minutes')::interval from generate_series(1, 40) g;
create temp table f15 (sort text, id uuid);
do $$ declare s text; after uuid; snap timestamptz; n int; r record; pg int;
begin
  foreach s in array array['new','near','top'] loop
    after := null; snap := now(); pg := 0;
    loop
      pg := pg + 1; n := 0;
      for r in select * from public.feed_v14(46.0, 80.0, 10000, array['talk'], s, null, false, after, snap, 15) loop
        insert into f15 values (s, r.id); n := n + 1; after := r.id;
      end loop;
      if pg = 1 and s = 'top' then insert into public.likes (post_id, user_id) select '5e000000-0000-0000-0000-000000000030', id from public.profiles limit 10; end if;
      exit when n < 15 or pg > 10;
    end loop;
  end loop;
end $$;
select t.ok('FEED v14 "Новые": 40 из 40 без дублей', (select count(*) = 40 and count(distinct id) = 40 from f15 where sort = 'new'));
select t.ok('FEED v14 "Рядом": 40 из 40 без дублей', (select count(*) = 40 and count(distinct id) = 40 from f15 where sort = 'near'));
select t.ok('FEED v14 "Для вас": снимок, 40 из 40 без дублей', (select count(*) = 40 and count(distinct id) = 40 from f15 where sort = 'top'));
select t.ok('FEED v14 возвращает счетчики в строке публикации', (select likes_count = 10 from public.posts where id = '5e000000-0000-0000-0000-000000000030'));

-- ===== 46/57: карта — легкий ответ и признак неполной выдачи =====
select t.ok('MAP v14 только нужные поля, без автора', (select not (public.map_v14(79.9, 45.9, 80.1, 46.1, null, null, null, null, null, false, 5)->'items'->0 ? 'user_id')
  and (public.map_v14(79.9, 45.9, 80.1, 46.1, null, null, null, null, null, false, 5)->'items'->0 ? 'title')));
select t.ok('MAP v14 сообщает о неполной выдаче, а не обрезает молча', (select (public.map_v14(79.9, 45.9, 80.1, 46.1, null, null, null, null, null, false, 5)->>'truncated')::boolean));

-- ===== 38: состояние аккаунта =====
set role authenticated; select t.as_user('50000000-0000-0000-0000-000000000002');
select t.ok('ACCOUNT активный аккаунт: состояние, разрешения, лимиты', (select public.my_account()->>'state' = 'active' and (public.my_account()->'limits'->'post'->>'limit')::int = 50
  and (public.my_account()->'can'->>'chat')::boolean and not (public.my_account()->'can'->>'meet')::boolean));
reset role; select t.as_user(null);
-- вернуть дневные лимиты по умолчанию для проверок гонок в run_tests.sh
update public.app_settings set day_limits = '{"post":[3,15],"comment":[20,100],"chat_request":[3,10],"meeting":[0,3]}'::jsonb, mod_require_mfa = false;
