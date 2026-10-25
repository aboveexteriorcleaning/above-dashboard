import "server-only";
import { cookies } from "next/headers";
import { isDemo, supabaseForUser } from "./supabase";
import * as demo from "./demo";

// ---------- types (mirror the database functions) ----------
export type Role = "owner" | "crew";
export type Session = { email: string; name: string | null; role: Role | null; linked: boolean };

export type Overview = {
  period: { from: string; to: string; days: number };
  revenue: { booked: number; booked_jobs: number; completed: number; completed_jobs: number;
    completed_prev_period: number; invoiced: number; paid_on_period_invoices: number;
    invoiced_incl_tax: number; avg_job_value: number | null };
  quotes: { sent: number; won: number; win_rate: number | null; open_value: number;
    median_turnaround_hours: number | null; turnaround_sample: number };
  leads: { requests: number };
  booked_ahead: { d7: number; d14: number; d30: number; recurring_jobs_in_window: number };
  receivables: { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number; open_invoices: number };
  customers: { new: number; returning: number; active_plans: number };
  quality: { callbacks: number; callback_rate: number | null };
  by_service: { service: string; revenue: number; jobs: number }[];
  by_zip: { zip: string; city: string; revenue: number; jobs: number }[];
  lead_sources: { source: string; requests: number }[];
};
export type TrendRow = { month: string; completed_revenue: number; completed_jobs: number;
  booked_revenue: number; quotes_sent: number; quotes_won: number };
export type Scorecard = { completed_jobs: number; revenue_credited: number; hours: number;
  hours_source: "clocked" | "scheduled"; unestimated_visits: number;
  revenue_per_hour: number | null; work_days: number; revenue_per_day: number | null;
  upsell_revenue: number; plans_sold: number; quotes_sent: number; quotes_approved: number; callbacks: number };
export type MyJob = { job_id: string; completed_at: string; client_name: string | null; job_title: string | null;
  my_revenue: number; my_hours: number | null; hours_source: "clocked" | "scheduled"; crew_size: number };
export type CompanySummary = { completed_revenue: number; completed_jobs: number; new_clients: number;
  quotes_sent: number; quotes_approved: number; quote_approval_rate: number | null;
  booked_next_30_days: number; active_plans: number };
export type TeamScore = Scorecard & { employee_id: string; full_name: string };
export type TeamMember = { id: string; full_name: string; email: string | null; role: Role; active: boolean;
  jobber_user_id: string | null; signed_in: boolean; hourly_cost: number | null; tracks_time: boolean;
  base_wage: number | null };
export type Freshness = { last_synced: string | null; healthy: boolean };
export type CommissionDay = { day: string; jobs: number; job_value: number; commission: number; hours: number;
  wage: number | null; hourly_pay: number | null; break_even_hours: number | null; commission_day: boolean };
export type CommissionSummary = { commission_earned: number; commission_days: number; work_days: number;
  commission_if_all: number; missing_wage: boolean | null };
export type Today = { jobs: number; job_value: number; commission: number; wage: number | null;
  break_even_hours: number | null; hours_so_far: number };
export type TeamCommission = { employee_id: string; full_name: string; commission_earned: number;
  commission_days: number; work_days: number; missing_wage: boolean | null };

// numeric columns arrive as strings from Postgres; make them numbers
const numify = <T,>(row: any): T => {
  const out: any = {};
  for (const [k, v] of Object.entries(row ?? {})) out[k] = typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && k !== "job_id" && k !== "zip" ? Number(v) : v;
  return out as T;
};

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const sb = await supabaseForUser();
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

// ---------- session ----------
export async function getSession(): Promise<Session | null> {
  if (isDemo()) {
    const role = (await cookies()).get("demo_role")?.value as Role | undefined;
    return role ? demo.session(role) : null;
  }
  const sb = await supabaseForUser();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb.rpc("link_my_login");
  const row = Array.isArray(data) ? data[0] : data;
  return { email: user.email ?? "", name: row?.full_name ?? null, role: row?.role ?? null, linked: !!row?.linked };
}

// ---------- owner ----------
export async function getOverview(from: string, to: string): Promise<Overview> {
  if (isDemo()) return demo.overview(from, to);
  return await rpc<Overview>("owner_overview", { p_from: from, p_to: to });
}
export async function getTrend(): Promise<TrendRow[]> {
  if (isDemo()) return demo.trend();
  return (await rpc<any[]>("owner_monthly_trend", { p_months: 12 })).map((r) => numify<TrendRow>(r));
}
export async function getTeamScorecards(from: string, to: string): Promise<TeamScore[]> {
  if (isDemo()) return demo.teamScores();
  return (await rpc<any[]>("team_scorecards", { p_from: from, p_to: to })).map((r) => numify<TeamScore>(r));
}
export async function getTeam(): Promise<TeamMember[]> {
  if (isDemo()) return demo.team();
  const sb = await supabaseForUser();
  const { data: emps, error } = await sb.from("employees")
    .select("id, full_name, email, role, active, jobber_user_id, auth_user_id, tracks_time").order("full_name");
  if (error) throw new Error(error.message);
  const { data: costs } = await sb.from("employee_costs").select("employee_id, effective_from, hourly_cost")
    .order("effective_from", { ascending: false });
  const { data: wages } = await sb.from("employee_wages").select("employee_id, effective_from, hourly_wage")
    .order("effective_from", { ascending: false });
  return (emps ?? []).map((e: any) => ({
    id: e.id, full_name: e.full_name, email: e.email, role: e.role, active: e.active,
    jobber_user_id: e.jobber_user_id, signed_in: !!e.auth_user_id, tracks_time: e.tracks_time !== false,
    base_wage: wages?.find((w: any) => w.employee_id === e.id)?.hourly_wage != null
      ? Number(wages!.find((w: any) => w.employee_id === e.id)!.hourly_wage) : null,
    hourly_cost: costs?.find((c: any) => c.employee_id === e.id)?.hourly_cost != null
      ? Number(costs!.find((c: any) => c.employee_id === e.id)!.hourly_cost) : null,
  }));
}

