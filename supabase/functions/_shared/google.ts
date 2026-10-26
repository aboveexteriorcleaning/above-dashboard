// Read-only Google Business Profile client (reviews).
// Google has no read-only permission for Business Profile, so this file is the
// lock: data requests are GET only, and only to these three paths:
//   list your accounts, list your locations, list a location's reviews.
// The single POST allowed is to Google's sign-in token endpoint (to turn the
// one-time code / refresh token into a short-lived access token). Nothing here
// can reply to reviews, edit the profile, or post anything.
import { db } from "./db.ts";

export class GoogleReadOnlyViolation extends Error {}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPE = "https://www.googleapis.com/auth/business.manage";

const READ_RULES: { origin: string; path: RegExp }[] = [
  { origin: "https://mybusinessaccountmanagement.googleapis.com", path: /^\/v1\/accounts$/ },
  { origin: "https://mybusinessbusinessinformation.googleapis.com", path: /^\/v1\/accounts\/\d+\/locations$/ },
  { origin: "https://mybusiness.googleapis.com", path: /^\/v4\/accounts\/\d+\/locations\/\d+\/reviews$/ },
  // Places API: public listing details (rating, review count, newest reviews) for one place.
  { origin: "https://places.googleapis.com", path: /^\/v1\/places\/[A-Za-z0-9_-]+$/ },
];

export function assertGoogleRequest(url: URL, init: RequestInit): void {
  if (init.redirect !== "error") throw new GoogleReadOnlyViolation("Blocked: Google requests must refuse redirects.");
  if (url.href === TOKEN_URL) {
    if (init.method !== "POST") throw new GoogleReadOnlyViolation("Blocked: token endpoint is POST only.");
    return;
  }
  if (init.method !== "GET") throw new GoogleReadOnlyViolation(`Blocked: only GET requests may be sent to Google (got ${init.method}).`);
  if (init.body != null) throw new GoogleReadOnlyViolation("Blocked: Google requests may not carry a body.");
  if (url.searchParams.has("access_token") || url.searchParams.has("$method") || url.searchParams.has("key")) throw new GoogleReadOnlyViolation("Blocked: no tokens or method overrides in the URL.");
  const ok = READ_RULES.some((r) => r.origin === url.origin && r.path.test(url.pathname));
  if (!ok) throw new GoogleReadOnlyViolation(`Blocked: ${url.origin}${url.pathname} is not a read-only reviews path.`);
}

const env = (k: string) => { const v = Deno.env.get(k); if (!v) throw new Error(`${k} is not set`); return v; };

async function tokenRequest(params: Record<string, string>, fetcher: typeof fetch = fetch) {
  const init: RequestInit = {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), ...params }),
  };
  assertGoogleRequest(new URL(TOKEN_URL), init);
  const res = await fetcher(TOKEN_URL, init);
  const t = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed: ${res.status} ${t.error ?? ""} ${t.error_description ?? ""}`.trim());
  return { access: t.access_token as string, refresh: t.refresh_token as string | undefined,
           expiresAt: new Date(Date.now() + ((t.expires_in as number) ?? 3600) * 1000), scope: t.scope as string | undefined };
}

export const exchangeCode = (code: string, verifier: string, redirectUri: string) =>
  tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });

async function accessToken(force = false): Promise<string> {
  const sql = db();
  const [row] = await sql`select * from private.integration_tokens where provider = 'google'`;
  if (!row) throw new Error("Google isn't connected yet (open the google-connect link)");
  if (!force && new Date(row.expires_at).getTime() > Date.now() + 120_000) return row.access_token;
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: row.refresh_token });
  await sql`update private.integration_tokens set access_token = ${t.access}, expires_at = ${t.expiresAt}, updated_at = now()
            where provider = 'google'`;
  return t.access;
}

export async function storeGoogleTokens(access: string, refresh: string, expiresAt: Date, accountId: string, accountName: string) {
  await db()`
    insert into private.integration_tokens (provider, access_token, refresh_token, expires_at, account_id, account_name)
    values ('google', ${access}, ${refresh}, ${expiresAt}, ${accountId}, ${accountName})
    on conflict (provider) do update set access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at, updated_at = now()`;
}

/** One read. `token` lets the OAuth callback read accounts with a brand-new token. */
export async function googleGet(url: URL, token?: string, fetcher: typeof fetch = fetch, attempt = 0): Promise<any> {
  const bearer = token ?? await accessToken(attempt > 0);
  const init: RequestInit = { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" } };
  assertGoogleRequest(url, init);
  const res = await fetcher(url, init);
  if (res.status === 401 && !token && attempt === 0) { await res.body?.cancel(); return googleGet(url, undefined, fetcher, 1); }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await res.body?.cancel(); await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    return googleGet(url, token, fetcher, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google ${url.pathname} failed: HTTP ${res.status} ${body?.error?.message ?? ""}`.trim());
  return body;
}

