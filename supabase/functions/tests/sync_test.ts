// deno test supabase/functions/tests
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { assertReadOnly, ReadOnlyViolation } from "../_shared/readonly_guard.ts";
import { QUERIES } from "../_shared/queries.ts";
import { mapJob, mapQuote, mapTimesheet, normalizePhone } from "../_shared/mapping.ts";
import { challengeFor, hmacSha256Base64, safeEqual } from "../_shared/pkce.ts";

// ---------------- read-only guard ----------------
Deno.test("every query the sync can run passes the read-only guard", () => {
  for (const [name, q] of Object.entries(QUERIES)) {
    try { assertReadOnly(q); } catch { throw new Error(`query ${name} was blocked`); }
  }
});

Deno.test("mutations are blocked in every disguise", () => {
  const attempts = [
    `mutation { clientEdit(clientId: "x", input: {}) { client { id } } }`,
    `  MUTATION X { jobCreate(input: {}) { job { id } } }`,
    `query A { jobs { nodes { id } } } mutation B { clientDelete(clientId:"x") { userErrors { message } } }`,
    `# harmless comment\nmutation { a }`,
    `subscription { jobUpdated { id } }`,
    `fragment F on Job { id } mutation { a }`,
  ];
  for (const a of attempts) assertThrows(() => assertReadOnly(a), ReadOnlyViolation, undefined, a);
});

Deno.test("keywords inside strings or comments cannot sneak past", () => {
  // a mutation hidden after a string that contains a quote
  assertThrows(() => assertReadOnly(`query { a(x: "he said \\"hi\\"") } mutation { b }`), ReadOnlyViolation);
  // the word in a string literal alone is harmless
  assertReadOnly(`query { clients(searchTerm: "mutation") { nodes { id } } }`);
  // the word in a comment alone is harmless
  assertReadOnly(`query { # not a mutation\n account { id } }`);
});

// ---------------- mapping ----------------
const sampleJob = {
  id: "JOB1", jobNumber: 900, title: "Roof Softwash & Gutter Cleaning", jobStatus: "archived",
  jobType: "ONE_OFF", createdAt: "2026-10-07T22:32:10Z", startAt: "2026-10-22T07:00:00Z",
  completedAt: "2026-10-22T19:23:42Z", total: 1116.52, // includes tax
  client: { id: "CL1" }, quote: { id: "Q1" },
  property: { id: "P1", address: { street1: "1 Test St", city: "Olympia", postalCode: "98516" } },
  lineItems: { nodes: [
    { id: "L1", name: "Softwash Roof Cleaning", quantity: 1, unitPrice: 1030, totalPrice: 1030 },
    { id: "L2", name: "Interior Gutter Cleaning", quantity: 1, unitPrice: 0, totalPrice: 0 },
    { id: "L3", name: "Biannual Roof Cleaning Plan", quantity: 1, unitPrice: -50, totalPrice: -50 },
  ] },
  visits: { nodes: [{ id: "V1", startAt: "2026-10-22T20:30:00Z", endAt: "2026-10-22T23:00:00Z",
    completedAt: "2026-10-22T19:23:42Z", visitStatus: "COMPLETED",
    assignedUsers: { nodes: [{ id: "U1" }, { id: "U2" }] } }] },
};

Deno.test("job revenue is pre-tax (sum of line items, plan discount applied)", () => {
  const m = mapJob(sampleJob);
  assertEquals(m.job.total, 980);
  assertEquals(m.lines.length, 3);
  assertEquals(m.visits[0].id, "V1");
  assertEquals(m.assignments, [{ visit_id: "V1", jobber_user_id: "U1" }, { visit_id: "V1", jobber_user_id: "U2" }]);
  assertEquals(m.property?.postal_code, "98516");
});

Deno.test("quote keeps salesperson, timestamps and optional items", () => {
  const resolve = (u: string) => (u === "U1" ? "emp-uuid-1" : null);
  const m = mapQuote({
    id: "Q1", quoteNumber: "2079", quoteStatus: "converted", createdAt: "2026-10-07T20:12:47Z",
    sentAt: "2026-10-07T20:13:50Z", client: { id: "CL1" }, request: null, salesperson: { id: "U1" },
    amounts: { subtotal: 1030, discountAmount: 0, total: 1116.52 },
    lastTransitioned: { approvedAt: "2026-10-07T22:31:55Z", convertedAt: "2026-10-07T22:32:11Z" },
    lineItems: { nodes: [
      { id: "QL1", name: "Softwash Roof Cleaning", totalPrice: 1030, optional: false },
      { id: "QL2", name: "Skylight Window Cleaning", totalPrice: 60, optional: true },
    ] },
  }, resolve);
  assertEquals(m.quote.salesperson_id, "emp-uuid-1");
  assertEquals(m.quote.approved_at, "2026-10-07T22:31:55Z");
  assertEquals(m.lines.filter((l: any) => l.is_optional).length, 1);
});

Deno.test("timesheet minutes come from start/end; unknown users are skipped", () => {
  const resolve = (u: string) => (u === "U1" ? "emp-1" : null);
  const t = mapTimesheet({ id: "T1", startAt: "2026-10-22T16:00:00Z", endAt: "2026-10-22T19:30:00Z",
    user: { id: "U1" }, job: { id: "JOB1" }, visit: { id: "V1" } }, resolve);
  assertEquals(t?.minutes, 210);
  assertEquals(mapTimesheet({ id: "T2", startAt: "2026-10-22T16:00:00Z", user: { id: "U9" } }, resolve), null);
  // still clocked in: falls back to finalDuration (seconds)
  assertEquals(mapTimesheet({ id: "T3", startAt: "2026-10-22T16:00:00Z", finalDuration: 5400, user: { id: "U1" } }, resolve)?.minutes, 90);
});

Deno.test("phone numbers normalise for lead matching", () => {
  assertEquals(normalizePhone("(360) 555-0134"), "+13605550134");
  assertEquals(normalizePhone("+1 360 555 0134"), "+13605550134");
  assertEquals(normalizePhone("p:+13605550134"), "+13605550134");
  assertEquals(normalizePhone(""), null);
});

// ---------------- security helpers ----------------
Deno.test("webhook signature check: right secret passes, wrong secret fails", async () => {
  const body = '{"data":{"webHookEvent":{"topic":"JOB_UPDATE","itemId":"x"}}}';
  const good = await hmacSha256Base64("client-secret", body);
  assert(safeEqual(good, await hmacSha256Base64("client-secret", body)));
  assert(!safeEqual(good, await hmacSha256Base64("wrong-secret", body)));
  assert(!safeEqual(good, await hmacSha256Base64("client-secret", body + " ")));
});

Deno.test("PKCE challenge matches the RFC 7636 test vector", async () => {
  assertEquals(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

import { upsellOfferFrom } from "../_shared/mapping.ts";
Deno.test("upsell offer custom field", () => {
  const f = (v: string) => [{ __typename: "CustomFieldDropdown", label: "Upsell offer", valueDropdown: v }];
  if (upsellOfferFrom(f("Accepted")) !== "accepted") throw new Error("accepted");
  if (upsellOfferFrom(f("Declined")) !== "declined") throw new Error("declined");
  if (upsellOfferFrom(f("Not offered")) !== "not_offered") throw new Error("not offered");
  if (upsellOfferFrom(f("Not a fit")) !== "not_a_fit") throw new Error("not a fit");
  if (upsellOfferFrom([{ __typename: "CustomFieldText", label: "Notes", valueText: "x" }]) !== null) throw new Error("other fields ignored");
  if (upsellOfferFrom(null) !== null) throw new Error("none");
});
