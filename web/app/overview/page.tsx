import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Aging, BarRows, MoneyFlow, Stat, Trend } from "@/components/charts";
import { getOverview, getTrend } from "@/lib/data";
import { resolvePeriod } from "@/lib/periods";
import { change, money, n, pct, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Overview({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod((await searchParams).p);
  const [o, trend] = await Promise.all([getOverview(period.from, period.to), getTrend()]);
  const vsPrev = change(o.revenue.completed, o.revenue.completed_prev_period);
  const r = o.revenue;
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
              <Periods current={period.key} base="/overview" />
            </div>

            <MoneyFlow stages={[
              { label: "Booked", value: r.booked, note: `${n(r.booked_jobs)} jobs scheduled or sold` },
              { label: "Completed", value: r.completed, note: `${n(r.completed_jobs)} jobs done${vsPrev == null ? "" : `, ${vsPrev >= 0 ? "up" : "down"} ${pct(Math.abs(vsPrev))} on the period before`}` },
              { label: "Invoiced", value: r.invoiced, note: "Before tax" },
              { label: "Paid", value: r.paid_on_period_invoices, note: `Collected on this period's invoices, out of ${money(r.invoiced_incl_tax)} with tax` },
            ]} />

            <section className="section" aria-labelledby="ahead">
              <div className="section-head"><h2 id="ahead">Work on the schedule</h2></div>
              <div className="stats">
                <Stat value={money(o.booked_ahead.d7)} label="Next 7 days" />
                <Stat value={money(o.booked_ahead.d14)} label="Next 14 days" />
                <Stat value={money(o.booked_ahead.d30)} label="Next 30 days"
                  note={o.booked_ahead.recurring_jobs_in_window ? `Includes ${o.booked_ahead.recurring_jobs_in_window} recurring jobs at full contract value` : undefined} />
                <Stat value={money(r.avg_job_value)} label="Average completed job" />
              </div>
            </section>

            <div className="grid-2 section">
              <section aria-labelledby="sales">
                <div className="section-head"><h2 id="sales">Quotes</h2></div>
                <div className="stats">
                  <Stat value={pct(o.quotes.win_rate)} label="Approval rate" note={`${n(o.quotes.won)} approved, ${n(o.quotes.sent)} sent this period`} />
                  <Stat value={money(o.quotes.open_value)} label="Still waiting" note="Sent this period, not yet approved" />
                </div>
              </section>
              <section aria-labelledby="customers">
                <div className="section-head"><h2 id="customers">Customers</h2></div>
                <div className="stats">
                  <Stat value={n(o.customers.new)} label="First-time customers" note="Counted by address" />
                  <Stat value={n(o.customers.returning_own)} label="Came back on their own" note="Returning for any service, not a plan visit" />
                  <Stat value={n(o.customers.returning_plan)} label="Plan visits" note="Returning for a scheduled plan visit" />
                  <Stat value={n(o.customers.active_plans)} label="Homes on a maintenance plan" note="Next plan visit booked, or a plan visit within the last cycle" />
                  <Stat value={n(o.quality.callbacks)} label="Callbacks"
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
