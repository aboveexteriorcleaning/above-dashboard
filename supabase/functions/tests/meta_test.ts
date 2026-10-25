import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { assertMetaRequest, leadsFrom, mapInsight, metaGet, MetaReadOnlyViolation } from "../_shared/meta.ts";

const OK: RequestInit = { method: "GET", redirect: "error" };
const ACCT = "990266526067044";

Deno.test("meta guard: only GET to this ad account's details and results", () => {
  assertMetaRequest(new URL(`https://graph.facebook.com/v26.0/act_${ACCT}/insights?level=ad`), OK, ACCT);
  assertMetaRequest(new URL(`https://graph.facebook.com/v26.0/act_${ACCT}?fields=name`), OK, ACCT);
  const bad: [string, RequestInit][] = [
    [`https://graph.facebook.com/v26.0/act_${ACCT}/ads`, OK],                       // creating ads lives here
    [`https://graph.facebook.com/v26.0/act_${ACCT}/campaigns`, OK],
    [`https://graph.facebook.com/v26.0/act_123/insights`, OK],                      // another account
    [`https://graph.facebook.com/v26.0/me/accounts`, OK],
    [`https://evil.example.com/v26.0/act_${ACCT}/insights`, OK],
    [`https://graph.facebook.com/v26.0/act_${ACCT}/insights`, { ...OK, method: "POST" }],
    [`https://graph.facebook.com/v26.0/act_${ACCT}/insights`, { ...OK, body: "{}" }],
    [`https://graph.facebook.com/v26.0/act_${ACCT}/insights`, { method: "GET" }],     // must refuse redirects
    [`https://graph.facebook.com/v26.0/act_${ACCT}/insights?method=post`, OK],       // Graph's method override
    [`https://graph.facebook.com/v26.0/act_${ACCT}/insights?access_token=x`, OK],
  ];
  for (const [u, init] of bad) assertThrows(() => assertMetaRequest(new URL(u), init, ACCT), MetaReadOnlyViolation, undefined, u);
});

Deno.test("meta client: GET with the token in a header, never the URL", async () => {
  Deno.env.set("META_ACCESS_TOKEN", "tok");
  Deno.env.set("META_AD_ACCOUNT_ID", `act_${ACCT}`);
  let seen: Request | null = null;
  const fake = (async (url: URL, init: RequestInit) => {
    seen = new Request(url, init);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  await metaGet("/insights", { level: "ad" }, fake);
  assertEquals(seen!.method, "GET");
  assertEquals(seen!.headers.get("Authorization"), "Bearer tok");
  assert(!seen!.url.includes("tok"));
  assertEquals(new URL(seen!.url).pathname, `/v26.0/act_${ACCT}/insights`);
  // @ts-expect-error not an allowed sub-path
  await assertRejects(() => metaGet("/ads", {}, fake), MetaReadOnlyViolation);
  await assertRejects(() => metaGet("/insights", { method: "post" }, fake), MetaReadOnlyViolation);
});

Deno.test("meta rows: spend, clicks and leads", () => {
  assertEquals(leadsFrom([{ action_type: "link_click", value: "9" }, { action_type: "lead", value: "3" }]), 3);
  assertEquals(leadsFrom([{ action_type: "onsite_conversion.lead_grouped", value: "2" }]), 2);
  assertEquals(leadsFrom(undefined), 0);
  const r = mapInsight({ date_start: "2026-10-20", campaign_id: "C1", campaign_name: "Roof", ad_id: "A1", spend: "12.34",
    impressions: "1000", clicks: "40", inline_link_clicks: "25", actions: [{ action_type: "lead", value: "2" }] });
  assertEquals([r.day, r.spend, r.impressions, r.link_clicks, r.meta_leads], ["2026-10-20", 12.34, 1000, 25, 2]);
});

// Tripwire: Meta can only be reached from the one read-only client.
Deno.test("meta tripwire: no other code touches Meta", async () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const allowed = new Set(["supabase/functions/_shared/meta.ts", "supabase/functions/meta-sync/index.ts", "supabase/functions/tests/meta_test.ts"]);
  const hits: string[] = [];
  async function walk(dir: string) {
    for await (const e of Deno.readDir(root + dir)) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (/(^|\/)(node_modules|\.next|\.git)(\/|$)/.test(rel)) continue;
      if (e.isDirectory) { await walk(rel); continue; }
      if (!/\.(ts|tsx|js|mjs|cjs|sql|ya?ml|json|toml|sh)$/.test(e.name)) continue;
      const text = await Deno.readTextFile(root + rel);
      if (/graph\.facebook\.com|facebook\.com\/v\d|META_ACCESS_TOKEN|_shared\/meta(\.ts)?"/.test(text) && !allowed.has(rel)) hits.push(rel);
    }
  }
  await walk("");
  assertEquals(hits, [], `Meta referenced outside the read-only client: ${hits.join(", ")}`);
  const client = await Deno.readTextFile(root + "supabase/functions/_shared/meta.ts");
  assertEquals([...client.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]), ["GET"]);
});
