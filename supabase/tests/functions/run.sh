#!/bin/sh
# Проверка Edge Functions без Supabase: подменяется клиент базы и сеть (Node 22+).
set -e
D=$(cd "$(dirname "$0")" && pwd); F="$D/../../functions"
sed 's#import { createClient } from "npm:@supabase/supabase-js@2";#const createClient = (globalThis as any).__fakeCreate;#' "$F/push/index.ts" > "$D/.push.ts"
sed 's#import { createClient } from "npm:@supabase/supabase-js@2";#const createClient = (globalThis as any).__fake;#' "$F/delete-account/index.ts" > "$D/.del.ts"
sed 's#import { createClient } from "npm:@supabase/supabase-js@2";#const createClient = (globalThis as any).__fake;#' "$F/moderate/index.ts" > "$D/.mod.ts"
sed 's#import { createClient } from "npm:@supabase/supabase-js@2";#const createClient = (globalThis as any).__fake;#' "$F/login/index.ts" > "$D/.login.ts"
# тестовые файлы: MOV H.264 и MP4 HEVC с координатами, поддельный JPEG
M=$(mktemp -d)
ffmpeg -loglevel error -f lavfi -i color=c=red:s=64x64:d=1 -metadata location="+43.2389+076.8897/" -movflags use_metadata_tags -f mov "$M/gps_h264.mov"
ffmpeg -loglevel error -f lavfi -i color=c=blue:s=64x64:d=1 -c:v libx265 -tag:v hvc1 -x265-params log-level=none -metadata location="+43.2389+076.8897/" -movflags use_metadata_tags "$M/gps_hevc.mp4"
ffmpeg -loglevel error -f lavfi -i color=c=green:s=32x32 -frames:v 1 "$M/ok.jpg"
printf 'GIF89a not a jpeg' > "$M/fake.jpg"
export MEDIA_DIR="$M"
cd "$D"
echo "== push"; node --experimental-strip-types --no-warnings push_test.mts | cut -c1-200
echo "== delete-account"; node --experimental-strip-types --no-warnings delete_test.mts
echo "== moderate: проверка файлов"; node --experimental-strip-types --no-warnings media_test.mts
echo "== moderate: уборка переписок (v14)"; node --experimental-strip-types --no-warnings cleanup_test.mts
echo "== login: вход по нику (v14.8)"; node --experimental-strip-types --no-warnings login_test.mts
rm -f "$D/.push.ts" "$D/.del.ts" "$D/.mod.ts" "$D/.login.ts"; rm -rf "$M"
