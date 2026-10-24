// One-time: sends an owner to Jobber's "Allow Access" screen.
// Link: <project>/functions/v1/jobber-connect?key=<JOBBER_SETUP_KEY>
import { db } from "../_shared/db.ts";
import { challengeFor, randomString, safeEqual } from "../_shared/pkce.ts";

Deno.serve(async (req) => {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  const expected = Deno.env.get("JOBBER_SETUP_KEY") ?? "";
  if (!expected || !safeEqual(key, expected)) return new Response("Forbidden", { status: 403 });

  const state = randomString(24);
  const verifier = randomString(48);
  const sql = db();
  await sql`delete from private.oauth_states where created_at < now() - interval '15 minutes'`;
  await sql`insert into private.oauth_states (state, code_verifier) values (${state}, ${verifier})`;

  const redirect = `${Deno.env.get("SUPABASE_URL")}/functions/v1/jobber-oauth-callback`;
  const url = new URL("https://api.getjobber.com/api/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", Deno.env.get("JOBBER_CLIENT_ID")!);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return Response.redirect(url.toString(), 302);
});
