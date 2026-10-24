"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/components/Shell";
import { isDemo, supabaseAdmin, supabaseForUser } from "@/lib/supabase";
import { pacificToday } from "@/lib/periods";

const back = (msg: string, tone: "ok" | "warn" = "ok") =>
  redirect(`/team?${tone}=${encodeURIComponent(msg)}#setup`);

export async function saveMember(form: FormData) {
  await requireSession(["owner"]);
  if (isDemo()) back("Preview mode: changes aren't saved.", "warn");

  const id = String(form.get("id"));
  const name = String(form.get("name") ?? "");
  const emailRaw = String(form.get("email") ?? "").trim().toLowerCase();
  const email = emailRaw || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) back(`${name}: that email doesn't look right.`, "warn");
  const role = form.get("role") === "owner" ? "owner" : "crew";
  const active = form.get("active") === "on";
  const costRaw = String(form.get("hourly_cost") ?? "").trim();
  const cost = costRaw === "" ? null : Number(costRaw);
  if (cost != null && (!Number.isFinite(cost) || cost < 0 || cost > 500)) back(`${name}: hourly cost should be between 0 and 500.`, "warn");

  // Runs as the signed-in owner; the database's access rules allow owners (and only owners) to do this.
  const sb = await supabaseForUser();
  const { error } = await sb.from("employees").update({ email, role, active }).eq("id", id);
  if (error) {
    const m = /active owner/i.test(error.message) ? "There must always be at least one active owner."
      : /employees_email_key|duplicate/i.test(error.message) ? "That email is already on another profile."
      : `Couldn't save ${name}.`;
    back(m, "warn");
  }
  if (cost != null) {
    const t = pacificToday();
    const today = `${t.y}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
    const { error: e2 } = await sb.from("employee_costs")
      .upsert({ employee_id: id, effective_from: today, hourly_cost: cost }, { onConflict: "employee_id,effective_from" });
    if (e2) back(`Saved ${name}, but couldn't save the hourly cost.`, "warn");
  }
  revalidatePath("/team");
  back(`Saved ${name}.`);
}

/** Sends a sign-in invite. Only an owner can trigger it, and only to the email already
 *  saved on that person's profile, so it can't be used to invite arbitrary people. */
export async function inviteMember(form: FormData) {
  await requireSession(["owner"]);
  if (isDemo()) back("Preview mode: no emails are sent.", "warn");

  const id = String(form.get("id"));
  const sb = await supabaseForUser();
  const { data: emp } = await sb.from("employees").select("full_name, email, active").eq("id", id).single();
  if (!emp?.email) back("Add an email first, then send the invite.", "warn");
  if (!emp!.active) back(`${emp!.full_name} is switched off. Turn them on first.`, "warn");

  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const { error } = await supabaseAdmin().auth.admin.inviteUserByEmail(emp!.email!, { redirectTo: `${origin}/auth/callback` });
  if (error) {
    if (/already/i.test(error.message)) back(`${emp!.full_name} already has a login. They can sign in from the login page.`);
    back(`Couldn't send the invite to ${emp!.full_name}.`, "warn");
  }
  back(`Invite sent to ${emp!.email}.`);
}
