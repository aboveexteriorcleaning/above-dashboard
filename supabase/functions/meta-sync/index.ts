// Meta ads sync, read-only.
//   POST ?mode=check                 -> confirm the token and account; reads, saves nothing
//   POST ?mode=backfill[&days=760]   -> resumable history import, one month at a time
//   POST ?mode=incremental&days=3    -> re-read the last N days (Meta updates recent results)
//   POST ?mode=status                -> counts only
// Requires header  x-sync-key: <SYNC_KEY secret>.
import { INSIGHT_FIELDS, mapInsight, metaGet, metaInsights } from "../_shared/meta.ts";
import { db, upsert } from "../_shared/db.ts";
import { markSync } from "../_shared/store.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
const BUDGET_MS = 100_000;

function syncKeyOk(given: string | null, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
const clampDays = (v: string | null, dflt: number) => Math.min(Math.max(Math.trunc(Number(v ?? dflt)) || dflt, 1), 1100);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };

Deno.serve(async (req) => {
  if (!syncKeyOk(req.headers.get("x-sync-key"), Deno.env.get("SYNC_KEY"))) return json({ error: "forbidden" }, 403);
  const params = new URL(req.url).searchParams;
  const mode = params.get("mode") ?? "incremental";
  try {
    if (!Deno.env.get("META_ACCESS_TOKEN") || !Deno.env.get("META_AD_ACCOUNT_ID")) {
      return json({ ok: true, skipped: "META_ACCESS_TOKEN / META_AD_ACCOUNT_ID not set yet" });
    }
    if (mode === "check") return json(await check());
    if (mode === "status") return json(await status());
    if (mode === "backfill") return json(await backfill(clampDays(params.get("days"), 760), params.get("restart") === "1"));
    return json(await incremental(clampDays(params.get("days"), 3)));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markSync("meta", false, msg).catch(() => {});
    return json({ ok: false, error: msg }, 500);
  }
});

async function check() {
  const acct = await metaGet("", { fields: "name,currency,timezone_name,account_status" });
  const sample = await metaGet("/insights", { level: "ad", date_preset: "last_30d", fields: INSIGHT_FIELDS, limit: 1 });
  return {
    ok: true, account: acct.name ?? null, currency: acct.currency ?? null, timezone: acct.timezone_name ?? null,
    active: acct.account_status === 1, sample_fields: Object.keys(sample.data?.[0] ?? {}).sort(),
  };
}

async function status() {
  const sql = db();
  const [s] = await sql`select last_success_at, last_error, last_error_at, cursor from public.sync_state where source = 'meta'`;
  const [c] = await sql`select count(*)::int rows, min(day) oldest, max(day) newest, round(sum(spend), 2) total_spend,
                               count(distinct campaign_id)::int campaigns from public.ad_spend_daily`;
  return { ok: true, last_success_at: s?.last_success_at ?? null, last_error: s?.last_error ?? null, progress: s?.cursor ?? null, ...c };
}

/** Read and save one date range. */
async function pull(since: string, until: string) {
  let n = 0;
  for await (const page of metaInsights({
    level: "ad", time_increment: 1, fields: INSIGHT_FIELDS,
    time_range: JSON.stringify({ since, until }),
  })) {
    const rows = page.map(mapInsight).filter((r) => r.day);
    await upsert("public.ad_spend_daily", rows, ["day", "ad_id"]);
    n += rows.length;
  }
  return n;
}

async function backfill(days: number, restart: boolean) {
  const t0 = Date.now();
  const sql = db();
  const [st] = await sql`select cursor from public.sync_state where source = 'meta'`;
  const cur: any = restart ? {} : (st?.cursor ?? {});
  const today = isoDay(new Date());
  const start = addDays(today, -days);
  // Walk backwards a month at a time from where we left off.
  let until: string = cur.backfill_next_until ?? today;
  let saved = 0;
  while (until >= start) {
    const since = addDays(until, -30) < start ? start : addDays(until, -30);
    saved += await pull(since, until);
    until = addDays(since, -1);
    const next = { ...cur, backfill_next_until: until, backfill_start: start };
    await sql`insert into public.sync_state (source, cursor) values ('meta', ${sql.json(next)})
              on conflict (source) do update set cursor = excluded.cursor`;
    if (Date.now() - t0 > BUDGET_MS && until >= start) return { ok: true, done: false, saved, note: "time limit reached; run again to continue" };
  }
  const done = { backfilled: true, backfill_start: start };
  await markSync("meta", true, undefined, done);
  await sql`update public.sync_state set cursor = ${sql.json(done)} where source = 'meta'`;
  return { ok: true, done: true, saved };
}

async function incremental(days: number) {
  const sql = db();
  const [st] = await sql`select cursor from public.sync_state where source = 'meta'`;
  if (!st?.cursor?.backfilled) return { ok: true, skipped: "history import not finished yet (run the Meta backfill)" };
  const today = isoDay(new Date());
  const saved = await pull(addDays(today, -days), today);
  await markSync("meta", true, undefined, st.cursor);
  return { ok: true, done: true, saved };
}
