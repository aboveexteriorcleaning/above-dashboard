// Jobber sends the owner back here after "Allow Access".
import { db } from "../_shared/db.ts";
import { accountFor, exchangeCode, storeTokens } from "../_shared/jobber.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (msg: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h2>Above Dashboard</h2><p>${msg}</p></body>`, { status, headers: { "Content-Type": "text/html" } });

Deno.serve(async (req) => {
  const p = new URL(req.url).searchParams;
  const code = p.get("code"), state = p.get("state");
  if (!code || !state) return page("Missing code. Start again from the Connect Jobber link.", 400);

  const sql = db();
  const [row] = await sql`
    delete from private.oauth_states
    where state = ${state} and created_at > now() - interval '15 minutes'
    returning code_verifier`;
  if (!row) return page("This link expired or was already used. Start again from the Connect Jobber link.", 400);

  try {
    const redirect = `${Deno.env.get("SUPABASE_URL")}/functions/v1/jobber-oauth-callback`;
    const t = await exchangeCode(code, row.code_verifier, redirect);
    const account = await accountFor(t.access);

    // Lock to the first account ever connected. Prevents anyone from swapping in another Jobber account.
    const [existing] = await sql`select account_id, account_name from private.integration_tokens where provider = 'jobber'`;
    if (existing?.account_id && existing.account_id !== account.id) {
      return page(`Refused: this dashboard is linked to <b>${esc(existing.account_name ?? "another account")}</b>, not <b>${esc(account.name)}</b>.`, 409);
    }
    if (!t.refresh) throw new Error("Jobber did not return a refresh token");
    await storeTokens(t.access, t.refresh, t.expiresAt, account.id, account.name);
    return page(`Connected to <b>${esc(account.name)}</b> with read-only access. You can close this tab.`);
  } catch (e) {
    return page(`Something went wrong: ${esc((e as Error).message)}`, 500);
  }
});
