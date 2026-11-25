#!/bin/sh
# собирает schema.sql = схема v12 + блок v14.9 (Shield) и миграцию 014
cd "$(dirname "$0")"
cat shield_part1.sql shield_part2.sql shield_part3.sql shield_part4.sql shield_part5.sql > shield_block.sql