export const accountsUrl = () => new URL("https://mybusinessaccountmanagement.googleapis.com/v1/accounts");
export function locationsUrl(accountNum: string, pageToken?: string) {
  const u = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${accountNum}/locations`);
  u.searchParams.set("readMask", "name,title,storefrontAddress");
  u.searchParams.set("pageSize", "100");
  if (pageToken) u.searchParams.set("pageToken", pageToken);
  return u;
}
export function reviewsUrl(accountNum: string, locationNum: string, pageToken?: string) {
  const u = new URL(`https://mybusiness.googleapis.com/v4/accounts/${accountNum}/locations/${locationNum}/reviews`);
  u.searchParams.set("pageSize", "50");
  u.searchParams.set("orderBy", "updateTime desc");
  if (pageToken) u.searchParams.set("pageToken", pageToken);
  return u;
}

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
export function mapReview(r: any, locationNum: string) {
  return {
    id: String(r.reviewId ?? r.name),
    location_id: locationNum,
    stars: STARS[r.starRating] ?? null,
    reviewer_name: r.reviewer?.isAnonymous ? null : (r.reviewer?.displayName ?? null),
    comment: r.comment ?? null,
    created_at: r.createTime,
    updated_at: r.updateTime ?? r.createTime,
    replied_at: r.reviewReply?.updateTime ?? null,
    synced_at: new Date().toISOString(),
  };
}

// ---------------- Places API (API key; public data only, cannot change anything) ----------------
export const PLACE_FIELDS = "id,displayName,rating,userRatingCount,reviews";
export function placeUrl(placeId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(placeId)) throw new GoogleReadOnlyViolation("Blocked: that doesn't look like a Place ID.");
  return new URL(`https://places.googleapis.com/v1/places/${placeId}`);
}
export async function placesGet(placeId: string, fetcher: typeof fetch = fetch, attempt = 0): Promise<any> {
  const url = placeUrl(placeId);
  const init: RequestInit = { method: "GET", redirect: "error",
    headers: { "X-Goog-Api-Key": env("GOOGLE_PLACES_API_KEY"), "X-Goog-FieldMask": PLACE_FIELDS, Accept: "application/json" } };
  assertGoogleRequest(url, init);
  const res = await fetcher(url, init);
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await res.body?.cancel(); await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    return placesGet(placeId, fetcher, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Places failed: HTTP ${res.status} ${body?.error?.message ?? ""}`.trim());
  return body;
}
export function mapPlaceReview(r: any, placeId: string) {
  const when = r.publishTime ?? null;
  return {
    id: String(r.name ?? `${placeId}:${r.authorAttribution?.displayName}:${when}`),
    location_id: placeId,
    stars: typeof r.rating === "number" ? Math.round(r.rating) : null,
    reviewer_name: r.authorAttribution?.displayName ?? null,
    comment: r.originalText?.text ?? r.text?.text ?? null,
    created_at: when,
    updated_at: when,
    replied_at: null,
    synced_at: new Date().toISOString(),
  };
}
