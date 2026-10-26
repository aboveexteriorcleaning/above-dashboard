import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { assertQuoReadOnly, assertQuoRequest, quoGet, QuoReadOnlyViolation } from "../_shared/quo.ts";
import { externalNumber, isReviewRequest, mapCall, mapMessage, textFingerprints } from "../_shared/quo_map.ts";

Deno.test("quo guard: only GET to the four list endpoints", () => {
  assertQuoReadOnly("GET", "/calls");
  assertQuoReadOnly("GET", "/messages");
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    assertThrows(() => assertQuoReadOnly(m, "/messages"), QuoReadOnlyViolation);
  }
  for (const p of ["/messages/AC1/retry", "/conversations", "/contacts", "/webhooks", "/calls/AC1"]) {
    assertThrows(() => assertQuoReadOnly("GET", p), QuoReadOnlyViolation);
  }
});

Deno.test("quo client sends GET with key and version, never a body", async () => {
  Deno.env.set("QUO_API_KEY", "test-key");
  let seen: Request | null = null;
  const fake = (async (url: URL, init: RequestInit) => {
    seen = new Request(url, init);
    return new Response(JSON.stringify({ data: [], nextCursor: null }), { status: 200 });
  }) as unknown as typeof fetch;
  await quoGet("/calls", { limit: 1, "createdAt[gte]": "2026-10-01T00:00:00Z" }, fake);
  assertEquals(seen!.method, "GET");
  assertEquals(seen!.headers.get("Authorization"), "test-key");
  assertEquals(seen!.headers.get("Quo-Api-Version"), "2026-03-30");
  assertEquals(new URL(seen!.url).searchParams.get("createdAt[gte]"), "2026-10-01T00:00:00Z");
  // @ts-expect-error not an allowed path
  await assertRejects(() => quoGet("/webhooks", {}, fake), QuoReadOnlyViolation);
});

