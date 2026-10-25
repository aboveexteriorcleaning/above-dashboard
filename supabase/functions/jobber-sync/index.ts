// Scheduled Jobber sync.
//   POST ?mode=check        -> compare our queries to Jobber's live schema; writes nothing
//   POST ?mode=backfill&only=<type>  -> resumable history import for one record type
//   POST ?mode=backfill&only=done    -> confirm every type finished; turns on the schedule
//   POST (default)          -> incremental: everything changed since the last run
// The scheduler calls every 5 minutes: a new cycle starts every ~15 minutes, and a cycle
// too big for one call continues on the next. Nightly run widens the windows.
// Requires header  x-sync-key: <SYNC_KEY secret>.
import { introspectType, pages, query } from "../_shared/jobber.ts";
import { FILTERS, MANIFEST, MANIFEST_OPTIONAL, type QueryName } from "../_shared/queries.ts";
import { db } from "../_shared/db.ts";
import {
  markSync, refreshDerived, saveClients, saveInvoices, saveJobFields, saveJobs, saveQuotes,
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
    if (mode === "backfill" && only === "jobfields") return json(await syncJobFields("jobFieldsAll", {}));
    if (mode === "check") return json(await schemaCheck());
    if (mode === "backfill") return json(await backfill(only, params.get("restart") === "1"));

    if (mode === "status") return json(await status());
    return json(await regularSync(mode === "nightly", params.get("force") === "1"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markSync("jobber", false, msg).catch(() => {});
    return json({ ok: false, error: msg }, 500);
  }
});

type Via = "poll" | "backfill";
type Step = { query: QueryName; vars: Record<string, unknown> };
type SyncType = {
  name: string; all: QueryName; root: string;
  save: (n: any[], via: Via) => Promise<void>;
  /** What to read on a regular run: everything that may have changed since `since`. */
  changed: (since: string, nightly: boolean) => Step[];
};
const days = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();

const TYPES: SyncType[] = [
  // Order matters: people and clients before the records that point at them.
  { name: "users", all: "users", root: "users", save: (n) => saveUsers(n),
    changed: () => [{ query: "users", vars: {} }] },
  { name: "clients", all: "clientsAll", root: "clients", save: saveClients,
    changed: (since) => [{ query: "clients", vars: { since } }] },
  { name: "requests", all: "requestsAll", root: "requests", save: saveRequests,
    changed: (since) => [{ query: "requests", vars: { since } }] },
  { name: "quotes", all: "quotesAll", root: "quotes", save: saveQuotes,
    changed: (since) => [{ query: "quotes", vars: { since } }] },
  { name: "jobs", all: "jobsAll", root: "jobs", save: saveJobs,
    // No "updated since" filter for jobs: new + completed + everything scheduled near now.
    // Webhooks cover other edits instantly; the nightly pass widens the window.
    changed: (since, nightly) => [
      { query: "jobsCreated", vars: { since } },
      { query: "jobsCompleted", vars: { since } },
      { query: "jobsScheduled", vars: nightly ? { from: days(-60), to: days(180) } : { from: days(-14), to: days(90) } },
    ] },
  { name: "invoices", all: "invoicesAll", root: "invoices", save: saveInvoices,
    changed: (since) => [{ query: "invoices", vars: { since } }] },
  { name: "timesheets", all: "timesheetsAll", root: "timeSheetEntries", save: saveTimesheets,
    changed: (since) => [{ query: "timesheets", vars: { since } }] },
];

/** Regular sync, resumable. A "cycle" reads every type's recent changes once. If a
 *  call nears the time limit it saves its place (type, step, page) and the next call
 *  continues. A cycle only counts as successful once every type is done. */
async function regularSync(nightlyRequested: boolean, force = false) {
  const sql = db();
  const BUDGET_MS = 100_000;
  const t0 = Date.now();
  const [state] = await sql`select last_success_at from public.sync_state where source = 'jobber'`;
  if (!state?.last_success_at) return { ok: false, skipped: "No backfill yet. Run the backfill first." };

  const [cyc] = await sql`select cursor from public.sync_state where source = 'jobber_cycle'`;
  let c = cyc?.cursor as null | { since: string; startedAt: string; nightly: boolean; type: number; step: number; after: string | null };
  if (!c) {
    // Don't start a fresh cycle more often than every ~14 minutes (the scheduler checks every 5).
    const age = Date.now() - new Date(state.last_success_at).getTime();
    if (!nightlyRequested && !force && age < 14 * 60_000) return { ok: true, done: true, skipped: "synced recently" };
    const overlap = nightlyRequested ? 3 * 86400_000 : 30 * 60_000;
    c = { since: new Date(new Date(state.last_success_at).getTime() - overlap).toISOString(),
          startedAt: new Date().toISOString(), nightly: nightlyRequested, type: 0, step: 0, after: null };
  }
  const save = async () => {
    await sql`insert into public.sync_state (source, cursor) values ('jobber_cycle', ${sql.json(c as never)})
              on conflict (source) do update set cursor = excluded.cursor`;
  };

  const timings: Record<string, { pages: number; records: number; ms: number }> = {};
  for (; c.type < TYPES.length; c.type++, c.step = 0, c.after = null) {
    const t = TYPES[c.type];
    const steps = t.changed(c.since, c.nightly);
    for (; c.step < steps.length; c.step++, c.after = null) {
      const step = steps[c.step];
      const label = `${t.name}:${step.query}`;
      const tm = (timings[label] ??= { pages: 0, records: 0, ms: 0 });
      const s0 = Date.now();
      for await (const page of pages(step.query, t.root, step.vars, c.after)) {
        await t.save(page.nodes, "poll");
        tm.pages++; tm.records += page.nodes.length;
        c.after = page.hasNext ? page.endCursor : null;
        if (page.hasNext && Date.now() - t0 > BUDGET_MS) {
          tm.ms += Date.now() - s0;
          await save();
          return { ok: true, done: false, note: "paused to stay under the time limit; continues next call", at: label, timings };
        }
      }
      tm.ms += Date.now() - s0;
      await save();
    }
  }
  const f0 = Date.now();
  await syncJobFields("jobFieldsCompleted", { since: c.since });
  await fillPlaceholders("poll");
  await refreshDerived();
  timings["finish"] = { pages: 0, records: 0, ms: Date.now() - f0 };
  // Record the cycle's START time as the success time, so changes made while it ran are re-read next cycle.
  await sql`update public.sync_state set last_success_at = ${c.startedAt}, last_error = null where source = 'jobber'`;
  await sql`delete from public.sync_state where source = 'jobber_cycle'`;
  return { ok: true, done: true, nightly: c.nightly, since: c.since, timings };
}

