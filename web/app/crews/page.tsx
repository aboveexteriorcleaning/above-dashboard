import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { BarRows, Stat } from "@/components/charts";
import { getCrews } from "@/lib/data";
import { previousPeriod, resolvePeriod, type PeriodParams, periodLine } from "@/lib/periods";
import * as ch from "@/lib/change";
import { money, n, pct, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";
const per = (a: number, b: number) => (b ? a / b : null);
const TIERS = ["Under $300", "$300–600", "$600–1,000", "$1,000–2,000", "$2,000+"];

export default async function Crews({ searchParams }: { searchParams: Promise<PeriodParams> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod(await searchParams);
  const prev = previousPeriod(period);
  const [c, pc] = await Promise.all([getCrews(period.from, period.to), prev ? getCrews(prev.from, prev.to) : null]);
  const gp = c.revenue - c.labor_cost, pgp = pc ? pc.revenue - pc.labor_cost : null;

  return (
    <Shell page="crews" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Crew economics</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>{periodLine(period, shortDate)}</p>
          </div>
          <Periods current={period.key} base="/crews" period={period} />
        </div>

        {c.labor_unpriced_days > 0 && (
          <p className="notice warn">{n(c.labor_unpriced_days)} crew days have no base wage on file, so their pay isn&rsquo;t included. Add wages on the Team page.</p>
        )}

        <section aria-labelledby="prod-h">
          <div className="section-head"><h2 id="prod-h">Productivity</h2><span className="muted small">Completed jobs</span></div>
          <div className="stats">
            <Stat value={money(per(c.revenue, c.field_hours))} label="Revenue per labor hour" change={ch.pct(per(c.revenue, c.field_hours), pc && per(pc.revenue, pc.field_hours), "up", money)} note={`${money(c.revenue)} over ${n(c.field_hours)} field hours`} />
            <Stat value={money(per(c.revenue, c.crew_days))} label="Revenue per crew day" change={ch.pct(per(c.revenue, c.crew_days), pc && per(pc.revenue, pc.crew_days), "up", money)} note={`${n(c.crew_days)} crew days (same crew, same day)`} />
            <Stat value={per(c.jobs, c.crew_days)?.toFixed(1) ?? "—"} label="Jobs per crew day" change={ch.pct(per(c.jobs, c.crew_days), pc && per(pc.jobs, pc.crew_days))} note={`${n(c.jobs)} jobs`} />
            <Stat value={pct(per(c.clocked_hours - c.scheduled_hours, c.scheduled_hours))} label="Clocked vs scheduled" change={ch.pts(per(c.clocked_hours - c.scheduled_hours, c.scheduled_hours), pc && per(pc.clocked_hours - pc.scheduled_hours, pc.scheduled_hours), "down")}
              note={`${n(c.clocked_hours)} clocked vs ${n(c.scheduled_hours)} scheduled crew hours`} tone={c.clocked_hours > c.scheduled_hours * 1.1 ? "down" : undefined} />
          </div>
        </section>

        <section className="section" aria-labelledby="margin-h">
          <div className="section-head"><h2 id="margin-h">Labor and margin</h2><span className="muted small">Labor only: materials not included yet</span></div>
          <div className="stats">
            <Stat value={money(c.labor_cost)} label="Crew labor cost" change={ch.pct(c.labor_cost, pc?.labor_cost, "none", money)} note="Daily pay (commission or hourly, whichever is higher) plus payroll costs" />
            <Stat value={pct(per(c.labor_cost, c.revenue))} label="Labor cost %" change={ch.pts(per(c.labor_cost, c.revenue), pc && per(pc.labor_cost, pc.revenue), "down")} />
            <Stat value={pct(per(gp, c.revenue))} label="Gross margin after labor" change={ch.pts(per(gp, c.revenue), pc && pgp != null ? per(pgp, pc.revenue) : null)} note={`${money(gp)} after crew labor`} />
            <Stat value={money(per(gp, c.field_hours))} label="Gross profit per labor hour" change={ch.pct(per(gp, c.field_hours), pc && pgp != null ? per(pgp, pc.field_hours) : null, "up", money)} />
            <Stat value={pct(per(c.overtime_hours, c.paid_hours))} label="Overtime" change={ch.pts(per(c.overtime_hours, c.paid_hours), pc && per(pc.overtime_hours, pc.paid_hours), "down")} note={`${n(c.overtime_hours)} of ${n(c.paid_hours)} paid hours over 40 a week`} />
          </div>
          <p className="muted small" style={{ maxWidth: "75ch" }}>Owners aren&rsquo;t paid hourly, so jobs they do alone carry no labor cost here; field hours use their scheduled time.</p>
        </section>

        <div className="grid-2 section">
          <section aria-labelledby="svc-h">
            <div className="section-head"><h2 id="svc-h">Margin by service</h2></div>
            <table className="rows">
              <thead><tr><th>Service</th><th className="num">Revenue</th><th className="num">Labor</th><th className="num">Margin</th></tr></thead>
              <tbody>{c.by_service.map((s) => (
                <tr key={s.service}><td>{s.service}<div className="small muted">{n(s.jobs)} jobs</div></td><td className="num">{money(s.revenue)}</td>
                  <td className="num">{money(s.labor)}</td><td className="num">{s.revenue > 0 ? pct((s.revenue - s.labor) / s.revenue) : "—"}</td></tr>
              ))}</tbody>
            </table>
            <p className="muted small">Each job&rsquo;s labor is split across its services by price.</p>
          </section>
          <section aria-labelledby="size-h">
            <div className="section-head"><h2 id="size-h">By job size</h2></div>
            <table className="rows">
              <thead><tr><th>Job value</th><th className="num">Jobs</th><th className="num">Margin</th><th className="num">Per crew hour</th></tr></thead>
              <tbody>{c.by_size.map((s) => (
                <tr key={s.t}><td>{TIERS[s.t - 1]}</td><td className="num">{n(s.jobs)}</td>
                  <td className="num">{s.revenue > 0 ? pct((s.revenue - s.labor) / s.revenue) : "—"}</td><td className="num">{money(s.revenue_per_hour)}</td></tr>
              ))}</tbody>
            </table>
            <p className="muted small">Per crew hour uses scheduled visit time × crew size.</p>
          </section>
        </div>

        <section className="section" aria-labelledby="over-h">
          <div className="section-head"><h2 id="over-h">Days that ran long</h2><span className="muted small">Clocked more than an hour over the scheduled visits</span></div>
          {c.over_days.length ? (
            <table className="rows">
              <thead><tr><th>Day</th><th>Person</th><th className="num">Scheduled</th><th className="num">Clocked</th></tr></thead>
              <tbody>{c.over_days.map((d) => (
                <tr key={d.day + d.name}><td>{shortDate(d.day + "T12:00:00Z")}</td><td>{d.name}</td><td className="num">{n(d.scheduled)} hr</td><td className="num down">{n(d.clocked)} hr</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="muted">None in this period.</p>}
          <p className="muted small" style={{ maxWidth: "75ch" }}>Crews clock in for the day, not per job, so this compares the whole day: drive time and breaks are inside the clocked hours. Drive time per job and travel % need GPS or per-job clock-ins. Revenue per truck is on the Financial page.</p>
        </section>
      </main>
    </Shell>
  );
}
