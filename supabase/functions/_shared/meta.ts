// Read-only Meta (Facebook/Instagram ads) client. The token itself only has the
// ads_read permission; this file is a second lock: it only sends GET requests,
// only to Meta's Graph API, and only to your one ad account and its results.

export class MetaReadOnlyViolation extends Error {}
export class MetaError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const ORIGIN = "https://graph.facebook.com";
export const VERSION = "v26.0";

function accountId(): string {
  const raw = (Deno.env.get("META_AD_ACCOUNT_ID") ?? "").replace(/^act_/, "").trim();
  if (!/^\d{5,20}$/.test(raw)) throw new MetaError(0, "META_AD_ACCOUNT_ID is not set (digits only)");
  return raw;
}

/** The only two paths this code may read: the ad account's basic details, and its results. */
export function allowedPaths(acct: string): string[] {
  return [`/${VERSION}/act_${acct}`, `/${VERSION}/act_${acct}/insights`];
}

export function assertMetaRequest(url: URL, init: RequestInit, acct: string): void {
  if (url.origin !== ORIGIN) throw new MetaReadOnlyViolation(`Blocked: ${url.origin} is not Meta's Graph API.`);
  if (!allowedPaths(acct).includes(url.pathname)) throw new MetaReadOnlyViolation(`Blocked: ${url.pathname} is not a read-only ad results path.`);
  if (init.method !== "GET") throw new MetaReadOnlyViolation(`Blocked: only GET requests may be sent to Meta (got ${init.method}).`);
  if (init.body != null) throw new MetaReadOnlyViolation("Blocked: Meta requests may not carry a body.");
  if (init.redirect !== "error") throw new MetaReadOnlyViolation("Blocked: Meta requests must refuse redirects.");
  if (url.searchParams.has("access_token")) throw new MetaReadOnlyViolation("Blocked: the token goes in a header, never the URL.");
  if (url.searchParams.has("method")) throw new MetaReadOnlyViolation("Blocked: method override is not allowed.");
}

type Params = Record<string, string | number | undefined>;

export async function metaGet(sub: "" | "/insights", params: Params = {}, fetcher: typeof fetch = fetch): Promise<any> {
  const token = Deno.env.get("META_ACCESS_TOKEN");
  if (!token) throw new MetaError(0, "META_ACCESS_TOKEN is not set");
  const acct = accountId();
  const url = new URL(`${ORIGIN}/${VERSION}/act_${acct}${sub}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const init: RequestInit = { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } };
    assertMetaRequest(url, init, acct);
    const res = await fetcher(url, init);
    const body = await res.json().catch(() => ({}));
    if (res.ok && !body.error) return body;
    const code = body?.error?.code;
    // 4/17/32/613 = rate limits; 1/2 = temporary Meta errors
    const retryable = res.status >= 500 || [1, 2, 4, 17, 32, 613].includes(code);
    if (retryable && attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    throw new MetaError(res.status, `Meta ${sub || "account"} failed: HTTP ${res.status} ${body?.error?.message ?? ""}`.trim());
  }
}

/** All pages of an insights query, following Meta's "after" cursor. */
export async function* metaInsights(params: Params, fetcher: typeof fetch = fetch) {
  let after: string | undefined;
  do {
    const page = await metaGet("/insights", { ...params, limit: 500, after }, fetcher);
    yield (page.data ?? []) as any[];
    after = page.paging?.next ? page.paging?.cursors?.after : undefined;
  } while (after);
}

const LEAD_TYPES = ["lead", "onsite_conversion.lead_grouped", "leadgen_grouped", "offsite_conversion.fb_pixel_lead"];

/** Meta's lead count for a row: the first lead action type present, in order of preference. */
export function leadsFrom(actions: { action_type: string; value: string }[] | undefined): number {
  for (const t of LEAD_TYPES) {
    const a = actions?.find((x) => x.action_type === t);
    if (a) return Math.round(Number(a.value) || 0);
  }
  return 0;
}

export function mapInsight(r: any) {
  return {
    day: r.date_start,
    campaign_id: r.campaign_id ?? "unknown",
    campaign_name: r.campaign_name ?? null,
    adset_id: r.adset_id ?? null,
    adset_name: r.adset_name ?? null,
    ad_id: r.ad_id ?? `campaign:${r.campaign_id ?? "unknown"}`,
    ad_name: r.ad_name ?? null,
    spend: Number(r.spend ?? 0),
    impressions: Math.round(Number(r.impressions ?? 0)),
    clicks: Math.round(Number(r.clicks ?? 0)),
    link_clicks: Math.round(Number(r.inline_link_clicks ?? 0)),
    reach: r.reach == null ? null : Math.round(Number(r.reach)),
    meta_leads: leadsFrom(r.actions),
    synced_at: new Date().toISOString(),
  };
}

export const INSIGHT_FIELDS = [
  "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
  "spend", "impressions", "clicks", "inline_link_clicks", "reach", "actions",
].join(",");
