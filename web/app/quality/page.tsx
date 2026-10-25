import { Shell, requireSession } from "@/components/Shell";
import { Periods } from "@/components/Periods";
import { Stat } from "@/components/charts";
import { getQuality } from "@/lib/data";
import { resolvePeriod } from "@/lib/periods";
import { money, n, pct, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Quality({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner"]);
  const period = resolvePeriod((await searchParams).p);
  const q = await getQuality(period.from, period.to);

  return (
    <Shell page="quality" session={session}>
      <main>
        <div className="pagehead">
          <div>
            <h1>Quality</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>{period.label}, {shortDate(period.from + "T12:00:00Z")} to {shortDate(period.to + "T12:00:00Z")}</p>
          </div>
          <Periods current={period.key} base="/quality" />
        </div>

        <section aria-labelledby="cb-h">
          <div className="section-head"><h2 id="cb-h">Callbacks</h2><span className="muted small">Jobs titled &ldquo;Callback – #job number&rdquo;</span></div>
          <div className="stats">
            <Stat value={pct(q.completed_jobs ? q.callbacks / q.completed_jobs : null)} label="Callback rate" note={`${n(q.callbacks)} callbacks, ${n(q.completed_jobs)} completed jobs`} tone={q.callbacks ? "down" : undefined} />
            <Stat value={`${n(q.rework_hours)} hr`} label="Rework hours" note="Scheduled callback time × crew" />
            <Stat value={money(q.callback_cost)} label="Callback cost" note="Rework hours × average crew hourly cost" />
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

        <section className="section" aria-labelledby="more-h">
          <div className="section-head"><h2 id="more-h">Coming later</h2></div>
          <p className="muted" style={{ maxWidth: "75ch" }}>
            Reviews (average rating, five-star reviews per 100 jobs, reviews by crew) once Google Business Profile is connected.
            Complaints, damage claims and safety incidents need a place to log them; on-time arrival needs per-visit start times from Jobber.
          </p>
        </section>
      </main>
    </Shell>
  );
}
