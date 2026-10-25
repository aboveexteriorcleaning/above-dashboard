import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { getCompanySummary, getMyCommission, getMyJobs, getMyPlanSales, getMyScorecard, getMyToday } from "@/lib/data";
import { resolvePeriod } from "@/lib/periods";
import { hm, money, moneyExact, n, pct, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

// Shows only the signed-in person's own numbers, plus company totals.
// No rankings and no other person's numbers: the database refuses to send them.
export default async function Me({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner", "crew"]);
  const period = resolvePeriod((await searchParams).p);
  const [me, jobs, co, plans] = await Promise.all([
    getMyScorecard(period.from, period.to), getMyJobs(period.from, period.to), getCompanySummary(period.from, period.to), getMyPlanSales(period.from, period.to),
  ]);
  const first = session.name?.split(" ")[0];
  // Commission vs hourly applies to people who clock in.
  const clocks = me.hours_source === "clocked";
  const [comm, today] = clocks ? await Promise.all([getMyCommission(period.from, period.to), getMyToday()]) : [null, null];

  return (
    <Shell page="me" session={session}>
      <main>
        <div className="pagehead">
          <h1>{first ? `${first}'s numbers` : "My numbers"}</h1>
          <Periods current={period.key} base="/me" />
        </div>

        {today && today.jobs > 0 && (
          <section className="today" aria-labelledby="today-h">
            <h2 id="today-h">Today</h2>
            <p className="today-line">
              {n(today.jobs)} {today.jobs === 1 ? "job" : "jobs"} worth <strong>{money(today.job_value)}</strong>
              {" "}pays <strong>{moneyExact(today.commission)}</strong> commission.
            </p>
            {today.break_even_hours != null ? (
              <>
                <p className="today-goal figure">Finish in under {hm(today.break_even_hours)}</p>
                <p className="muted small">
                  to beat hourly. Clocked so far today: {hm(today.hours_so_far)}
                  {today.hours_so_far < today.break_even_hours
                    ? `, ${hm(today.break_even_hours - today.hours_so_far)} to go.`
                    : ", past break-even, so hourly pays more today."}
                </p>
              </>
            ) : <p className="muted small">Ask an owner to add your base wage to see your break-even time.</p>}
          </section>
        )}

        <section className="me-hero" aria-label="Your revenue">
          <div className="muted">Revenue from your completed jobs, {period.label.toLowerCase()}</div>
          <div className="figure">{money(me.revenue_credited)}</div>
          <p className="muted small" style={{ maxWidth: "60ch" }}>
            Shared jobs are split evenly between everyone assigned to them.
          </p>
        </section>

        <section className="section" aria-label="Your work">
          <div className="stats">
            <Stat value={n(me.completed_jobs)} label="Jobs completed" />
            {me.hours_source === "clocked"
              ? <Stat value={`${n(me.hours)} hr`} label="Hours clocked" note={`Across ${n(me.work_days)} work days`} />
              : <Stat value={`${n(me.hours)} hr`} label="Hours on jobs (est.)"
                  note={`From scheduled visit times across ${n(me.work_days)} days${me.unestimated_visits ? `; ${n(me.unestimated_visits)} visits had no set time` : ""}`} />}
            <Stat value={money(me.revenue_per_hour)} label="Revenue per hour" />
            <Stat value={money(me.revenue_per_day)} label="Revenue per work day" />
          </div>
        </section>

        {comm && (
          <section className="section" aria-labelledby="comm-h">
            <div className="section-head"><h2 id="comm-h">Commission</h2><span className="muted small">{period.label}</span></div>
            {comm.summary.missing_wage && <p className="notice warn">Your base wage isn&rsquo;t set yet, so some days can&rsquo;t be compared. Ask an owner to add it on the Team page.</p>}
            <div className="stats">
              <Stat value={moneyExact(comm.summary.commission_earned)} label="Commission earned" note="On days commission beat hourly" />
              <Stat value={`${n(comm.summary.commission_days)} of ${n(comm.summary.work_days)}`} label="Commission days"
                note={comm.summary.work_days ? `${pct(comm.summary.commission_days / comm.summary.work_days)} of your work days` : undefined} />
            </div>
            {comm.days.length > 0 && (
              <div style={{ overflowX: "auto", marginTop: 20 }}>
                <table className="rows">
                  <thead><tr>
                    <th>Day</th><th className="num hide-sm">Job value</th><th className="num">Commission</th>
                    <th className="num">Hours</th><th className="num hide-sm">Break-even</th><th className="num">Paid by</th>
                  </tr></thead>
                  <tbody>
                    {comm.days.map((d) => (
                      <tr key={d.day}>
                        <td>{shortDate(d.day + "T12:00:00Z")}</td>
                        <td className="num hide-sm">{money(d.job_value)}</td>
                        <td className="num">{moneyExact(d.commission)}</td>
                        <td className="num">{n(d.hours)}</td>
                        <td className="num muted hide-sm">{d.break_even_hours != null ? hm(d.break_even_hours) : "—"}</td>
                        <td className="num">{d.wage == null ? <span className="muted">No wage set</span>
                          : d.commission_day ? <span className="tag">Commission</span> : <span className="muted">Hourly</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small" style={{ maxWidth: "70ch" }}>
              Each day you&rsquo;re paid the higher of commission (solo jobs 20%, two-person 15%, three or more 10% of the job&rsquo;s value)
              or your hours clocked times your wage. Break-even is how long the day can take with commission still ahead.
              These are estimates; your paycheck is the final word.
            </p>
          </section>
        )}

        <section className="section" aria-label="Your sales">
          <div className="stats">
            <Stat value={money(me.upsell_revenue)} label="Upsells" note="Services added on site, plus optional items you sold on quotes" />
            <Stat value={n(plans.plans_sold)} label="Maintenance plans sold"
              note={plans.plans_sold ? `${money(plans.value_sold)} a year in plan work` : undefined} />
            {plans.serviced_homes > 0 && <Stat value={pct(plans.conversion)} label="Plan conversion"
              note={`Sold a plan at ${n(plans.converted_homes)} of ${n(plans.serviced_homes)} homes you worked at that weren't on one`} />}
            {(me.quotes_sent > 0 || me.quotes_approved > 0) && <Stat value={`${n(me.quotes_approved)} / ${n(me.quotes_sent)}`} label="Your quotes approved / sent" />}
            <Stat value={n(me.callbacks)} label="Callbacks on your jobs" tone={me.callbacks > 0 ? "down" : undefined} />
          </div>
        </section>

        <section className="section" aria-labelledby="jobs">
          <div className="section-head"><h2 id="jobs">Your jobs</h2><span className="muted small">{n(jobs.length)} completed</span></div>
          {jobs.length ? (
            <table className="rows">
              <thead><tr><th>Date</th><th>Client</th><th className="hide-sm">Job</th><th className="num hide-sm">Crew</th><th className="num">Hours (est.)</th><th className="num">Your share</th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.job_id}>
                    <td>{shortDate(j.completed_at)}</td>
                    <td>{j.client_name ?? "—"}</td>
                    <td className="hide-sm muted">{j.job_title ?? ""}</td>
                    <td className="num muted hide-sm">{j.crew_size > 1 ? `${j.crew_size} people` : "Solo"}</td>
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
            <Stat value={pct(co.quote_approval_rate)} label="Quote approval rate" note={`${n(co.quotes_approved)} approved, ${n(co.quotes_sent)} sent`} />
            <Stat value={n(co.active_plans)} label="Customers on plans" />
          </div>
        </section>
      </main>
    </Shell>
  );
}
