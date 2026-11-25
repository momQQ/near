#!/bin/sh
# Локальная проверка схемы: чистая база → schema.sql (дважды) → тесты прав v11, v12 и Shield v14.9.
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
# v14.9 Shield — после параллельных проверок (включает обязательные сессии)
psql -d near_test -q -v ON_ERROR_STOP=1 -f "$DIR/rls_v14.sql" 2>&1 | grep -v "^ |^-|^(|^$" | tee -a /tmp/near_tests.log | grep -E "PASS|FAIL|ERROR" || true
# AUTH-02: два одновременных первых входа одного аккаунта — активной становится только одна сессия
psql -d near_test -qAtc "insert into auth.users (id,email,raw_user_meta_data,email_confirmed_at) values ('4f000000-0000-0000-0000-000000000001','par@x.kz','{\"nickname\":\"parallel_user\",\"accepted_rules\":\"true\"}',now())" >/dev/null
J1='{"sub":"4f000000-0000-0000-0000-000000000001","session_id":"4f100000-0000-0000-0000-000000000001"}'
J2='{"sub":"4f000000-0000-0000-0000-000000000001","session_id":"4f100000-0000-0000-0000-000000000002"}'
psql -d near_test -qAt -c "begin; select set_config('request.jwt.claim.sub','4f000000-0000-0000-0000-000000000001',true), set_config('request.jwt.claims','$J1',true); set local role authenticated; select public.session_begin('dev-1','A'); select pg_sleep(2); commit;" >/dev/null 2>&1 &
sleep 0.5
psql -d near_test -qAt -c "begin; select set_config('request.jwt.claim.sub','4f000000-0000-0000-0000-000000000001',true), set_config('request.jwt.claims','$J2',true); set local role authenticated; select public.session_begin('dev-2','B'); commit;" >/dev/null 2>&1 || true
wait
N=$(psql -d near_test -qAtc "select count(*) from user_sessions where user_id='4f000000-0000-0000-0000-000000000001' and status='active'")
if [ "$N" = "1" ]; then echo "PASS: AUTH-02 параллельные входы не создают две активные сессии" >> /tmp/near_tests.log; else echo "FAIL: AUTH-02 параллельно активных сессий: $N" >> /tmp/near_tests.log; fi
P=$(grep -c "PASS" /tmp/near_tests.log || true); F=$(grep -c "FAIL" /tmp/near_tests.log || true)
echo "Итог: PASS=$P FAIL=$F"
[ "$F" = "0" ] && [ "$P" -gt 0 ]
