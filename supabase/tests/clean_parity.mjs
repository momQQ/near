// CLEAN-01: печатает SQL-проверку, что near_clean (база) дает тот же результат, что src/lib/clean.js (приложение).
// Примеры из clean_cases.json (ожидаемые значения) + 3000 случайных строк (ожидание берется из JS).
// Запуск: node supabase/tests/clean_parity.mjs supabase/tests/clean_cases.json | psql -d near_test
import { readFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const src = readFileSync(here + "../../src/lib/clean.js", "utf8");
const mod = new Function(src + "\nreturn { mask, isThreat, nearBlockReason, nearFlagReason };")();
const cases = JSON.parse(readFileSync(process.argv[2] || here + "clean_cases.json", "utf8"));
let bad = 0;
for (const [i, e] of cases) if (mod.mask(i) !== e) { bad++; console.error("JS FAIL", JSON.stringify(i), "→", JSON.stringify(mod.mask(i)), "ожидалось", JSON.stringify(e)); }
const parts = ["бля", "ть", "сук", "а", "х", "у", "й", "пизд", "ец", "еб", "ал", "за", "на", "fuck", "shit", "ing", "cyka", "su", "ka", "Б", "Х", "ё", "і", "қ", " ", " ", ", ", ".", "-", "*", "​", "́", "0", "3", "@", "hue", "ebay", "небо", "хлеб", "сукно", "x", "y", "u", "о", "мудак", "пид", "ор", "!", "#", "ЁЖ", "ÉÀ", "ш", "лю", "ха", "blyat", "nahuy", "a", "e"];
let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const fuzz = [];
for (let n = 0; n < 3000; n++) { let s = ""; const L = 1 + Math.floor(rnd() * 7); for (let i = 0; i < L; i++) s += parts[Math.floor(rnd() * parts.length)]; fuzz.push([s, mod.mask(s)]); }
const threats = [["я убью тебя", true], ["прибью полку", false], ["убью время", false], ["I will kill you", true], ["зарежу", true], ["killing it", false]];
for (const [t, e] of threats) if (mod.isThreat(t) !== e) { bad++; console.error("JS THREAT FAIL", t); }
const q = (s) => "'" + s.replace(/'/g, "''") + "'";
let sql = "do $$ declare f int := " + bad + "; r text; begin\n";
for (const [i, e] of [...cases, ...fuzz]) sql += `  r := public.near_clean(${q(i)}); if r is distinct from ${q(e)} then f := f + 1; raise notice 'FAIL: CLEAN-01 % -> % (ожидалось %)', ${q(i)}, r, ${q(e)}; end if;\n`;
for (const [t, e] of threats) sql += `  if public.near_is_threat(${q(t)}) <> ${e} then f := f + 1; raise notice 'FAIL: CLEAN-01 угроза %', ${q(t)}; end if;\n`;
// v14.2: блокировка и пометки — одинаково в базе и приложении
const rules = ["Интим услуги недорого", "эскорт", "Скиньте код из смс", "не сообщайте никому код из смс", "Никому не скиньте код", "пришли номер карты", "смс код пришел",
  "ссылка bit.ly/abc", "https://bitly.com/x", "нужна предоплата", "без предоплаты", "переведите на каспи", "убью тебя", "интимная гигиена", "обычный текст", "Продиктуй пин-код"];
for (const t of rules) {
  const b = mod.nearBlockReason(t), fl = mod.nearFlagReason(t);
  sql += `  if public.near_block_reason(${q(t)}) is distinct from ${b ? q(b) : "null"} then f := f + 1; raise notice 'FAIL: RULES блок % -> % (JS ${b})', ${q(t)}, public.near_block_reason(${q(t)}); end if;\n`;
  sql += `  if public.near_flag_reason(${q(t)}) is distinct from ${fl ? q(fl) : "null"} then f := f + 1; raise notice 'FAIL: RULES пометка % (JS ${fl})', ${q(t)}; end if;\n`;
}
sql += `  if f = 0 then raise notice 'PASS: CLEAN-01 база и приложение маскируют и блокируют одинаково (${cases.length} примеров + ${fuzz.length} случайных строк, угрозы, правила v14.2)'; end if;\nend $$;\n`;
process.stdout.write(sql);
