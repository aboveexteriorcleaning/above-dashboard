import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Aging, BarRows, MoneyFlow, Stat, Trend } from "@/components/charts";
import { getAlerts, getOverview, getTrend } from "@/lib/data";
import { previousPeriod, resolvePeriod } from "@/lib/periods";
import * as ch from "@/lib/change";
import { money, n, pct, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Overview({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod((await searchParams).p);
  const prev = previousPeriod(period);
  const [o, trend, al, po] = await Promise.all([getOverview(period.from, period.to), getTrend(), getAlerts(), prev ? getOverview(prev.from, prev.to) : null]);
  const r = o.revenue, pr = po?.revenue;
  const alerts: { text: string; href: string }[] = [];
  if (al.leads_waiting) alerts.push({ text: `${al.leads_waiting} new ${al.leads_waiting === 1 ? "lead has" : "leads have"} no reply yet`, href: "/leads#list" });
  if (al.follow_ups_due) alerts.push({ text: `${al.follow_ups_due} lead ${al.follow_ups_due === 1 ? "follow-up is" : "follow-ups are"} due`, href: "/leads#list" });
  if (al.missed_not_returned) alerts.push({ text: `${al.missed_not_returned} missed ${al.missed_not_returned === 1 ? "call" : "calls"} from the last 3 days not returned`, href: "/leads" });
  if (al.big_quotes_no_follow_up) alerts.push({ text: `${al.big_quotes_no_follow_up} quotes over $1,000 waiting 3+ days with no call or text`, href: "/sales#fu-h" });
  if (al.plans_need_booking) alerts.push({ text: `${al.plans_need_booking} plan ${al.plans_need_booking === 1 ? "home needs" : "homes need"} the next visit booked`, href: "/plans#sheet" });
  if (al.long_crew_days) alerts.push({ text: `${al.long_crew_days} crew ${al.long_crew_days === 1 ? "day" : "days"} this week ran over an hour past the schedule`, href: "/crews#over-h" });
  if (al.next7_utilization != null && al.next7_utilization < 0.6) alerts.push({ text: `Only ${pct(al.next7_utilization)} of the next 7 days is booked`, href: "/financial#cap-h" });
  if (al.callback_rate_30 != null && al.callback_rate_prior != null && al.callback_rate_30 > al.callback_rate_prior + 0.02)
    alerts.push({ text: `Callbacks are up: ${pct(al.callback_rate_30)} of jobs in the last 30 days vs ${pct(al.callback_rate_prior)} before`, href: "/quality" });
  if (al.approval_rate_30 != null && al.approval_rate_prior != null && al.approval_rate_30 < al.approval_rate_prior - 0.1)
    alerts.push({ text: `Quote approvals dropped: ${pct(al.approval_rate_30)} in the last 30 days vs ${pct(al.approval_rate_prior)} before`, href: "/sales" });
  return (
    <Shell page="overview" session={session}>
          <main>
            <div className="pagehead">
              <div>
                <h1>Business overview</h1>
                <p className="muted" style={{ margin: "6px 0 0" }}>
                  {period.label}, {shortDate(period.from + "T12:00:00Z")} to {shortDate(period.to + "T12:00:00Z")}
                </p>
              </div>
              <Periods current={period.key} base="/overview" period={period} />
            </div>

            {alerts.length > 0 && (
              <section className="alerts" aria-labelledby="al-h">
                <h2 id="al-h">Needs attention</h2>
                <ul>{alerts.map((x) => <li key={x.text}><a href={x.href}>{x.text}</a></li>)}</ul>
              </section>
            )}

            <MoneyFlow stages={[
              { label: "Booked", value: r.booked, note: `${n(r.booked_jobs)} jobs scheduled or sold`, change: ch.pct(r.booked, pr?.booked, "up", money) },
              { label: "Completed", value: r.completed, note: `${n(r.completed_jobs)} jobs done`, change: ch.pct(r.completed, pr?.completed, "up", money) },
              { label: "Invoiced", value: r.invoiced, note: "Before tax", change: ch.pct(r.invoiced, pr?.invoiced, "up", money) },
              { label: "Paid", value: r.paid_on_period_invoices, change: ch.pct(r.paid_on_period_invoices, pr?.paid_on_period_invoices, "up", money), note: `Collected on this period's invoices, out of ${money(r.invoiced_incl_tax)} with tax` },
            ]} />

            <section className="section" aria-labelledby="ahead">
              <div className="section-head"><h2 id="ahead">Work on the schedule</h2></div>
              <div className="stats">
                <Stat value={money(o.booked_ahead.d7)} label="Next 7 days" />
                <Stat value={money(o.booked_ahead.d14)} label="Next 14 days" />
                <Stat value={money(o.booked_ahead.d30)} label="Next 30 days"
                  note={o.booked_ahead.recurring_jobs_in_window ? `Includes ${o.booked_ahead.recurring_jobs_in_window} recurring jobs at full contract value` : undefined} />
                <Stat value={money(r.avg_job_value)} label="Average completed job" change={ch.pct(r.avg_job_value, pr?.avg_job_value, "up", money)} />
              </div>
            </section>

            <div className="grid-2 section">
              <section aria-labelledby="sales">
                <div className="section-head"><h2 id="sales">Quotes</h2></div>
                <div className="stats">
                  <Stat value={pct(o.quotes.win_rate)} label="Approval rate" change={ch.pts(o.quotes.win_rate, po?.quotes.win_rate)} note={`${n(o.quotes.won)} approved, ${n(o.quotes.sent)} sent this period`} />
                  <Stat value={money(o.quotes.open_value)} label="Still waiting" change={ch.pct(o.quotes.open_value, po?.quotes.open_value, "none", money)} note="Sent this period, no reply yet (before tax)" />
                </div>
              </section>
              <section aria-labelledby="customers">
                <div className="section-head"><h2 id="customers">Customers</h2></div>
                <div className="stats">
                  <Stat value={n(o.customers.new)} label="First-time customers" change={ch.pct(o.customers.new, po?.customers.new)} note="Counted by address" />
                  <Stat value={n(o.customers.returning_own)} label="Came back on their own" change={ch.pct(o.customers.returning_own, po?.customers.returning_own)} note="Returning for any service, not a plan visit" />
                  <Stat value={n(o.customers.returning_plan)} label="Plan visits" change={ch.pct(o.customers.returning_plan, po?.customers.returning_plan)} note="Returning for a scheduled plan visit" />
                  <Stat value={n(o.customers.active_plans)} label="Homes on a maintenance plan" note="Next plan visit booked, or a plan visit within the last cycle" />
                  <Stat value={n(o.quality.callbacks)} label="Callbacks" change={ch.pct(o.quality.callbacks, po?.quality.callbacks, "down")}
                    note={o.quality.callback_rate != null ? `${pct(o.quality.callback_rate)} of completed jobs` : undefined}
                    tone={o.quality.callbacks > 0 ? "down" : undefined} />
                </div>
              </section>
            </div>

            <section className="section panel" aria-labelledby="trend">
              <div className="section-head"><h2 id="trend">Completed revenue by month</h2><span className="muted small">Last 12 months</span></div>
              <Trend rows={trend} />
            </section>

            <div className="grid-2 section">
              <section aria-labelledby="svc">
                <div className="section-head"><h2 id="svc">By service</h2></div>
                <BarRows label="Service" extra="Jobs" rows={o.by_service.map((s) => ({ key: s.service, label: s.service, value: s.revenue, sub: n(s.jobs) }))} />
                {o.by_service.some((s) => s.revenue < 0) && <p className="muted small">Negative rows are plan discounts.</p>}
              </section>
              <section aria-labelledby="zip">
                <div className="section-head"><h2 id="zip">By area</h2></div>
                <BarRows label="ZIP code" extra="Jobs" rows={o.by_zip.map((z) => ({ key: z.zip, label: <>{z.zip} <span className="muted">{z.city}</span></>, value: z.revenue, sub: n(z.jobs) }))} />
              </section>
            </div>

            <section className="section" aria-labelledby="ar">
              <div className="section-head"><h2 id="ar">Unpaid invoices</h2><span className="muted small">{n(o.receivables.open_invoices)} open, as of now</span></div>
              <Aging r={o.receivables} />
            </section>
          </main>
    </Shell>
  );
}
