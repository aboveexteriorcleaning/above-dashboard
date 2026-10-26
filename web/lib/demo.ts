// Sample data for previews and screenshots (DEMO_MODE=1). Not real customers or results.
import type { ReviewKpis, Alerts, FinancialKpis, CustomerKpis, PlanExtras, UpsellKpis, CrewKpis, QualityKpis, SalesKpis, AdsKpis, Lead, LeadKpis, PlanCustomer, PlanKpis, PlanSales, TeamPlanSales, CommissionDay, CommissionSummary, CompanySummary, MyJob, Overview, Role, Scorecard, Session, TeamCommission, TeamMember, TeamScore, Today, TrendRow } from "./data";

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
    customers: { new: 22, returning: 15, returning_own: 9, returning_plan: 6, active_plans: 34 },
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

export function planKpis(): PlanKpis {
  const vals = [1850, 2400, 3100, 4600, 6900, 7400, 6200, 5800, 4300, 3900, 3200, 2650];
  const base = new Date(Date.UTC(2025, 10, 1));
  const monthly = vals.map((v, i) => {
    const d = new Date(base); d.setUTCMonth(base.getUTCMonth() + i);
    return { month: d.toISOString().slice(0, 10), completed_revenue: v, completed_jobs: Math.round(v / 380) };
  });
  const ahead = [1900, 3600, 4200, 5100, 6800, 2100].map((v, i) => {
    const d = new Date(Date.UTC(2026, 9 + i, 1));
    return { month: d.toISOString().slice(0, 10), value: v, visits: Math.round(v / 370) };
  });
  return {
    revenue: 2650, visits: 7, share_of_revenue: 0.085, discounts: 375, avg_visit: 378, annual_value: 23100,
    booked_ahead: 23700, booked_ahead_visits: 64, revenue_to_date: 61400, homes: 31, signups: 4,
    channels: { on_site: 3, pre_job: 1, unattributed: 0 },
    conversion: { serviced: 41, on_plan: 9, rate: 0.22, serviced_12m: 412, on_plan_12m: 31, rate_12m: 0.075 },
    status: { on_schedule: 22, booked_late: 2, not_booked: 6, needs_date: 1, overdue: 3, lapsed: 5 },
    by_plan: [
      { plan: "Biannual Window Cleaning Plan", per_year: 2, homes: 17, revenue: 1290 },
      { plan: "Biannual Roof Cleaning Plan", per_year: 2, homes: 7, revenue: 780 },
      { plan: "Quarterly Window Cleaning Plan", per_year: 4, homes: 3, revenue: 330 },
      { plan: "Annual Window Cleaning Plan", per_year: 1, homes: 2, revenue: 0 },
      { plan: "4-Month Roof Cleaning Plan", per_year: 3, homes: 2, revenue: 250 },
    ],
    monthly, ahead,
  };
}
export function planCustomers(): PlanCustomer[] {
  const rows: [string, string, string, string | null, string | null, string | null, PlanCustomer["status"], number, number, number][] = [
    ["Sample Customer A", "101 Example St", "Biannual Window Cleaning Plan", "2026-07-06", "2027-01-06", "2027-01-04", "on_schedule", 2, 700, 350],
    ["Sample Customer B", "22 Demo Ave", "Biannual Roof Cleaning Plan", "2026-10-10", null, "2027-04-10", "not_booked", 1, 950, 950],
    ["Sample Customer C", "9 Placeholder Rd", "Quarterly Window Cleaning Plan", "2026-05-02", null, "2026-08-01", "overdue", 3, 1020, 340],
    ["Sample Customer D", "47 Fictional Ln", "Biannual Window Cleaning Plan", "2026-06-18", "2026-12-17", "2026-12-18", "on_schedule", 1, 450, 450],
    ["Sample Customer E", "310 Mock Ct", "4-Month Roof Cleaning Plan", "2026-06-01", "2026-11-20", "2026-09-30", "booked_late", 1, 525, 525],
    ["Sample Customer F", "5 Example Way", "Annual Window Cleaning Plan", null, "2027-06-11", null, "on_schedule", 0, 0, 525],
    ["Sample Customer G", "88 Demo Blvd", "Biannual Window Cleaning Plan", "2025-09-14", null, "2026-03-15", "lapsed", 1, 300, 300],
    ["Sample Customer H", "14 Sample Dr", "Biannual Roof Cleaning Plan", "2026-09-08", null, "2027-03-09", "needs_date", 1, 279, 279],
  ];
  return rows.map(([name, street, plan, last, next, due, status, visits, rev, value], i) => {
    const per = /Quarterly/.test(plan) ? 4 : /4-Month/.test(plan) ? 3 : /Annual W/.test(plan) ? 1 : 2;
    return {
      home_key: street.toLowerCase(), service_line: /Roof/.test(plan) ? "roof" : "window", plan_name: plan, services_per_year: per,
      client_id: null, client_name: name, phone: "+1 555 010 00" + i, email: null, street, city: "Olympia",
      last_visit: last, next_visit: next, next_job_id: null, next_job_number: next ? 700 + i : null, due_date: due, status,
      days_overdue: status === "overdue" ? 84 : status === "lapsed" ? 223 : 0, visits_done: visits, revenue_to_date: rev,
      visit_value: value, annual_value: status === "overdue" || status === "lapsed" ? 0 : value * per, signed_up: "2026-03-01",
      sold_by: i % 3 === 0 ? "Sample Owner" : i % 3 === 1 ? "Crew member A & Crew member B" : "Crew member A",
      sale_channel: i % 3 === 0 ? "pre_job" : "on_site", sold_on: last ?? "2026-06-01",
    };
  });
}
export const myPlanSales = (): PlanSales => ({ plans_sold: 3, on_site: 3, pre_job: 0, value_sold: 1650, serviced_homes: 14, converted_homes: 3, conversion: 0.214 });
export const teamPlanSales = (): TeamPlanSales[] => [
  { employee_id: "1", full_name: "Crew member A", plans_sold: 3, on_site: 3, pre_job: 0, value_sold: 1650, serviced_homes: 14, converted_homes: 3, conversion: 0.214 },
  { employee_id: "2", full_name: "Sample Owner", plans_sold: 1, on_site: 0, pre_job: 1, value_sold: 900, serviced_homes: 4, converted_homes: 0, conversion: 0 },
  { employee_id: "3", full_name: "Crew member B", plans_sold: 1, on_site: 1, pre_job: 0, value_sold: 350, serviced_homes: 11, converted_homes: 1, conversion: 0.091 },
];

