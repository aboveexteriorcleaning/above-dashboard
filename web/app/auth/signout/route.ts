import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { isDemo, supabaseForUser } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  if (isDemo()) (await cookies()).delete("demo_role");
  else await (await supabaseForUser()).auth.signOut();
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}
