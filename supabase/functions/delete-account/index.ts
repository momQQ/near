// NEAR: удаление аккаунта по запросу самого пользователя (SEC-05).
// Работает как задача: pending → running → done или failed. Повторный вызов продолжает
// незавершенную задачу. Ошибка хранилища не дает статус done.
// Что удаляется: файлы пользователя (публикации, карантин, аватар, его файлы в переписках),
// профиль, публикации, комментарии, лайки, друзья, подписки. Сообщения в переписках
// остаются у собеседника с подписью "Удаленный аккаунт", вложения в них стираются.
// Нужна свежая аутентификация: вход не раньше 10 минут назад.
// Развертывание: Verify JWT — включен.
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const REAUTH_MIN = 10;

class StepError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }

// все файлы внутри папки (рекурсивно); ошибка листинга — ошибка задачи
async function listAll(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000, offset });
    if (error) {
      if (/not.?found/i.test(error.message)) return out;
      throw new StepError("list_" + bucket);
    }
    if (!data?.length) break;
    for (const it of data) {
      const path = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.id === null) out.push(...(await listAll(bucket, path))); // это папка
      else out.push(path);
    }
    if (data.length < 1000) break;
  }
  return out;
}
async function removeAll(bucket: string, paths: string[]) {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
    if (error) throw new StepError("remove_" + bucket);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const corr = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return json({ error: "Войдите заново и повторите", code: "NR403" }, 401);
  const body = await req.json().catch(() => ({}));
  if (body.confirm !== "DELETE") return json({ error: "Нет подтверждения", code: "NR422" }, 400);
  const uid = u.user.id;

  // повторная аутентификация: вход должен быть свежим
  const last = u.user.last_sign_in_at ? new Date(u.user.last_sign_in_at).getTime() : 0;
  if (Date.now() - last > REAUTH_MIN * 60e3) return json({ error: "Для удаления войдите еще раз", code: "REAUTH" }, 401);

  // задача удаления (одна активная на пользователя)
  let { data: job } = await admin.from("deletion_jobs").select("*").eq("user_id", uid).neq("status", "done").maybeSingle();
  if (!job) {
    const ins = await admin.from("deletion_jobs").insert({ user_id: uid }).select("*").single();
    if (ins.error) return json({ error: "Не удалось начать удаление. Повторите", code: "NR409" }, 409);
    job = ins.data;
  }
  if (job.status === "running" && Date.now() - new Date(job.updated_at).getTime() < 120e3) {
    return json({ status: "running", job: job.id }, 202);
  }
  await admin.from("deletion_jobs").update({ status: "running", attempts: job.attempts + 1, updated_at: new Date().toISOString(), error_code: null }).eq("id", job.id);

  try {
    // 1. вложения пользователя в переписках: файлы стираются, сообщение остается без файла
    const { error: me } = await admin.from("messages").update({ kind: "text", text: "[вложение удалено]", media_url: null, media_path: null })
      .eq("sender_id", uid).not("media_path", "is", null).is("text", null);
    const { error: me2 } = await admin.from("messages").update({ kind: "text", media_url: null, media_path: null })
      .eq("sender_id", uid).not("media_path", "is", null);
    if (me || me2) throw new StepError("messages");
    await removeAll("chat-media", await listAll("chat-media", uid));
    // 2. файлы публикаций, аватар, карантин
    await removeAll("post-media", await listAll("post-media", uid));
    await removeAll("post-quarantine", await listAll("post-quarantine", uid));
    // 3. подписки push — сразу (чтобы не приходили уведомления)
    const { error: pe } = await admin.from("push_subs").delete().eq("user_id", uid);
    if (pe) throw new StepError("push");
    // 4. аккаунт: сессии и токены обновления отзываются, данные удаляются каскадом
    const { error: de } = await admin.auth.admin.deleteUser(uid);
    if (de && !/not.?found/i.test(de.message)) throw new StepError("auth");
    // 5. пустые переписки (оба участника удалены)
    await admin.from("conversations").delete().is("user_a", null).is("user_b", null);
    await admin.from("deletion_jobs").update({ status: "done", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
    console.log(JSON.stringify({ fn: "delete-account", corr, job: job.id, status: "done" }));
    return json({ ok: true, status: "done" });
  } catch (e) {
    const code = e instanceof StepError ? e.code : "unknown";
    await admin.from("deletion_jobs").update({ status: "failed", error_code: code, updated_at: new Date().toISOString() }).eq("id", job.id);
    console.error(JSON.stringify({ fn: "delete-account", corr, job: job.id, status: "failed", code }));
    return json({ error: "Удаление не завершено. Нажмите \"Удалить\" еще раз — мы продолжим с места остановки", code: "RETRY", status: "failed" }, 500);
  }
});
