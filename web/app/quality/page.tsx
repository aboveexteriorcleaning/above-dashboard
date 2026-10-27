import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { getQuality, getReviews } from "@/lib/data";
import { previousPeriod, resolvePeriod, type PeriodParams, periodLine } from "@/lib/periods";
import * as ch from "@/lib/change";
import { money, n, pct, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Quality({ searchParams }: { searchParams: Promise<PeriodParams> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod(await searchParams);
  const prev = previousPeriod(period);
  const [q, rv, pq] = await Promise.all([getQuality(period.from, period.to), getReviews(period.from, period.to), prev ? getQuality(prev.from, prev.to) : null]);

  return (
    <Shell page="quality" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Quality</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>{periodLine(period, shortDate)}</p>
          </div>
          <Periods current={period.key} base="/quality" period={period} />
        </div>

        <section aria-labelledby="cb-h">
          <div className="section-head"><h2 id="cb-h">Callbacks</h2><span className="muted small">Jobs titled &ldquo;Callback – #job number&rdquo;</span></div>
          <div className="stats">
            <Stat value={pct(q.completed_jobs ? q.callbacks / q.completed_jobs : null)} label="Callback rate" change={ch.pts(q.completed_jobs ? q.callbacks / q.completed_jobs : null, pq && pq.completed_jobs ? pq.callbacks / pq.completed_jobs : null, "down")} note={`${n(q.callbacks)} callbacks, ${n(q.completed_jobs)} completed jobs`} tone={q.callbacks ? "down" : undefined} />
            <Stat value={`${n(q.rework_hours)} hr`} label="Rework hours" change={ch.pct(q.rework_hours, pq?.rework_hours, "down")} note="Scheduled callback time × crew" />
            <Stat value={money(q.callback_cost)} label="Callback cost" change={ch.pct(q.callback_cost, pq?.callback_cost, "down", money)} note="Rework hours × average crew hourly cost" />
          </div>
          {q.unlinked > 0 && <p className="notice warn">{n(q.unlinked)} callbacks don&rsquo;t name the original job number, so they can&rsquo;t be traced to a crew.</p>}
        </section>

        <div className="grid-2 section">
          <section aria-labelledby="list-h">
            <div className="section-head"><h2 id="list-h">This period&rsquo;s callbacks</h2></div>
            {q.list.length ? (
              <table className="rows">
                <thead><tr><th>Callback</th><th>Original job / crew</th><th className="num">Rework</th></tr></thead>
                <tbody>{q.list.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.client_name ?? "Client"}</strong><div className="small muted">#{c.job_number ?? "—"}, {shortDate(c.created_at)}</div></td>
                    <td>{c.original_job_number ? `#${c.original_job_number}` : "—"}<div className="small muted">{c.original_crew ?? "Unknown crew"}</div></td>
                    <td className="num">{c.rework_hours == null ? "—" : `${c.rework_hours} hr`}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <p className="muted">No callbacks in this period.</p>}
          </section>
          <section aria-labelledby="who-h">
            <div className="section-head"><h2 id="who-h">By crew member</h2><span className="muted small">Callbacks on jobs they did</span></div>
            <table className="rows">
              <thead><tr><th>Person</th><th className="num">Jobs</th><th className="num">Callbacks</th><th className="num">Rate</th></tr></thead>
              <tbody>{q.by_person.map((p) => (
                <tr key={p.name}><td>{p.name}</td><td className="num">{n(p.jobs)}</td><td className={`num${p.callbacks ? " down" : ""}`}>{n(p.callbacks)}</td><td className="num">{pct(p.rate)}</td></tr>
              ))}</tbody>
            </table>
          </section>
        </div>

        <section className="section" aria-labelledby="rev-h">
          <div className="section-head"><h2 id="rev-h">Google reviews</h2><span className="muted small">{rv.connected ? `${rv.average_all ?? "—"} stars from ${n(rv.total_all ?? 0)} reviews, all time` : "Not connected yet"}</span></div>
          {rv.connected ? (
            <>
              <div className="stats">
                <Stat value={rv.average == null ? "—" : `${rv.average} ★`} label="Average rating" note={`${n(rv.reviews)} new reviews this period`} />
                <Stat value={rv.completed_jobs ? (rv.five_star / rv.completed_jobs * 100).toFixed(1) : "—"} label="Five-star reviews per 100 jobs" note={`${n(rv.five_star)} five-star, ${n(rv.completed_jobs)} completed jobs`} />
                <Stat value={pct(rv.requests ? rv.reviews / rv.requests : null)} label="Review request conversion" note={`${n(rv.reviews)} reviews from ${n(rv.requests)} people sent a review link in Quo`} />
                {rv.source === "places"
                  ? <Stat value="—" label="Replied to" note="Google's public listing data doesn't include owner replies" />
                  : <Stat value={pct(rv.reviews ? rv.replied / rv.reviews : null)} label="Replied to" note={rv.reply_hours != null ? `Median ${rv.reply_hours} hr to reply` : undefined} />}
                <Stat value={n(rv.low)} label="3 stars or fewer" tone={rv.low ? "down" : undefined} />
              </div>
              <div className="grid-2 section">
                <section aria-labelledby="rc-h">
                  <div className="section-head"><h3 id="rc-h">Reviews by crew</h3><span className="muted small">{n(rv.matched)} of {n(rv.reviews)} matched to a job</span></div>
                  {rv.by_person.length ? (
                    <table className="rows">
                      <thead><tr><th>Person</th><th className="num">Reviews</th><th className="num">Average</th><th className="num">Five-star</th></tr></thead>
                      <tbody>{rv.by_person.map((p) => <tr key={p.name}><td>{p.name}</td><td className="num">{n(p.reviews)}</td><td className="num">{p.average} ★</td><td className="num">{n(p.five_star)}</td></tr>)}</tbody>
                    </table>
                  ) : <p className="muted">No reviews matched to a job yet.</p>}
                  <p className="muted small">{rv.source === "places" ? "Reviews are collected from Google every 3 hours (the newest 5 each time), so history builds up from the day this was connected. " : ""}A review is matched when the reviewer&rsquo;s name (full name, or first name and last initial) matches a client who had a job done in the 60 days before.</p>
                </section>
                <section aria-labelledby="rr-h">
                  <div className="section-head"><h3 id="rr-h">Latest reviews</h3></div>
                  {rv.recent.length ? (
                    <ul className="reviews">{rv.recent.map((r) => (
                      <li key={r.id}>
                        <div><strong className={r.stars != null && r.stars <= 3 ? "down" : undefined}>{"★".repeat(r.stars ?? 0)}{"☆".repeat(5 - (r.stars ?? 0))}</strong> <span className="small muted">{r.reviewer_name ?? "Anonymous"}, {shortDate(r.created_at)}{r.crew ? ` · ${r.crew}` : ""}{r.replied || rv.source === "places" ? "" : " · not replied"}</span></div>
                        {r.comment && <p className="small" style={{ margin: "4px 0 0" }}>{r.comment}</p>}
                      </li>
                    ))}</ul>
                  ) : <p className="muted">No reviews in this period.</p>}
                </section>
              </div>
            </>
          ) : <p className="muted" style={{ maxWidth: "75ch" }}>Once Google approves API access and the Business Profile is connected, rating, reviews per 100 jobs, review request conversion and reviews by crew show here.</p>}
        </section>

        <p className="muted small section" style={{ maxWidth: "75ch" }}>
          Complaints, damage claims and safety incidents need a place to log them; on-time arrival needs per-visit start times from Jobber.
        </p>
      </main>
    </Shell>
  );
}
