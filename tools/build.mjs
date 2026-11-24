// NEAR: сборка. Запуск из корня проекта: node tools/build.mjs
//  1) js/app.js собирается из модулей src/app/*.js (по порядку имен);
//  2) app.html — из app.tpl.html и parts.json ({{KEY}} → блок);
//  3) проверка: синтаксис всех js (node --check) и простые правила (lint).
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const root = new URL("..", import.meta.url).pathname;
const R = (p) => readFileSync(root + p, "utf8");
let errors = 0;
const fail = (m) => { console.error("✗ " + m); errors++; };

// 1. app.js из модулей
const dir = "src/app/";
if (existsSync(root + dir)) {
  const parts = readdirSync(root + dir).filter((f) => f.endsWith(".js")).sort();
  const body = parts.map((f) => `/* ===== ${f} ===== */\n` + R(dir + f).replace(/\s+$/, "") + "\n").join("\n");
  writeFileSync(root + "js/app.js", `/* NEAR — интерфейс. ФАЙЛ СОБРАН АВТОМАТИЧЕСКИ из src/app/*.js (node tools/build.mjs), правьте модули. */\n(function () {\n  "use strict";\n${body}})();\n`);
  console.log(`✓ js/app.js из ${parts.length} модулей`);
}

// 1b. NEAR Clean: один источник (src/lib/clean.js) для приложения; та же логика в базе — 014_v14.sql
{
  const d = R("js/data.js"), c = R("src/lib/clean.js");
  const re = /  \/\* @clean:start[^\n]*\n[\s\S]*?  \/\* @clean:end \*\/\n/;
  if (!re.test(d)) fail("js/data.js: нет меток @clean:start/@clean:end");
  else writeFileSync(root + "js/data.js", d.replace(re, (m) => m.split("\n")[0] + "\n" + c + "  /* @clean:end */\n"));
}

// 2. app.html
const parts = JSON.parse(R("parts.json"));
let html = R("app.tpl.html").replace(/\{\{(\w+)\}\}/g, (m, k) => (k in parts ? parts[k] : (fail("нет блока " + k), m)));
writeFileSync(root + "app.html", html);
console.log("✓ app.html");

// 3. проверки
for (const f of ["js/app.js", "js/data.js", "js/i18n.js", "js/config.js", "sw.js"]) {
  try { execFileSync(process.execPath, ["--check", root + f]); } catch (e) { fail(f + ": " + String(e.stderr || e.message).split("\n").slice(0, 4).join(" ")); }
}
const app = R("js/app.js");
// одинаковые имена функций верхнего уровня в одной области — частая ошибка при разбиении на модули
const fn = {}; for (const m of app.matchAll(/^  (?:async )?function (\w+)\(/gm)) fn[m[1]] = (fn[m[1]] || 0) + 1;
Object.entries(fn).filter(([, n]) => n > 1).forEach(([k]) => fail("функция объявлена дважды: " + k));
for (const f of ["js/app.js", "js/data.js", "js/i18n.js", "sw.js"]) {
  const s = R(f);
  if (/\bdebugger\b/.test(s)) fail(f + ": debugger");
  if (/console\.log\(/.test(s)) fail(f + ": console.log (используйте console.warn только для ошибок)");
}
// каждый id, к которому обращается код через $("..."), должен быть в разметке или создаваться кодом
const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]).concat([...app.matchAll(/id=\\?"([\w-]+)\\?"/g)].map((m) => m[1])));
const used = new Set([...app.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]));
[...used].filter((x) => !ids.has(x) && !/^(onb|onbCard|feedStale|feedTail|mv)$/.test(x)).forEach((x) => fail("нет элемента #" + x));
// ESLint (если установлен): необъявленные переменные, повторы, недостижимый код
const eslint = ["node_modules/.bin/eslint", "/opt/node22/lib/node_modules/eslint/bin/eslint.js"].map((p) => (p.startsWith("/") ? p : root + p)).find((p) => existsSync(p));
if (eslint) { try { execFileSync(process.execPath, [eslint, "js/", "sw.js"], { cwd: root, stdio: "pipe" }); console.log("✓ eslint"); } catch (e) { fail("eslint:\n" + String(e.stdout || e.message)); } }
else console.log("· eslint не найден — пропускаем (npm i -D eslint)");
// 4. PERF-01: минификация (esbuild). Исходники остаются как есть, страница подключает *.min.*
//    Нет esbuild — копируем без сжатия, чтобы сайт работал одинаково.
if (!errors) {
  const esb = [root + "node_modules/esbuild/bin/esbuild", "/opt/npm-tools/node_modules/esbuild/bin/esbuild"].find((p) => existsSync(p));
  const MIN = [["js/config.js", "js/config.min.js"], ["js/i18n.js", "js/i18n.min.js"], ["js/data.js", "js/data.min.js"], ["js/app.js", "js/app.min.js"], ["css/app.css", "css/app.min.css"], ["css/near.css", "css/near.min.css"]];
  const { gzipSync } = await import("node:zlib");
  let a = 0, b = 0, ga = 0, gb = 0;
  for (const [src, out] of MIN) {
    try {
      if (esb) execFileSync(esb, [root + src, "--minify", "--target=es2020,safari15", "--legal-comments=none", "--charset=utf8", "--sourcemap", "--outfile=" + root + out], { stdio: "pipe" });
      else writeFileSync(root + out, R(src));
    } catch (e) { fail("минификация " + src + ": " + String(e.stderr || e.message).split("\n").slice(0, 3).join(" ")); writeFileSync(root + out, R(src)); }
    a += Buffer.byteLength(R(src)); b += Buffer.byteLength(R(out)); ga += gzipSync(R(src)).length; gb += gzipSync(R(out)).length;
  }
  html = html.replace(/(src|href)="(js\/(?:config|i18n|data|app)|css\/(?:app|near))\.(js|css)"/g, '$1="$2.min.$3"');
  writeFileSync(root + "app.html", html);
  const kb = (x) => (x / 1024).toFixed(0) + " КБ";
  console.log(esb ? `✓ минификация: ${kb(a)} → ${kb(b)}, gzip ${kb(ga)} → ${kb(gb)}` : "· esbuild не найден — файлы *.min.* без сжатия");
}
console.log(errors ? `Ошибок: ${errors}` : "✓ проверки пройдены");
process.exit(errors ? 1 : 0);
