import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { getTeam, getTeamCommission, getTeamPlanSales, getTeamScorecards } from "@/lib/data";
import { resolvePeriod } from "@/lib/periods";
import { money, moneyExact, n, pct } from "@/lib/format";
import { inviteMember, saveMember } from "./actions";

export const dynamic = "force-dynamic";

export default async function Team({ searchParams }: { searchParams: Promise<{ p?: string; ok?: string; warn?: string }> }) {
  const session = await requireSession(["owner"]);
  const sp = await searchParams;
  const period = resolvePeriod(sp.p);
  const [scores, team, comm, planSales] = await Promise.all([getTeamScorecards(period.from, period.to), getTeam(), getTeamCommission(period.from, period.to), getTeamPlanSales(period.from, period.to)]);
  const ranked = [...scores].sort((a, b) => b.revenue_credited - a.revenue_credited);

  return (
    <Shell page="team" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Team</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>Only owners can see this page.</p>
          </div>
          <Periods current={period.key} base="/team" />
        </div>

        <section aria-labelledby="scores">
          <div className="section-head"><h2 id="scores">Scorecards</h2><span className="muted small">{period.label}</span></div>
          <div style={{ overflowX: "auto" }}>
            <table className="rows" style={{ minWidth: 760 }}>
              <thead><tr>
                <th>Person</th><th className="num">Revenue</th><th className="num">Jobs</th><th className="num">Hours</th>
                <th className="num">Per hour</th><th className="num">Per day</th><th className="num">Upsells</th>
<th className="num">Quotes approved / sent</th><th className="num">Callbacks</th>
              </tr></thead>
              <tbody>
                {ranked.map((s) => (
                  <tr key={s.employee_id}>
                    <td><strong>{s.full_name}</strong></td>
                    <td className="num">{money(s.revenue_credited)}</td>
                    <td className="num">{n(s.completed_jobs)}</td>
                    <td className="num">{n(s.hours)}{s.hours_source === "scheduled" && <span className="muted"> est.</span>}</td>
                    <td className="num">{money(s.revenue_per_hour)}</td>
                    <td className="num">{money(s.revenue_per_day)}</td>
                    <td className="num">{money(s.upsell_revenue)}</td>
                    <td className="num">{s.quotes_sent || s.quotes_approved ? `${n(s.quotes_approved)} / ${n(s.quotes_sent)}` : "—"}</td>
                    <td className={`num${s.callbacks ? " down" : ""}`}>{n(s.callbacks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Shared jobs are split evenly between everyone assigned. Hours are clocked time for people who clock in, and scheduled visit time (est.) for people who don&rsquo;t. Quotes count as approved in the period they were approved and as sent in the period they were sent. Compare people with similar roles and job mix.</p>
        </section>

        <section className="section" aria-labelledby="plans-h">
          <div className="section-head"><h2 id="plans-h">Plan sales</h2><span className="muted small">{period.label}</span></div>
          {planSales.length ? (
            <div style={{ overflowX: "auto" }}>
              <table className="rows" style={{ minWidth: 620 }}>
                <thead><tr>
                  <th>Person</th><th className="num">Plans sold</th><th className="num">On site / pre-job</th>
                  <th className="num">On-site conversion</th><th className="num">Yearly value sold</th>
                </tr></thead>
                <tbody>
                  {planSales.map((p) => (
                    <tr key={p.employee_id}>
                      <td><strong>{p.full_name}</strong></td>
                      <td className="num">{n(p.plans_sold)}</td>
                      <td className="num">{n(p.on_site)} / {n(p.pre_job)}</td>
                      <td className="num">{p.serviced_homes ? <>{pct(p.conversion)} <span className="muted">({n(p.converted_homes)} of {n(p.serviced_homes)})</span></> : "—"}</td>
                      <td className="num">{money(p.value_sold)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">No plan sales or completed jobs in this period.</p>}
          <p className="muted small" style={{ maxWidth: "75ch" }}>
            On site: the plan was added to the job on or after the visit day, or the next plan visit was booked within 2 days of the visit. Credit is split evenly between everyone on that visit.
            Pre-job: the plan was on the quote or on the job before the visit. Credit goes to the quote&rsquo;s salesperson.
            On-site conversion is the share of homes they worked at, that weren&rsquo;t already on a plan, where they sold one. Yearly value is the plan visit price times visits a year.
          </p>
        </section>

        <section className="section" aria-labelledby="comm-h">
          <div className="section-head"><h2 id="comm-h">Commission vs hourly</h2><span className="muted small">{period.label}</span></div>
          {comm.length ? (
            <table className="rows">
              <thead><tr><th>Person</th><th className="num">Commission days</th><th className="num">Commission earned</th></tr></thead>
              <tbody>
                {comm.map((c) => (
                  <tr key={c.employee_id}>
                    <td><strong>{c.full_name}</strong>{c.missing_wage && <span className="tag off" style={{ marginLeft: 8 }}>Base wage missing</span>}</td>
                    <td className="num">{n(c.commission_days)} of {n(c.work_days)}</td>
                    <td className="num">{moneyExact(c.commission_earned)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">No one who clocks in has worked in this period.</p>}
          <p className="muted small" style={{ maxWidth: "70ch" }}>
            Each day pays the higher of commission (solo 20%, two-person 15%, three or more 10% of job value, each) or hours clocked times base wage.
            Jobs count on their scheduled visit day. Estimates only; payroll is the final word.
          </p>
        </section>

        <section className="section" id="setup" aria-labelledby="setup-h">
          <div className="section-head"><h2 id="setup-h">Who can sign in</h2></div>
          {sp.ok && <p className="notice" role="status">{sp.ok}</p>}
          {sp.warn && <p className="notice warn" role="alert">{sp.warn}</p>}
          <p className="muted" style={{ maxWidth: "70ch" }}>
            People come from Jobber automatically. Add someone&rsquo;s email, choose what they can see, then send an invite.
            Crew see only their own numbers and company totals. Hourly cost (wage plus payroll costs) is used for job margins and is visible only to owners.
          </p>
          {team.map((m) => (
            <div key={m.id} className="member">
              <form action={saveMember} style={{ display: "contents" }}>
                <input type="hidden" name="id" value={m.id} />
                <input type="hidden" name="name" value={m.full_name} />
                <div>
                  <div style={{ fontWeight: 700 }}>{m.full_name}</div>
                  <div className="small">
                    {m.signed_in ? <span className="tag">Signed in</span> : m.email ? <span className="tag off">Not signed in yet</span> : <span className="muted">No email yet</span>}
                  </div>
                </div>
                <div><label htmlFor={`e-${m.id}`}>Email</label><input id={`e-${m.id}`} name="email" type="email" defaultValue={m.email ?? ""} /></div>
                <div>
                  <label htmlFor={`r-${m.id}`}>Can see</label>
                  <select id={`r-${m.id}`} name="role" defaultValue={m.role}>
                    <option value="crew">Own numbers</option>
                    <option value="owner">Everything</option>
                  </select>
                </div>
                <div><label htmlFor={`w-${m.id}`}>Base wage</label><input id={`w-${m.id}`} name="base_wage" inputMode="decimal" defaultValue={m.base_wage ?? ""} placeholder="$/hr" /></div>
                <div><label htmlFor={`c-${m.id}`}>Hourly cost</label><input id={`c-${m.id}`} name="hourly_cost" inputMode="decimal" defaultValue={m.hourly_cost ?? ""} placeholder="$" /></div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", margin: 0, fontWeight: 500 }}>
                    <input type="checkbox" name="active" defaultChecked={m.active} style={{ width: "auto" }} /> Active
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", margin: 0, fontWeight: 500 }}>
                    <input type="checkbox" name="tracks_time" defaultChecked={m.tracks_time} style={{ width: "auto" }} /> Clocks in
                  </label>
                  <button className="btn" type="submit">Save</button>
                </div>
              </form>
              {m.email && !m.signed_in && m.active && (
                <form action={inviteMember} style={{ gridColumn: "1 / -1" }}>
                  <input type="hidden" name="id" value={m.id} />
                  <button className="btn quiet" type="submit">Email {m.full_name.split(" ")[0]} a sign-in invite</button>
                </form>
              )}
            </div>
          ))}
        </section>
      </main>
    </Shell>
  );
}
