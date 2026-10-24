"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isDemo, supabaseForUser } from "@/lib/supabase";

export async function sendLoginLink(form: FormData) {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) redirect("/login?error=" + encodeURIComponent("Enter a valid email address."));
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const sb = await supabaseForUser();
  // shouldCreateUser:false -> only people an owner has invited can get a link.
  const { error } = await sb.auth.signInWithOtp({
    email, options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/callback` },
  });
  // Same message either way, so the page doesn't reveal who has an account.
  if (error && !/not allowed|not found|signups/i.test(error.message)) {
    redirect("/login?error=" + encodeURIComponent("Couldn't send the link. Try again in a minute."));
  }
  redirect("/login?sent=1");
}

export async function demoSignIn(form: FormData) {
  if (!isDemo()) redirect("/login");
  const role = form.get("role") === "crew" ? "crew" : "owner";
  (await cookies()).set("demo_role", role, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/");
}
