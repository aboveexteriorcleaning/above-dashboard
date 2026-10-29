// Read-only Google Sheets client for the Meta lead sheet.
// Two locks:
//  1. Google's: access is granted with the spreadsheets.readonly scope only (an owner
//     signs in once through google-connect?for=sheets, or a service account shared as
//     Viewer), so Google refuses any edit to any sheet.
//  2. This file's: data requests are GET only, and only to the one spreadsheet
//     named in LEADS_SHEET_ID (its tab list, and reading cell values). The single
//     POST allowed is to Google's token endpoint, to swap a signed request for a
//     short-lived access token.

import { db } from "./db.ts";

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

// ---------- sign-in: an owner's read-only Google login, or a service account ----------
type ServiceAccount = { client_email: string; private_key: string };

const b64url = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function serviceAccount(): ServiceAccount | null {
  const raw = Deno.env.get("GOOGLE_SHEETS_SERVICE_ACCOUNT");
  if (!raw) return null;
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

let cached: { token: string; until: number } | null = null;

/** The owner's stored read-only Google login (from google-connect?for=sheets), if any. */
async function storedLogin(): Promise<{ refresh_token: string; account_name: string | null } | null> {
  const [row] = await db()`select refresh_token, account_name from private.integration_tokens where provider = 'google_sheets'`;
  return row ? { refresh_token: row.refresh_token, account_name: row.account_name } : null;
}

export async function sheetsConnected(): Promise<boolean> {
  return !!serviceAccount() || !!(await storedLogin());
}

/** Who the sheet is read as, for the check result and error hints. */
export async function readingAs(): Promise<string> {
  const sa = serviceAccount();
  if (sa) return sa.client_email;
  return (await storedLogin())?.account_name ?? "the connected Google account";
}

async function accessToken(sheetId: string, fetcher: typeof fetch): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const sa = serviceAccount();
  let params: Record<string, string>;
  if (sa) {
    params = { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signedAssertion(sa) };
  } else {
    const login = await storedLogin();
    if (!login) throw new Error("Google Sheets isn't connected yet (open google-connect?for=sheets)");
    const id = Deno.env.get("GOOGLE_CLIENT_ID"), secret = Deno.env.get("GOOGLE_CLIENT_SECRET");
    if (!id || !secret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set");
    params = { grant_type: "refresh_token", refresh_token: login.refresh_token, client_id: id, client_secret: secret };
  }
  const init: RequestInit = {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  };
  assertSheetsRequest(new URL(TOKEN_URL), init, sheetId);
  const res = await fetcher(TOKEN_URL, init);
  const t = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed: ${res.status} ${t.error ?? ""} ${t.error_description ?? ""}`.trim());
  if (!sa && t.scope && !String(t.scope).split(" ").every((s: string) => s === SHEETS_SCOPE)) {
    throw new Error("Refused: the Google login has more than read-only Sheets access. Reconnect with google-connect?for=sheets.");
  }
  cached = { token: t.access_token, until: Date.now() + ((t.expires_in as number) ?? 3600) * 1000 };
  return cached.token;
}

/** Saves the owner's read-only Sheets login (no network call). */
export async function storeSheetsLogin(access: string, refresh: string, expiresAt: Date, accountName: string) {
  await db()`
    insert into private.integration_tokens (provider, access_token, refresh_token, expires_at, account_id, account_name)
    values ('google_sheets', ${access}, ${refresh}, ${expiresAt}, 'sheets', ${accountName})
    on conflict (provider) do update set access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at, account_name = excluded.account_name, updated_at = now()`;
}

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
    const hint = res.status === 403 ? ` (make sure ${await readingAs()} can open the sheet, and the Google Sheets API is turned on)` : "";
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
