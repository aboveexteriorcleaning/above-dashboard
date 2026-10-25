// Sample data for previews and screenshots (DEMO_MODE=1). Not real customers or results.
import type { CommissionDay, CommissionSummary, CompanySummary, MyJob, Overview, Role, Scorecard, Session, TeamCommission, TeamMember, TeamScore, Today, TrendRow } from "./data";

export const session = (role: Role): Session =>
  role === "owner"
    ? { email: "owner@example.com", name: "Sample Owner", role: "owner", linked: true }
    : { email: "crew@example.com", name: "Sample Crew", role: "crew", linked: true };

export function overview(from: string, to: string): Overview {
  return {
    period: { from, to, days: 24 },
    revenue: { booked: 38420, booked_jobs: 41, completed: 31275, completed_jobs: 37, completed_prev_period: 27940,
      invoiced: 28910, paid_on_period_invoices: 24180, invoiced_incl_tax: 31338, avg_job_value: 845 },
    quotes: { sent: 64, won: 29, win_rate: 0.453, open_value: 21870, median_turnaround_hours: 5.5, turnaround_sample: 38 },
    leads: { requests: 71 },
    booked_ahead: { d7: 9840, d14: 17260, d30: 29415, recurring_jobs_in_window: 6 },
    receivables: { current: 3120, d1_30: 2480, d31_60: 760, d61_90: 0, d90_plus: 340, open_invoices: 11 },
    customers: { new: 22, returning: 15, active_plans: 34 },
    quality: { callbacks: 2, callback_rate: 0.054 },
    by_service: [
      { service: "Softwash Roof Cleaning", revenue: 12840, jobs: 13 },
      { service: "Christmas Lights Installation", revenue: 6300, jobs: 11 },
      { service: "Exterior Window Cleaning", revenue: 4120, jobs: 9 },
      { service: "Softwash Siding Cleaning", revenue: 3600, jobs: 4 },
      { service: "Interior & Exterior Gutter Cleaning", revenue: 2210, jobs: 8 },
      { service: "Concrete Pressure Washing", revenue: 1480, jobs: 3 },
      { service: "Moss Spot Check", revenue: 350, jobs: 7 },
      { service: "Biannual Roof Cleaning Plan", revenue: -400, jobs: 8 },
    ],
    by_zip: [
      { zip: "98516", city: "Olympia", revenue: 9870, jobs: 11 },
      { zip: "98503", city: "Lacey", revenue: 7420, jobs: 9 },
      { zip: "98513", city: "Olympia", revenue: 5160, jobs: 6 },
      { zip: "98501", city: "Tumwater", revenue: 4300, jobs: 5 },
      { zip: "98502", city: "Olympia", revenue: 2875, jobs: 4 },
      { zip: "98579", city: "Rochester", revenue: 1650, jobs: 2 },
    ],
    lead_sources: [
      { source: "Quo", requests: 31 }, { source: "Meta lead form", requests: 22 },
      { source: "Website", requests: 12 }, { source: "Referral", requests: 6 },
    ],
  };
}

export function trend(): TrendRow[] {
  const base = [5400, 8200, 6900, 14800, 22400, 27100, 31800, 29400, 33150, 30200, 27940, 31275];
  return base.map((v, i) => ({
    month: monthIso(i),
    completed_revenue: v, completed_jobs: Math.round(v / 820), booked_revenue: Math.round(v * 1.12),
    quotes_sent: Math.round(v / 520), quotes_won: Math.round(v / 1150),
  }));
}
function monthIso(i: number) { // Nov 2025 .. Oct 2026
  const d = new Date(Date.UTC(2025, 10 + i, 1));
  return d.toISOString().slice(0, 10);
}

export const myScore = (): Scorecard => ({
  completed_jobs: 19, revenue_credited: 9640, hours: 112.5, hours_source: "clocked", unestimated_visits: 0, revenue_per_hour: 85.69, work_days: 15,
  revenue_per_day: 642.67, upsell_revenue: 410, plans_sold: 3, quotes_sent: 0, quotes_approved: 0, callbacks: 1,
});

export const myJobs = (): MyJob[] => [
  ["Oct 23", "J. Alvarez", "Christmas Lights Installation", 350, 2.1],
  ["Oct 23", "R. Chen", "Christmas Light Reinstall", 274.5, 1.6],
  ["Oct 22", "D. Whitaker", "Roof Softwash & Gutter Cleaning", 515, 3.4],
  ["Oct 21", "M. Okafor", "Exterior Window Cleaning", 410, 3.8],
  ["Oct 20", "T. Brennan", "Window Cleaning", 380, 4.0],
  ["Oct 17", "S. Patel", "Softwash Roof Cleaning", 640, 4.6],
].map(([d, c, t, r, h], i) => ({
  job_id: `demo-${i}`, completed_at: new Date(`2026 ${d} 19:00 UTC`).toISOString(),
  client_name: c as string, job_title: t as string, my_revenue: r as number, my_hours: h as number, hours_source: "clocked", crew_size: i % 3 === 0 ? 1 : 2,
}));

