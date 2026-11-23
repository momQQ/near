// =====================================================
//  NEAR — ИИ-проверка фото и сообщений
//  Supabase Edge Function "moderate"
//  Использует бесплатный OpenAI Moderation API (omni-moderation-latest).
//
//  Нужны секреты (Supabase → Edge Functions → Secrets):
//    OPENAI_API_KEY  — ключ с platform.openai.com
//  SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase добавляет сам.
// =====================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Категории, при которых контент скрывается
const BLOCK = [
  "sexual", "sexual/minors", "violence/graphic", "self-harm", "self-harm/intent", "self-harm/instructions",
  "harassment/threatening", "hate/threatening", "illicit/violent",
];
const TEXT_BLOCK = [...BLOCK, "harassment", "hate"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { table, id } = await req.json();
    if (!["post_media", "messages"].includes(table) || typeof id !== "string") return json({ error: "bad request" }, 400);

    // проверяем, что запрос пришел от вошедшего пользователя
    const auth = req.headers.get("Authorization") ?? "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: row } = await admin.from(table).select("*").eq("id", id).maybeSingle();
    if (!row) return json({ error: "not found" }, 404);
    if (row.mod_status !== "pending") return json({ status: row.mod_status });

    // что проверяем: фото или текст
    const input: unknown[] = [];
    const isImage = table === "post_media" ? row.type === "image" : row.kind === "image";
    if (isImage) input.push({ type: "image_url", image_url: { url: row.url ?? row.media_url } });
    if (row.text) input.push({ type: "text", text: row.text });
    if (!input.length) { await admin.from(table).update({ mod_status: "ok" }).eq("id", id); return json({ status: "ok" }); }

    const r = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}` },
      body: JSON.stringify({ model: "omni-moderation-latest", input }),
    });
    if (!r.ok) {
      // если сервис недоступен — не блокируем пользователя, пропускаем контент
      console.error("moderation api", r.status, await r.text());
      await admin.from(table).update({ mod_status: "ok" }).eq("id", id);
      return json({ status: "ok", note: "moderation unavailable" });
    }
    const out = await r.json();
    const cats = out.results?.[0]?.categories ?? {};
    const list = isImage ? BLOCK : TEXT_BLOCK;
    const hit = list.filter((k) => cats[k]);
    const status = hit.length ? "flagged" : "ok";
    await admin.from(table).update({ mod_status: status }).eq("id", id);

    if (status === "flagged") {
      // автоматическая жалоба — попадет в панель модератора
      const owner = table === "post_media" ? row.user_id : row.sender_id;
      await admin.from("reports").upsert({
        reporter_id: owner, target_type: table === "post_media" ? "post" : "message",
        target_id: table === "post_media" ? row.post_id : row.id, target_user: owner,
        reason: "nsfw", details: "Автопроверка ИИ: " + hit.join(", "),
      }, { onConflict: "reporter_id,target_type,target_id", ignoreDuplicates: true });
      if (table === "post_media") {
        await admin.from("notifications").insert({ user_id: owner, type: "post_hidden", post_id: row.post_id,
          text: "Фото в вашей публикации скрыто автоматической проверкой. Модератор посмотрит его." });
      }
    }
    return json({ status, categories: hit });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
