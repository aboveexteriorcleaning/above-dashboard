import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { getCompanySummary, getMyJobs, getMyScorecard } from "@/lib/data";
import { resolvePeriod } from "@/lib/periods";
import { money, moneyExact, n, pct, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

// Shows only the signed-in person's own numbers, plus company totals.
// No rankings and no other person's numbers: the database refuses to send them.
export default async function Me({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner", "crew"]);
  const period = resolvePeriod((await searchParams).p);
  const [me, jobs, co] = await Promise.all([
    getMyScorecard(period.from, period.to), getMyJobs(period.from, period.to), getCompanySummary(period.from, period.to),
  ]);
  const first = session.name?.split(" ")[0];

  return (
    <Shell page="me" session={session}>
      <main>
        <div className="pagehead">
          <h1>{first ? `${first}'s numbers` : "My numbers"}</h1>
          <Periods current={period.key} base="/me" />
        </div>

        <section className="me-hero" aria-label="Your revenue">
          <div className="muted">Revenue from your completed jobs, {period.label.toLowerCase()}</div>
          <div className="figure">{money(me.revenue_credited)}</div>
          <p className="muted small" style={{ maxWidth: "60ch" }}>
            When a job is shared, you&rsquo;re credited by your share of the clocked time on it.
          </p>
        </section>

        <section className="section" aria-label="Your work">
          <div className="stats">
            <Stat value={n(me.completed_jobs)} label="Jobs completed" />
            <Stat value={`${n(me.clocked_hours)} hr`} label="Hours clocked" note={`Across ${n(me.work_days)} work days`} />
            <Stat value={money(me.revenue_per_hour)} label="Revenue per hour" />
            <Stat value={money(me.revenue_per_day)} label="Revenue per work day" />
          </div>
        </section>

        <section className="section" aria-label="Your sales">
          <div className="stats">
            <Stat value={money(me.upsell_revenue)} label="Upsells" note="Services added on site, plus optional items you sold on quotes" />
            <Stat value={n(me.plans_sold)} label="Maintenance plans sold" />
            {me.quotes_sent > 0 && <Stat value={`${n(me.quotes_approved)} of ${n(me.quotes_sent)}`} label="Your quotes approved" />}
            <Stat value={n(me.callbacks)} label="Callbacks on your jobs" tone={me.callbacks > 0 ? "down" : undefined} />
          </div>
        </section>

        <section className="section" aria-labelledby="jobs">
          <div className="section-head"><h2 id="jobs">Your jobs</h2><span className="muted small">{n(jobs.length)} completed</span></div>
          {jobs.length ? (
            <table className="rows">
              <thead><tr><th>Date</th><th>Client</th><th className="hide-sm">Job</th><th className="num">Hours</th><th className="num">Your share</th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.job_id}>
                    <td>{shortDate(j.completed_at)}</td>
                    <td>{j.client_name ?? "—"}</td>
                    <td className="hide-sm muted">{j.job_title ?? ""}</td>
                    <td className="num">{j.my_hours ? n(j.my_hours) : "—"}</td>
                    <td className="num">{moneyExact(j.my_revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">No completed jobs in this period yet.</p>}
        </section>

        <section className="section company-band" aria-labelledby="co">
          <div className="section-head"><h2 id="co">Above, all together</h2><span className="muted small">{period.label}</span></div>
          <div className="stats">
            <Stat value={money(co.completed_revenue)} label="Completed revenue" note={`${n(co.completed_jobs)} jobs`} />
            <Stat value={money(co.booked_next_30_days)} label="Booked, next 30 days" />
            <Stat value={n(co.new_clients)} label="New customers" />
            <Stat value={pct(co.quote_approval_rate)} label="Quotes approved" note={`${n(co.quotes_approved)} of ${n(co.quotes_sent)}`} />
            <Stat value={n(co.active_plans)} label="Customers on plans" />
          </div>
        </section>
      </main>
    </Shell>
  );
}
