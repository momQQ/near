// =====================================================
//  NEAR Shield — вход по никнейму или почте (Supabase Edge Function "shield-login")
//
//  {mode: "login", login, password, captcha?}  → сессия Supabase (access/refresh token)
//  {mode: "reauth", password} + Authorization  → повторное подтверждение личности на 5 минут
//      (смена почты, удаление аккаунта); новая сессия сразу закрывается.
//
//  - почта по никнейму находится на сервере и не раскрывается;
//  - ответ на любую ошибку одинаковый: "Не удалось войти. Проверьте данные или восстановите доступ";
//  - лимиты атомарные (login_gate): по сети и по паре "аккаунт + сеть"; чужие попытки
//    не блокируют владельца — по аккаунту только включается CAPTCHA;
//  - Turnstile проверяется здесь (секрет TURNSTILE_SECRET_KEY) и/или самим Supabase Auth.
//  Секреты: TURNSTILE_SECRET_KEY (необязательно). Verify JWT — ВЫКЛЮЧЕН.
// =====================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const GENERIC = "Не удалось войти. Проверьте данные или восстановите доступ";

async function turnstile(token: string | undefined, ip: string) {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return true;                       // капчу проверяет Supabase Auth (Attack Protection)
  if (!token) return false;
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST", body: new URLSearchParams({ secret, response: token, remoteip: ip }), signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  return !!r && r.ok && (await r.json()).success === true;
}

async function passwordGrant(email: string, password: string, captcha?: string) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, ...(captcha ? { gotrue_meta_security: { captcha_token: captcha } } : {}) }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  return await r.json();
}

const claims = (jwt: string) => { try { return JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; } };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const corr = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const body = await req.json().catch(() => ({}));
  const mode = body.mode === "reauth" ? "reauth" : "login";
  const password = typeof body.password === "string" ? body.password : "";
  try {
    let login = typeof body.login === "string" ? body.login.trim() : "";
    let current: { sub: string; session_id: string } | null = null;
    if (mode === "reauth") {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: u } = await admin.auth.getUser(token);
      if (!u?.user) return json({ error: "unauthorized" }, 401);
      current = claims(token);
      login = u.user.email ?? "";
    }
    if (!login || !password || login.length > 120 || password.length > 200) return json({ error: GENERIC }, 400);

    const { data: gate } = await admin.rpc("login_gate", { p_src: ip, p_login: login });
    if (!gate?.allowed) return json({ error: "Слишком много попыток. Попробуйте позже или восстановите доступ", retry: true }, 429);
    const needCaptcha = !!gate?.captcha || !!Deno.env.get("TURNSTILE_SECRET_KEY");
    if (needCaptcha && (!body.captcha || !(await turnstile(body.captcha, ip)))) return json({ error: "Подтвердите, что вы не робот", captcha_required: true }, 400);

    const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(login) ? login : ((await admin.rpc("login_email", { p_login: login })).data as string | null);
    const sess = email ? await passwordGrant(email, password, Deno.env.get("TURNSTILE_SECRET_KEY") ? undefined : body.captcha) : null;
    await admin.rpc("login_record", { p_src: ip, p_login: login, p_ok: !!sess });
    console.log(JSON.stringify({ fn: "shield-login", corr, mode, ok: !!sess }));
    if (!sess) return json({ error: GENERIC }, 401);

    if (mode === "reauth") {
      if (sess.user?.id !== current?.sub) return json({ error: GENERIC }, 401);
      await admin.rpc("session_reauth_mark", { p_user: current!.sub, p_sid: current!.session_id });
      // проверочная сессия больше не нужна
      await fetch(`${URL_}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${sess.access_token}` } }).catch(() => null);
      return json({ ok: true, until: new Date(Date.now() + 5 * 60e3).toISOString() });
    }
    return json({ access_token: sess.access_token, refresh_token: sess.refresh_token, expires_in: sess.expires_in, token_type: "bearer" });
  } catch (e) {
    console.error(JSON.stringify({ fn: "shield-login", corr, error: (e as Error).name }));
    return json({ error: GENERIC }, 500);
  }
});
