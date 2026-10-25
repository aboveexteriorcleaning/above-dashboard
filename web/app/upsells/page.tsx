import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { getUpsells } from "@/lib/data";
import { resolvePeriod } from "@/lib/periods";
import { money, n, pct, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";
const per = (a: number, b: number) => (b ? a / b : null);

export default async function Upsells({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod((await searchParams).p);
  const u = await getUpsells(period.from, period.to);
  const o = u.offers;

  return (
    <Shell page="upsells" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Upsells</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>{period.label}, {shortDate(period.from + "T12:00:00Z")} to {shortDate(period.to + "T12:00:00Z")}</p>
          </div>
          <Periods current={period.key} base="/upsells" />
        </div>

        <section aria-labelledby="up-h">
          <div className="section-head"><h2 id="up-h">Upsells sold</h2><span className="muted small">Completed jobs; already part of job revenue</span></div>
          <div className="stats">
            <Stat value={money(u.revenue)} label="Upsell revenue" note={`${money(u.on_site)} added on site, ${money(u.quote_add_on)} optional quote items picked; ${pct(per(u.revenue, u.job_revenue))} of job revenue`} />
            <Stat value={pct(per(u.upsold_jobs, u.completed_jobs))} label="Upsell conversion" note={`${n(u.upsold_jobs)} of ${n(u.completed_jobs)} completed jobs`} />
            <Stat value={money(per(u.revenue, u.completed_jobs))} label="Upsell revenue per job" />
            <Stat value={money(per(u.revenue, u.upsold_jobs))} label="Average upsell" note="Per job with an upsell" />
          </div>
        </section>

        <section className="section" aria-labelledby="off-h">
          <div className="section-head"><h2 id="off-h">Upsell offers</h2><span className="muted small">From the &ldquo;Upsell offer&rdquo; field on Jobber jobs</span></div>
          {o.recorded > 0 ? (
            <div className="stats">
              <Stat value={pct(per(o.offered, u.completed_jobs))} label="Offer rate" note={`Offered on ${n(o.offered)} of ${n(u.completed_jobs)} completed jobs`} />
              <Stat value={pct(per(o.accepted, o.offered))} label="Offer acceptance" note={`${n(o.accepted)} accepted, ${n(o.declined)} declined`} />
              <Stat value={money(per(u.revenue, o.offered))} label="Upsell revenue per offer" />
              <Stat value={pct(per(u.completed_jobs - o.recorded, u.completed_jobs))} label="Field left blank" note={`${n(o.not_a_fit)} marked not a fit`} tone={u.completed_jobs - o.recorded > 0 ? "down" : undefined} />
            </div>
          ) : (
            <p className="muted" style={{ maxWidth: "75ch" }}>No offers recorded yet. Once crews fill in the &ldquo;Upsell offer&rdquo; dropdown (Accepted / Declined / Not offered / Not a fit) when completing jobs, offer rate and acceptance show here.</p>
          )}
        </section>

        <div className="grid-2 section">
          <section aria-labelledby="combo-h">
            <div className="section-head"><h2 id="combo-h">What sells with what</h2></div>
            {u.combos.length ? (
              <table className="rows">
                <thead><tr><th>Main service → added</th><th className="num">Jobs</th><th className="num">Revenue</th></tr></thead>
                <tbody>{u.combos.map((c) => (
                  <tr key={c.base + c.add_on}><td>{c.base} → <strong>{c.add_on}</strong></td><td className="num">{n(c.jobs)}</td><td className="num">{money(c.revenue)}</td></tr>
                ))}</tbody>
              </table>
            ) : <p className="muted">No upsells in this period.</p>}
          </section>
          <section aria-labelledby="by-h">
            <div className="section-head"><h2 id="by-h">By person</h2><span className="muted small">Split evenly across the crew, like revenue</span></div>
            <div style={{ overflowX: "auto" }}>
              <table className="rows" style={{ minWidth: 460 }}>
                <thead><tr><th>Person</th><th className="num">Upsold jobs</th><th className="num">Revenue</th><th className="num">Per labor hour</th></tr></thead>
                <tbody>{u.by_person.map((p) => (
                  <tr key={p.name}><td>{p.name}</td><td className="num">{n(p.upsold_jobs)} of {n(p.jobs)}</td><td className="num">{money(p.revenue)}</td><td className="num">{money(per(p.revenue, p.hours))}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </Shell>
  );
}
