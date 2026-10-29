// Read-only Google Sheets client for the Meta lead sheet.
// Two locks:
//  1. Google's: the service account is shared on the sheet as Viewer only, and the
//     token asks for the spreadsheets.readonly scope, so Google refuses any edit.
//  2. This file's: data requests are GET only, and only to the one spreadsheet
//     named in LEADS_SHEET_ID (its tab list, and reading cell values). The single
//     POST allowed is to Google's token endpoint, to swap a signed request for a
//     short-lived access token.

export class SheetsReadOnlyViolation extends Error {}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEETS_ORIGIN = "https://sheets.googleapis.com";

export function assertSheetsRequest(url: URL, init: RequestInit, sheetId: string): void {
  if (init.redirect !== "error") throw new SheetsReadOnlyViolation("Blocked: Sheets requests must refuse redirects.");
  if (url.href === TOKEN_URL) {
    if (init.method !== "POST") throw new SheetsReadOnlyViolation("Blocked: token endpoint is POST only.");
    return;
  }
  if (init.method !== "GET") throw new SheetsReadOnlyViolation(`Blocked: only GET requests may be sent to Google Sheets (got ${init.method}).`);
  if (init.body != null) throw new SheetsReadOnlyViolation("Blocked: Sheets requests may not carry a body.");
  if (["access_token", "$method", "key", "alt"].some((k) => url.searchParams.has(k))) {
    throw new SheetsReadOnlyViolation("Blocked: no tokens, keys or method overrides in the URL.");
  }
  if (!/^[A-Za-z0-9_-]{20,}$/.test(sheetId)) throw new SheetsReadOnlyViolation("Blocked: LEADS_SHEET_ID doesn't look like a spreadsheet id.");
  const base = `/v4/spreadsheets/${sheetId}`;
  const ok = url.origin === SHEETS_ORIGIN && (url.pathname === base || url.pathname === `${base}/values:batchGet`);
  if (!ok) throw new SheetsReadOnlyViolation(`Blocked: ${url.origin}${url.pathname} is not a read of the lead sheet.`);
}

// ---------- service account sign-in ----------
type ServiceAccount = { client_email: string; private_key: string };

const b64url = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function serviceAccount(): ServiceAccount {
  const raw = Deno.env.get("GOOGLE_SHEETS_SERVICE_ACCOUNT");
  if (!raw) throw new Error("GOOGLE_SHEETS_SERVICE_ACCOUNT is not set");
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SHEETS_SERVICE_ACCOUNT is missing client_email or private_key");
  return sa;
}

async function signedAssertion(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  return `${header}.${claims}.${b64url(sig)}`;
}

let cached: { token: string; until: number; email: string } | null = null;

async function accessToken(sheetId: string, fetcher: typeof fetch): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const sa = serviceAccount();
  const init: RequestInit = {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signedAssertion(sa) }),
  };
  assertSheetsRequest(new URL(TOKEN_URL), init, sheetId);
  const res = await fetcher(TOKEN_URL, init);
  const t = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed: ${res.status} ${t.error ?? ""} ${t.error_description ?? ""}`.trim());
  cached = { token: t.access_token, until: Date.now() + ((t.expires_in as number) ?? 3600) * 1000, email: sa.client_email };
  return cached.token;
}

export const serviceAccountEmail = () => serviceAccount().client_email;

async function sheetsGet(url: URL, sheetId: string, fetcher: typeof fetch = fetch, attempt = 0): Promise<any> {
  const init: RequestInit = { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${await accessToken(sheetId, fetcher)}`, Accept: "application/json" } };
  assertSheetsRequest(url, init, sheetId);
  const res = await fetcher(url, init);
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await res.body?.cancel(); await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    return sheetsGet(url, sheetId, fetcher, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = res.status === 403 ? ` (share the sheet with ${serviceAccountEmail()} as Viewer, and turn on the Google Sheets API)` : "";
    throw new Error(`Google Sheets failed: HTTP ${res.status} ${body?.error?.message ?? ""}${hint}`.trim());
  }
  return body;
}

