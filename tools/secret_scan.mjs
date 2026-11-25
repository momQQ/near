// NEAR: поиск секретов перед публикацией (ТЗ v14.6, CI). Запуск: node tools/secret_scan.mjs
// Падает, если в файлах проекта есть ключ service_role, секретный ключ Supabase, приватный ключ или пароль от базы.
// Публичный anon-ключ в js/config.js разрешен: он и так виден в браузере.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SKIP = new Set([".git", "node_modules", "vendor", "icons", "img"]);
const EXT = /\.(js|mjs|mts|ts|json|html|sql|md|yml|yaml|toml|env|sh|txt|css)$|^\.env/i;
const RULES = [
  [/sb_secret_[A-Za-z0-9_-]{10,}/, "секретный ключ Supabase (sb_secret_)"],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, "приватный ключ"],
  [/postgres(ql)?:\/\/[^:\s]+:[^@\s]{6,}@/i, "строка подключения к базе с паролем"],
  [/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["']?eyJ/, "service_role ключ в переменной"],
  [/(AKIA|ASIA)[A-Z0-9]{16}/, "ключ AWS"],
  [/AIza[0-9A-Za-z_-]{35}/, "ключ Google API"]
];
const bad = [];
function walk(dir) {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n), st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!EXT.test(n) || st.size > 3e6 || /\.min\.|\.map$/.test(n)) continue;
    const t = readFileSync(p, "utf8"), rel = relative(root, p);
    if (rel === "tools/secret_scan.mjs") continue;
    for (const [re, what] of RULES) if (re.test(t)) bad.push(`${rel}: ${what}`);
    // любой JWT с ролью, отличной от anon, — утечка
    for (const m of t.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g)) {
      try { const pl = JSON.parse(Buffer.from(m[1], "base64url").toString()); if (pl.role && pl.role !== "anon") bad.push(`${rel}: JWT с ролью "${pl.role}"`); } catch (e) {}
    }
  }
}
walk(root);
if (bad.length) { console.error("✗ Найдены секреты:\n  " + bad.join("\n  ")); process.exit(1); }
console.log("✓ секретов не найдено");
