import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { BarRows, Stat, Trend } from "@/components/charts";
import { PlanSheet } from "@/components/PlanSheet";
import { getPlanCustomers, getPlanKpis } from "@/lib/data";
import { resolvePeriod } from "@/lib/periods";
import { money, n, pct, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const mon = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export default async function Plans({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod((await searchParams).p);
  const [k, customers] = await Promise.all([getPlanKpis(period.from, period.to), getPlanCustomers()]);
  const st = k.status;
  const flagged = (st.overdue ?? 0) + (st.not_booked ?? 0) + (st.needs_date ?? 0) + (st.booked_late ?? 0);

  return (
    <Shell page="plans" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Maintenance plans</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>
              {period.label}, {shortDate(period.from + "T12:00:00Z")} to {shortDate(period.to + "T12:00:00Z")}
            </p>
          </div>
          <Periods current={period.key} base="/plans" />
        </div>

        {flagged > 0 && (
          <a href="#sheet" className="attention">
            <strong>{n(flagged)} plan {flagged === 1 ? "home needs" : "homes need"} attention</strong>
            <span>
              {[st.overdue && `${st.overdue} overdue`, st.not_booked && `${st.not_booked} not booked`,
                st.needs_date && `${st.needs_date} need a date`, st.booked_late && `${st.booked_late} booked late`].filter(Boolean).join(" · ")}
            </span>
          </a>
        )}

        <section aria-labelledby="period-h">
          <div className="section-head"><h2 id="period-h">This period</h2></div>
          <div className="stats">
            <Stat value={money(k.revenue)} label="Plan revenue"
              note={`${n(k.visits)} plan visits${k.share_of_revenue != null ? `, ${pct(k.share_of_revenue)} of completed revenue` : ""}`} />
            <Stat value={money(k.avg_visit)} label="Average plan visit" />
            <Stat value={money(k.discounts)} label="Plan discounts given" note="Total of the plan line items" />
            <Stat value={n(k.signups)} label="New plan homes" note="First plan job created this period" />
          </div>
        </section>

        <section className="section" aria-labelledby="now-h">
          <div className="section-head"><h2 id="now-h">Right now</h2></div>
          <div className="stats">
            <Stat value={n(k.homes)} label="Homes on a plan" note={`${n(st.on_schedule ?? 0)} with the next visit booked on time`} />
            <Stat value={money(k.annual_value)} label="Annual plan value" note="Each home's visit price × visits per year" />
            <Stat value={money(k.booked_ahead)} label="Plan work booked ahead" note={`${n(k.booked_ahead_visits)} upcoming plan visits`} />
            <Stat value={money(k.revenue_to_date)} label="Plan revenue, all time" />
          </div>
        </section>

        <section className="section panel" aria-labelledby="trend-h">
          <div className="section-head"><h2 id="trend-h">Plan revenue by month</h2><span className="muted small">Last 12 months, completed plan visits</span></div>
          <Trend rows={k.monthly} label="Completed plan revenue by month" unit="plan visits" />
        </section>

        <div className="grid-2 section">
          <section aria-labelledby="ahead-h">
            <div className="section-head"><h2 id="ahead-h">Booked plan visits</h2><span className="muted small">Next 6 months</span></div>
            <BarRows label="Month" valueLabel="Booked" extra="Visits"
              rows={k.ahead.map((a) => ({ key: a.month, label: mon(a.month), value: a.value, sub: n(a.visits) }))} />
          </section>
          <section aria-labelledby="byplan-h">
            <div className="section-head"><h2 id="byplan-h">By plan</h2><span className="muted small">Homes now, revenue this period</span></div>
            {k.by_plan.length ? (
              <table className="rows">
                <thead><tr><th>Plan</th><th className="num">Per year</th><th className="num">Homes</th><th className="num">Revenue</th></tr></thead>
                <tbody>
                  {k.by_plan.map((p) => (
                    <tr key={p.plan}><td>{p.plan.replace(/ Plan$/, "")}</td><td className="num">{n(p.per_year)}</td><td className="num">{n(p.homes)}</td><td className="num">{money(p.revenue)}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted">No active plans yet.</p>}
          </section>
        </div>

        <section className="section" id="sheet" aria-labelledby="sheet-h">
          <div className="section-head"><h2 id="sheet-h">Plan customers</h2><span className="muted small">{n(customers.length)} homes, as of now</span></div>
          <PlanSheet rows={customers} />
        </section>
      </main>
    </Shell>
  );
}
