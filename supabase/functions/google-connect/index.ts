// One-time: sends an owner to Google's "Allow access" screen for the Business Profile.
// Link: <project>/functions/v1/google-connect?key=<GOOGLE_SETUP_KEY>
import { db } from "../_shared/db.ts";
import { challengeFor, randomString, safeEqual } from "../_shared/pkce.ts";
import { SCOPE } from "../_shared/google.ts";

Deno.serve(async (req) => {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  const expected = Deno.env.get("GOOGLE_SETUP_KEY") ?? "";
  if (!expected || !safeEqual(key, expected)) return new Response("Forbidden", { status: 403 });

  const state = randomString(24);
  const verifier = randomString(48);
  const sql = db();
  await sql`delete from private.oauth_states where created_at < now() - interval '15 minutes'`;
  await sql`insert into private.oauth_states (state, code_verifier, provider) values (${state}, ${verifier}, 'google')`;

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", Deno.env.get("GOOGLE_CLIENT_ID")!);
  url.searchParams.set("redirect_uri", `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-oauth-callback`);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return Response.redirect(url.toString(), 302);
});
