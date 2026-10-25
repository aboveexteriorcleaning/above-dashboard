import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { assertQuoReadOnly, quoGet, QuoReadOnlyViolation } from "../_shared/quo.ts";
import { externalNumber, mapCall, mapMessage, textFingerprints } from "../_shared/quo_map.ts";

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
