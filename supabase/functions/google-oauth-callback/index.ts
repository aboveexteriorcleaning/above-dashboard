// Google sends the owner back here after "Allow access".
import { db } from "../_shared/db.ts";
import { accountsUrl, exchangeCode, googleGet, storeGoogleTokens } from "../_shared/google.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (msg: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h2>Above Dashboard</h2><p>${msg}</p></body>`, { status, headers: { "Content-Type": "text/html" } });

Deno.serve(async (req) => {
  const p = new URL(req.url).searchParams;
  if (p.get("error")) return page(`Google said: ${esc(p.get("error") ?? "")}. Nothing was connected.`, 400);
  const code = p.get("code"), state = p.get("state");
  if (!code || !state) return page("Missing code. Start again from the Connect Google link.", 400);

  const sql = db();
  const [row] = await sql`
    delete from private.oauth_states
    where state = ${state} and provider = 'google' and created_at > now() - interval '15 minutes'
    returning code_verifier`;
  if (!row) return page("This link expired or was already used. Start again from the Connect Google link.", 400);

  try {
    const t = await exchangeCode(code, row.code_verifier, `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-oauth-callback`);
    if (!t.refresh) throw new Error("Google did not return a refresh token");
    const accounts = (await googleGet(accountsUrl(), t.access)).accounts ?? [];
    if (!accounts.length) return page("This Google account doesn't manage any Business Profiles. Sign in with the account that owns Above's profile.", 400);
    const acct = accounts[0];
    const accountId = String(acct.name ?? "");             // "accounts/123"
    const accountName = String(acct.accountName ?? "Business Profile");
    // Lock to the first account ever connected.
    const [existing] = await sql`select account_id, account_name from private.integration_tokens where provider = 'google'`;
    if (existing?.account_id && existing.account_id !== accountId) {
      return page(`Refused: this dashboard is linked to <b>${esc(existing.account_name ?? "another account")}</b>, not <b>${esc(accountName)}</b>.`, 409);
    }
    await storeGoogleTokens(t.access, t.refresh, t.expiresAt, accountId, accountName);
    return page(`Connected to <b>${esc(accountName)}</b>. The dashboard only reads reviews. You can close this tab.`);
  } catch (e) {
    return page(`Something went wrong: ${esc((e as Error).message)}`, 500);
  }
});
