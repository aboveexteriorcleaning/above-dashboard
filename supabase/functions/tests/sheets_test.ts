import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { assertSheetsRequest, isLeadTab, mapLeadRows, normalizePhone, SheetsReadOnlyViolation, tabsUrl, valuesUrl } from "../_shared/sheets.ts";

const ID = "1D4GG_0mQwMgDi5tZEgZwQi7-Eq9JxULiuARlCedsH7c";
const GET: RequestInit = { method: "GET", redirect: "error" };

Deno.test("sheets guard: GET only, the one lead sheet only", () => {
  assertSheetsRequest(tabsUrl(ID), GET, ID);
  assertSheetsRequest(valuesUrl(ID, ["Gutters", "Sep26 Roof"]), GET, ID);
  assertSheetsRequest(new URL("https://oauth2.googleapis.com/token"), { method: "POST", redirect: "error", body: "x" }, ID);
  const bad: [string, RequestInit][] = [
    [`https://sheets.googleapis.com/v4/spreadsheets/${ID}/values:batchUpdate`, { ...GET, method: "POST" }],     // writing cells
    [`https://sheets.googleapis.com/v4/spreadsheets/${ID}/values/A1:append`, { ...GET, method: "POST" }],       // appending rows
    [`https://sheets.googleapis.com/v4/spreadsheets/${ID}:batchUpdate`, { ...GET, method: "POST" }],            // editing tabs
    [`https://sheets.googleapis.com/v4/spreadsheets/${ID}/values:batchClear`, GET],
    [`https://sheets.googleapis.com/v4/spreadsheets/${ID}/values:batchGet`, { ...GET, method: "PUT" }],
    [`https://sheets.googleapis.com/v4/spreadsheets/someOtherSheetId_abcdefghij`, GET],                         // another sheet
    [`https://sheets.googleapis.com/v4/spreadsheets/${ID}?key=AIza`, GET],
    [`https://sheets.googleapis.com/v4/spreadsheets/${ID}?$method=POST`, GET],
    [`https://www.googleapis.com/drive/v3/files/${ID}`, GET],                                                    // Drive
    [`https://sheets.googleapis.com/v4/spreadsheets/${ID}`, { method: "GET" }],                                  // must refuse redirects
    ["https://oauth2.googleapis.com/revoke", { method: "POST", redirect: "error" }],
  ];
  for (const [u, init] of bad) assertThrows(() => assertSheetsRequest(new URL(u), init, ID), SheetsReadOnlyViolation, undefined, u);
  assertThrows(() => assertSheetsRequest(tabsUrl("x"), GET, "x"), SheetsReadOnlyViolation);
});

Deno.test("sheets: Meta's lead columns map to ad + phone, no names or emails", () => {
  const rows = [
    ["id", "created_time", "ad_id", "ad_name", "adset_id", "adset_name", "campaign_id", "campaign_name", "form_id", "form_name",
     "is_organic", "platform", "email", "first_name", "last_name", "phone_number", "lead_status"],
    ["l:1098696893042230", "2026-10-28T20:56:29-05:00", "ag:120250954602000297", "guttersdiff2", "as:1", "Gutters", "c:9", "Gutters Oct",
     "f:5", "Gutters Oct 26'", "false", "fb", "jane@example.com", "Jane", "Doe", "p:+13605551234", "CREATED"],
    ["", "2026-10-28T20:56:29-05:00", "ag:1", "x", "", "", "", "", "", "", "", "", "", "", "", "p:+13605550000", ""],   // no id: skipped
  ];
  assert(isLeadTab(rows));
  const [l, ...rest] = mapLeadRows("Gutters", rows);
  assertEquals(rest.length, 0);
  assertEquals([l.id, l.created_at, l.phone, l.ad_id, l.ad_name, l.campaign_id, l.is_organic, l.sheet_tab],
    ["1098696893042230", "2026-10-29T01:56:29.000Z", "+13605551234", "120250954602000297", "guttersdiff2", "9", false, "Gutters"]);
  assert(!("email" in l) && !("first_name" in l), "names and emails are never stored");
  assert(!isLeadTab([["Name", "Phone"], ["a", "b"]]));
});

Deno.test("sheets: phone numbers normalize to +1", () => {
  assertEquals(normalizePhone("p:+13605551234"), "+13605551234");
  assertEquals(normalizePhone("(360) 555-1234"), "+13605551234");
  assertEquals(normalizePhone("13605551234"), "+13605551234");
  assertEquals(normalizePhone("555-1234"), null);
  assertEquals(normalizePhone(""), null);
});

Deno.test("sheets tripwire: no other code touches Google Sheets", async () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const allowed = new Set(["supabase/functions/_shared/sheets.ts", "supabase/functions/tests/sheets_test.ts", "supabase/functions/leads-sheet-sync/index.ts",
    "supabase/functions/tests/google_test.ts"]);   // only names the sheets client in its allow-list
  const hits: string[] = [];
  async function walk(dir: string) {
    for await (const e of Deno.readDir(root + dir)) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (/(^|\/)(node_modules|\.next|\.git)(\/|$)/.test(rel)) continue;
      if (e.isDirectory) { await walk(rel); continue; }
      if (!/\.(ts|tsx|js|mjs|cjs|sql|ya?ml|json|toml|sh)$/.test(e.name)) continue;
      const t = await Deno.readTextFile(root + rel);
      if (/sheets\.googleapis\.com|_shared\/sheets(\.ts)?"/.test(t) && !allowed.has(rel)) hits.push(rel);
    }
  }
  await walk("");
  assertEquals(hits, [], `Google Sheets referenced outside the read-only client: ${hits.join(", ")}`);
  const client = await Deno.readTextFile(root + "supabase/functions/_shared/sheets.ts");
  const methods = [...client.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
  assertEquals([...new Set(methods)].sort(), ["GET", "POST"], "only GET reads plus the token POST");
  assertEquals(methods.filter((m) => m === "POST").length, 1, "exactly one POST: the sign-in token request");
  assert(client.includes("spreadsheets.readonly"), "asks Google for read-only access");
});