export function leadKpis(): LeadKpis {
  const vals = [18, 22, 15, 12, 20, 34, 41, 52, 47, 39, 31, 27];
  const months = vals.map((v, i) => {
    const d = new Date(Date.UTC(2025, 10 + i, 1));
    return { month: d.toISOString().slice(0, 10), leads: v, quoted: Math.round(v * 0.62), booked: Math.round(v * 0.34) };
  });
  return {
    leads: 27, responded: 23, no_reply: 2, waiting_on_them: 2, timed_leads: 25,
    follow_up: { fu1_due: 9, fu1_done: 7, fu2_due: 5, fu2_done: 3, followed_up: 7, followed_up_replied: 4, followed_up_booked: 2, followed_up_matched: 6 },
    follow_ups_due_now: 2, not_converted: 2, got_both_follow_ups: 3,
    contact_rate: 0.81, two_way: 22, unworked: 1,
    reach: { leads: 14, avg_attempts: 1.8, first_try: 6, two_three: 3, four_plus: 1, came_back: 2, never: 2, still_trying: 1 }, median_first_any_min: 2, lead_to_booking_days: 3.5, touches_before_booking: 4.2,
    by_zip: [{ zip: "98513", leads: 6, booked: 3, revenue: 2140, revenue_per_lead: 356.67 }, { zip: "98516", leads: 5, booked: 2, revenue: 1310, revenue_per_lead: 262 }, { zip: "98502", leads: 3, booked: 1, revenue: 450, revenue_per_lead: 150 }],
    quote_speed: { quoted: 15, avg_hours: 21.4, median_hours: 6.5, fast_quoted: 11, fast_booked: 7, slow_quoted: 4, slow_booked: 1 }, median_response_min: 6.5, median_response_min_in_hours: 3, within_5_min: 0.44,
    quoted: 17, booked: 9, booked_value: 8640,
    speed_booking: { fast_leads: 12, fast_booked: 6, slow_leads: 13, slow_booked: 3, matched_leads: 18 },
    new_quoted: 41, new_quoted_booked: 19, new_quoted_no_phone: 12, new_booked: 22, new_booked_value: 17350,
    by_source: [
      { source: "Called in", leads: 12, booked: 5, booked_value: 4890 },
      { source: "Form (auto-text)", leads: 9, booked: 2, booked_value: 1650 },
      { source: "Texted in", leads: 5, booked: 2, booked_value: 2100 },
      { source: "We reached out", leads: 1, booked: 0, booked_value: 0 },
    ],
    by_line: [{ line: "Main line", leads: 27, booked: 9 }],
    missed: { missed: 14, inbound_calls: 61, voicemails: 6, returned: 11, not_returned: 3, median_return_min: 22 },
    monthly: months,
    people: [
      { name: "Sample Owner", calls_answered: 38, calls_made: 52, texts_sent: 140, leads_first_reply: 19, median_response_min: 4 },
      { name: "Second Owner", calls_answered: 12, calls_made: 20, texts_sent: 61, leads_first_reply: 6, median_response_min: 14 },
    ],
  };
}
export function leadList(): Lead[] {
  const rows: [string | null, string, string, number | null, string | null, string | null, string | null, number][] = [
    ["Sample Lead A", "2026-10-24T17:12:00Z", "Called in", 0, "Sample Owner", "2026-10-24T22:00:00Z", "2026-10-25T16:00:00Z", 640],
    [null, "2026-10-24T03:40:00Z", "Form (auto-text)", null, null, null, null, 0],
    ["Sample Lead C", "2026-10-23T18:05:00Z", "Form (auto-text)", 4, "Sample Owner", "2026-10-23T23:30:00Z", null, 0],
    ["Sample Lead D", "2026-10-22T20:15:00Z", "Texted in", 38, "Second Owner", null, null, 0],
    ["Sample Lead E", "2026-10-21T16:30:00Z", "Called in", 15, "Sample Owner", "2026-10-21T21:00:00Z", "2026-10-22T18:00:00Z", 1150],
    [null, "2026-10-20T15:02:00Z", "Called in", null, null, null, null, 0],
  ];
  return rows.map(([name, at, source, mins, who, q, b, v], i) => ({
    contact_phone: `+1360555010${i}`, client_name: name, client_id: null, lead_at: at, source, line_name: "Main line",
    first_response_at: mins == null ? null : at, response_minutes: mins, responded_by: who, quoted_at: q, booked_at: b,
    booked_value: v, in_hours: true, clock_from: source.startsWith("Form") && mins != null ? "their reply" : "first contact", waiting_on_them: i === 1,
    follow_up: i === 1 ? "First follow-up due" : i === 2 ? "Followed up once" : null, fu1_at: null, fu2_at: null, hours_to_quote: q ? 5 : null,
  }));
}

