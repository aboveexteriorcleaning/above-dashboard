import { NextResponse, type NextRequest } from "next/server";
import { supabaseForUser } from "@/lib/supabase";

// The emailed sign-in link lands here.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const tokenHash = req.nextUrl.searchParams.get("token_hash");
  const type = req.nextUrl.searchParams.get("type");
  const sb = await supabaseForUser();
  let ok = false;
  if (code) ok = !(await sb.auth.exchangeCodeForSession(code)).error;
  else if (tokenHash && (type === "magiclink" || type === "invite" || type === "email")) {
    ok = !(await sb.auth.verifyOtp({ token_hash: tokenHash, type: type as "magiclink" | "invite" | "email" })).error;
  }
  const dest = ok ? "/" : "/login?error=" + encodeURIComponent("That sign-in link expired or was already used. Request a new one.");
  return NextResponse.redirect(new URL(dest, req.url));
}
