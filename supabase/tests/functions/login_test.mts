// AUTH-01: вход по никнейму, одинаковая ошибка, лимиты, CAPTCHA, повторное подтверждение (подмена Supabase и сети)
const USERS: Record<string, { email: string; pass: string; id: string }> = { almatyuser: { email: "a@x.kz", pass: "secret123", id: "U1" } };
const ATT: { src: string; login: string; ok: boolean }[] = []; const MARK: any[] = []; const LOGOUT: string[] = [];
const rpc = async (fn: string, a: any) => {
  if (fn === "login_gate") {
    const f = ATT.filter((x) => !x.ok);
    const src = f.filter((x) => x.src === a.p_src).length, pair = f.filter((x) => x.src === a.p_src && x.login === a.p_login.toLowerCase()).length;
    const acct = f.filter((x) => x.login === a.p_login.toLowerCase()).length;
    return { data: { allowed: src < 20 && pair < 5, captcha: acct >= 5 || src >= 5 } };
  }
  if (fn === "login_email") return { data: USERS[a.p_login.toLowerCase().replace(/^@/, "")]?.email ?? null };
  if (fn === "login_record") { ATT.push({ src: a.p_src, login: a.p_login.toLowerCase(), ok: a.p_ok }); return { data: null }; }
  if (fn === "session_reauth_mark") { MARK.push(a); return { data: null }; }
  return { data: null };
};
const jwt = (o: any) => "h." + Buffer.from(JSON.stringify(o)).toString("base64url") + ".s";
(globalThis as any).__fake = () => ({ rpc, auth: { getUser: async (t: string) => (t.startsWith("h.") ? { data: { user: { id: "U1", email: "a@x.kz" } } } : { data: { user: null } }) } });
(globalThis as any).fetch = async (u: string, init: any) => {
  if (u.includes("/logout")) { LOGOUT.push(init.headers.Authorization); return new Response("{}"); }
  if (u.includes("turnstile")) return new Response(JSON.stringify({ success: String(init.body).includes("response=ok") }));
  const b = JSON.parse(init.body); const user = Object.values(USERS).find((x) => x.email === b.email);
  if (!user || user.pass !== b.password) return new Response('{"error":"invalid_grant"}', { status: 400 });
  return new Response(JSON.stringify({ access_token: jwt({ sub: user.id, session_id: "NEW" }), refresh_token: "R", expires_in: 3600, user: { id: user.id } }));
};
const env: Record<string, string> = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "svc" };
let handler: any; (globalThis as any).Deno = { env: { get: (k: string) => env[k] }, serve: (h: any) => (handler = h) };
console.log = ((o) => (...a: any[]) => { if (!String(a[0]).startsWith("{")) o(...a); })(console.log);
await import("./.login.ts");
const call = async (b: any, ip = "1.1.1.1", auth?: string) => {
  const r = await handler(new Request("http://f", { method: "POST", headers: { "x-forwarded-for": ip, ...(auth ? { Authorization: "Bearer " + auth } : {}) }, body: JSON.stringify(b) }));
  return [r.status, await r.json()] as const;
};
const [s1, b1] = await call({ login: "@AlmatyUser", password: "secret123" });
console.log("вход по никнейму:", s1, !!b1.access_token, "| почта в ответе:", JSON.stringify(b1).includes("a@x.kz"));
const [s2, b2] = await call({ login: "nobody_here", password: "x" }); const [s3, b3] = await call({ login: "almatyuser", password: "wrong" });
console.log("нет аккаунта и неверный пароль — одинаково:", s2 === s3 && b2.error === b3.error, "|", b2.error);
for (let i = 0; i < 6; i++) await call({ login: "almatyuser", password: "wrong", captcha: "x" }, "6.6.6.6");
const [s4, b4] = await call({ login: "almatyuser", password: "secret123", captcha: "x" }, "6.6.6.6");
console.log("пара сеть+аккаунт после 5 ошибок — пауза:", s4, b4.retry === true);
const [s5, b5] = await call({ login: "almatyuser", password: "secret123" }, "9.9.9.9");
console.log("владелец из своей сети — не заблокирован, нужна CAPTCHA:", s5, b5.captcha_required === true);
const [s6, b6] = await call({ login: "almatyuser", password: "secret123", captcha: "x" }, "9.9.9.9");
env.TURNSTILE_SECRET_KEY = "T";
const [s7, b7] = await call({ login: "almatyuser", password: "secret123", captcha: "bad" }, "9.9.9.9");
const [s8, b8] = await call({ login: "almatyuser", password: "secret123", captcha: "ok" }, "9.9.9.9");
console.log("CAPTCHA проверяется сервером: неверная —", s7, "| верная —", s8, !!b8.access_token);
const cur = jwt({ sub: "U1", session_id: "CUR" });
const [s9] = await call({ mode: "reauth", password: "wrong", captcha: "ok" }, "9.9.9.9", jwt({ sub: "U1", session_id: "CUR" }));
const [s10, b10] = await call({ mode: "reauth", password: "secret123", captcha: "ok" }, "9.9.9.9", jwt({ sub: "U1", session_id: "CUR" }));
console.log("повторное подтверждение: неверный пароль —", s9, "| верный —", s10, b10.ok === true, "| отмечена текущая сессия:", MARK[0]?.p_sid === "CUR", "| проверочная сессия закрыта:", LOGOUT.length === 1);
const [s11] = await call({ mode: "reauth", password: "secret123" }, "9.9.9.9", "BAD");
console.log("без входа подтверждение невозможно:", s11);
void s6; void b6; void cur;