export function ads(): AdsKpis {
  const spend = [310, 280, 0, 0, 420, 650, 820, 760, 540, 480, 610, 920];
  const monthly = spend.map((v, i) => {
    const d = new Date(Date.UTC(2025, 10 + i, 1));
    return { month: d.toISOString().slice(0, 10), spend: v, leads: Math.round(v / 24), new_customers: Math.round(v / 70) + 4, new_value: Math.round(v * 3.4) + 2400 };
  });
  return {
    spend: 920, impressions: 61240, link_clicks: 1184, clicks: 1610, meta_leads: 38, days_with_spend: 24,
    form_leads: 33, new_customers: 22, new_customer_value: 17350,
    attributed: { form_leads: 33, matched: 21, quoted: 14, booked: 8, booked_value: 6240, realized_revenue: 3980 },
    campaigns: [
      { campaign_id: "1", name: "Christmas lights 2026", spend: 540, impressions: 38200, link_clicks: 702, leads: 24, first_day: "2026-10-01", last_day: "2026-10-24" },
      { campaign_id: "2", name: "Roof softwash", spend: 310, impressions: 19800, link_clicks: 401, leads: 12, first_day: "2026-10-01", last_day: "2026-10-24" },
      { campaign_id: "3", name: "Window cleaning", spend: 70, impressions: 3240, link_clicks: 81, leads: 2, first_day: "2026-10-12", last_day: "2026-10-18" },
    ],
    monthly,
  };
}

