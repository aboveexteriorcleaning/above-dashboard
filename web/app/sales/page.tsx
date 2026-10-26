import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { getSales } from "@/lib/data";
import { resolvePeriod } from "@/lib/periods";
import { jobberClientUrl } from "@/lib/jobber-links";
import { money, n, pct, shortDate, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";
const rate = (a: number, b: number) => (b ? a / b : null);

export default async function Sales({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod((await searchParams).p);
  const s = await getSales(period.from, period.to);
  const d = s.discount, fu = s.follow_up, w = s.pipeline;

  return (
    <Shell page="sales" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Sales &amp; quotes</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>{period.label}, {shortDate(period.from + "T12:00:00Z")} to {shortDate(period.to + "T12:00:00Z")}</p>
          </div>
          <Periods current={period.key} base="/sales" />
        </div>

        <section aria-labelledby="q-h">
          <div className="section-head"><h2 id="q-h">Quotes</h2><span className="muted small">Sent counted when sent, approved when approved</span></div>
          <div className="stats">
            <Stat value={pct(rate(s.approved, s.sent))} label="Quote to booking" note={`${n(s.approved)} approved, ${n(s.sent)} sent`} />
            <Stat value={money(s.approved_value)} label="Approved quote value" note={`Average ${money(s.avg_approved_value)} per approved quote`} />
            <Stat value={s.days_to_approve == null ? "—" : `${s.days_to_approve} days`} label="Sent to approved" note="Median" />
            <Stat value={money(s.lost_value)} label="Lost quote value" note={`${n(s.lost)} quotes sent this period and archived without approval`} />
          </div>
        </section>

        <div className="grid-2 section">
          <section aria-labelledby="wait-h">
            <div className="section-head"><h2 id="wait-h">Still waiting</h2><span className="muted small">No reply yet; customers who booked another option left out</span></div>
            <div className="stats">
              <Stat value={money(s.waiting_period.value)} label="Sent this period, still waiting" note={`${n(s.waiting_period.count)} quotes`} />
              <Stat value={money(w.value)} label="Open pipeline" note={`${n(w.count)} quotes sent in the last 90 days, as of now`} />
            </div>
            <table className="rows" style={{ marginTop: 16 }}>
              <tbody>
                <tr><td>Sent in the last 7 days</td><td className="num">{money(w.d0_7)}</td></tr>
                <tr><td>8 to 30 days ago</td><td className="num">{money(w.d8_30)}</td></tr>
                <tr><td>31 to 90 days ago</td><td className="num">{money(w.d31_90)}</td></tr>
              </tbody>
            </table>
            {s.stale.count > 0 && (
              <p className="muted small" style={{ maxWidth: "60ch" }}>
                Not counted: {n(s.stale.count)} quotes ({money(s.stale.value)}) waiting over 90 days. They&rsquo;re probably dead; archiving them in Jobber keeps this list clean.
              </p>
            )}
          </section>
          <section aria-labelledby="disc-h">
            <div className="section-head"><h2 id="disc-h">Discounts</h2><span className="muted small">Quotes sent this period</span></div>
            <div className="stats">
              <Stat value={pct(d.rate)} label="Average discount rate" note={`${money(d.discount)} off ${money(d.pre_discount)}; ${money(d.plan_discount)} of it plan discounts`} />
              <Stat value={pct(rate(d.with_discount_won, d.with_discount_sent))} label="Approved, with a discount" note={`${n(d.with_discount_won)} of ${n(d.with_discount_sent)}`} />
              <Stat value={pct(rate(d.without_discount_won, d.without_discount_sent))} label="Approved, no discount" note={`${n(d.without_discount_won)} of ${n(d.without_discount_sent)}`} />
            </div>
          </section>
        </div>

        <section className="section" aria-labelledby="fu-h">
          <div className="section-head"><h2 id="fu-h">Quote follow-up</h2><span className="muted small">Quotes not approved within 2 days</span></div>
          <div className="stats">
            <Stat value={pct(rate(fu.followed_up, fu.needed))} label="Followed up within a week" note={`${n(fu.followed_up)} of ${n(fu.needed)} quotes got a call or text 1–7 days after sending`} />
          </div>
          <p className="muted small" style={{ maxWidth: "75ch" }}>Checked in Quo against the client&rsquo;s phone in Jobber. {fu.no_phone ? `${n(fu.no_phone)} quotes went to clients with no phone in Jobber and can't be checked.` : ""}</p>
          {s.to_follow_up.length > 0 && (
            <>
              <h3 style={{ margin: "20px 0 8px" }}>Biggest quotes waiting on a reply</h3>
              <div style={{ overflowX: "auto" }}>
                <table className="rows" style={{ minWidth: 560 }}>
                  <thead><tr><th>Client</th><th className="num">Quote</th><th>Sent</th><th>Last call or text</th></tr></thead>
                  <tbody>{s.to_follow_up.map((q) => {
                    const url = jobberClientUrl(q.client_id);
                    return (
                      <tr key={q.id}>
                        <td><strong>{url ? <a href={url} target="_blank" rel="noreferrer">{q.client_name ?? "Client"}</a> : (q.client_name ?? "Client")}</strong></td>
                        <td className="num">{money(q.value)}</td>
                        <td>{shortDate(q.sent_at)} <span className="muted small">({q.days_waiting} days)</span></td>
                        <td className={q.last_contact ? undefined : "down"}>{q.last_contact ? timeAgo(q.last_contact) : "None since sending"}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section className="section" aria-labelledby="sp-h">
          <div className="section-head"><h2 id="sp-h">By salesperson</h2><span className="muted small">Jobber quote salesperson</span></div>
          <table className="rows">
            <thead><tr><th>Salesperson</th><th className="num">Sent</th><th className="num">Approved</th><th className="num">Rate</th><th className="num">Approved value</th></tr></thead>
            <tbody>{s.by_salesperson.map((p) => (
              <tr key={p.name}><td><strong>{p.name}</strong></td><td className="num">{n(p.sent)}</td><td className="num">{n(p.approved)}</td>
                <td className="num">{pct(rate(p.approved, p.sent))}</td><td className="num">{money(p.approved_value)}</td></tr>
            ))}</tbody>
          </table>
          <p className="muted small">Lost-quote reasons aren&rsquo;t recorded in Jobber yet. A &ldquo;Lost reason&rdquo; custom field on quotes would let this page show why quotes are lost.</p>
        </section>
      </main>
    </Shell>
  );
}
