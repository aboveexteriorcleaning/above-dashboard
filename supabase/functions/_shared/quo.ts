// Read-only Quo client. Quo API keys can't be limited to reading, so this file
// is the lock: it can only send GET requests, only to these four list endpoints.
// There is no code anywhere in this project that sends texts, places calls, or
// edits anything in Quo.

export class QuoReadOnlyViolation extends Error {}

const BASE = "https://api.quo.com";
const VERSION = "2026-03-30";
export const ALLOWED_PATHS = ["/calls", "/messages", "/users", "/phone-numbers"] as const;
export type QuoPath = typeof ALLOWED_PATHS[number];

export function assertQuoReadOnly(method: string, path: string): void {
  if (method !== "GET") throw new QuoReadOnlyViolation(`Blocked: only GET requests may be sent to Quo (got ${method}).`);
  if (!(ALLOWED_PATHS as readonly string[]).includes(path)) {
    throw new QuoReadOnlyViolation(`Blocked: ${path} is not one of the read-only list endpoints.`);
  }
}

/** Final check on the exact request about to leave: Quo's host, an allowed list path, GET, no body. */
export function assertQuoRequest(url: URL, init: RequestInit): void {
  if (url.origin !== BASE) throw new QuoReadOnlyViolation(`Blocked: ${url.origin} is not Quo's API.`);
  assertQuoReadOnly(String(init.method ?? ""), url.pathname);
  if (init.body != null) throw new QuoReadOnlyViolation("Blocked: Quo requests may not carry a body.");
  if (init.redirect !== "error") throw new QuoReadOnlyViolation("Blocked: Quo requests must refuse redirects.");
}

export class QuoError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Params = Record<string, string | number | undefined>;

/** One GET, with backoff on 429 / 5xx. Never logs response bodies (they hold customer data). */
export async function quoGet(path: QuoPath, params: Params = {}, fetcher: typeof fetch = fetch): Promise<any> {
  assertQuoReadOnly("GET", path);
  const key = Deno.env.get("QUO_API_KEY");
  if (!key) throw new QuoError(0, "QUO_API_KEY is not set");
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const init: RequestInit = {
      method: "GET",
      redirect: "error",   // never follow Quo somewhere else with the key attached
      headers: { Authorization: key, "Quo-Api-Version": VERSION, Accept: "application/json" },
    };
    assertQuoRequest(url, init);
    const res = await fetcher(url, init);
    if (res.ok) return await res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 5) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, Math.min(8000, 400 * 2 ** attempt) + Math.random() * 250));
      continue;
    }
    let title = "";
    try { const b = await res.json(); title = b?.title ?? b?.message ?? ""; } catch { /* ignore */ }
    throw new QuoError(res.status, `Quo ${path} failed: HTTP ${res.status} ${title}`.trim());
  }
}

/** Newest-first pages. Stops when a page has nothing newer than `stopBefore`. */
export async function* quoPages(path: QuoPath, params: Params, fetcher: typeof fetch = fetch) {
  let after: string | undefined;
  do {
    const page = await quoGet(path, { ...params, limit: 50, after }, fetcher);
    yield (page.data ?? []) as any[];
    after = page.nextCursor ?? undefined;
  } while (after);
}
