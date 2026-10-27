import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { getCustomers } from "@/lib/data";
import { previousPeriod, resolvePeriod } from "@/lib/periods";
import * as ch from "@/lib/change";
import { money, n, pct, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";
const per = (a: number, b: number) => (b ? a / b : null);

export default async function Customers({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod((await searchParams).p);
  const prev = previousPeriod(period);
  const [c, pc] = await Promise.all([getCustomers(period.from, period.to), prev ? getCustomers(prev.from, prev.to) : null]);

  return (
    <Shell page="customers" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Customers</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>{period.label}, {shortDate(period.from + "T12:00:00Z")} to {shortDate(period.to + "T12:00:00Z")} · counted by address</p>
          </div>
          <Periods current={period.key} base="/customers" period={period} />
        </div>

        <section aria-labelledby="p-h">
          <div className="section-head"><h2 id="p-h">This period</h2><span className="muted small">Completed jobs</span></div>
          <div className="stats">
            <Stat value={n(c.customers)} label="Customers served" change={ch.pct(c.customers, pc?.customers)} note={`${n(c.jobs)} jobs`} />
            <Stat value={money(per(c.revenue, c.customers))} label="Revenue per customer" change={ch.pct(per(c.revenue, c.customers), pc && per(pc.revenue, pc.customers), "up", money)} />
            <Stat value={pct(per(c.new_revenue, c.revenue))} label="Revenue from new customers" change={ch.pts(per(c.new_revenue, c.revenue), pc && per(pc.new_revenue, pc.revenue), "none")} note={`${n(c.new_customers)} new, ${money(c.new_revenue)}; returning ${money(c.returning_revenue)}`} />
            <Stat value={money(c.first_job_avg)} label="Average first job" change={ch.pct(c.first_job_avg, pc?.first_job_avg, "up", money)} />
            <Stat value={n(c.reactivated)} label="Reactivated" change={ch.pct(c.reactivated, pc?.reactivated)} note={`Back after 18+ months away; ${money(c.reactivated_revenue)}`} />
          </div>
        </section>

        <section className="section" aria-labelledby="r-h">
          <div className="section-head"><h2 id="r-h">Retention and lifetime value</h2><span className="muted small">All history, as of now</span></div>
          <div className="stats">
            <Stat value={money(c.lifetime_avg)} label="Lifetime value" note={`Average completed revenue per customer; ${money(c.lifetime_avg_2yr)} for customers with us 2+ years`} />
            <Stat value={pct(c.repeat_rate)} label="Repeat customer rate" note={`Of ${n(c.repeat_base)} customers whose first job was over a year ago, share who came back`} />
            <Stat value={pct(c.second_job_rate)} label="Second job within a year" note={`${n(c.second_job_base)} customers whose first job was 12–24 months ago`} />
            <Stat value={pct(c.retention)} label="Year-over-year retention" note={`Of ${n(c.retention_base)} customers from the year before, share who bought again in the last 12 months`} />
            <Stat value={c.days_between == null ? "—" : `${n(c.days_between)} days`} label="Time between services" note="Median" />
            <Stat value={c.jobs_per_customer_12m == null ? "—" : String(c.jobs_per_customer_12m)} label="Jobs per customer" note="Last 12 months" />
            <Stat value={pct(c.cross_service)} label="Buy 2+ services" note="Share of customers who've bought more than one kind of service" />
          </div>
        </section>

        <section className="section" aria-labelledby="t-h">
          <div className="section-head"><h2 id="t-h">Top customers by lifetime value</h2></div>
          <table className="rows">
            <thead><tr><th>Customer</th><th className="num">Jobs</th><th className="num">Lifetime</th><th>Customer since</th></tr></thead>
            <tbody>{c.top_customers.map((t) => (
              <tr key={t.home_key}><td>{t.name ?? t.home_key}</td><td className="num">{n(t.jobs)}</td><td className="num">{money(t.lifetime)}</td><td>{new Date(t.first_at).toLocaleDateString("en-US", { month: "short", year: "numeric" })}</td></tr>
            ))}</tbody>
          </table>
          <p className="muted small" style={{ maxWidth: "75ch" }}>Referral rate and referral revenue need the lead source recorded on Jobber clients; acquisition payback and lifetime value to CAC are on the Ads page once ad history builds up.</p>
        </section>
      </main>
    </Shell>
  );
}