// ---------- everyone ----------
export async function getMyScorecard(from: string, to: string): Promise<Scorecard> {
  if (isDemo()) return demo.myScore();
  const rows = await rpc<any[]>("my_scorecard", { p_from: from, p_to: to });
  return numify<Scorecard>(rows[0]);
}
export async function getMyJobs(from: string, to: string): Promise<MyJob[]> {
  if (isDemo()) return demo.myJobs();
  return (await rpc<any[]>("my_jobs", { p_from: from, p_to: to })).map((r) => numify<MyJob>(r));
}
export async function getCompanySummary(from: string, to: string): Promise<CompanySummary> {
  if (isDemo()) return demo.company();
  const rows = await rpc<any[]>("company_summary", { p_from: from, p_to: to });
  return numify<CompanySummary>(rows[0]);
}
export async function getFreshness(): Promise<Freshness> {
  if (isDemo()) return { last_synced: new Date(Date.now() - 4 * 60_000).toISOString(), healthy: true };
  const rows = await rpc<any[]>("data_freshness");
  return rows?.[0] ?? { last_synced: null, healthy: false };
}

// ---------- commission ----------
export async function getMyCommission(from: string, to: string): Promise<{ summary: CommissionSummary; days: CommissionDay[] }> {
  if (isDemo()) return demo.commission();
  const [sum, days] = await Promise.all([
    rpc<any[]>("my_commission_summary", { p_from: from, p_to: to }),
    rpc<any[]>("my_commission_days", { p_from: from, p_to: to }),
  ]);
  return { summary: numify<CommissionSummary>(sum[0]), days: days.map((d) => numify<CommissionDay>(d)) };
}
export async function getMyToday(): Promise<Today> {
  if (isDemo()) return demo.today();
  const rows = await rpc<any[]>("my_today");
  return numify<Today>(rows[0]);
}
export async function getTeamCommission(from: string, to: string): Promise<TeamCommission[]> {
  if (isDemo()) return demo.teamCommission();
  return (await rpc<any[]>("team_commission", { p_from: from, p_to: to })).map((r) => numify<TeamCommission>(r));
}

// ---------- plans (owners) ----------
export type PlanStatus = "on_schedule" | "booked_late" | "needs_date" | "not_booked" | "overdue" | "lapsed";
export type PlanKpis = {
  revenue: number; visits: number; share_of_revenue: number | null; discounts: number; avg_visit: number | null;
  annual_value: number; booked_ahead: number; booked_ahead_visits: number; revenue_to_date: number;
  homes: number; signups: number;
  channels: { on_site: number; pre_job: number; unattributed: number };
  conversion: { serviced: number; on_plan: number; rate: number | null; serviced_12m: number; on_plan_12m: number; rate_12m: number | null };
  status: Partial<Record<PlanStatus, number>>;
  by_plan: { plan: string; per_year: number; homes: number; revenue: number }[];
  monthly: { month: string; completed_revenue: number; completed_jobs: number }[];
  ahead: { month: string; value: number; visits: number }[];
};
export type PlanCustomer = {
  home_key: string; service_line: string; plan_name: string; services_per_year: number;
  client_id: string | null; client_name: string | null; phone: string | null; email: string | null;
  street: string | null; city: string | null; last_visit: string | null; next_visit: string | null;
  next_job_id: string | null; next_job_number: number | null; due_date: string | null; status: PlanStatus;
  days_overdue: number; visits_done: number; revenue_to_date: number; visit_value: number;
  annual_value: number; signed_up: string | null;
  sold_by: string | null; sale_channel: "on_site" | "pre_job" | null; sold_on: string | null;
};
export async function getPlanKpis(from: string, to: string): Promise<PlanKpis> {
  if (isDemo()) return demo.planKpis();
  return await rpc<PlanKpis>("owner_plans", { p_from: from, p_to: to });
}
export async function getPlanCustomers(): Promise<PlanCustomer[]> {
  if (isDemo()) return demo.planCustomers();
  return (await rpc<any[]>("plan_customers")).map((r) => ({
    ...r,
    services_per_year: Number(r.services_per_year), visits_done: Number(r.visits_done), days_overdue: Number(r.days_overdue),
    revenue_to_date: Number(r.revenue_to_date ?? 0), visit_value: Number(r.visit_value ?? 0), annual_value: Number(r.annual_value ?? 0),
  }));
}

export type PlanSales = { plans_sold: number; on_site: number; pre_job: number; value_sold: number;
  serviced_homes: number; converted_homes: number; conversion: number | null };
export type TeamPlanSales = PlanSales & { employee_id: string; full_name: string };
export async function getMyPlanSales(from: string, to: string): Promise<PlanSales> {
  if (isDemo()) return demo.myPlanSales();
  const rows = await rpc<any[]>("my_plan_sales", { p_from: from, p_to: to });
  return numify<PlanSales>(rows[0]);
}
export async function getTeamPlanSales(from: string, to: string): Promise<TeamPlanSales[]> {
  if (isDemo()) return demo.teamPlanSales();
  return (await rpc<any[]>("team_plan_sales", { p_from: from, p_to: to })).map((r) => numify<TeamPlanSales>(r));
}
