import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { assertGoogleRequest, GoogleReadOnlyViolation, mapPlaceReview, mapReview, placeUrl, placesGet, reviewsUrl } from "../_shared/google.ts";

const GET: RequestInit = { method: "GET", redirect: "error" };
Deno.test("google guard: GET only, three read paths only", () => {
  assertGoogleRequest(new URL("https://mybusinessaccountmanagement.googleapis.com/v1/accounts"), GET);
  assertGoogleRequest(new URL("https://mybusinessbusinessinformation.googleapis.com/v1/accounts/123/locations?readMask=name"), GET);
  assertGoogleRequest(reviewsUrl("123", "456"), GET);
  assertGoogleRequest(new URL("https://oauth2.googleapis.com/token"), { method: "POST", redirect: "error", body: "x" });
  const bad: [string, RequestInit][] = [
    ["https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews/789/reply", GET],          // replying
    ["https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews/789/reply", { ...GET, method: "PUT" }],
    ["https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews", { ...GET, method: "POST" }],
    ["https://mybusinessbusinessinformation.googleapis.com/v1/locations/456", { ...GET, method: "PATCH" }], // editing the profile
    ["https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts", GET],
    ["https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews?$method=PUT", GET],
    ["https://evil.example.com/v1/accounts", GET],
    ["https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews", { method: "GET" }],       // must refuse redirects
    ["https://oauth2.googleapis.com/revoke", { method: "POST", redirect: "error" }],
  ];
  for (const [u, init] of bad) assertThrows(() => assertGoogleRequest(new URL(u), init), GoogleReadOnlyViolation, undefined, u);
});

Deno.test("google reviews map to stars and dates", () => {
  const r = mapReview({ reviewId: "R1", starRating: "FIVE", reviewer: { displayName: "Jane D." }, comment: "Great job",
    createTime: "2026-10-20T18:00:00Z", updateTime: "2026-10-20T18:00:00Z", reviewReply: { comment: "Thanks!", updateTime: "2026-10-21T00:00:00Z" } }, "456");
  assertEquals([r.id, r.stars, r.reviewer_name, r.replied_at], ["R1", 5, "Jane D.", "2026-10-21T00:00:00Z"]);
  assertEquals(mapReview({ reviewId: "R2", starRating: "THREE", reviewer: { isAnonymous: true, displayName: "A Google user" }, createTime: "2026-10-01T00:00:00Z" }, "456").reviewer_name, null);
});

Deno.test("google tripwire: no other code touches Google's APIs", async () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const allowed = new Set(["supabase/functions/_shared/google.ts", "supabase/functions/google-connect/index.ts",
    "supabase/functions/google-oauth-callback/index.ts", "supabase/functions/google-sync/index.ts", "supabase/functions/tests/google_test.ts"]);
  const hits: string[] = [];
  async function walk(dir: string) {
    for await (const e of Deno.readDir(root + dir)) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (/(^|\/)(node_modules|\.next|\.git)(\/|$)/.test(rel)) continue;
      if (e.isDirectory) { await walk(rel); continue; }
      if (!/\.(ts|tsx|js|mjs|cjs|sql|ya?ml|json|toml|sh)$/.test(e.name)) continue;
      const t = await Deno.readTextFile(root + rel);
      if (/googleapis\.com|accounts\.google\.com|GOOGLE_CLIENT_SECRET|_shared\/google(\.ts)?"/.test(t) && !allowed.has(rel)) hits.push(rel);
    }
  }
  await walk("");
  assertEquals(hits, [], `Google referenced outside the read-only client: ${hits.join(", ")}`);
  const client = await Deno.readTextFile(root + "supabase/functions/_shared/google.ts");
  const methods = [...client.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
  assertEquals([...new Set(methods)].sort(), ["GET", "POST"], "only GET reads plus the token POST");
  assertEquals(methods.filter((m) => m === "POST").length, 1, "exactly one POST: the sign-in token request");
  assert(/TOKEN_URL[\s\S]*method:\s*"POST"/.test(client));
});

Deno.test("places: GET one place, key in a header, nothing else", async () => {
  assertGoogleRequest(placeUrl("ChIJabc123_-x"), GET);
  for (const [u, init] of [
    ["https://places.googleapis.com/v1/places:searchText", { ...GET, method: "POST" }],
    ["https://places.googleapis.com/v1/places/ChIJabc/photos/x/media", GET],
    ["https://places.googleapis.com/v1/places/ChIJabc?key=AIza", GET],
    ["https://places.googleapis.com/v1/places/ChIJabc", { ...GET, method: "PATCH" }],
  ] as [string, RequestInit][]) assertThrows(() => assertGoogleRequest(new URL(u), init), GoogleReadOnlyViolation, undefined, u);
  assertThrows(() => placeUrl("../accounts"), GoogleReadOnlyViolation);
  Deno.env.set("GOOGLE_PLACES_API_KEY", "AIzaTEST");
  let seen: Request | null = null;
  const fake = (async (url: URL, init: RequestInit) => { seen = new Request(url, init); return new Response(JSON.stringify({ rating: 4.9 }), { status: 200 }); }) as unknown as typeof fetch;
  const p = await placesGet("ChIJabc", fake);
  assertEquals(p.rating, 4.9);
  assertEquals(seen!.method, "GET");
  assertEquals(seen!.headers.get("X-Goog-Api-Key"), "AIzaTEST");
  assert(!seen!.url.includes("AIza"));
});

Deno.test("places reviews map to stars, name and date", () => {
  const r = mapPlaceReview({ name: "places/X/reviews/R9", rating: 5, text: { text: "Great" }, originalText: { text: "Great!" },
    authorAttribution: { displayName: "Jane Doe" }, publishTime: "2026-10-20T18:00:00Z" }, "X");
  assertEquals([r.id, r.stars, r.reviewer_name, r.comment, r.created_at, r.replied_at], ["places/X/reviews/R9", 5, "Jane Doe", "Great!", "2026-10-20T18:00:00Z", null]);
});
