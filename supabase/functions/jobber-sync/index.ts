// Scheduled Jobber sync.
//   POST ?mode=check        -> compare our queries to Jobber's live schema; writes nothing
//   POST ?mode=backfill     -> full history pull (first run)
//   POST (default)          -> incremental: everything changed since the last run
// Called every 15 minutes by pg_cron, and nightly with a 3-day overlap as a safety net.
// Requires header  x-sync-key: <SYNC_KEY secret>.
import { introspectType, pages, query } from "../_shared/jobber.ts";
import { FILTERS, MANIFEST } from "../_shared/queries.ts";
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

    const sql = db();
    const [state] = await sql`select last_success_at from public.sync_state where source = 'jobber'`;
    if (mode !== "backfill" && !state?.last_success_at) {
      return json({ ok: false, skipped: "No backfill yet. Run ?mode=backfill first." });
    }
    const started = new Date();
    // Overlap windows so nothing slips between runs; upserts make re-reads harmless.
    const since = mode === "backfill" || !state?.last_success_at
      ? null
      : new Date(new Date(state.last_success_at).getTime() - (mode === "nightly" ? 3 * 86400_000 : 30 * 60_000)).toISOString();
    const via = since ? "poll" : "backfill";
    const counts: Record<string, number> = {};
    const run = async (name: string, iter: AsyncGenerator<any[]>, save: (n: any[]) => Promise<void>) => {
      if (only && only !== name) return;
      counts[name] = 0;
      for await (const nodes of iter) { await save(nodes); counts[name] += nodes.length; }
    };

    // Order matters: people and clients before the records that point at them.
    await run("users", pages("users", "users"), saveUsers);
    await run("clients", pages("clients", "clients", { since }), (n) => saveClients(n, via));
    await run("requests", pages("requests", "requests", { since }), (n) => saveRequests(n, via));
    await run("quotes", pages("quotes", "quotes", { since }), (n) => saveQuotes(n, via));
    await run("jobs", pages("jobs", "jobs", { since }), (n) => saveJobs(n, via));
    await run("invoices", pages("invoices", "invoices", { since }), (n) => saveInvoices(n, via));
    // Timesheets are filtered by start time; re-read the last 3 days so late edits are caught.
    const tsSince = since ? new Date(Date.parse(since) - 3 * 86400_000).toISOString() : null;
    await run("timesheets", pages("timesheets", "timeSheetEntries", { since: tsSince }), (n) => saveTimesheets(n, via));

    // Fill any placeholder clients created by child records.
    const placeholders = await sql`select id from public.clients where name = '(syncing)' limit 200`;
    for (const p of placeholders) {
      const d = await query("client", { id: p.id });
      if (d.client) await saveClients([d.client], via);
    }

    await refreshDerived();
    // A partial backfill (one record type) must not count as the first full sync.
    // ?mode=backfill&only=done marks the backfill complete once every type has been pulled.
    if (only && only !== "done") return json({ ok: true, mode, only, counts });
    await markSync("jobber", true, undefined, { lastRunStarted: started.toISOString(), mode });
    return json({ ok: true, mode, since, counts });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markSync("jobber", false, msg).catch(() => {});
    return json({ ok: false, error: msg }, 500);
  }
});

/** Read-only comparison of our query fields with Jobber's real schema. */
async function schemaCheck() {
  const missing: string[] = [];
  for (const [type, fields] of Object.entries(MANIFEST)) {
    const d = await introspectType(type);
    if (!d.__type) { missing.push(`type ${type} not found`); continue; }
    const have = new Set((d.__type.fields ?? []).map((f: any) => f.name));
    for (const f of fields) if (!have.has(f)) missing.push(`${type}.${f}`);
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
  return { ok: missing.length === 0, account: account.account, missing };
}
