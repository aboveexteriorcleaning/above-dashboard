// Quo sync (calls + texts), read-only.
//   POST ?mode=check      -> confirm the key works; reads one page of each list, saves nothing
//   POST ?mode=backfill   -> resumable history import (default: last 2 years); repeat until done
//   POST ?mode=status     -> counts only, no customer details
//   POST (default)        -> incremental: anything new since the last run (skips until backfill is done)
// Requires header  x-sync-key: <SYNC_KEY secret>.
import { quoGet, quoPages } from "../_shared/quo.ts";
import { mapCall, mapMessage, mapNumber, mapUser } from "../_shared/quo_map.ts";
import { db, upsert } from "../_shared/db.ts";
import { markSync } from "../_shared/store.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

const BUDGET_MS = 100_000;

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-key") !== Deno.env.get("SYNC_KEY")) return json({ error: "forbidden" }, 403);
  const params = new URL(req.url).searchParams;
  const mode = params.get("mode") ?? "incremental";
  try {
    if (!Deno.env.get("QUO_API_KEY")) return json({ ok: true, skipped: "QUO_API_KEY not set yet" });
    if (mode === "check") return json(await check());
    if (mode === "status") return json(await status());
    if (mode === "backfill") return json(await backfill(Number(params.get("days") ?? 730), params.get("restart") === "1"));
    return json(await incremental(params.get("force") === "1"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markSync("quo", false, msg).catch(() => {});
    return json({ ok: false, error: msg }, 500);
  }
});

type Cursor = { backfilled?: boolean; calls_done?: boolean; messages_done?: boolean; days?: number };

async function getCursor(): Promise<Cursor> {
  const [row] = await db()`select cursor from public.sync_state where source = 'quo'`;
  return (row?.cursor ?? {}) as Cursor;
}
async function setCursor(c: Cursor) {
  await db()`insert into public.sync_state (source, cursor) values ('quo', ${db().json(c as never)})
             on conflict (source) do update set cursor = excluded.cursor`;
}

async function refreshDirectory(): Promise<Set<string>> {
  const numbers: any[] = [], users: any[] = [];
  for await (const page of quoPages("/phone-numbers", {})) numbers.push(...page);
  for await (const page of quoPages("/users", {})) users.push(...page);
  await upsert("public.quo_phone_numbers", numbers.map(mapNumber));
  await upsert("public.quo_users", users.map(mapUser));
  return new Set(numbers.map((n) => mapNumber(n).phone_number).filter((x): x is string => !!x));
}

async function check() {
  const lines = await quoGet("/phone-numbers", { limit: 50 });
  const users = await quoGet("/users", { limit: 50 });
  const calls = await quoGet("/calls", { limit: 1 });
  const msgs = await quoGet("/messages", { limit: 1 });
  return {
    ok: true,
    quo_lines: (lines.data ?? []).length,
    quo_users: (users.data ?? []).length,
    can_read_calls: Array.isArray(calls.data),
    can_read_messages: Array.isArray(msgs.data),
    call_fields: Object.keys(calls.data?.[0] ?? {}).sort(),
    message_fields: Object.keys(msgs.data?.[0] ?? {}).filter((k) => k !== "text").sort(),
  };
}

async function status() {
  const sql = db();
  const [s] = await sql`select last_success_at, last_error, last_error_at, cursor from public.sync_state where source = 'quo'`;
  const counts = await sql`select kind, direction, count(*)::int n, min(occurred_at) oldest, max(occurred_at) newest
                           from public.communications group by 1, 2 order by 1, 2`;
  const [leads] = await sql`select count(*)::int n from app.quo_leads`;
  return { ok: true, last_success_at: s?.last_success_at ?? null, last_error: s?.last_error ?? null,
           last_error_at: s?.last_error_at ?? null, progress: s?.cursor ?? null, counts, leads_all_time: leads.n };
}

/** Save one page of calls or messages. Returns the oldest createdAt on the page. */
async function savePage(kind: "calls" | "messages", items: any[], ours: Set<string>) {
  const rows = kind === "calls" ? items.map((c) => mapCall(c, ours)) : await Promise.all(items.map((m) => mapMessage(m, ours)));
  await upsert("public.communications", rows.filter((r) => r.id && r.occurred_at));
  return items.reduce<string | null>((o, it) => (!o || it.createdAt < o ? it.createdAt : o), null);
}

const filter = (kind: "calls" | "messages", op: "before" | "since", iso: string) =>
  kind === "calls"
    ? { [op === "before" ? "createdAt[lte]" : "createdAt[gte]"]: iso }
    : { [op === "before" ? "createdAt[lt]" : "createdAt[gt]"]: iso };

async function backfill(days: number, restart: boolean) {
  const t0 = Date.now();
  const sql = db();
  let cur = restart ? {} : await getCursor();
  cur = { ...cur, days };
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const ours = await refreshDirectory();
  const saved: Record<string, number> = { calls: 0, messages: 0 };

  for (const kind of ["calls", "messages"] as const) {
    if (cur[`${kind}_done`]) continue;
    const k = kind === "calls" ? "call" : "message";
    const [o] = await sql`select min(occurred_at) oldest from public.communications where kind = ${k}`;
    const params: Record<string, string> = o?.oldest ? filter(kind, "before", new Date(o.oldest).toISOString()) : {};
    let finished = true;
    for await (const page of quoPages(kind === "calls" ? "/calls" : "/messages", params)) {
      const keep = page.filter((it) => it.createdAt >= cutoff);
      if (keep.length) await savePage(kind, keep, ours);
      saved[kind] += keep.length;
      if (keep.length < page.length) break;                    // reached the cutoff
      if (Date.now() - t0 > BUDGET_MS) { finished = false; break; }
    }
    if (finished) cur = { ...cur, [`${kind}_done`]: true };
    await setCursor(cur);
    if (!finished) return { ok: true, done: false, saved, note: "time limit reached; run again to continue" };
  }
  await sql`select app.refresh_quo()`;
  cur = { ...cur, backfilled: true };
  await setCursor(cur);
  await markSync("quo", true, undefined, cur);
  return { ok: true, done: true, saved };
}

async function incremental(force: boolean) {
  const sql = db();
  const cur = await getCursor();
  if (!cur.backfilled) return { ok: true, skipped: "history import not finished yet (run the Quo backfill)" };
  const [s] = await sql`select last_success_at from public.sync_state where source = 'quo'`;
  const last = s?.last_success_at ? new Date(s.last_success_at) : new Date(Date.now() - 86400_000);
  if (!force && Date.now() - last.getTime() < 4 * 60_000) return { ok: true, skipped: "synced under 4 minutes ago" };
  // Re-read the last 2 hours too: call status and voicemails can land after the call starts.
  const since = new Date(last.getTime() - 2 * 3600_000).toISOString();
  const ours = await refreshDirectory();
  const saved: Record<string, number> = { calls: 0, messages: 0 };
  for (const kind of ["calls", "messages"] as const) {
    for await (const page of quoPages(kind === "calls" ? "/calls" : "/messages", filter(kind, "since", since))) {
      if (page.length) await savePage(kind, page, ours);
      saved[kind] += page.length;
    }
  }
  await sql`select app.refresh_quo()`;
  await markSync("quo", true, undefined, cur);
  return { ok: true, done: true, saved };
}
