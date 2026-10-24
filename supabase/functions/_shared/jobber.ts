// Jobber API client: token handling, throttling, read-only enforcement.
import { db } from "./db.ts";
import { assertReadOnly } from "./readonly_guard.ts";
import { PAGE_SIZE, QUERIES, type QueryName } from "./queries.ts";

/** Jobber refuses a request whose cost exceeds the whole budget; waiting won't help. */
export class QueryTooExpensive extends Error {}

const API = "https://api.getjobber.com/api/graphql";
const TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const VERSION = () => Deno.env.get("JOBBER_API_VERSION") ?? "2025-04-16";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} is not set in Supabase secrets`);
  return v;
}

// ---------------- tokens ----------------
export async function exchangeCode(code: string, verifier: string, redirectUri: string) {
  return await tokenRequest({
    grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri,
  });
}

async function tokenRequest(params: Record<string, string>) {
  const body = new URLSearchParams({
    client_id: env("JOBBER_CLIENT_ID"), client_secret: env("JOBBER_CLIENT_SECRET"), ...params,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Jobber token request failed: ${res.status} ${await res.text()}`);
  const t = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    access: t.access_token,
    refresh: t.refresh_token,
    expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000),
  };
}

export async function storeTokens(access: string, refresh: string, expiresAt: Date, accountId?: string, accountName?: string) {
  const sql = db();
  await sql`
    insert into private.integration_tokens (provider, access_token, refresh_token, expires_at, account_id, account_name)
    values ('jobber', ${access}, ${refresh}, ${expiresAt}, ${accountId ?? null}, ${accountName ?? null})
    on conflict (provider) do update set
      access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      account_id = coalesce(excluded.account_id, private.integration_tokens.account_id),
      account_name = coalesce(excluded.account_name, private.integration_tokens.account_name),
      updated_at = now()`;
}

async function accessToken(forceRefresh = false): Promise<string> {
  const sql = db();
  const [row] = await sql`select * from private.integration_tokens where provider = 'jobber'`;
  if (!row) throw new Error("Jobber is not connected yet. Run the Connect Jobber link first.");
  const expiringSoon = new Date(row.expires_at).getTime() - Date.now() < 5 * 60_000;
  if (!forceRefresh && !expiringSoon) return row.access_token;

  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: row.refresh_token });
  // With refresh-token rotation Jobber returns a new refresh token; always keep the latest.
  await storeTokens(t.access, t.refresh ?? row.refresh_token, t.expiresAt);
  return t.access;
}

// ---------------- requests ----------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Raw document sender. Only used for named queries and introspection. */
async function send(
  document: string, variables: Record<string, unknown>, attempt = 0, refreshed = false,
): Promise<any> {
  assertReadOnly(document);
  const token = await accessToken(refreshed);
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-JOBBER-GRAPHQL-VERSION": VERSION(),
    },
    body: JSON.stringify({ query: document, variables }),
  });
  // Expired token: refresh once, never more.
  if (res.status === 401 && !refreshed) return send(document, variables, attempt, true);
  if (res.status === 429 && attempt < 5) { await sleep(2 ** attempt * 2000); return send(document, variables, attempt + 1); }
  if (!res.ok) throw new Error(`Jobber API ${res.status}: ${await res.text()}`);

  const json = await res.json();
  const cost = json.extensions?.cost;
  const ts = cost?.throttleStatus;
  const requested = cost?.requestedQueryCost ?? 0;
  const throttled = json.errors?.some((e: any) => e?.extensions?.code === "THROTTLED");

  if (throttled) {
    if (ts && requested > ts.maximumAvailable) {
      throw new QueryTooExpensive(`request cost ${requested} > Jobber max ${ts.maximumAvailable}`);
    }
    // No cost details and still throttled after a few full refills: assume the request is too big.
    if (!ts && attempt >= 3) throw new QueryTooExpensive("throttled repeatedly without cost details");
    if (attempt >= 8) throw new Error("Jobber kept rate-limiting after 8 waits");
    // Wait exactly as long as the budget needs to refill (plus a little), else back off.
    const waitMs = ts && ts.restoreRate > 0
      ? Math.ceil((requested - ts.currentlyAvailable) / ts.restoreRate) * 1000 + 1000
      : 2 ** attempt * 2000;
    await sleep(Math.min(Math.max(waitMs, 1000), 60_000));
    return send(document, variables, attempt + 1);
  }
  if (json.errors?.length) throw new Error(`Jobber query error: ${JSON.stringify(json.errors).slice(0, 800)}`);

  // Be a polite neighbour: if the budget is getting low, let it refill before the next call.
  if (ts && ts.currentlyAvailable < requested * 2 && ts.restoreRate > 0) {
    await sleep(Math.ceil((requested * 2 - ts.currentlyAvailable) / ts.restoreRate) * 1000);
  }
  return json.data;
}

/** Look up which Jobber account a fresh token belongs to (before storing it). */
export async function accountFor(token: string): Promise<{ id: string; name: string }> {
  const document = QUERIES.account;
  assertReadOnly(document);
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": VERSION() },
    body: JSON.stringify({ query: document }),
  });
  const j = await res.json();
  if (!j.data?.account) throw new Error(`Could not read Jobber account: ${JSON.stringify(j).slice(0, 300)}`);
  return j.data.account;
}

/** Run one of the named, pre-written read queries. Arbitrary strings are not accepted. */
export function query(name: QueryName, variables: Record<string, unknown> = {}) {
  return send(QUERIES[name], variables);
}

/** Introspection, used by the schema check before any data is written. */
export function introspectType(typeName: string) {
  return send(
    `query T($n: String!) { __type(name: $n) { name fields { name args { name } } inputFields { name } } }`,
    { n: typeName },
  );
}

export type Page = { nodes: any[]; endCursor: string | null; hasNext: boolean };

/** Page through a connection, resuming from `startAfter` if given.
 *  If Jobber says a page is too expensive, the page size is halved and retried. */
export async function* pages(
  name: QueryName, root: string, variables: Record<string, unknown> = {}, startAfter: string | null = null,
): AsyncGenerator<Page> {
  let after = startAfter;
  let size = PAGE_SIZE[name] ?? 25;
  while (true) {
    let data: any;
    try {
      data = await query(name, { ...variables, first: size, after });
    } catch (e) {
      if (e instanceof QueryTooExpensive && size > 1) { size = Math.max(1, Math.floor(size / 2)); continue; }
      throw e;
    }
    const conn = data[root];
    const hasNext = !!conn.pageInfo.hasNextPage;
    yield { nodes: conn.nodes as any[], endCursor: conn.pageInfo.endCursor ?? null, hasNext };
    if (!hasNext) return;
    after = conn.pageInfo.endCursor;
  }
}
