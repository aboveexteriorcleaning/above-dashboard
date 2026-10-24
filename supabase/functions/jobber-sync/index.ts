// Scheduled Jobber sync.
//   POST ?mode=check        -> compare our queries to Jobber's live schema; writes nothing
//   POST ?mode=backfill&only=<type>  -> resumable history import for one record type
//   POST ?mode=backfill&only=done    -> confirm every type finished; turns on the schedule
//   POST (default)          -> incremental: everything changed since the last run
// Called every 15 minutes by pg_cron, and nightly with a 3-day overlap as a safety net.
// Requires header  x-sync-key: <SYNC_KEY secret>.
import { introspectType, pages, query } from "../_shared/jobber.ts";
import { FILTERS, MANIFEST, type QueryName } from "../_shared/queries.ts";
import { db } from "../_shared/db.ts";
import {
  markSync, refreshDerived, saveClients, saveInvoices, saveJobs, saveQuotes,
  saveRequests, saveTimesheets, saveUsers,
} from "../_shared/store.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-key") !== Deno.env.get("SYNC_KEY")) return json({ error: "forbidden" }, 403);
  const params = new URL(req.url).searchParams;
  const mode = params.get("mode") ?? "incremental";
  const only = params.get("only"); // backfill one record type at a time, e.g. ?mode=backfill&only=jobs

  try {
    if (mode === "check") return json(await schemaCheck());
    if (mode === "backfill") return json(await backfill(only, params.get("restart") === "1"));

    const sql = db();
    const [state] = await sql`select last_success_at from public.sync_state where source = 'jobber'`;
    if (!state?.last_success_at) {
      return json({ ok: false, skipped: "No backfill yet. Run the backfill first." });
    }
    const started = new Date();
    // Overlap windows so nothing slips between runs; upserts make re-reads harmless.
    const since = new Date(new Date(state.last_success_at).getTime() -
      (mode === "nightly" ? 3 * 86400_000 : 30 * 60_000)).toISOString();
    const counts: Record<string, number> = {};
    for (const t of TYPES) {
      counts[t.name] = 0;
      const s = t.name === "timesheets" ? new Date(Date.parse(since) - 3 * 86400_000).toISOString() : since;
      for await (const page of pages(t.query, t.root, t.name === "users" ? {} : { since: s })) {
        await t.save(page.nodes, "poll");
        counts[t.name] += page.nodes.length;
      }
    }
    await fillPlaceholders("poll");
    await refreshDerived();
    await markSync("jobber", true, undefined, { lastRunStarted: started.toISOString(), mode });
    return json({ ok: true, mode, since, counts });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markSync("jobber", false, msg).catch(() => {});
    return json({ ok: false, error: msg }, 500);
  }
});

type Via = "poll" | "backfill";
const TYPES: { name: string; query: QueryName; root: string; save: (n: any[], via: Via) => Promise<void> }[] = [
  // Order matters: people and clients before the records that point at them.
  { name: "users",      query: "users",      root: "users",            save: (n) => saveUsers(n) },
  { name: "clients",    query: "clients",    root: "clients",          save: saveClients },
  { name: "requests",   query: "requests",   root: "requests",         save: saveRequests },
  { name: "quotes",     query: "quotes",     root: "quotes",           save: saveQuotes },
  { name: "jobs",       query: "jobs",       root: "jobs",             save: saveJobs },
  { name: "invoices",   query: "invoices",   root: "invoices",         save: saveInvoices },
  { name: "timesheets", query: "timesheets", root: "timeSheetEntries", save: saveTimesheets },
];

/** History import for one record type. Saves its place after every page and stops
 *  safely before the function's time limit; call again to continue (done: false).
 *  `only=done` checks every type finished, then switches on the regular schedule. */
async function backfill(only: string | null, restart: boolean) {
  const sql = db();
  const BUDGET_MS = 100_000;
  const t0 = Date.now();
  const key = (name: string) => `jobber_backfill:${name}`;

  if (only === "done") {
    const rows = await sql`select source, cursor from public.sync_state where source like 'jobber_backfill:%'`;
    const finished = new Set(rows.filter((r) => r.cursor?.complete).map((r) => (r.source as string).split(":")[1]));
    const missing = TYPES.map((t) => t.name).filter((n) => !finished.has(n));
    if (missing.length) return { ok: false, error: `not finished yet: ${missing.join(", ")}` };
    await fillPlaceholders("backfill");
    await refreshDerived();
    await markSync("jobber", true, undefined, { backfillCompletedAt: new Date().toISOString() });
    return { ok: true, done: true, message: "Backfill complete; 15-minute sync is now active." };
  }

  const t = TYPES.find((x) => x.name === only);
  if (!t) return { ok: false, error: `only= must be one of ${TYPES.map((x) => x.name).join(", ")}, done` };

  const [st] = await sql`select cursor from public.sync_state where source = ${key(t.name)}`;
  if (st?.cursor?.complete && !restart) return { ok: true, only: t.name, done: true, saved: 0, note: "already complete" };
  const startAfter: string | null = restart ? null : (st?.cursor?.after ?? null);

  let saved = 0;
  for await (const page of pages(t.query, t.root, t.name === "users" ? {} : { since: null }, startAfter)) {
    await t.save(page.nodes, "backfill");
    saved += page.nodes.length;
    const cursor = page.hasNext ? { after: page.endCursor } : { complete: true };
    await sql`insert into public.sync_state (source, last_success_at, cursor)
              values (${key(t.name)}, now(), ${sql.json(cursor as never)})
              on conflict (source) do update set last_success_at = now(), cursor = excluded.cursor`;
    if (page.hasNext && Date.now() - t0 > BUDGET_MS) {
      return { ok: true, only: t.name, done: false, saved, note: "paused to stay under the time limit; call again" };
    }
  }
  return { ok: true, only: t.name, done: true, saved };
}

/** Fill in placeholder clients created when a record arrived before its client. */
async function fillPlaceholders(via: Via) {
  const sql = db();
  const placeholders = await sql`select id from public.clients where name = '(syncing)' limit 200`;
  for (const p of placeholders) {
    const d = await query("client", { id: p.id });
    if (d.client) await saveClients([d.client], via);
  }
}

/** Read-only comparison of our query fields with Jobber's real schema. */
async function schemaCheck() {
  const missing: string[] = [];
  const available: Record<string, string[]> = {};
  for (const [type, fields] of Object.entries(MANIFEST)) {
    const d = await introspectType(type);
    if (!d.__type) { missing.push(`type ${type} not found`); continue; }
    const have = new Set((d.__type.fields ?? []).map((f: any) => f.name));
    const before = missing.length;
    for (const f of fields) if (!have.has(f)) missing.push(`${type}.${f}`);
    if (missing.length > before) available[type] = [...have].sort() as string[];
    if (type === "Query") {
      for (const root of Object.keys(FILTERS)) {
        const field = (d.__type.fields ?? []).find((x: any) => x.name === root);
        if (field && !field.args.some((a: any) => a.name === "filter")) missing.push(`Query.${root}(filter:)`);
      }
    }
  }
  const scalar = await introspectType("ISO8601DateTime");
  if (!scalar.__type) missing.push("scalar ISO8601DateTime");
  const encoded = await introspectType("EncodedId");
  if (!encoded.__type) missing.push("scalar EncodedId");
  const account = await query("account");
  return { ok: missing.length === 0, account: account.account, missing, available };
}
