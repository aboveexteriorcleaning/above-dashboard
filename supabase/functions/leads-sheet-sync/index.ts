// Meta lead sheet sync, read-only.
//   POST ?mode=check  -> list the tabs that hold Meta leads and their row counts; saves nothing
//   POST (default)    -> read every lead tab and save each lead's time, phone and ad
// Needs LEADS_SHEET_ID, plus an owner's read-only Google login (google-connect?for=sheets)
// or a service account (GOOGLE_SHEETS_SERVICE_ACCOUNT) shared on the sheet as Viewer.
// Requires header  x-sync-key: <SYNC_KEY secret>.
import { upsert } from "../_shared/db.ts";
import { isLeadTab, mapLeadRows, readingAs, readSheet, sheetsConnected } from "../_shared/sheets.ts";
import { markSync } from "../_shared/store.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

function syncKeyOk(given: string | null, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (!syncKeyOk(req.headers.get("x-sync-key"), Deno.env.get("SYNC_KEY"))) return json({ error: "forbidden" }, 403);
  const mode = new URL(req.url).searchParams.get("mode") ?? "sync";
  const sheetId = Deno.env.get("LEADS_SHEET_ID");
  if (!sheetId || !(await sheetsConnected())) return json({ ok: true, skipped: "Lead sheet isn't set up yet (connect Google Sheets and set LEADS_SHEET_ID)" });
  try {
    const tabs = await readSheet(sheetId);
    const leadTabs = tabs.filter((t) => isLeadTab(t.rows));
    if (mode === "check") {
      return json({
        ok: true, reading_as: await readingAs(),
        lead_tabs: leadTabs.map((t) => ({ tab: t.tab, leads: Math.max(t.rows.length - 1, 0) })),
        other_tabs: tabs.filter((t) => !isLeadTab(t.rows)).map((t) => t.tab),
      });
    }
    const leads = leadTabs.flatMap((t) => mapLeadRows(t.tab, t.rows));
    for (let i = 0; i < leads.length; i += 500) await upsert("public.meta_form_leads", leads.slice(i, i + 500));
    await markSync("lead_sheet", true);
    return json({ ok: true, done: true, tabs: leadTabs.length, leads: leads.length, with_ad: leads.filter((l) => l.ad_id).length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markSync("lead_sheet", false, msg).catch(() => {});
    return json({ ok: false, error: msg }, 500);
  }
});
