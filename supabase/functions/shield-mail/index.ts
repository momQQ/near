// =====================================================
//  NEAR Shield — письма безопасности (Supabase Edge Function "shield-mail")
//  Вызывает только база (заголовок x-near-secret): код входа с нового устройства
//  и уведомление владельцу о новом входе. Почта берется на сервере и не передается клиенту.
//  Отправка: Brevo (BREVO_API_KEY) или Resend (RESEND_API_KEY); MAIL_FROM — адрес отправителя.
//  Verify JWT — ВЫКЛЮЧЕН.
// =====================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
let secret: string | null = null;
async function dbSecret() {
  if (!secret) { const { data } = await admin.from("push_config").select("secret").eq("id", 1).single(); secret = data?.secret ?? null; }
  return secret;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function letter(kind: string, code?: string, device?: string) {
  const dev = esc(device || "новое устройство");
  if (kind === "login_code") {
    return {
      subject: `NEAR: код входа ${code}`,
      text: `Код для входа в NEAR: ${code}\nУстройство: ${device || "новое устройство"}\nКод действует 10 минут. Если это не вы — не сообщайте код никому и смените пароль.`,
      html: `<p>Код для входа в NEAR:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${esc(code || "")}</p>
             <p>Устройство: ${dev}. Код действует 10 минут.</p><p>Если это не вы — никому не сообщайте код и смените пароль.</p>`,
    };
  }
  return {
    subject: "NEAR: выполнен вход с нового устройства",
    text: `В ваш аккаунт NEAR выполнен вход: ${device || "новое устройство"}. Предыдущая сессия завершена.\nЕсли это не вы — восстановите пароль.`,
    html: `<p>В ваш аккаунт NEAR выполнен вход: <b>${dev}</b>. Предыдущая сессия завершена.</p><p>Если это не вы — восстановите пароль.</p>`,
  };
}

async function send(to: string, m: { subject: string; text: string; html: string }) {
  const from = Deno.env.get("MAIL_FROM") ?? "NEAR <no-reply@near.kz>";
  const brevo = Deno.env.get("BREVO_API_KEY"), resend = Deno.env.get("RESEND_API_KEY");
  const name = from.replace(/\s*<.*$/, ""), email = (from.match(/<(.+)>/) ?? [, from])[1];
  if (brevo) {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST", headers: { "api-key": brevo, "Content-Type": "application/json" },
      body: JSON.stringify({ sender: { name, email }, to: [{ email: to }], subject: m.subject, textContent: m.text, htmlContent: m.html }), signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    return !!r && r.ok;
  }
  if (resend) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: m.subject, text: m.text, html: m.html }), signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    return !!r && r.ok;
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (req.headers.get("x-near-secret") !== (await dbSecret())) return json({ error: "forbidden" }, 403);
  const body = await req.json().catch(() => ({}));
  if (!["login_code", "new_login"].includes(body.kind) || typeof body.user_id !== "string") return json({ error: "bad request" }, 400);
  if (body.kind === "login_code" && !/^\d{6}$/.test(String(body.code))) return json({ error: "bad request" }, 400);
  const { data: u } = await admin.auth.admin.getUserById(body.user_id);
  const to = u?.user?.email;
  if (!to) return json({ error: "no email" }, 404);
  const ok = await send(to, letter(body.kind, body.code, body.device));
  console.log(JSON.stringify({ fn: "shield-mail", kind: body.kind, ok }));   // ни код, ни адрес в лог не пишутся
  return json({ ok }, ok ? 200 : 503);
});