/** Health check: sync times, last error, and record totals. No customer details. */
async function status() {
  const sql = db();
  const sync = await sql`select source, last_success_at, last_error, last_error_at,
                                case when source = 'jobber_cycle' then cursor end as in_progress
                         from public.sync_state where source not like 'jobber_backfill:%' order by source`;
  const [totals] = await sql`select
      (select count(*) from public.employees)::int as team_members,
      (select count(*) from public.clients)::int as clients,
      (select count(*) from public.clients where name = '(syncing)')::int as clients_pending,
      (select count(*) from public.requests)::int as requests,
      (select count(*) from public.quotes)::int as quotes,
      (select count(*) from public.jobs)::int as jobs,
      (select count(*) from public.jobs where completed_at is not null)::int as jobs_completed,
      (select count(*) from public.visits)::int as visits,
      (select count(*) from public.job_line_items)::int as job_line_items,
      (select count(*) from public.invoices)::int as invoices,
      (select count(*) from public.timesheet_entries)::int as timesheet_entries,
      (select max(synced_at) from public.jobs) as newest_job_sync`;
  const jobs = await sql`select jobid, schedule, active from cron.job order by jobid`.catch(() => []);
  const runs = await sql`select status, start_time from cron.job_run_details
                         order by start_time desc limit 5`.catch(() => []);
  return { ok: true, sync, totals, scheduler: { jobs, recent_runs: runs } };
}

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
  for await (const page of pages(t.all, t.root, {}, startAfter)) {
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

/** Job custom fields (upsell offers). Never fails the sync: if Jobber rejects the
 *  query (e.g. different field names), the error is recorded and the step skipped. */
async function syncJobFields(name: QueryName, vars: Record<string, unknown>) {
  let n = 0;
  try {
    for await (const page of pages(name, "jobs", vars)) { await saveJobFields(page.nodes); n += page.nodes.length; }
    await markSync("jobber_job_fields", true);
    return { ok: true, done: true, jobs_checked: n };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markSync("jobber_job_fields", false, msg).catch(() => {});
    return { ok: true, done: true, skipped: "job custom fields unavailable", error: msg.slice(0, 300) };
  }
}

/** Read-only comparison of our query fields with Jobber's real schema,
 *  including which keys each list's `filter` accepts. */
async function schemaCheck() {
  const missing: string[] = [];
  const available: Record<string, string[]> = {};
  const filters: Record<string, { accepts: string[]; otherArgs: string[] }> = {};
  for (const [type, fields] of Object.entries(MANIFEST)) {
    const d = await introspectType(type);
    if (!d.__type) { missing.push(`type ${type} not found`); continue; }
    const have = new Set((d.__type.fields ?? []).map((f: any) => f.name));
    const before = missing.length;
    for (const f of fields) if (!have.has(f)) missing.push(`${type}.${f}`);
    if (missing.length > before) available[type] = [...have].sort() as string[];
    if (type === "Query") {
      for (const [root, keys] of Object.entries(FILTERS)) {
        const field = (d.__type.fields ?? []).find((x: any) => x.name === root);
        const filterArg = field?.args.find((a: any) => a.name === "filter");
        if (!filterArg) { missing.push(`Query.${root}(filter:)`); continue; }
        const inputName = unwrap(filterArg.type);
        const input = inputName ? (await introspectType(inputName)).__type : null;
        const accepts = (input?.inputFields ?? []).map((f: any) => f.name).sort();
        filters[root] = { accepts, otherArgs: field.args.map((a: any) => a.name) };
        for (const k of keys) if (!accepts.includes(k)) missing.push(`Query.${root}(filter: { ${k} })`);
      }
    }
  }
  const scalar = await introspectType("ISO8601DateTime");
  if (!scalar.__type) missing.push("scalar ISO8601DateTime");
  const encoded = await introspectType("EncodedId");
  if (!encoded.__type) missing.push("scalar EncodedId");
  const optional_missing: string[] = [];
  for (const [type, fields] of Object.entries(MANIFEST_OPTIONAL)) {
    const d = await introspectType(type);
    if (!d.__type) { optional_missing.push(`type ${type} not found`); continue; }
    const have = new Set((d.__type.fields ?? []).map((f: any) => f.name));
    for (const f of fields) if (!have.has(f)) optional_missing.push(`${type}.${f} (have: ${[...have].join(", ")})`);
  }
  const account = await query("account");
  return { ok: missing.length === 0, account: account.account, missing, available, filters,
           job_custom_fields: optional_missing.length ? { ok: false, missing: optional_missing } : { ok: true } };
}

function unwrap(t: any): string | null {
  while (t && !t.name) t = t.ofType;
  return t?.name ?? null;
}
