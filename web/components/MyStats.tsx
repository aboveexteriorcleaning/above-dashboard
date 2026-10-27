import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { getCompanySummary, getMyCommission, getMyEarnings, getMyJobs, getMyPlanSales, getMyReviews, getMyUpsellRate, getMyScorecard, getMyToday } from "@/lib/data";
import { periodPhrase, previousPeriod, type resolvePeriod } from "@/lib/periods";
import * as ch from "@/lib/change";

type Period = ReturnType<typeof resolvePeriod>;
import { hm, money, moneyExact, n, pct, shortDate } from "@/lib/format";

// One person's own numbers plus company totals: no rankings, no other person's numbers.
// Crew see this for themselves on My stats. Owners see the same page for a team member
// (`viewAs`), which the database honours only for owners.
export async function MyStats({ period, first, base, viewAs }: { period: Period; first?: string; base: string; viewAs?: string }) {
  const [me, jobs, co, plans, rv, up] = await Promise.all([
    getMyScorecard(period.from, period.to, viewAs), getMyJobs(period.from, period.to, viewAs), getCompanySummary(period.from, period.to),
    getMyPlanSales(period.from, period.to, viewAs), getMyReviews(period.from, period.to, viewAs), getMyUpsellRate(period.from, period.to, viewAs),
  ]);
  // Commission vs hourly applies to people who clock in.
  const clocks = me.hours_source === "clocked";
  const [comm, today, earn] = clocks
    ? await Promise.all([getMyCommission(period.from, period.to, viewAs), getMyToday(viewAs), getMyEarnings(period.from, period.to, viewAs)])
    : [null, null, null];
  // The same numbers for the equal earlier period, for the change badges.
  const prev = previousPeriod(period);
  const [pme, pco, pplans, pup, pcomm, pearn] = prev
    ? await Promise.all([
        getMyScorecard(prev.from, prev.to, viewAs), getCompanySummary(prev.from, prev.to), getMyPlanSales(prev.from, prev.to, viewAs),
        getMyUpsellRate(prev.from, prev.to, viewAs),
        clocks ? getMyCommission(prev.from, prev.to, viewAs) : null, clocks ? getMyEarnings(prev.from, prev.to, viewAs) : null])
    : [null, null, null, null, null, null];
  const heroChg = ch.pct(me.revenue_credited, pme?.revenue_credited, "up", money);

  return (
    <>
        <div className="pagehead">
          <h1>{first ? `${first}'s numbers` : "My numbers"}</h1>
          <Periods current={period.key} base={base} period={period} />
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
          <div className="muted">Revenue from your completed jobs, {periodPhrase(period)}</div>
          <div className="stat-row"><div className="figure">{money(me.revenue_credited)}</div>{heroChg && <span className={`chg ${heroChg.tone}`} title={heroChg.title}>{heroChg.text}</span>}</div>
          <p className="muted small" style={{ maxWidth: "60ch" }}>
            Shared jobs are split evenly between everyone assigned to them.
          </p>
        </section>

        <section className="section" aria-label="Your work">
          <div className="stats">
            <Stat value={n(me.completed_jobs)} label="Jobs completed" change={ch.pct(me.completed_jobs, pme?.completed_jobs)} />
            {me.hours_source === "clocked"
              ? <Stat value={`${n(me.hours)} hr`} label="Hours clocked" change={ch.pct(me.hours, pme?.hours, "none")} note={`Across ${n(me.work_days)} work days`} />
              : <Stat value={`${n(me.hours)} hr`} label="Hours on jobs (est.)" change={ch.pct(me.hours, pme?.hours, "none")}
                  note={`From scheduled visit times across ${n(me.work_days)} days${me.unestimated_visits ? `; ${n(me.unestimated_visits)} visits had no set time` : ""}`} />}
            <Stat value={money(me.revenue_per_hour)} label="Revenue per hour" change={ch.pct(me.revenue_per_hour, pme?.revenue_per_hour, "up", money)} />
            <Stat value={money(me.revenue_per_day)} label="Revenue per work day" change={ch.pct(me.revenue_per_day, pme?.revenue_per_day, "up", money)} />
          </div>
        </section>

        {comm && (
          <section className="section" aria-labelledby="comm-h">
            <div className="section-head"><h2 id="comm-h">Commission</h2><span className="muted small">{period.label}</span></div>
            {comm.summary.missing_wage && <p className="notice warn">Your base wage isn&rsquo;t set yet, so some days can&rsquo;t be compared. Ask an owner to add it on the Team page.</p>}
            <div className="stats">
              <Stat value={moneyExact(comm.summary.commission_earned)} label="Commission earned" change={ch.pct(comm?.summary.commission_earned, pcomm?.summary.commission_earned, "up", moneyExact)} note="On days commission beat hourly" />
              <Stat value={`${n(comm.summary.commission_days)} of ${n(comm.summary.work_days)}`} label="Commission days" change={ch.pts(comm?.summary.work_days ? comm.summary.commission_days / comm.summary.work_days : null, pcomm?.summary.work_days ? pcomm.summary.commission_days / pcomm.summary.work_days : null)}
                note={comm.summary.work_days ? `${pct(comm.summary.commission_days / comm.summary.work_days)} of your work days` : undefined} />
              {earn && <Stat value={moneyExact(earn.upsell_commission)} label="Upsell earnings" change={ch.pct(earn?.upsell_commission, pearn?.upsell_commission, "up", moneyExact)}
                note={earn.upsell_value
                  ? `Commission on ${money(earn.upsell_value)} of on-site upsells, on days commission beat hourly${earn.upsell_commission_all_days > earn.upsell_commission ? ` (${moneyExact(earn.upsell_commission_all_days - earn.upsell_commission)} more fell on hourly days)` : ""}`
                  : "Commission on services you add on site"} />}
              {earn && <Stat value={moneyExact(earn.plan_earnings)} label="Plan earnings" change={ch.pct(earn?.plan_earnings, pearn?.plan_earnings, "up", moneyExact)}
                note={`${n(earn.plans_sold)} ${earn.plans_sold === 1 ? "plan" : "plans"} sold × ${money(earn.plan_bonus_each)}`} />}
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
            <Stat value={money(me.upsell_revenue)} label="Upsells" change={ch.pct(me.upsell_revenue, pme?.upsell_revenue, "up", money)} note="Services added on site, plus optional items you sold on quotes" />
            {up.jobs > 0 && <Stat value={pct(up.rate)} label="Upsell conversion" change={ch.pts(up.rate, pup && pup.jobs ? pup.rate : null)}
              note={`Added a service on site at ${n(up.upsold_jobs)} of your ${n(up.jobs)} jobs${up.offered ? `; ${n(up.accepted)} of ${n(up.offered)} offers accepted (${pct(up.accepted / up.offered)})` : ""}`} />}
            <Stat value={n(plans.plans_sold)} label="Maintenance plans sold" change={ch.pct(plans.plans_sold, pplans?.plans_sold)}
              note={plans.plans_sold ? `${money(plans.value_sold)} a year in plan work` : undefined} />
            {plans.serviced_homes > 0 && <Stat value={pct(plans.conversion)} label="Plan conversion" change={ch.pts(plans.conversion, pplans && pplans.serviced_homes ? pplans.conversion : null)}
              note={`Sold a plan at ${n(plans.converted_homes)} of ${n(plans.serviced_homes)} homes you worked at that weren't on one`} />}
            {(me.quotes_sent > 0 || me.quotes_approved > 0) && <Stat value={`${n(me.quotes_approved)} / ${n(me.quotes_sent)}`} label="Your quotes approved / sent" />}
            <Stat value={n(me.callbacks)} label="Callbacks on your jobs" change={ch.pct(me.callbacks, pme?.callbacks, "down")} tone={me.callbacks > 0 ? "down" : undefined} />
            {rv.reviews > 0 && <Stat value={`${n(rv.reviews)}`} label="Google reviews on your jobs" note={`${rv.average ?? "—"} ★ average, ${n(rv.five_star)} five-star`} />}
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
            <Stat value={money(co.completed_revenue)} label="Completed revenue" change={ch.pct(co.completed_revenue, pco?.completed_revenue, "up", money)} note={`${n(co.completed_jobs)} jobs`} />
            <Stat value={money(co.booked_next_30_days)} label="Booked, next 30 days" />
            <Stat value={n(co.new_clients)} label="New customers" change={ch.pct(co.new_clients, pco?.new_clients)} />
            <Stat value={pct(co.quote_approval_rate)} label="Quote approval rate" change={ch.pts(co.quote_approval_rate, pco?.quote_approval_rate)} note={`${n(co.quotes_approved)} approved, ${n(co.quotes_sent)} sent`} />
            <Stat value={n(co.active_plans)} label="Customers on plans" />
          </div>
        </section>
    </>
  );
}
