// NEAR: вход по нику или email и паролю (ТЗ v14.8, раздел 03).
// Ник превращается в email только здесь, на сервере (service role). Email чужого ника клиент не получает никогда.
// Одинаковый ответ на "нет такого ника" и "неверный пароль". Частота: 5 неудачных попыток на ник / 20 на IP за 15 минут.
// CAPTCHA (Turnstile/hCaptcha) передается в Supabase Auth как есть, если включена в Authentication → Attack Protection.
// Пароль не логируется и не сохраняется. Развертывание: Verify JWT — выключен (вход до сессии).
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SALT = Deno.env.get("LOGIN_IP_SALT") ?? "near";
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const BAD = { error: "invalid", message: "Неверный ник, email или пароль" };

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: { login?: string; password?: string; captcha_token?: string };
  try { body = await req.json(); } catch { return json(BAD, 400); }
  const login = String(body.login ?? "").trim().slice(0, 254), password = String(body.password ?? "");
  if (!login || !password || password.length > 128) return json(BAD, 400);
  const ip = await sha((req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() + SALT);

  const gate = await admin.rpc("login_gate", { p_login: login, p_ip: ip });
  if (gate.error) return json({ error: "unavailable", message: "Вход временно недоступен. Попробуйте позже" }, 503);
  if (gate.data && gate.data.ok === false) {
    return json({ error: "rate", message: "Слишком много попыток. Попробуйте через 15 минут", retry_after: gate.data.retry_after ?? 900 }, 429);
  }

  let email = login.includes("@") ? login.toLowerCase() : null;
  if (!email) {
    const r = await admin.rpc("login_email", { p_login: login });
    email = (r.data as string | null) ?? null;
  }
  // нет такого ника: тот же ответ и примерно то же время, что при неверном пароле
  if (!email) {
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
    await admin.rpc("login_note", { p_login: login, p_ip: ip, p_ok: false });
    return json(BAD, 401);
  }
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON },
    body: JSON.stringify({ email, password, gotrue_meta_security: body.captcha_token ? { captcha_token: body.captcha_token } : undefined }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    await admin.rpc("login_note", { p_login: login, p_ip: ip, p_ok: false });
    const code = String(out.error_code ?? out.code ?? out.error ?? "");
    if (/email_not_confirmed/.test(code)) return json({ error: "pending_email", message: "Подтвердите почту: ссылка в письме" }, 403);
    if (/captcha/i.test(code + JSON.stringify(out))) return json({ error: "captcha", message: "Пройдите проверку, что вы не робот" }, 400);
    return json(BAD, 401);
  }
  await admin.rpc("login_note", { p_login: login, p_ip: ip, p_ok: true });
  // клиенту — только сессия; email в ответе не возвращаем
  return json({ access_token: out.access_token, refresh_token: out.refresh_token, expires_in: out.expires_in, token_type: out.token_type });
});