export const sales = (): SalesKpis => ({
  sent: 64, sent_value: 58210, approved: 29, approved_value: 24870, avg_approved_value: 857.6, days_to_approve: 1.5, lost: 9, lost_value: 8420,
  waiting: { count: 31, value: 27390, d0_7: 9840, d8_30: 8150, d31_plus: 9400 },
  discount: { pre_discount: 61300, discount: 3090, plan_discount: 1650, rate: 0.05, with_discount_sent: 18, with_discount_won: 11, without_discount_sent: 46, without_discount_won: 18 },
  follow_up: { needed: 22, followed_up: 15, no_phone: 9 },
  by_salesperson: [{ name: "Sample Owner", sent: 41, approved: 19, approved_value: 16020 }, { name: "Second Owner", sent: 23, approved: 10, approved_value: 8850 }],
  to_follow_up: [
    { id: "q1", client_name: "Sample Customer J", client_id: null, value: 6740, sent_at: "2026-10-22T01:30:00Z", days_waiting: 3, last_contact: null },
    { id: "q2", client_name: "Sample Customer K", client_id: null, value: 1507, sent_at: "2026-10-20T16:26:00Z", days_waiting: 5, last_contact: "2026-10-23T18:00:00Z" },
    { id: "q3", client_name: "Sample Customer L", client_id: null, value: 864, sent_at: "2026-10-12T01:13:00Z", days_waiting: 13, last_contact: null },
  ],
});

export const crews = (): CrewKpis => ({
  revenue: 31275, jobs: 37, field_hours: 262, labor_cost: 6840, labor_unpriced_days: 0, crew_days: 29, work_days: 21,
  scheduled_hours: 214, clocked_hours: 241,
  over_days: [{ day: "2026-10-22", name: "Crew member A", scheduled: 6, clocked: 8.5 }, { day: "2026-10-17", name: "Crew member B", scheduled: 5.5, clocked: 7 }],
  overtime_hours: 6.5, paid_hours: 241,
  by_service: [
    { service: "Roof", jobs: 14, revenue: 13400, labor: 2650 }, { service: "Christmas lights", jobs: 11, revenue: 6300, labor: 1720 },
    { service: "Windows", jobs: 12, revenue: 5200, labor: 1180 }, { service: "Gutters", jobs: 10, revenue: 3100, labor: 690 },
    { service: "House wash", jobs: 4, revenue: 3600, labor: 600 }, { service: "Plan discount", jobs: 8, revenue: -400, labor: 0 },
  ],
  by_size: [
    { t: 1, jobs: 6, revenue: 1340, labor: 520, revenue_per_hour: 74 }, { t: 2, jobs: 14, revenue: 6210, labor: 1790, revenue_per_hour: 96 },
    { t: 3, jobs: 9, revenue: 6980, labor: 1600, revenue_per_hour: 118 }, { t: 4, jobs: 6, revenue: 8650, labor: 1810, revenue_per_hour: 131 },
    { t: 5, jobs: 2, revenue: 8095, labor: 1120, revenue_per_hour: 152 },
  ],
});
export const quality = (): QualityKpis => ({
  callbacks: 2, completed_jobs: 37, rework_hours: 3.5, callback_cost: 96.25, unlinked: 0,
  list: [
    { id: "c1", job_number: 741, client_name: "Sample Customer M", created_at: "2026-10-19T18:00:00Z", original_job_number: 702, original_crew: "Crew member A & Crew member B", rework_hours: 2 },
    { id: "c2", job_number: 733, client_name: "Sample Customer N", created_at: "2026-10-08T18:00:00Z", original_job_number: 690, original_crew: "Crew member A", rework_hours: 1.5 },
  ],
  by_person: [{ name: "Crew member A", jobs: 28, callbacks: 2, rate: 0.071 }, { name: "Crew member B", jobs: 19, callbacks: 1, rate: 0.053 }, { name: "Sample Owner", jobs: 9, callbacks: 0, rate: 0 }],
});