export function tabsUrl(sheetId: string) {
  const u = new URL(`${SHEETS_ORIGIN}/v4/spreadsheets/${sheetId}`);
  u.searchParams.set("fields", "sheets.properties(title,gridProperties.rowCount)");
  return u;
}
export function valuesUrl(sheetId: string, tabs: string[]) {
  const u = new URL(`${SHEETS_ORIGIN}/v4/spreadsheets/${sheetId}/values:batchGet`);
  for (const t of tabs) u.searchParams.append("ranges", `'${t.replace(/'/g, "''")}'!A1:AZ`);
  u.searchParams.set("majorDimension", "ROWS");
  u.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  return u;
}

/** Every tab of the sheet with its rows (first row = headers). */
export async function readSheet(sheetId: string, fetcher: typeof fetch = fetch): Promise<{ tab: string; rows: string[][] }[]> {
  const meta = await sheetsGet(tabsUrl(sheetId), sheetId, fetcher);
  const tabs: string[] = (meta.sheets ?? []).map((s: any) => String(s.properties?.title ?? "")).filter(Boolean);
  const out: { tab: string; rows: string[][] }[] = [];
  for (let i = 0; i < tabs.length; i += 20) {
    const part = tabs.slice(i, i + 20);
    const v = await sheetsGet(valuesUrl(sheetId, part), sheetId, fetcher);
    (v.valueRanges ?? []).forEach((r: any, k: number) => out.push({ tab: part[k], rows: (r.values ?? []) as string[][] }));
  }
  return out;
}

// ---------- mapping Meta's lead columns ----------
const NEEDED = ["id", "created_time", "ad_id", "phone_number"];
const strip = (v: string | undefined) => (v ?? "").trim().replace(/^[a-z]{1,3}:/i, "").trim() || null;   // "ag:123" -> "123"

/** "p:+1 (360) 555-1234" -> "+13605551234"; null when it isn't a usable US/intl number. */
export function normalizePhone(v: string | undefined): string | null {
  const s = strip(v);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function isLeadTab(rows: string[][]): boolean {
  const h = (rows[0] ?? []).map((c) => String(c).trim().toLowerCase());
  return NEEDED.every((k) => h.includes(k));
}

/** Rows of one tab -> lead records. Only the fields the dashboard needs: no names or emails. */
export function mapLeadRows(tab: string, rows: string[][]) {
  if (!isLeadTab(rows)) return [];
  const h = rows[0].map((c) => String(c).trim().toLowerCase());
  const col = (r: string[], k: string) => { const i = h.indexOf(k); return i >= 0 ? r[i] : undefined; };
  const out = [];
  for (const r of rows.slice(1)) {
    const id = strip(col(r, "id"));
    const created = (col(r, "created_time") ?? "").trim();
    const when = created ? new Date(created) : null;
    if (!id || !when || isNaN(when.getTime())) continue;
    const organic = (col(r, "is_organic") ?? "").trim().toLowerCase();
    out.push({
      id,
      created_at: when.toISOString(),
      phone: normalizePhone(col(r, "phone_number")),
      ad_id: strip(col(r, "ad_id")),
      ad_name: (col(r, "ad_name") ?? "").trim() || null,
      adset_name: (col(r, "adset_name") ?? "").trim() || null,
      campaign_id: strip(col(r, "campaign_id")),
      campaign_name: (col(r, "campaign_name") ?? "").trim() || null,
      form_name: (col(r, "form_name") ?? "").trim() || null,
      platform: (col(r, "platform") ?? "").trim() || null,
      is_organic: organic === "true" ? true : organic === "false" ? false : null,
      sheet_tab: tab,
      synced_at: new Date().toISOString(),
    });
  }
  return out;
}