Deno.test("quo client retries on 429", async () => {
  Deno.env.set("QUO_API_KEY", "test-key");
  let n = 0;
  const fake = (async () => {
    n++;
    return n < 3 ? new Response("{}", { status: 429 }) : new Response(JSON.stringify({ data: [1] }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await quoGet("/users", {}, fake);
  assertEquals(r.data, [1]);
  assertEquals(n, 3);
});

const OURS = new Set(["+13605550100"]);

Deno.test("calls map to the outside number and the person who answered", () => {
  const row = mapCall({
    id: "AC1", direction: "incoming", status: "completed", createdAt: "2026-10-01T16:00:00Z",
    answeredAt: "2026-10-01T16:00:05Z", answeredBy: "USkale", duration: 95, phoneNumberId: "PN1",
    participants: [{ phoneNumber: "+13605550100", actorId: "USkale" }, { phoneNumber: "+1 (360) 555-0199", actorId: null }],
  }, OURS);
  assertEquals(row.contact_phone, "+13605550199");
  assertEquals(row.direction, "inbound");
  assertEquals(row.quo_user_id, "USkale");
  assert(row.answered_at);
  assertEquals(row.ai_handled, false);
});

Deno.test("messages keep fingerprints, never the text", async () => {
  const row = await mapMessage({
    id: "AC2", direction: "outgoing", createdAt: "2026-10-01T16:00:00Z", status: "delivered",
    from: "+13605550100", to: ["+13605550123"], text: "Hi Jordan, thanks for reaching out to Above Exterior Cleaning! We'll call you shortly.",
    userId: "USkale", phoneNumberId: "PN1", conversationId: "CN1",
  }, OURS);
  assertEquals(row.contact_phone, "+13605550123");
  assert(!JSON.stringify(row).includes("Jordan"));
  assert(!JSON.stringify(row).toLowerCase().includes("reaching out"));
  const other = await textFingerprints("Hey Sam, thanks for reaching out to Above Exterior Cleaning! We'll call you shortly.");
  assertEquals(other.head, row.text_head_hash);   // same template, different name
  assertEquals(other.tail, row.text_tail_hash);
});

Deno.test("external number skips our own lines and junk", () => {
  assertEquals(externalNumber(["+13605550100", "anonymous", "+13605550111"], OURS), "+13605550111");
  assertEquals(externalNumber(["blocked"], OURS), null);
});

Deno.test("quo final check: right host, GET, no body, no redirects", () => {
  const ok: RequestInit = { method: "GET", redirect: "error" };
  assertQuoRequest(new URL("https://api.quo.com/messages?limit=1"), ok);
  assertThrows(() => assertQuoRequest(new URL("https://api.openphone.com/v1/messages"), ok), QuoReadOnlyViolation);
  assertThrows(() => assertQuoRequest(new URL("https://api.quo.com/messages"), { ...ok, method: "POST" }), QuoReadOnlyViolation);
  assertThrows(() => assertQuoRequest(new URL("https://api.quo.com/messages"), { ...ok, body: "{}" }), QuoReadOnlyViolation);
  assertThrows(() => assertQuoRequest(new URL("https://api.quo.com/messages"), { method: "GET" }), QuoReadOnlyViolation);
  assertThrows(() => assertQuoRequest(new URL("https://api.quo.com/messages/AC1/retry"), ok), QuoReadOnlyViolation);
  assertThrows(() => assertQuoRequest(new URL("https://api.quo.com/calls/../messages/AC1/retry"), ok), QuoReadOnlyViolation);
});

// Tripwire: Quo can only be reached from the one read-only client. If anyone adds
// Quo access anywhere else, or a non-GET method to the client, this fails the deploy.
Deno.test("quo tripwire: no other code touches Quo", async () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const allowed = new Set(["supabase/functions/_shared/quo.ts", "supabase/functions/quo-sync/index.ts", "supabase/functions/tests/quo_test.ts", "README.md"]);
  const skip = /(^|\/)(node_modules|\.next|\.git)(\/|$)/;
  const hits: string[] = [];
  async function walk(dir: string) {
    for await (const e of Deno.readDir(root + dir)) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (skip.test(rel)) continue;
      if (e.isDirectory) { await walk(rel); continue; }
      if (!/\.(ts|tsx|js|mjs|cjs|sql|ya?ml|json|toml|sh)$/.test(e.name)) continue;
      const text = await Deno.readTextFile(root + rel);
      if (/api\.quo\.com|openphone\.com|QUO_API_KEY|_shared\/quo\.ts|_shared\/quo"/i.test(text) && !allowed.has(rel)) hits.push(rel);
    }
  }
  await walk("");
  assertEquals(hits, [], `Quo referenced outside the read-only client: ${hits.join(", ")}`);
  const client = await Deno.readTextFile(root + "supabase/functions/_shared/quo.ts");
  const methods = [...client.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
  assertEquals(methods, ["GET"], "the Quo client may only ever use GET");
  assert(!/\b(POST|PUT|PATCH|DELETE)\b"/.test(client.replace(/\/\/.*$/gm, "")), "no write methods in the Quo client");
});

Deno.test("review request texts are flagged (text itself isn't kept)", async () => {
  assert(isReviewRequest("Thanks again! Would you leave us a review? https://g.page/r/abc123/review"));
  assert(isReviewRequest("Review us here: https://search.google.com/local/writereview?placeid=XYZ"));
  assert(!isReviewRequest("See you Tuesday at 9"));
  const row = await mapMessage({ id: "AC9", direction: "outgoing", createdAt: "2026-10-01T16:00:00Z", to: ["+13605550124"],
    text: "Hi Pat, thanks for choosing Above! Mind leaving a quick review? https://g.page/r/abc/review", userId: "USkale" }, OURS);
  assert(row.is_review_request);
  assert(!JSON.stringify(row).includes("g.page"));
});