export const company = (): CompanySummary => ({
  completed_revenue: 31275, completed_jobs: 37, new_clients: 22, quotes_sent: 64, quotes_approved: 29,
  quote_approval_rate: 0.453, booked_next_30_days: 29415, active_plans: 34,
});

export const teamScores = (): TeamScore[] => [
  { employee_id: "1", full_name: "Crew member A", ...myScore() },
  { employee_id: "2", full_name: "Crew member B", ...myScore(), revenue_credited: 8820, hours: 101, revenue_per_hour: 87.33, completed_jobs: 17, upsell_revenue: 260, plans_sold: 1, callbacks: 0 },
  { employee_id: "3", full_name: "Owner A", ...myScore(), revenue_credited: 7410, hours: 66, hours_source: "scheduled", unestimated_visits: 2, revenue_per_hour: 112.27, completed_jobs: 12, quotes_sent: 41, quotes_approved: 19, plans_sold: 6 },
  { employee_id: "4", full_name: "Owner B", ...myScore(), revenue_credited: 5405, hours: 52, hours_source: "scheduled", revenue_per_hour: 103.94, completed_jobs: 9, quotes_sent: 23, quotes_approved: 10, plans_sold: 2 },
];

export const team = (): TeamMember[] => [
  { id: "3", full_name: "Owner A", email: "owner.a@example.com", role: "owner", active: true, jobber_user_id: "U3", signed_in: true, hourly_cost: null, tracks_time: false, base_wage: null },
  { id: "4", full_name: "Owner B", email: "owner.b@example.com", role: "owner", active: true, jobber_user_id: "U4", signed_in: false, hourly_cost: null, tracks_time: false, base_wage: null },
  { id: "1", full_name: "Crew member A", email: "crew.a@example.com", role: "crew", active: true, jobber_user_id: "U1", signed_in: true, hourly_cost: 28, tracks_time: true, base_wage: 20 },
  { id: "2", full_name: "Crew member B", email: null, role: "crew", active: true, jobber_user_id: "U2", signed_in: false, hourly_cost: 27, tracks_time: true, base_wage: 20 },
  { id: "5", full_name: "Seasonal helper", email: null, role: "crew", active: false, jobber_user_id: "U5", signed_in: false, hourly_cost: null, tracks_time: true, base_wage: 20 },
];

export function commission(): { summary: CommissionSummary; days: CommissionDay[] } {
  const raw: [string, number, number, number, number][] = [ // day, jobs, value, commission, hours
    ["2026-10-23", 2, 1249, 187.35, 8.5], ["2026-10-22", 1, 1030, 154.5, 6.0], ["2026-10-21", 2, 1300, 195, 9.5],
    ["2026-10-20", 1, 548, 82.2, 5.5], ["2026-10-17", 1, 900, 135, 7.0], ["2026-10-16", 2, 1610, 241.5, 10.0],
    ["2026-10-15", 1, 450, 90, 6.5], ["2026-10-14", 2, 1840, 276, 9.0],
  ];
  const days = raw.map(([day, jobs, v, c, h]) => ({
    day, jobs, job_value: v, commission: c, hours: h, wage: 20, hourly_pay: h * 20,
    break_even_hours: Math.round((c / 20) * 100) / 100, commission_day: c >= h * 20,
  }));
  const hit = days.filter((d) => d.commission_day);
  return { days, summary: { commission_earned: hit.reduce((a, d) => a + d.commission, 0), commission_days: hit.length,
    work_days: days.length, commission_if_all: days.reduce((a, d) => a + d.commission, 0), missing_wage: false } };
}
export const today = (): Today => ({ jobs: 2, job_value: 1500, commission: 225, wage: 20, break_even_hours: 11.25, hours_so_far: 4.5 });
export const teamCommission = (): TeamCommission[] => [
  { employee_id: "1", full_name: "Crew member A", commission_earned: 1149.35, commission_days: 6, work_days: 8, missing_wage: false },
  { employee_id: "2", full_name: "Crew member B", commission_earned: 640.5, commission_days: 4, work_days: 8, missing_wage: false },
];
