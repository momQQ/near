const now = () => new Date().toISOString();
const DB = { deletion_jobs: [], messages: [{ id: "m1", sender_id: "U", media_path: "U/c/1.jpg", text: null, kind: "image" }, { id: "m2", sender_id: "U", media_path: "U/c/2.jpg", text: "подпись", kind: "image" }, { id: "m3", sender_id: "X", media_path: "X/c/3.jpg", text: null, kind: "image" }], push_subs: [{ user_id: "U" }], conversations: [] };
const FILES = { "chat-media": ["U/c/1.jpg", "U/c/2.jpg", "X/c/3.jpg"], "post-media": ["U/p/a.jpg", "U/avatar.jpg", "X/p/b.jpg"], "post-quarantine": [], "post-private": ["U/p1/0.webp", "U/p1/0-t.webp", "X/p2/0.webp"], "avatars": ["U/avatar-1.webp"] };
let failRemove = true, lastSign = Date.now() - 60e3, deleted = false;
function q(t) { let rows = DB[t]; const f = []; const b = {
  select() { return b; }, eq(k, v) { f.push((r) => r[k] === v); return b; }, neq(k, v) { f.push((r) => r[k] !== v); return b; },
  not(k) { f.push((r) => r[k] != null); return b; }, is(k, v) { f.push((r) => r[k] == v); return b; },
  maybeSingle() { return Promise.resolve({ data: DB[t].filter((r) => f.every((g) => g(r)))[0] ?? null }); },
  insert(x) { const row = { id: "j" + (DB[t].length + 1), status: "pending", attempts: 0, updated_at: now(), ...x }; DB[t].push(row); return { select: () => ({ single: () => Promise.resolve({ data: row }) }) }; },
  update(p) { const u = { eq(k, v) { f.push((r) => r[k] === v); return u; }, not(k) { f.push((r) => r[k] != null); return u; }, is(k, v) { f.push((r) => r[k] == v); return u; },
     then(res) { DB[t].filter((r) => f.every((g) => g(r))).forEach((r) => Object.assign(r, p)); return Promise.resolve({ error: null }).then(res); } }; return u; },
  delete() { const d = { eq(k, v) { f.push((r) => r[k] === v); return d; }, is(k, v) { f.push((r) => r[k] == v); return d; }, then(res) { DB[t] = DB[t].filter((r) => !f.every((g) => g(r))); return Promise.resolve({ error: null }).then(res); } }; return d; } }; return b; }
const storage = { from: (bk) => ({
  list: async (prefix) => { const names = [...new Set(FILES[bk].filter((p) => p.startsWith(prefix + "/")).map((p) => p.slice(prefix.length + 1).split("/")[0]))];
    return { data: names.map((n) => ({ name: n, id: FILES[bk].includes(prefix + "/" + n) ? "f" : null })), error: null }; },
  remove: async (paths) => { if (failRemove && bk === "post-media") return { error: { message: "storage down" } }; FILES[bk] = FILES[bk].filter((p) => !paths.includes(p)); return { error: null }; } }) };
globalThis.__fake = () => ({ from: q, storage, auth: { getUser: async (t) => ({ data: t === "T" ? { user: { id: "U", last_sign_in_at: new Date(lastSign).toISOString() } } : null }), admin: { deleteUser: async () => { deleted = true; return { error: null }; } } } });
let handler; globalThis.Deno = { env: { get: () => "x" }, serve: (h) => (handler = h) };
console.error = console.log = ((o) => (...a) => { if (!String(a[0]).startsWith("{")) o(...a); })(console.log);
await import("./.del.ts");
const call = async (tok = "T", body = { confirm: "DELETE" }) => { const r = await handler(new Request("http://f", { method: "POST", headers: { Authorization: "Bearer " + tok }, body: JSON.stringify(body) })); return r.status + " " + await r.text(); };
console.log("без токена:", await call("BAD"));
console.log("без подтверждения:", await call("T", {}));
lastSign = Date.now() - 30 * 60e3; console.log("старый вход:", await call());
lastSign = Date.now() - 60e3;
console.log("сбой хранилища:", await call(), "| job:", DB.deletion_jobs[0].status, DB.deletion_jobs[0].error_code, "| аккаунт удален:", deleted);
failRemove = false;
DB.deletion_jobs[0].updated_at = now();
console.log("повтор:", await call(), "| job:", DB.deletion_jobs[0].status, "попыток", DB.deletion_jobs[0].attempts, "| аккаунт удален:", deleted);
console.log("файлы:", JSON.stringify(FILES));
console.log("сообщения:", JSON.stringify(DB.messages.map((m) => [m.id, m.kind, m.text, m.media_path])));
console.log("push подписки:", DB.push_subs.length);
