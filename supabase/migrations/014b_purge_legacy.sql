-- =====================================================
--  014b — удаление старых персональных данных (ТЗ v14.4, раздел 04)
--  ЗАПУСКАТЬ ТОЛЬКО после решения владельца и резервной копии (SETUP.md, шаг 16),
--  и только когда все пользователи перешли на приложение v14 (старые версии читают колонку gender).
--  Что делает:
--   1) имя и фамилия: у кого никнейм уже выбран — на экране никнейм; у остальных — "Пользователь"
--      (при следующем входе приложение попросит выбрать никнейм);
--   2) пол удаляется вместе с колонкой;
--   3) из метаданных входа (auth.users) убираются name, full_name, first/last name и gender.
--      Google при каждом входе может прислать full_name заново — NEAR его не читает и не показывает.
--  Отменить нельзя: восстановление — только из резервной копии.
-- =====================================================
begin;
select set_config('near.system', '1', true);
update public.profiles set name = coalesce(nickname, 'Пользователь') where name is distinct from coalesce(nickname, 'Пользователь');
alter table public.profiles drop column if exists gender;
update auth.users set raw_user_meta_data = raw_user_meta_data - 'name' - 'full_name' - 'first' - 'last' - 'given_name' - 'family_name' - 'gender'
 where raw_user_meta_data ?| array['name','full_name','first','last','given_name','family_name','gender'];
commit;
-- Готово ✅ 014b
