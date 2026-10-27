import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { LeadSheet } from "@/components/LeadSheet";
import { getLeadKpis, getLeadList, getQuoFreshness } from "@/lib/data";
import { previousPeriod, resolvePeriod, type PeriodParams, periodLine, periodPhrase } from "@/lib/periods";
import * as ch from "@/lib/change";
import { hours, minutes, money, n, pct, shortDate, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const mon = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

export default async function Leads({ searchParams }: { searchParams: Promise<PeriodParams> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod(await searchParams);
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

  const prev = previousPeriod(period);
  const [k, list, pk] = await Promise.all([getLeadKpis(period.from, period.to), getLeadList(period.from, period.to), prev ? getLeadKpis(prev.from, prev.to) : null]);
  const pm = pk?.missed, pfu = pk?.follow_up;
  const rt = (a: number | null | undefined, b: number | null | undefined) => (b ? (a ?? 0) / b : null);

  const m = k.missed;
  const maxMonth = Math.max(...k.monthly.map((x) => x.leads), 1);
  const fu = k.follow_up;
  const attention = k.no_reply + m.not_returned + k.follow_ups_due_now;

  return (
    <Shell page="leads" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Leads</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>
              {periodLine(period, shortDate)}
              <span className="small"> · Quo updated {timeAgo(fresh.last_synced)}{fresh.healthy ? "" : " (last sync had an error)"}</span>
            </p>
          </div>
          <Periods current={period.key} base="/leads" linked period={period} />
        </div>

        {attention > 0 && (
          <a href="#list" className="attention">
            <strong>{n(attention)} {attention === 1 ? "person is" : "people are"} waiting on you</strong>
            <span>{[k.no_reply && `${k.no_reply} ${k.no_reply === 1 ? "lead" : "leads"} with no reply yet`,
              m.not_returned && `${m.not_returned} missed ${m.not_returned === 1 ? "call" : "calls"} not returned`,
              k.follow_ups_due_now && `${k.follow_ups_due_now} ${k.follow_ups_due_now === 1 ? "follow-up" : "follow-ups"} due now`].filter(Boolean).join(" · ")}</span>
          </a>
        )}

        <section aria-labelledby="leads-h">
          <div className="section-head"><h2 id="leads-h">New leads</h2><span className="muted small">Leads and reply speed from Quo; quotes and bookings from Jobber, every channel</span></div>
          <div className="stats">
            <Stat value={n(k.leads)} label="New leads" change={ch.pct(k.leads, pk?.leads)} note={k.by_source.slice(0, 3).map((s) => `${s.leads} ${s.source.toLowerCase()}`).join(", ") || undefined} />
            <Stat value={minutes(k.median_response_min)} label="Speed to lead" change={ch.pct(k.median_response_min, pk?.median_response_min, "down", minutes)}
              note={`Median first reply${k.median_response_min_in_hours != null ? `; ${minutes(k.median_response_min_in_hours)} for leads between 7am and 7pm` : ""}`} />
            <Stat value={n(k.new_quoted)} label="Got a quote" change={ch.pct(k.new_quoted, pk?.new_quoted)}
              note={`New customers' first quote${k.new_quoted ? `; ${pct(k.new_quoted_booked / k.new_quoted)} have booked since` : ""}`} />
            <Stat value={n(k.new_booked)} label="Booked" change={ch.pct(k.new_booked, pk?.new_booked)} note={`New customers' first job, ${money(k.new_booked_value)} of work`} />
          </div>
        </section>

        <section className="section" aria-labelledby="contact-h">
          <div className="section-head"><h2 id="contact-h">Working the leads</h2><span className="muted small">Attempts: calls and texts by a person within 7 days, before the first conversation; touches within 10 minutes count once</span></div>
          <div className="stats">
            <Stat value={pct(k.contact_rate)} label="Contact rate" change={ch.pts(k.contact_rate, pk?.contact_rate)} note={`${n(k.two_way)} of ${n(k.leads)} leads had a real two-way conversation`} />
            <Stat value={k.reach.avg_attempts == null ? "—" : String(k.reach.avg_attempts)} label="Attempts to reach a lead" change={ch.pct(k.reach.avg_attempts, pk?.reach.avg_attempts, "down")}
              note={`${n(k.reach.leads)} leads we had to reach out to: ${n(k.reach.first_try)} reached first try, ${n(k.reach.two_three)} in 2–3, ${n(k.reach.four_plus)} in 4+, ${n(k.reach.came_back)} came back on their own`} />
            <Stat value={pct(k.reach.leads ? k.reach.never / k.reach.leads : null)} label="Never reached" change={ch.pts(rt(k.reach.never, k.reach.leads), pk && rt(pk.reach.never, pk.reach.leads), "down")} tone={k.reach.never ? "down" : undefined}
              note={`${n(k.reach.never)} with no conversation within 7 days${k.reach.still_trying ? `; ${n(k.reach.still_trying)} newer leads still in their first week` : ""}`} />
            <Stat value={pct(k.leads ? k.unworked / k.leads : null)} label="Unworked leads" change={ch.pts(rt(k.unworked, k.leads), pk && rt(pk.unworked, pk.leads), "down")} note={`${n(k.unworked)} leads never got a call or text from a person`} tone={k.unworked ? "down" : undefined} />
            <Stat value={minutes(k.median_first_any_min)} label="First response, automatic included" change={ch.pct(k.median_first_any_min, pk?.median_first_any_min, "down", minutes)} note="Calls and texts that came in; form leads get the auto-text instantly" />
            <Stat value={k.lead_to_booking_days == null ? "—" : `${k.lead_to_booking_days} days`} label="Lead to booking" change={ch.pct(k.lead_to_booking_days, pk?.lead_to_booking_days, "down")} note={`Median; ${k.touches_before_booking ?? "—"} touches before booking on average (matched by phone)`} />
          </div>
        </section>

        <section className="section" aria-labelledby="speed-h">
          <div className="section-head"><h2 id="speed-h">Does speed pay off?</h2><span className="muted small">Booked = matched to a Jobber job by phone</span></div>
          <div className="stats">
            <Stat value={pct(k.within_5_min)} label="Answered within 5 min" change={ch.pts(k.within_5_min, pk?.within_5_min)}
              note={`${n(k.speed_booking.fast_leads)} of ${n(k.timed_leads)} leads${k.waiting_on_them ? `; ${n(k.waiting_on_them)} form ${k.waiting_on_them === 1 ? "lead never" : "leads never"} replied to the auto-text, so ${k.waiting_on_them === 1 ? "isn't" : "aren't"} timed` : ""}`} />
            <Stat value={pct(k.speed_booking.fast_leads ? k.speed_booking.fast_booked / k.speed_booking.fast_leads : null)} label="Booked, answered within 5 min" change={ch.pts(rt(k.speed_booking.fast_booked, k.speed_booking.fast_leads), pk && rt(pk.speed_booking.fast_booked, pk.speed_booking.fast_leads))}
              note={`${n(k.speed_booking.fast_booked)} of ${n(k.speed_booking.fast_leads)} leads`} />
            <Stat value={pct(k.speed_booking.slow_leads ? k.speed_booking.slow_booked / k.speed_booking.slow_leads : null)} label="Booked, answered after 5 min" change={ch.pts(rt(k.speed_booking.slow_booked, k.speed_booking.slow_leads), pk && rt(pk.speed_booking.slow_booked, pk.speed_booking.slow_leads))}
              note={`${n(k.speed_booking.slow_booked)} of ${n(k.speed_booking.slow_leads)} leads`} />
          </div>
          <p className="muted small" style={{ maxWidth: "75ch" }}>
            {n(k.speed_booking.matched_leads)} of this period&rsquo;s {n(k.leads)} leads have a phone number that matches a Jobber client, so these booking rates firm up as more profiles carry phone numbers.
            Form leads are timed from the auto-text if you reached them within 24 hours, otherwise from their reply to your next reply. Follow-ups after 24 hours of silence don&rsquo;t count.
          </p>
        </section>

        <section className="section" aria-labelledby="fu-h">
          <div className="section-head"><h2 id="fu-h">Follow-ups</h2><span className="muted small">Form leads who didn&rsquo;t answer the auto-text</span></div>
          <div className="stats">
            <Stat value={pct(fu.fu1_due ? fu.fu1_done / fu.fu1_due : null)} label="First follow-up done" change={ch.pts(rt(fu.fu1_done, fu.fu1_due), pfu && rt(pfu.fu1_done, pfu.fu1_due))} note={`${n(fu.fu1_done)} of ${n(fu.fu1_due)} due`} />
            <Stat value={pct(fu.fu2_due ? fu.fu2_done / fu.fu2_due : null)} label="Second follow-up done" change={ch.pts(rt(fu.fu2_done, fu.fu2_due), pfu && rt(pfu.fu2_done, pfu.fu2_due))} note={`${n(fu.fu2_done)} of ${n(fu.fu2_due)} due`} />
            <Stat value={pct(fu.followed_up ? fu.followed_up_booked / fu.followed_up : null)} label="Booked after a follow-up" change={ch.pts(rt(fu.followed_up_booked, fu.followed_up), pfu && rt(pfu.followed_up_booked, pfu.followed_up))}
              note={`${n(fu.followed_up_booked)} of ${n(fu.followed_up)} followed-up leads; ${n(fu.followed_up_replied)} replied`} />
            <Stat value={n(k.not_converted)} label="Never replied" change={ch.pct(k.not_converted, pk?.not_converted, "down")} note={`Got the auto-text and both follow-ups${k.got_both_follow_ups ? `; ${pct(k.not_converted / k.got_both_follow_ups)} of ${n(k.got_both_follow_ups)}` : ""}`} />
          </div>
          <p className="muted small" style={{ maxWidth: "75ch" }}>
            First follow-up is due when they haven&rsquo;t replied 24 hours after the auto-text, and counts if someone calls or texts 12&ndash;48 hours after it.
            Second follow-up is due when they haven&rsquo;t replied 24 hours after the first, and counts 12&ndash;48 hours after the first. Each is counted once it&rsquo;s done
            or its window has closed. Booked is matched by phone ({n(fu.followed_up_matched)} of {n(fu.followed_up)} followed-up leads match a Jobber client).
          </p>
        </section>

        <section className="section" aria-labelledby="tq-h">
          <div className="section-head"><h2 id="tq-h">Time to quote</h2><span className="muted small">From their first call or text to their first quote</span></div>
          <div className="stats">
            <Stat value={hours(k.quote_speed.avg_hours)} label="Average time to quote" change={ch.pct(k.quote_speed.avg_hours, pk?.quote_speed.avg_hours, "down", hours)} note={`Median ${hours(k.quote_speed.median_hours)}, ${n(k.quote_speed.quoted)} quoted leads`} />
            <Stat value={pct(k.quote_speed.fast_quoted ? k.quote_speed.fast_booked / k.quote_speed.fast_quoted : null)} label="Booked, quoted within 24 hr" change={ch.pts(rt(k.quote_speed.fast_booked, k.quote_speed.fast_quoted), pk && rt(pk.quote_speed.fast_booked, pk.quote_speed.fast_quoted))}
              note={`${n(k.quote_speed.fast_booked)} of ${n(k.quote_speed.fast_quoted)} leads`} />
            <Stat value={pct(k.quote_speed.slow_quoted ? k.quote_speed.slow_booked / k.quote_speed.slow_quoted : null)} label="Booked, quoted after 24 hr" change={ch.pts(rt(k.quote_speed.slow_booked, k.quote_speed.slow_quoted), pk && rt(pk.quote_speed.slow_booked, pk.quote_speed.slow_quoted))}
              note={`${n(k.quote_speed.slow_booked)} of ${n(k.quote_speed.slow_quoted)} leads`} />
          </div>
          <p className="muted small" style={{ maxWidth: "75ch" }}>
            For form leads, first contact is their reply to the auto-text. Quotes and bookings are matched to the lead by phone number, so only leads whose Jobber profile has their phone are included.
          </p>
        </section>

        <section className="section" aria-labelledby="missed-h">
          <div className="section-head"><h2 id="missed-h">Missed calls</h2><span className="muted small">All callers, not just new leads</span></div>
          <div className="stats">
            <Stat value={n(m.missed)} label="Missed calls" change={ch.pct(m.missed, pm?.missed, "down")} note={m.inbound_calls ? `${pct(m.missed / m.inbound_calls)} of ${n(m.inbound_calls)} incoming calls` : undefined} tone={m.missed ? "down" : undefined} />
            <Stat value={n(m.returned)} label="Got back to" change={ch.pct(m.returned, pm?.returned)} note={m.median_return_min != null ? `Median ${minutes(m.median_return_min)} later` : undefined} />
            <Stat value={n(m.not_returned)} label="Never returned" change={ch.pct(m.not_returned, pm?.not_returned, "down")} note="No call, text or answered call since" tone={m.not_returned ? "down" : undefined} />
            <Stat value={n(m.voicemails)} label="Left a voicemail" change={ch.pct(m.voicemails, pm?.voicemails, "none")} />
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

        {k.by_zip.length > 0 && (
          <section className="section" aria-labelledby="zip-h">
            <div className="section-head"><h2 id="zip-h">Revenue per lead by ZIP</h2><span className="muted small">Completed revenue within 180 days; leads matched to Jobber by phone, ZIPs with 2+ leads</span></div>
            <table className="rows">
              <thead><tr><th>ZIP</th><th className="num">Leads</th><th className="num">Booked</th><th className="num">Revenue</th><th className="num">Per lead</th></tr></thead>
              <tbody>{k.by_zip.map((z) => (
                <tr key={z.zip}><td>{z.zip}</td><td className="num">{n(z.leads)}</td><td className="num">{n(z.booked)}</td><td className="num">{money(z.revenue)}</td><td className="num">{money(z.revenue_per_lead)}</td></tr>
              ))}</tbody>
            </table>
          </section>
        )}

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
          <div className="section-head"><h2 id="list-h">Lead list</h2><span className="muted small">{n(list.length)} leads, {periodPhrase(period)}</span></div>
          <LeadSheet rows={list} />
        </section>
      </main>
    </Shell>
  );
}