export const upsells = (): UpsellKpis => ({
  completed_jobs: 37, upsold_jobs: 9, revenue: 2140, on_site: 1460, quote_add_on: 680, job_revenue: 31275,
  offers: { recorded: 21, offered: 17, accepted: 9, declined: 8, not_a_fit: 4 },
  by_service: [{ service: "Gutters", times: 5, revenue: 990 }, { service: "Windows", times: 3, revenue: 650 }, { service: "Roof", times: 1, revenue: 500 }],
  combos: [{ base: "Roof", add_on: "Gutters", jobs: 4, revenue: 820 }, { base: "Windows", add_on: "Gutters", jobs: 2, revenue: 330 }, { base: "House wash", add_on: "Windows", jobs: 2, revenue: 450 }],
  by_person: [{ name: "Crew member A", jobs: 24, upsold_jobs: 7, revenue: 940, hours: 168 }, { name: "Crew member B", jobs: 15, upsold_jobs: 3, revenue: 410, hours: 94 }, { name: "Sample Owner", jobs: 9, upsold_jobs: 2, revenue: 790, hours: 41 }],
});
export const customers = (): CustomerKpis => ({
  customers: 34, revenue: 31275, jobs: 37, new_customers: 22, new_revenue: 19840, returning_revenue: 11435,
  first_job_avg: 902, reactivated: 2, reactivated_revenue: 1240, lifetime_avg: 1130, lifetime_avg_2yr: 1890, all_customers: 1180,
  repeat_rate: 0.31, repeat_base: 640, second_job_rate: 0.22, second_job_base: 210, retention: 0.38, retention_base: 290,
  days_between: 168, jobs_per_customer_12m: 1.4, cross_service: 0.27,
  top_customers: [
    { home_key: "a", jobs: 9, lifetime: 7420, first_at: "2024-04-10T00:00:00Z", last_at: "2026-10-02T00:00:00Z", name: "Sample Customer A" },
    { home_key: "b", jobs: 6, lifetime: 5110, first_at: "2024-08-01T00:00:00Z", last_at: "2026-09-14T00:00:00Z", name: "Sample Customer B" },
  ],
});
export const planExtras = (): PlanExtras => ({
  mrr: 1925, avg_plan_value: 745, renewal_rate: 0.78, renewal_base: 18, cancellation_rate: 0.16,
  plan_upsell_revenue: 1380, plan_lifetime_avg: 2140, non_plan_lifetime_avg: 890,
});

export const financial = (): FinancialKpis => ({
  settings: { crew_hours_per_day: 8, work_days_per_week: 6, trucks: 2 },
  revenue: 31275, invoiced: 28910, collected: 24180, labor_cost: 6840, headcount: 4, field_headcount: 4,
  open_ar: 6700, invoiced_90d: 92400, available_hours: 342, scheduled_hours: 236,
  next7_available: 96, next7_booked: 71, next14_available: 192, next14_booked: 118,
  booked_jobs: 41, cancelled_jobs: 2, cancelled_value: 1140, booking_lead_days: 9.5,
  by_zip: [{ zip: "98513", jobs: 9, revenue: 8120, gross_after_labor: 6340 }, { zip: "98516", jobs: 8, revenue: 7340, gross_after_labor: 5810 }, { zip: "98502", jobs: 6, revenue: 4980, gross_after_labor: 3900 }],
  forecast: [], snapshots: 1,
});
export const alerts = (): Alerts => ({
  leads_waiting: 2, follow_ups_due: 2, missed_not_returned: 1, big_quotes_no_follow_up: 3, plans_need_booking: 6, long_crew_days: 1,
  next7_utilization: 0.74, callback_rate_30: 0.054, callback_rate_prior: 0.031, approval_rate_30: 0.41, approval_rate_prior: 0.47,
});

export const reviews = (): ReviewKpis => ({
  connected: true, source: "places", average_all: 4.9, total_all: 187, reviews: 9, average: 4.78, five_star: 8, low: 1, completed_jobs: 37,
  replied: 7, reply_hours: 5.5, requests: 24, matched: 6,
  by_person: [{ name: "Crew member A", reviews: 5, average: 5, five_star: 5 }, { name: "Crew member B", reviews: 3, average: 4.67, five_star: 2 }],
  recent: [
    { id: "r1", stars: 5, reviewer_name: "Sample Reviewer A", created_at: "2026-10-23T18:00:00Z", comment: "Roof looks brand new. The crew was quick, polite and cleaned up everything.", replied: true, crew: "Crew member A & Crew member B" },
    { id: "r2", stars: 4, reviewer_name: "Sample Reviewer B", created_at: "2026-10-19T18:00:00Z", comment: "Windows look great, arrived a little later than planned.", replied: false, crew: "Crew member B" },
  ],
});
