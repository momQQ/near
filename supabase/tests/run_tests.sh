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
psql -d near_test -q -v ON_ERROR_STOP=1 -f "$DIR/rls_v11.sql" 2>&1 | grep -v "^ |^-|^(|^$" | tee /tmp/near_tests.log | grep -E "PASS|FAIL" || true
psql -d near_test -q -v ON_ERROR_STOP=1 -f "$DIR/rls_v12.sql" 2>&1 | grep -v "^ |^-|^(|^$" | tee -a /tmp/near_tests.log | grep -E "PASS|FAIL|ERROR" || true
psql -d near_test -q -v ON_ERROR_STOP=1 -f "$DIR/rls_v14.sql" 2>&1 | grep -v "^ |^-|^(|^$" | tee -a /tmp/near_tests.log | grep -E "PASS|FAIL|ERROR" || true
# CLEAN-01: SQL и JS дают одинаковый результат (примеры + 3000 случайных строк)
node "$DIR/clean_parity.mjs" "$DIR/clean_cases.json" | psql -d near_test -q 2>&1 | grep -E "PASS|FAIL|ERROR" | sed 's/^psql:[^ ]* //' | tee -a /tmp/near_tests.log || true
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
P=$(grep -c "PASS" /tmp/near_tests.log || true); F=$(grep -cE "FAIL|ERROR" /tmp/near_tests.log || true)
echo "Итог: PASS=$P FAIL=$F"
[ "$F" = "0" ] && [ "$P" -gt 0 ]
