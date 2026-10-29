import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { getAds, getMetaFreshness } from "@/lib/data";
import { previousPeriod, resolvePeriod, type PeriodParams, periodLine } from "@/lib/periods";
import * as ch from "@/lib/change";
import { money, moneyExact, n, pct, shortDate, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const mon = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
const per = (a: number, b: number) => (a && b ? a / b : null);

export default async function Ads({ searchParams }: { searchParams: Promise<PeriodParams> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod(await searchParams);
  const fresh = await getMetaFreshness();

  if (!fresh.connected) {
    return (
      <Shell page="ads" session={session}>
        <main>
          <div className="pagehead"><h1>Ads</h1></div>
          <div className="panel" style={{ maxWidth: "70ch" }}>
            <h2>Meta isn&rsquo;t connected yet</h2>
            <p className="muted">Once the Meta token is added and the history import has run, this page shows ad spend, cost per lead and cost per new customer.</p>
          </div>
        </main>
      </Shell>
    );
  }

  const prev = previousPeriod(period);
  const [a, pa] = await Promise.all([getAds(period.from, period.to), prev ? getAds(prev.from, prev.to) : null]);
  const maxSpend = Math.max(...a.monthly.map((m) => m.spend), 1);

  return (
    <Shell page="ads" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Ads</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>
              {periodLine(period, shortDate)}
              <span className="small"> · Meta updated {timeAgo(fresh.last_synced)}{fresh.healthy ? "" : " (last sync had an error)"}</span>
            </p>
          </div>
          <Periods current={period.key} base="/ads" period={period} />
        </div>

        <section aria-labelledby="meta-h">
          <div className="section-head"><h2 id="meta-h">On Meta</h2><span className="muted small">As Meta reports it</span></div>
          <div className="stats">
            <Stat value={money(a.spend)} label="Ad spend" change={ch.pct(a.spend, pa?.spend, "none", money)} note={`${n(a.days_with_spend)} days with spend`} />
            <Stat value={n(a.meta_leads)} label="Leads" change={ch.pct(a.meta_leads, pa?.meta_leads)} note={`${moneyExact(per(a.spend, a.meta_leads))} per lead`} />
            <Stat value={n(a.link_clicks)} label="Link clicks" change={ch.pct(a.link_clicks, pa?.link_clicks)} note={`${moneyExact(per(a.spend, a.link_clicks))} per click; ${pct(per(a.link_clicks, a.impressions))} of impressions`} />
            <Stat value={n(a.impressions)} label="Impressions" change={ch.pct(a.impressions, pa?.impressions)} note={`${moneyExact(per(a.spend * 1000, a.impressions))} per 1,000`} />
          </div>
        </section>

        <section className="section" aria-labelledby="attr-h">
          <div className="section-head"><h2 id="attr-h">Attributed to ads</h2><span className="muted small">Meta form leads, matched to Jobber by phone</span></div>
          <div className="stats">
            <Stat value={money(per(a.spend, a.attributed.quoted))} label="Cost per quoted job" change={ch.pct(per(a.spend, a.attributed.quoted), pa && per(pa.spend, pa.attributed.quoted), "down", money)} note={`${n(a.attributed.quoted)} form leads quoted`} />
            <Stat value={money(per(a.spend, a.attributed.booked))} label="Cost per booked job" change={ch.pct(per(a.spend, a.attributed.booked), pa && per(pa.spend, pa.attributed.booked), "down", money)} note={`${n(a.attributed.booked)} form leads booked, ${money(a.attributed.booked_value)} of work`} />
            <Stat value={money(per(a.attributed.realized_revenue, a.attributed.form_leads))} label="Revenue per lead" change={ch.pct(per(a.attributed.realized_revenue, a.attributed.form_leads), pa && per(pa.attributed.realized_revenue, pa.attributed.form_leads), "up", money)} note={`${money(a.attributed.realized_revenue)} completed so far, ${n(a.attributed.form_leads)} form leads`} />
            <Stat value={a.spend ? `${(a.attributed.booked_value / a.spend).toFixed(2)}×` : "—"} label="Return on ad spend" change={ch.pct(per(a.attributed.booked_value, a.spend), pa && per(pa.attributed.booked_value, pa.spend))}
              note={a.spend ? `Booked revenue ÷ spend (${money(a.attributed.booked_value)} booked); ${(a.attributed.realized_revenue / a.spend).toFixed(2)}× on work completed so far` : undefined} />
          </div>
          <p className="muted small" style={{ maxWidth: "75ch" }}>
            {n(a.attributed.matched)} of {n(a.attributed.form_leads)} form leads match a Jobber client. Reliable from Oct 24, when lead profiles started carrying phone numbers.
            People who saw an ad and called instead of filling in the form aren&rsquo;t attributed here.
          </p>
        </section>

        <section className="section" aria-labelledby="blend-h">
          <div className="section-head"><h2 id="blend-h">Spend vs results</h2><span className="muted small">Blended: all new customers, not only those from ads</span></div>
          <div className="stats">
            <Stat value={n(a.form_leads)} label="Form leads in Quo" change={ch.pct(a.form_leads, pa?.form_leads)} note={`${moneyExact(per(a.spend, a.form_leads))} of ad spend per form lead`} />
            <Stat value={n(a.new_customers)} label="New customers booked" change={ch.pct(a.new_customers, pa?.new_customers)} note={`Customer acquisition cost: ${money(per(a.spend, a.new_customers))} of ad spend per new customer`} />
            <Stat value={money(a.new_customer_value)} label="New customer work booked" change={ch.pct(a.new_customer_value, pa?.new_customer_value, "up", money)}
              note={a.spend ? `$${(a.new_customer_value / a.spend).toFixed(2)} booked per $1 of ad spend` : undefined} />
          </div>
          <p className="muted small" style={{ maxWidth: "75ch" }}>
            New customers come from Jobber (first-ever job at the address, any channel), so these include referrals and calls that didn&rsquo;t come from an ad.
            Use them to compare months; tying each booking to a specific ad comes once Meta lead forms are linked to Jobber.
          </p>
        </section>

        <section className="section" aria-labelledby="camp-h">
          <div className="section-head"><h2 id="camp-h">Campaigns</h2><span className="muted small">{period.label}</span></div>
          {a.campaigns.length ? (
            <div style={{ overflowX: "auto" }}>
              <table className="rows" style={{ minWidth: 640 }}>
                <thead><tr><th>Campaign</th><th className="num">Spend</th><th className="num">Leads</th><th className="num">Per lead</th><th className="num">Link clicks</th><th className="num">Per click</th></tr></thead>
                <tbody>{a.campaigns.map((c) => (
                  <tr key={c.campaign_id}>
                    <td><strong>{c.name ?? "Unnamed campaign"}</strong><div className="small muted">{shortDate(c.first_day + "T12:00:00Z")} to {shortDate(c.last_day + "T12:00:00Z")}</div></td>
                    <td className="num">{money(c.spend)}</td><td className="num">{n(c.leads)}</td><td className="num">{moneyExact(per(c.spend, c.leads))}</td>
                    <td className="num">{n(c.link_clicks)}</td><td className="num">{moneyExact(per(c.spend, c.link_clicks))}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="muted">No ad spend in this period.</p>}
        </section>

        <section className="section" aria-labelledby="month-h">
          <div className="section-head"><h2 id="month-h">By month</h2><span className="muted small">Last 12 months</span></div>
          <div style={{ overflowX: "auto" }}>
            <table className="rows" style={{ minWidth: 640 }}>
              <thead><tr><th>Month</th><th className="num">Spend</th><th className="num">Meta leads</th><th className="num">Per lead</th><th className="num">New customers</th><th className="num">Per new customer</th><th className="barcell hide-sm" aria-hidden /></tr></thead>
              <tbody>{a.monthly.map((m) => (
                <tr key={m.month}>
                  <td>{mon(m.month)}</td><td className="num">{money(m.spend)}</td><td className="num">{n(m.leads)}</td>
                  <td className="num">{moneyExact(per(m.spend, m.leads))}</td><td className="num">{n(m.new_customers)}</td>
                  <td className="num">{money(per(m.spend, m.new_customers))}</td>
                  <td className="barcell hide-sm" aria-hidden><div className="track"><div className="bar" style={{ width: `${(m.spend / maxSpend) * 100}%` }} /></div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      </main>
    </Shell>
  );
}
