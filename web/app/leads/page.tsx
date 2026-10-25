import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { LeadSheet } from "@/components/LeadSheet";
import { getLeadKpis, getLeadList, getQuoFreshness } from "@/lib/data";
import { resolvePeriod } from "@/lib/periods";
import { minutes, money, n, pct, shortDate, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const mon = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

export default async function Leads({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod((await searchParams).p);
  const fresh = await getQuoFreshness();

  if (!fresh.connected) {
    return (
      <Shell page="leads" session={session}>
        <main>
          <div className="pagehead"><h1>Leads</h1></div>
          <div className="panel" style={{ maxWidth: "70ch" }}>
            <h2>Quo isn&rsquo;t connected yet</h2>
            <p className="muted">Once the Quo key is added and the history import has run, this page shows new leads, how fast they got a reply, missed calls, and how many turned into quotes and booked jobs.</p>
          </div>
        </main>
      </Shell>
    );
  }

  const [k, list] = await Promise.all([getLeadKpis(period.from, period.to), getLeadList(period.from, period.to)]);
  const m = k.missed;
  const maxMonth = Math.max(...k.monthly.map((x) => x.leads), 1);
  const attention = k.no_reply + m.not_returned;

  return (
    <Shell page="leads" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Leads</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>
              {period.label}, {shortDate(period.from + "T12:00:00Z")} to {shortDate(period.to + "T12:00:00Z")}
              <span className="small"> · Quo updated {timeAgo(fresh.last_synced)}{fresh.healthy ? "" : " (last sync had an error)"}</span>
            </p>
          </div>
          <Periods current={period.key} base="/leads" />
        </div>

        {attention > 0 && (
          <a href="#list" className="attention">
            <strong>{n(attention)} {attention === 1 ? "person is" : "people are"} waiting on you</strong>
            <span>{[k.no_reply && `${k.no_reply} ${k.no_reply === 1 ? "lead" : "leads"} with no reply yet`,
              m.not_returned && `${m.not_returned} missed ${m.not_returned === 1 ? "call" : "calls"} not returned`].filter(Boolean).join(" · ")}</span>
          </a>
        )}

        <section aria-labelledby="leads-h">
          <div className="section-head"><h2 id="leads-h">New leads</h2><span className="muted small">Leads and reply speed from Quo; quotes and bookings from Jobber, every channel</span></div>
          <div className="stats">
            <Stat value={n(k.leads)} label="New leads" note={k.by_source.slice(0, 3).map((s) => `${s.leads} ${s.source.toLowerCase()}`).join(", ") || undefined} />
            <Stat value={minutes(k.median_response_min)} label="Speed to lead"
              note={`Median first reply${k.median_response_min_in_hours != null ? `; ${minutes(k.median_response_min_in_hours)} for leads between 7am and 7pm` : ""}`} />
            <Stat value={n(k.new_quoted)} label="Got a quote"
              note={`New customers' first quote${k.new_quoted ? `; ${pct(k.new_quoted_booked / k.new_quoted)} have booked since` : ""}`} />
            <Stat value={n(k.new_booked)} label="Booked" note={`New customers' first job, ${money(k.new_booked_value)} of work`} />
          </div>
        </section>

        <section className="section" aria-labelledby="speed-h">
          <div className="section-head"><h2 id="speed-h">Does speed pay off?</h2><span className="muted small">Booked = matched to a Jobber job by phone</span></div>
          <div className="stats">
            <Stat value={pct(k.within_5_min)} label="Answered within 5 min"
              note={`${n(k.speed_booking.fast_leads)} of ${n(k.timed_leads)} leads${k.waiting_on_them ? `; ${n(k.waiting_on_them)} form ${k.waiting_on_them === 1 ? "lead never" : "leads never"} replied to the auto-text, so ${k.waiting_on_them === 1 ? "isn't" : "aren't"} timed` : ""}`} />
            <Stat value={pct(k.speed_booking.fast_leads ? k.speed_booking.fast_booked / k.speed_booking.fast_leads : null)} label="Booked, answered within 5 min"
              note={`${n(k.speed_booking.fast_booked)} of ${n(k.speed_booking.fast_leads)} leads`} />
            <Stat value={pct(k.speed_booking.slow_leads ? k.speed_booking.slow_booked / k.speed_booking.slow_leads : null)} label="Booked, answered after 5 min"
              note={`${n(k.speed_booking.slow_booked)} of ${n(k.speed_booking.slow_leads)} leads`} />
          </div>
          <p className="muted small" style={{ maxWidth: "75ch" }}>
            {n(k.speed_booking.matched_leads)} of this period&rsquo;s {n(k.leads)} leads have a phone number that matches a Jobber client, so these booking rates firm up as more profiles carry phone numbers.
            Form leads are timed from the auto-text if you reached them within 24 hours, otherwise from their reply to your next reply. Follow-ups after 24 hours of silence don&rsquo;t count.
          </p>
        </section>

        <section className="section" aria-labelledby="missed-h">
          <div className="section-head"><h2 id="missed-h">Missed calls</h2><span className="muted small">All callers, not just new leads</span></div>
          <div className="stats">
            <Stat value={n(m.missed)} label="Missed calls" note={m.inbound_calls ? `${pct(m.missed / m.inbound_calls)} of ${n(m.inbound_calls)} incoming calls` : undefined} tone={m.missed ? "down" : undefined} />
            <Stat value={n(m.returned)} label="Got back to" note={m.median_return_min != null ? `Median ${minutes(m.median_return_min)} later` : undefined} />
            <Stat value={n(m.not_returned)} label="Never returned" note="No call, text or answered call since" tone={m.not_returned ? "down" : undefined} />
            <Stat value={n(m.voicemails)} label="Left a voicemail" />
          </div>
        </section>

        <div className="grid-2 section">
          <section aria-labelledby="month-h">
            <div className="section-head"><h2 id="month-h">Leads by month</h2><span className="muted small">Quoted and booked: new customers, from Jobber</span></div>
            <table className="rows">
              <thead><tr><th>Month</th><th className="num">Leads</th><th className="num">Quoted</th><th className="num">Booked</th><th className="barcell hide-sm" aria-hidden /></tr></thead>
              <tbody>
                {k.monthly.map((x) => (
                  <tr key={x.month}>
                    <td>{mon(x.month)}</td><td className="num">{n(x.leads)}</td><td className="num">{n(x.quoted)}</td><td className="num">{n(x.booked)}</td>
                    <td className="barcell hide-sm" aria-hidden><div className="track"><div className="bar" style={{ width: `${(x.leads / maxMonth) * 100}%` }} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div>
            <section aria-labelledby="src-h">
              <div className="section-head"><h2 id="src-h">How leads came in</h2></div>
              {k.by_source.length ? (
                <table className="rows">
                  <thead><tr><th>Source</th><th className="num">Leads</th><th className="num">Booked*</th><th className="num">Work booked*</th></tr></thead>
                  <tbody>{k.by_source.map((s) => (
                    <tr key={s.source}><td>{s.source}</td><td className="num">{n(s.leads)}</td><td className="num">{n(s.booked)}</td><td className="num">{money(s.booked_value)}</td></tr>
                  ))}</tbody>
                </table>
              ) : <p className="muted">No new leads in this period.</p>}
              <p className="muted small">*Only leads whose phone number matches a Jobber client.{k.new_quoted_no_phone ? ` ${n(k.new_quoted_no_phone)} of this period's ${n(k.new_quoted)} quoted new customers have no phone in Jobber, so they can't be matched.` : ""}</p>
            </section>
            {k.by_line.length > 1 && (
              <section className="section" aria-labelledby="line-h">
                <div className="section-head"><h2 id="line-h">By Quo number</h2></div>
                <table className="rows">
                  <thead><tr><th>Number</th><th className="num">Leads</th><th className="num">Booked</th></tr></thead>
                  <tbody>{k.by_line.map((s) => <tr key={s.line}><td>{s.line}</td><td className="num">{n(s.leads)}</td><td className="num">{n(s.booked)}</td></tr>)}</tbody>
                </table>
              </section>
            )}
          </div>
        </div>

        <section className="section" aria-labelledby="ppl-h">
          <div className="section-head"><h2 id="ppl-h">Phones by person</h2><span className="muted small">{period.label}</span></div>
          {k.people.length ? (
            <div style={{ overflowX: "auto" }}>
              <table className="rows" style={{ minWidth: 640 }}>
                <thead><tr><th>Person</th><th className="num">Calls answered</th><th className="num">Calls made</th><th className="num">Texts sent</th><th className="num">Leads they replied to first</th><th className="num">Median reply</th></tr></thead>
                <tbody>{k.people.map((p) => (
                  <tr key={p.name}><td><strong>{p.name}</strong></td><td className="num">{n(p.calls_answered)}</td><td className="num">{n(p.calls_made)}</td>
                    <td className="num">{n(p.texts_sent)}</td><td className="num">{n(p.leads_first_reply)}</td><td className="num">{minutes(p.median_response_min)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="muted">No calls or texts in this period.</p>}
          <p className="muted small">Automatic texts aren&rsquo;t counted. Quo users are matched to the team by email or name.</p>
        </section>

        <section className="section" id="list" aria-labelledby="list-h">
          <div className="section-head"><h2 id="list-h">Lead list</h2><span className="muted small">{n(list.length)} leads, {period.label.toLowerCase()}</span></div>
          <LeadSheet rows={list} />
        </section>
      </main>
    </Shell>
  );
}
