// Edge Function login: ник → email только на сервере, одинаковые ошибки, лимит попыток, email не уходит клиенту.
const USERS = { "host_alma": { email: "h@x.kz", password: "Almaty2026", confirmed: true }, "newbie": { email: "n@x.kz", password: "Almaty2026", confirmed: false } };
const fails = {};
const rpc = async (fn, a) => {
  if (fn === "login_gate") return { data: { ok: (fails[a.p_login.toLowerCase()] ?? 0) < 5, retry_after: 900 } };
  if (fn === "login_email") return { data: USERS[a.p_login.toLowerCase()]?.email ?? null };
  if (fn === "login_note") { if (!a.p_ok) fails[a.p_login.toLowerCase()] = (fails[a.p_login.toLowerCase()] ?? 0) + 1; return { data: null }; }
};
globalThis.__fake = () => ({ rpc });
let sent = [];
globalThis.fetch = async (url, init) => {
  const b = JSON.parse(init.body); sent.push(b);
  const u = Object.values(USERS).find((x) => x.email === b.email);
  if (!u || u.password !== b.password) return new Response(JSON.stringify({ error_code: "invalid_credentials" }), { status: 400 });
  if (!u.confirmed) return new Response(JSON.stringify({ error_code: "email_not_confirmed" }), { status: 400 });
  return new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 3600, token_type: "bearer", user: { email: u.email } }));
};
let handler; globalThis.Deno = { env: { get: () => "x" }, serve: (h) => (handler = h) };
await import("./.login.ts");
const call = async (login, password) => { const r = await handler(new Request("http://f", { method: "POST", headers: { "x-forwarded-for": "1.2.3.4" }, body: JSON.stringify({ login, password }) })); return [r.status, await r.json()]; };
const ok = (name, c) => console.log((c ? "PASS: " : "FAIL: ") + name);
let [s, b] = await call("Host_Alma", "Almaty2026");
ok("вход по нику выдает сессию", s === 200 && b.access_token === "A");
ok("email в ответе не возвращается", !JSON.stringify(b).includes("@"));
const [s1, b1] = await call("nobody", "Almaty2026"); const [s2, b2] = await call("Host_Alma", "wrong");
ok("нет ника и неверный пароль — одинаковый ответ", s1 === s2 && b1.message === b2.message && !JSON.stringify(b1).includes("@"));
[s, b] = await call("h@x.kz", "Almaty2026"); ok("вход по email тоже работает", s === 200);
[s, b] = await call("newbie", "Almaty2026"); ok("неподтвержденная почта — понятная ошибка", s === 403 && b.error === "pending_email");
for (let i = 0; i < 5; i++) await call("Host_Alma", "bad" + i);
[s, b] = await call("Host_Alma", "Almaty2026"); ok("после 5 неудачных попыток — пауза (429)", s === 429 && b.retry_after > 0);
ok("пароль не попадает в журнал попыток", !JSON.stringify(fails).includes("Almaty2026"));
