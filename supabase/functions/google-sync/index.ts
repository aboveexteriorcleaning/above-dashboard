// Google reviews sync, read-only.
//   POST ?mode=check   -> list the connected account's locations (names only); saves nothing
//   POST (default)     -> read reviews (all on the first run, then the newest until nothing has changed)
// Requires header  x-sync-key: <SYNC_KEY secret>.
import { db, upsert } from "../_shared/db.ts";
import { googleGet, locationsUrl, mapReview, reviewsUrl } from "../_shared/google.ts";
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
  const mode = new URL(req.url).searchParams.get("mode") ?? "incremental";
  try {
    const sql = db();
    const [tok] = await sql`select account_id from private.integration_tokens where provider = 'google'`;
    if (!tok) return json({ ok: true, skipped: "Google isn't connected yet" });
    const accountNum = String(tok.account_id).replace(/^accounts\//, "");
    const locations = await listLocations(accountNum);
    if (mode === "check") {
      return json({ ok: true, locations: locations.map((l) => ({ id: l.num, title: l.title, city: l.city })) });
    }
    const only = Deno.env.get("GOOGLE_LOCATION_ID");
    const targets = only ? locations.filter((l) => l.num === only) : locations;
    const out: Record<string, unknown> = {};
    for (const loc of targets) out[loc.title ?? loc.num] = await syncLocation(accountNum, loc.num);
    await sql`select app.refresh_reviews()`;
    await markSync("google", true);
    return json({ ok: true, done: true, locations: out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markSync("google", false, msg).catch(() => {});
    return json({ ok: false, error: msg }, 500);
  }
});

async function listLocations(accountNum: string) {
  const out: { num: string; title: string | null; city: string | null }[] = [];
  let token: string | undefined;
  do {
    const page = await googleGet(locationsUrl(accountNum, token));
    for (const l of page.locations ?? []) {
      out.push({ num: String(l.name).replace(/^locations\//, ""), title: l.title ?? null, city: l.storefrontAddress?.locality ?? null });
    }
    token = page.nextPageToken;
  } while (token);
  return out;
}

async function syncLocation(accountNum: string, locationNum: string) {
  const sql = db();
  const [last] = await sql`select max(updated_at) t from public.google_reviews where location_id = ${locationNum}`;
  const since = last?.t ? new Date(last.t).toISOString() : null;
  let token: string | undefined, saved = 0, average: number | null = null, total: number | null = null;
  do {
    const page = await googleGet(reviewsUrl(accountNum, locationNum, token));
    average = page.averageRating ?? average; total = page.totalReviewCount ?? total;
    const rows = (page.reviews ?? []).map((r: any) => mapReview(r, locationNum)).filter((r: any) => r.created_at);
    await upsert("public.google_reviews", rows);
    saved += rows.length;
    // Newest-updated first: stop once we reach reviews we already have unchanged.
    if (since && rows.some((r: any) => r.updated_at <= since)) break;
    token = page.nextPageToken;
  } while (token);
  await sql`insert into public.google_review_totals (location_id, average_rating, total_reviews, updated_at)
            values (${locationNum}, ${average}, ${total}, now())
            on conflict (location_id) do update set average_rating = excluded.average_rating,
              total_reviews = excluded.total_reviews, updated_at = now()`;
  return { saved, average, total };
}
