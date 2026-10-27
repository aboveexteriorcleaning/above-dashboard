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
  customers: { new: number; returning: number; returning_own: number; returning_plan: number; active_plans: number };
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

async function rpc<T>(fn: string, args?: Record<string, unknown>, viewAs?: string): Promise<T> {
  const sb = await supabaseForUser(viewAs);
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
export async function getMyScorecard(from: string, to: string, viewAs?: string): Promise<Scorecard> {
  if (isDemo()) return demo.myScore();
  const rows = await rpc<any[]>("my_scorecard", { p_from: from, p_to: to }, viewAs);
  return numify<Scorecard>(rows[0]);
}
export async function getMyJobs(from: string, to: string, viewAs?: string): Promise<MyJob[]> {
  if (isDemo()) return demo.myJobs();
  return (await rpc<any[]>("my_jobs", { p_from: from, p_to: to }, viewAs)).map((r) => numify<MyJob>(r));
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
export async function getMyCommission(from: string, to: string, viewAs?: string): Promise<{ summary: CommissionSummary; days: CommissionDay[] }> {
  if (isDemo()) return demo.commission();
  const [sum, days] = await Promise.all([
    rpc<any[]>("my_commission_summary", { p_from: from, p_to: to }, viewAs),
    rpc<any[]>("my_commission_days", { p_from: from, p_to: to }, viewAs),
  ]);
  return { summary: numify<CommissionSummary>(sum[0]), days: days.map((d) => numify<CommissionDay>(d)) };
}
export async function getMyToday(viewAs?: string): Promise<Today> {
  if (isDemo()) return demo.today();
  const rows = await rpc<any[]>("my_today", undefined, viewAs);
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
export async function getMyPlanSales(from: string, to: string, viewAs?: string): Promise<PlanSales> {
  if (isDemo()) return demo.myPlanSales();
  const rows = await rpc<any[]>("my_plan_sales", { p_from: from, p_to: to }, viewAs);
  return numify<PlanSales>(rows[0]);
}
export async function getTeamPlanSales(from: string, to: string): Promise<TeamPlanSales[]> {
  if (isDemo()) return demo.teamPlanSales();
  return (await rpc<any[]>("team_plan_sales", { p_from: from, p_to: to })).map((r) => numify<TeamPlanSales>(r));
}

// ---------- leads (Quo, owners) ----------
export type LeadKpis = {
  leads: number; responded: number; no_reply: number; waiting_on_them: number; timed_leads: number;
  follow_up: { fu1_due: number; fu1_done: number; fu2_due: number; fu2_done: number; followed_up: number;
    followed_up_replied: number; followed_up_booked: number; followed_up_matched: number };
  follow_ups_due_now: number; not_converted: number; got_both_follow_ups: number;
  contact_rate: number | null; two_way: number; unworked: number;
  reach: { leads: number; avg_attempts: number | null; first_try: number; two_three: number; four_plus: number; came_back: number; never: number; still_trying: number }; median_first_any_min: number | null;
  lead_to_booking_days: number | null; touches_before_booking: number | null;
  by_zip: { zip: string; leads: number; booked: number; revenue: number; revenue_per_lead: number }[];
  quote_speed: { quoted: number; avg_hours: number | null; median_hours: number | null; fast_quoted: number; fast_booked: number; slow_quoted: number; slow_booked: number };
  median_response_min: number | null; median_response_min_in_hours: number | null; within_5_min: number | null;
  quoted: number; booked: number; booked_value: number;
  speed_booking: { fast_leads: number; fast_booked: number; slow_leads: number; slow_booked: number; matched_leads: number };
  new_quoted: number; new_quoted_booked: number; new_quoted_no_phone: number; new_booked: number; new_booked_value: number;
  by_source: { source: string; leads: number; booked: number; booked_value: number }[];
  by_line: { line: string; leads: number; booked: number }[];
  missed: { missed: number; inbound_calls: number; voicemails: number; returned: number; not_returned: number; median_return_min: number | null };
  monthly: { month: string; leads: number; quoted: number; booked: number }[];
  people: { name: string; calls_answered: number; calls_made: number; texts_sent: number; leads_first_reply: number; median_response_min: number | null }[];
};
export type Lead = {
  contact_phone: string; client_name: string | null; client_id: string | null; lead_at: string; source: string;
  line_name: string | null; first_response_at: string | null; response_minutes: number | null; responded_by: string | null;
  quoted_at: string | null; booked_at: string | null; booked_value: number; in_hours: boolean; clock_from: string | null; waiting_on_them: boolean;
  follow_up: string | null; fu1_at: string | null; fu2_at: string | null; hours_to_quote: number | null;
};
export type QuoFreshness = { last_synced: string | null; healthy: boolean; connected: boolean };

export async function getLeadKpis(from: string, to: string): Promise<LeadKpis> {
  if (isDemo()) return demo.leadKpis();
  return await rpc<LeadKpis>("owner_leads", { p_from: from, p_to: to });
}
export async function getLeadList(from: string, to: string): Promise<Lead[]> {
  if (isDemo()) return demo.leadList();
  return (await rpc<any[]>("lead_list", { p_from: from, p_to: to })).map((r) => ({
    ...r, response_minutes: r.response_minutes == null ? null : Number(r.response_minutes), booked_value: Number(r.booked_value ?? 0),
  }));
}
export async function getQuoFreshness(): Promise<QuoFreshness> {
  if (isDemo()) return { last_synced: new Date(Date.now() - 3 * 60_000).toISOString(), healthy: true, connected: true };
  const rows = await rpc<any[]>("quo_freshness");
  return rows?.[0] ?? { last_synced: null, healthy: true, connected: false };
}

// ---------- ads (Meta, owners) ----------
export type AdsKpis = {
  spend: number; impressions: number; link_clicks: number; clicks: number; meta_leads: number; days_with_spend: number;
  form_leads: number; new_customers: number; new_customer_value: number;
  attributed: { form_leads: number; matched: number; quoted: number; booked: number; booked_value: number; realized_revenue: number };
  campaigns: { campaign_id: string; name: string | null; spend: number; impressions: number; link_clicks: number; leads: number; first_day: string; last_day: string }[];
  monthly: { month: string; spend: number; leads: number; new_customers: number; new_value: number }[];
};
export async function getAds(from: string, to: string): Promise<AdsKpis> {
  if (isDemo()) return demo.ads();
  return await rpc<AdsKpis>("owner_ads", { p_from: from, p_to: to });
}
export async function getMetaFreshness(): Promise<QuoFreshness> {
  if (isDemo()) return { last_synced: new Date(Date.now() - 20 * 60_000).toISOString(), healthy: true, connected: true };
  const rows = await rpc<any[]>("meta_freshness");
  return rows?.[0] ?? { last_synced: null, healthy: true, connected: false };
}

// ---------- sales & quotes (owners) ----------
export type SalesKpis = {
  sent: number; sent_value: number; approved: number; approved_value: number; avg_approved_value: number | null;
  days_to_approve: number | null; lost: number; lost_value: number;
  waiting_period: { count: number; value: number };
  pipeline: { count: number; value: number; d0_7: number; d8_30: number; d31_90: number };
  stale: { count: number; value: number };
  discount: { pre_discount: number; discount: number; plan_discount: number; rate: number | null;
    with_discount_sent: number; with_discount_won: number; without_discount_sent: number; without_discount_won: number };
  follow_up: { needed: number; followed_up: number; no_phone: number };
  by_salesperson: { name: string; sent: number; approved: number; approved_value: number }[];
  to_follow_up: { id: string; client_name: string | null; client_id: string | null; value: number; sent_at: string; days_waiting: number; last_contact: string | null }[];
};
export async function getSales(from: string, to: string): Promise<SalesKpis> {
  if (isDemo()) return demo.sales();
  return await rpc<SalesKpis>("owner_sales", { p_from: from, p_to: to });
}

// ---------- operations (owners) ----------
export type CrewKpis = {
  revenue: number; jobs: number; field_hours: number; labor_cost: number; labor_unpriced_days: number;
  crew_days: number; work_days: number; scheduled_hours: number; clocked_hours: number;
  over_days: { day: string; name: string; scheduled: number; clocked: number }[];
  overtime_hours: number; paid_hours: number;
  by_service: { service: string; jobs: number; revenue: number; labor: number }[];
  by_size: { t: number; jobs: number; revenue: number; labor: number; revenue_per_hour: number | null }[];
};
export type QualityKpis = {
  callbacks: number; completed_jobs: number; rework_hours: number; callback_cost: number; unlinked: number;
  list: { id: string; job_number: number | null; client_name: string | null; created_at: string; original_job_number: number | null; original_crew: string | null; rework_hours: number | null }[];
  by_person: { name: string; jobs: number; callbacks: number; rate: number | null }[];
};
export async function getCrews(from: string, to: string): Promise<CrewKpis> {
  if (isDemo()) return demo.crews();
  return await rpc<CrewKpis>("owner_crews", { p_from: from, p_to: to });
}
export async function getQuality(from: string, to: string): Promise<QualityKpis> {
  if (isDemo()) return demo.quality();
  return await rpc<QualityKpis>("owner_quality", { p_from: from, p_to: to });
}

// ---------- revenue: upsells, customers, plan extras (owners) ----------
export type UpsellKpis = {
  completed_jobs: number; upsold_jobs: number; revenue: number; on_site: number; quote_add_on: number; job_revenue: number;
  offers: { recorded: number; offered: number; accepted: number; declined: number; not_a_fit: number };
  by_service: { service: string; times: number; revenue: number }[];
  combos: { base: string; add_on: string; jobs: number; revenue: number }[];
  by_person: { name: string; jobs: number; upsold_jobs: number; revenue: number; hours: number }[];
};
export type CustomerKpis = {
  customers: number; revenue: number; jobs: number; new_customers: number; new_revenue: number; returning_revenue: number;
  first_job_avg: number | null; reactivated: number; reactivated_revenue: number;
  lifetime_avg: number | null; lifetime_avg_2yr: number | null; all_customers: number;
  repeat_rate: number | null; repeat_base: number; second_job_rate: number | null; second_job_base: number;
  retention: number | null; retention_base: number; days_between: number | null; jobs_per_customer_12m: number | null;
  cross_service: number | null;
  top_customers: { home_key: string; jobs: number; lifetime: number; first_at: string; last_at: string; name: string | null }[];
};
export type PlanExtras = {
  mrr: number; avg_plan_value: number | null; renewal_rate: number | null; renewal_base: number; cancellation_rate: number | null;
  plan_upsell_revenue: number; plan_lifetime_avg: number | null; non_plan_lifetime_avg: number | null;
};
export async function getUpsells(from: string, to: string): Promise<UpsellKpis> {
  if (isDemo()) return demo.upsells();
  return await rpc<UpsellKpis>("owner_upsells", { p_from: from, p_to: to });
}
export async function getCustomers(from: string, to: string): Promise<CustomerKpis> {
  if (isDemo()) return demo.customers();
  return await rpc<CustomerKpis>("owner_customers", { p_from: from, p_to: to });
}
export async function getPlanExtras(from: string, to: string): Promise<PlanExtras> {
  if (isDemo()) return demo.planExtras();
  return await rpc<PlanExtras>("owner_plan_extras", { p_from: from, p_to: to });
}

// ---------- financial + alerts (owners) ----------
export type FinancialKpis = {
  settings: { crew_hours_per_day: number; drive_hours_per_day: number; work_weekdays: number[]; trucks: number };
  revenue: number; invoiced: number; collected: number; labor_cost: number; headcount: number; field_headcount: number;
  open_ar: number; invoiced_90d: number; available_hours: number; scheduled_hours: number;
  next7_available: number; next7_booked: number; next14_available: number; next14_booked: number;
  booked_jobs: number; cancelled_jobs: number; cancelled_value: number; booking_lead_days: number | null;
  by_zip: { zip: string; jobs: number; revenue: number; gross_after_labor: number }[];
  forecast: { day: string; booked_30: number; actual: number }[]; snapshots: number;
};
export type Alerts = {
  leads_waiting: number; follow_ups_due: number; missed_not_returned: number; big_quotes_no_follow_up: number;
  plans_need_booking: number; long_crew_days: number; next7_utilization: number | null;
  callback_rate_30: number | null; callback_rate_prior: number | null; approval_rate_30: number | null; approval_rate_prior: number | null;
};
export async function getFinancial(from: string, to: string): Promise<FinancialKpis> {
  if (isDemo()) return demo.financial();
  return await rpc<FinancialKpis>("owner_financial", { p_from: from, p_to: to });
}
export async function getAlerts(): Promise<Alerts> {
  if (isDemo()) return demo.alerts();
  return await rpc<Alerts>("owner_alerts");
}
export async function getSettings(): Promise<FinancialKpis["settings"]> {
  if (isDemo()) return { crew_hours_per_day: 8, drive_hours_per_day: 1, work_weekdays: [1, 2, 3, 4, 5], trucks: 2 };
  const sb = await supabaseForUser();
  const { data } = await sb.from("business_settings").select("crew_hours_per_day, drive_hours_per_day, work_weekdays, trucks").limit(1).maybeSingle();
  return (data as any) ?? { crew_hours_per_day: 8, drive_hours_per_day: 1, work_weekdays: [1, 2, 3, 4, 5], trucks: 2 };
}

// ---------- Google reviews ----------
export type ReviewKpis = {
  connected: boolean; source: string | null; average_all: number | null; total_all: number | null; reviews: number; average: number | null;
  five_star: number; low: number; completed_jobs: number; replied: number; reply_hours: number | null; requests: number; matched: number;
  by_person: { name: string; reviews: number; average: number; five_star: number }[];
  recent: { id: string; stars: number | null; reviewer_name: string | null; created_at: string; comment: string | null; replied: boolean; crew: string | null }[];
};
export async function getReviews(from: string, to: string): Promise<ReviewKpis> {
  if (isDemo()) return demo.reviews();
  return await rpc<ReviewKpis>("owner_reviews", { p_from: from, p_to: to });
}
export type UpsellRate = { jobs: number; upsold_jobs: number; rate: number | null; offered: number; accepted: number };
export type TeamUpsellRate = UpsellRate & { employee_id: string };
export async function getMyUpsellRate(from: string, to: string, viewAs?: string): Promise<UpsellRate> {
  if (isDemo()) return demo.myUpsellRate();
  const rows = await rpc<any[]>("my_upsell_rate", { p_from: from, p_to: to }, viewAs);
  return numify<UpsellRate>(rows?.[0] ?? { jobs: 0, upsold_jobs: 0, rate: null, offered: 0, accepted: 0 });
}
export async function getTeamUpsellRates(from: string, to: string): Promise<TeamUpsellRate[]> {
  if (isDemo()) return demo.teamUpsellRates();
  return (await rpc<any[]>("team_upsell_rates", { p_from: from, p_to: to })).map((r) => numify<TeamUpsellRate>(r));
}
export async function getMyReviews(from: string, to: string, viewAs?: string): Promise<{ reviews: number; average: number | null; five_star: number }> {
  if (isDemo()) return { reviews: 3, average: 5, five_star: 3 };
  const rows = await rpc<any[]>("my_reviews", { p_from: from, p_to: to }, viewAs);
  return numify(rows?.[0] ?? { reviews: 0, average: null, five_star: 0 });
}
