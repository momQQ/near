// v14 / 02: уборка переписок удаленных аккаунтов — при ошибке хранилища строка остается (ссылки не теряются), файлы читаются постранично
const CONVS: any[] = [
  { id: "c1", user_a: "U1", user_b: null, orphaned_at: "2000-01-01" },   // 2500 файлов — нужно 3 страницы
  { id: "c2", user_a: "U2", user_b: null, orphaned_at: "2000-01-01" },   // хранилище отвечает ошибкой при удалении
  { id: "c3", user_a: "U3", user_b: null, orphaned_at: "2000-01-01" }    // ошибка при чтении списка
];
const FILES: Record<string, string[]> = { "U1/c1": Array.from({ length: 2500 }, (_, i) => "f" + i), "U2/c2": ["a", "b"], "U3/c3": ["x"] };
const removed: string[] = [];
function q(t: string) { const b: any = {
  select() { return b; }, eq() { return b; }, lt() { return b; }, limit() { return Promise.resolve({ data: t === "conversations" ? CONVS.slice() : [] }); },
  delete() { return { eq(k: string, v: any) { const i = CONVS.findIndex((r) => r[k] === v); if (i >= 0) CONVS.splice(i, 1); return Promise.resolve({ error: null }); } }; } }; return b; }
const storage = { from: () => ({
  list: async (dir: string, o: any) => (dir.startsWith("U3/") ? { data: null, error: { message: "timeout" } } : { data: (FILES[dir] ?? []).slice(o.offset, o.offset + o.limit).map((name) => ({ name })), error: null }),
  remove: async (ps: string[]) => (ps.some((p) => p.startsWith("U2/")) ? { error: { message: "503" } } : (removed.push(...ps), { error: null })) }) };
(globalThis as any).__fake = () => ({ from: q, storage, rpc: async () => ({}) });
let handler: any; (globalThis as any).Deno = { env: { get: () => "x" }, serve: (h: any) => (handler = h) };
console.warn = () => {};
console.log = ((o) => (...a: any[]) => { if (!String(a[0]).startsWith("{")) o(...a); })(console.log);
await import("./.mod.ts");
const fn = (globalThis as any).__near_cleanupOrphans;
const r = fn ? await fn() : null;
const ok = r && r.removed === 1 && r.retry === 2 && removed.length === 2500 && CONVS.map((c) => c.id).join() === "c2,c3";
console.log((ok ? "PASS" : "FAIL") + ": 02 уборка: удалена 1 переписка (2500 файлов, 3 страницы); 2 с ошибкой хранилища остались для повтора", JSON.stringify(r));
if (!ok) process.exit(1);
