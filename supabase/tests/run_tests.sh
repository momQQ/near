#!/bin/sh
# Локальная проверка схемы: чистая база → schema.sql (дважды) → тесты прав.
# Нужен Postgres 15+ и psql. Подключение — через PGHOST/PGPORT/PGUSER, например:
#   PGHOST=localhost PGUSER=postgres sh supabase/tests/run_tests.sh
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
psql -d postgres -qc "drop database if exists near_test" -c "create database near_test"
psql -d near_test -q -v ON_ERROR_STOP=1 -f "$DIR/stub_supabase.sql"
# заглушка PostGIS не поддерживает typmod и GiST — убираем их только для теста
sed -e 's/extensions.geography(Point, 4326)/extensions.geography/' -e '/using gist (geog)/d' -e '/create extension if not exists postgis/d' \
  "$DIR/../schema.sql" > /tmp/near_schema_test.sql
psql -d near_test -q -v ON_ERROR_STOP=1 -f /tmp/near_schema_test.sql > /tmp/near_schema_1.log 2>&1 || { cat /tmp/near_schema_1.log; exit 1; }
psql -d near_test -q -v ON_ERROR_STOP=1 -f /tmp/near_schema_test.sql > /tmp/near_schema_2.log 2>&1 || { echo "повторный запуск схемы упал"; cat /tmp/near_schema_2.log; exit 1; }
# v14.2: ошибка psql (ON_ERROR_STOP) больше не теряется в конвейере — она считается провалом
: > /tmp/near_tests.log
run_sql() {
  rc=0; psql -d near_test -q -v ON_ERROR_STOP=1 -f "$1" > /tmp/near_one.log 2>&1 || rc=$?
  grep -v "^ |^-|^(|^$" /tmp/near_one.log | tee -a /tmp/near_tests.log | grep -E "PASS|FAIL|ERROR" || true  # grep без совпадений — не ошибка
  [ "$rc" -eq 0 ] || echo "FAIL: $(basename "$1") остановился с ошибкой (код $rc)" | tee -a /tmp/near_tests.log
}
run_sql "$DIR/rls_v11.sql"
run_sql "$DIR/rls_v12.sql"
run_sql "$DIR/rls_v14.sql"
run_sql "$DIR/rls_v15.sql"
run_sql "$DIR/rls_v16.sql"
# CLEAN-01: SQL и JS дают одинаковый результат (примеры + 3000 случайных строк)
node "$DIR/clean_parity.mjs" "$DIR/clean_cases.json" > /tmp/near_parity.sql || echo "FAIL: clean_parity.mjs" | tee -a /tmp/near_tests.log
psql -d near_test -q < /tmp/near_parity.sql 2>&1 | grep -E "PASS|FAIL|ERROR" | sed 's/^psql:[^ ]* //' | tee -a /tmp/near_tests.log
# POST-02: два одновременных запроса на последнее место — проходит только один
psql -d near_test -qAtc "select set_config('request.jwt.claim.sub','',false); insert into posts(id,user_id,category,text,lat,lng) values ('e0000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-00000000000a','event','Гонка',43.2,76.9); insert into events values ('e0000000-0000-0000-0000-000000000001', now()+interval '1 day', 1);" >/dev/null
psql -d near_test -qAt -c "begin; insert into event_members(post_id,user_id) values ('e0000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001'); select pg_sleep(2); commit;" >/dev/null 2>&1 &
sleep 0.5
psql -d near_test -qAt -c "insert into event_members(post_id,user_id) values ('e0000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002')" >/dev/null 2>&1 || true
wait
N=$(psql -d near_test -qAtc "select count(*) from event_members where post_id='e0000000-0000-0000-0000-000000000001'")
if [ "$N" = "1" ]; then echo "PASS: POST-02 параллельная запись не превышает лимит мест" >> /tmp/near_tests.log; else echo "FAIL: POST-02 параллельная запись: $N" >> /tmp/near_tests.log; fi
# SOS-01: две параллельные отправки SOS одним автором — активным становится только один
psql -d near_test -qAt -c "begin; select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000003',true); set local role authenticated; insert into posts(user_id,category,text,lat,lng,is_sos) values ('30000000-0000-0000-0000-000000000003','incident','SOS: A',43.2,76.9,true); select pg_sleep(2); commit;" >/dev/null 2>&1 &
sleep 0.5
psql -d near_test -qAt -c "begin; select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000003',true); set local role authenticated; insert into posts(user_id,category,text,lat,lng,is_sos) values ('30000000-0000-0000-0000-000000000003','incident','SOS: B',43.2,76.9,true); commit;" >/dev/null 2>&1 || true
wait
N=$(psql -d near_test -qAtc "select count(*) from posts where user_id='30000000-0000-0000-0000-000000000003' and is_sos and status='active'")
if [ "$N" = "1" ]; then echo "PASS: SOS-01 два параллельных SOS дают один активный" >> /tmp/near_tests.log; else echo "FAIL: SOS-01 параллельно активных: $N" >> /tmp/near_tests.log; fi
# v14 / Q09: 4 места + два параллельных добавления — остается 5
U=41000000-0000-0000-0000-000000000005
psql -d near_test -qAtc "insert into saved_places(user_id,name,lat,lng) select '$U','P'||g,43.2,76.9 from generate_series(1,4) g" >/dev/null
for k in 1 2; do psql -d near_test -qAt -c "begin; select set_config('request.jwt.claim.sub','$U',true); set local role authenticated; insert into saved_places(user_id,name,lat,lng) values ('$U','R$k',43.2,76.9); select pg_sleep(1); commit;" >/dev/null 2>&1 & done
wait
N=$(psql -d near_test -qAtc "select count(*) from saved_places where user_id='$U'")
if [ "$N" = "5" ]; then echo "PASS: Q09 параллельные избранные места: не больше 5" >> /tmp/near_tests.log; else echo "FAIL: Q09 избранных мест: $N" >> /tmp/near_tests.log; fi
# v14 / LIM: у нового аккаунта 2 публикации, три параллельные попытки — проходит одна (лимит 3)
U=41000000-0000-0000-0000-000000000004
for k in 1 2; do psql -d near_test -qAt -c "select set_config('request.jwt.claim.sub','$U',false); set role authenticated; insert into posts(user_id,category,text,lat,lng) values ('$U','talk','Пост номер $k для лимита',43.2,76.9);" >/dev/null 2>&1; done
for k in 3 4 5; do psql -d near_test -qAt -c "begin; select set_config('request.jwt.claim.sub','$U',true); set local role authenticated; insert into posts(user_id,category,text,lat,lng) values ('$U','talk','Параллельный пост $k',43.2,76.9); select pg_sleep(1); commit;" >/dev/null 2>&1 & done
wait
N=$(psql -d near_test -qAtc "select count(*) from posts where user_id='$U'")
if [ "$N" = "3" ]; then echo "PASS: LIM параллельные публикации не превышают дневной лимит" >> /tmp/near_tests.log; else echo "FAIL: LIM параллельно опубликовано: $N" >> /tmp/near_tests.log; fi
# v14.8 / MEET: два решения Host на последнее место одновременно — проходит одно
M=$(psql -d near_test -qAtc "select id from meetings where title = 'Race meet'" )
if [ -z "$M" ]; then
psql -d near_test -qAtc "insert into posts(id,user_id,category,text,lat,lng) values ('6f000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','meetup','Гонка за место',43.2,76.9);
 insert into meetings(id,host_id,category,title,starts_at,ends_at,capacity) values ('6f000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','sport','Race meet',now()+interval '1 day',now()+interval '1 day 2 hours',3);
 insert into rooms(type,scope_id,title,is_public,meeting_id) values ('meeting','6f000000-0000-0000-0000-000000000001','Race meet',false,'6f000000-0000-0000-0000-000000000001');
 update meetings set room_id=(select id from rooms where meeting_id='6f000000-0000-0000-0000-000000000001') where id='6f000000-0000-0000-0000-000000000001';
 insert into meeting_members(meeting_id,user_id,role,status) values ('6f000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','host','accepted'),('6f000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002','member','accepted'),
  ('6f000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000003','member','requested'),('6f000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000004','member','requested');" >/dev/null
fi
for k in 3 4; do psql -d near_test -qAt -c "begin; select set_config('request.jwt.claim.sub','60000000-0000-0000-0000-000000000001',true); set local role authenticated; select public.decide_request('6f000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-00000000000$k',true); select pg_sleep(1); commit;" >/dev/null 2>&1 & done
wait
N=$(psql -d near_test -qAtc "select count(*) from meeting_members where meeting_id='6f000000-0000-0000-0000-000000000001' and status='accepted'")
if [ "$N" = "3" ]; then echo "PASS: MEET два запроса на последнее место — один успех" >> /tmp/near_tests.log; else echo "FAIL: MEET последнее место: принято $N из 3" >> /tmp/near_tests.log; fi
P=$(grep -c "PASS" /tmp/near_tests.log || true); F=$(grep -cE "FAIL|ERROR" /tmp/near_tests.log || true)
echo "Итог: PASS=$P FAIL=$F"
[ "$F" = "0" ] && [ "$P" -gt 0 ]
