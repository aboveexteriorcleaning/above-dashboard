import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { getFinancial } from "@/lib/data";
import { previousPeriod, resolvePeriod } from "@/lib/periods";
import * as ch from "@/lib/change";
import { money, n, pct, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";
const per = (a: number, b: number) => (b ? a / b : null);

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function dayList(days: number[]) {
  const d = [...days].sort();
  const run = d.length > 2 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return run ? `${DAY_NAMES[d[0] - 1]}–${DAY_NAMES[d[d.length - 1] - 1]}` : d.map((x) => DAY_NAMES[x - 1]).join(", ");
}

export default async function Financial({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod((await searchParams).p);
  const prev = previousPeriod(period);
  const [f, pf] = await Promise.all([getFinancial(period.from, period.to), prev ? getFinancial(prev.from, prev.to) : null]);
  const days = Math.round((new Date(period.to).getTime() - new Date(period.from).getTime()) / 86400000) + 1;
  const dso = f.invoiced_90d ? (f.open_ar / f.invoiced_90d) * 90 : null;

  return (
    <Shell page="financial" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Financial</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>{period.label}, {shortDate(period.from + "T12:00:00Z")} to {shortDate(period.to + "T12:00:00Z")}</p>
          </div>
          <Periods current={period.key} base="/financial" period={period} />
        </div>

        <section aria-labelledby="rev-h">
          <div className="section-head"><h2 id="rev-h">Revenue and margin</h2><span className="muted small">Completed, invoiced and collected kept separate</span></div>
          <div className="stats">
            <Stat value={money(f.revenue)} label="Completed revenue" change={ch.pct(f.revenue, pf?.revenue, "up", money)} note="Before tax" />
            <Stat value={money(f.invoiced)} label="Invoiced" change={ch.pct(f.invoiced, pf?.invoiced, "up", money)} note={`${money(f.collected)} collected on these invoices`} />
            <Stat value={pct(per(f.revenue - f.labor_cost, f.revenue))} label="Gross margin after labor" change={ch.pts(per(f.revenue - f.labor_cost, f.revenue), pf && per(pf.revenue - pf.labor_cost, pf.revenue))} note={`${money(f.revenue - f.labor_cost)} after ${money(f.labor_cost)} crew labor; materials not included`} />
            <Stat value={money(per(f.revenue, f.headcount))} label="Revenue per team member" change={ch.pct(per(f.revenue, f.headcount), pf && per(pf.revenue, pf.headcount), "up", money)} note={`${n(f.headcount)} active; ${money(per(f.revenue, f.field_headcount))} per field worker (${n(f.field_headcount)})`} />
            <Stat value={money(per(f.revenue, f.settings.trucks))} label="Revenue per truck" change={ch.pct(per(f.revenue, f.settings.trucks), pf && per(pf.revenue, pf.settings.trucks), "up", money)} note={`${n(f.settings.trucks)} trucks (set on the Team page)`} />
          </div>
        </section>

        <section className="section" aria-labelledby="cap-h">
          <div className="section-head"><h2 id="cap-h">Capacity</h2><span className="muted small">{n(f.settings.trucks)} trucks × {n(f.settings.crew_hours_per_day - f.settings.drive_hours_per_day)} schedulable hr ({f.settings.crew_hours_per_day} hr day − {f.settings.drive_hours_per_day} hr drive) × {dayList(f.settings.work_weekdays)}</span></div>
          <div className="stats">
            <Stat value={pct(per(f.scheduled_hours, f.available_hours))} label="Schedule utilization" change={ch.pts(per(f.scheduled_hours, f.available_hours), pf && per(pf.scheduled_hours, pf.available_hours))} note={`${n(f.scheduled_hours)} scheduled of ${n(f.available_hours)} available truck hours so far this period`} />
            <Stat value={money(per(f.revenue, f.available_hours))} label="Revenue per available crew hour" change={ch.pct(per(f.revenue, f.available_hours), pf && per(pf.revenue, pf.available_hours), "up", money)} />
            <Stat value={pct(per(f.next7_booked, f.next7_available))} label="Next 7 days booked" note={`${n(Math.max(f.next7_available - f.next7_booked, 0))} truck hours still open`} tone={per(f.next7_booked, f.next7_available) != null && f.next7_booked / f.next7_available < 0.6 ? "down" : undefined} />
            <Stat value={pct(per(f.next14_booked, f.next14_available))} label="Next 14 days booked" note={`${n(Math.max(f.next14_available - f.next14_booked, 0))} truck hours still open`} />
            <Stat value={f.booking_lead_days == null ? "—" : `${f.booking_lead_days} days`} label="Booking lead time" change={ch.pct(f.booking_lead_days, pf?.booking_lead_days, "none")} note="Median days from booking to the visit" />
          </div>
        </section>

        <div className="grid-2 section">
          <section aria-labelledby="ar-h">
            <div className="section-head"><h2 id="ar-h">Cash</h2></div>
            <div className="stats">
              <Stat value={money(f.open_ar)} label="Unpaid invoices" note="As of now" />
              <Stat value={dso == null ? "—" : `${Math.round(dso)} days`} label="Days sales outstanding" note="Unpaid ÷ last 90 days invoiced × 90" />
            </div>
          </section>
          <section aria-labelledby="can-h">
            <div className="section-head"><h2 id="can-h">Cancellations</h2><span className="muted small">Jobs booked this period</span></div>
            <div className="stats">
              <Stat value={pct(per(f.cancelled_jobs, f.booked_jobs))} label="Cancellation rate" change={ch.pts(per(f.cancelled_jobs, f.booked_jobs), pf && per(pf.cancelled_jobs, pf.booked_jobs), "down")} note={`${n(f.cancelled_jobs)} of ${n(f.booked_jobs)} archived or deleted without being done`} />
              <Stat value={money(f.cancelled_value)} label="Revenue lost to cancellations" change={ch.pct(f.cancelled_value, pf?.cancelled_value, "down", money)} />
            </div>
          </section>
        </div>

        <div className="grid-2 section">
          <section aria-labelledby="zip-h">
            <div className="section-head"><h2 id="zip-h">By area</h2><span className="muted small">Completed jobs</span></div>
            <table className="rows">
              <thead><tr><th>ZIP</th><th className="num">Jobs</th><th className="num">Revenue</th><th className="num">After labor</th></tr></thead>
              <tbody>{f.by_zip.map((z) => (
                <tr key={z.zip}><td>{z.zip}</td><td className="num">{n(z.jobs)}</td><td className="num">{money(z.revenue)}</td><td className="num">{money(z.gross_after_labor)}</td></tr>
              ))}</tbody>
            </table>
          </section>
          <section aria-labelledby="fc-h">
            <div className="section-head"><h2 id="fc-h">Forecast accuracy</h2><span className="muted small">Booked next 30 days vs what was completed</span></div>
            {f.forecast.length ? (
              <table className="rows">
                <thead><tr><th>Snapshot</th><th className="num">Booked then</th><th className="num">Completed</th><th className="num">Difference</th></tr></thead>
                <tbody>{f.forecast.map((x) => (
                  <tr key={x.day}><td>{shortDate(x.day + "T12:00:00Z")}</td><td className="num">{money(x.booked_30)}</td><td className="num">{money(x.actual)}</td>
                    <td className="num">{pct(per(x.actual - x.booked_30, x.booked_30))}</td></tr>
                ))}</tbody>
              </table>
            ) : <p className="muted">A snapshot of the next 30 days is saved every night ({n(f.snapshots)} so far). Accuracy shows here once the first one is 30 days old.</p>}
          </section>
        </div>

        <p className="muted small section" style={{ maxWidth: "75ch" }}>
          Not available yet: net profit and contribution margin (need accounting data), overtime by week is on Crew economics,
          reschedule rate (needs visit history), and weather-related lost production (needs a way to mark weather days).
        </p>
      </main>
    </Shell>
  );
}
