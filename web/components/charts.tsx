import { money, moneyShort, n } from "@/lib/format";

/** Booked → Completed → Invoiced → Paid. A real sequence, drawn as one connected band. */
export function MoneyFlow({ stages }: { stages: { label: string; value: number; note: string }[] }) {
  const max = Math.max(...stages.map((s) => s.value), 1);
  return (
    <section className="flow" aria-label="Revenue from booking to payment">
      <div className="flow-stages">
        {stages.map((s) => (
          <div key={s.label} className="flow-stage">
            <div className="flow-label">{s.label}</div>
            <div className="flow-value figure">{money(s.value)}</div>
            <div className="flow-note">{s.note}</div>
          </div>
        ))}
      </div>
      <div className="flow-bars" aria-hidden>
        {stages.map((s) => <div key={s.label} className="flow-bar" style={{ height: `${Math.max(4, (s.value / max) * 100)}%` }} />)}
      </div>
    </section>
  );
}

export function BarRows({ rows, label, valueLabel = "Revenue", extra }: {
  rows: { key: string; label: React.ReactNode; value: number; sub?: React.ReactNode }[];
  label: string; valueLabel?: string; extra?: string;
}) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  if (rows.length === 0) return <p className="muted">Nothing in this period yet.</p>;
  return (
    <table className="rows">
      <thead><tr><th>{label}</th>{extra && <th className="num hide-sm">{extra}</th>}<th className="num">{valueLabel}</th><th className="barcell hide-sm" aria-hidden /></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.label}</td>
            {extra && <td className="num muted hide-sm">{r.sub}</td>}
            <td className="num">{money(r.value)}</td>
            <td className="barcell hide-sm" aria-hidden>
              <div className="track"><div className={`bar${r.value < 0 ? " neg" : ""}`} style={{ width: `${(Math.abs(r.value) / max) * 100}%` }} /></div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Aging({ r }: { r: { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number } }) {
  const parts = [
    // Gets steadily warmer and darker as invoices age.
    { k: "Not yet due", v: r.current, c: "var(--glass)" },
    { k: "1–30 days late", v: r.d1_30, c: "color-mix(in srgb, var(--cedar) 40%, var(--mist))" },
    { k: "31–60 days", v: r.d31_60, c: "color-mix(in srgb, var(--cedar) 70%, var(--mist))" },
    { k: "61–90 days", v: r.d61_90, c: "var(--cedar)" },
    { k: "Over 90 days", v: r.d90_plus, c: "color-mix(in srgb, var(--cedar) 65%, #3a0f00)" },
  ];
  const total = parts.reduce((a, p) => a + p.v, 0);
  if (!total) return <p className="muted">No unpaid invoices.</p>;
  return (
    <div>
      <div className="aging" role="img" aria-label={parts.map((p) => `${p.k}: ${money(p.v)}`).join(", ")}>
        {parts.map((p) => p.v > 0 && <span key={p.k} style={{ width: `${(p.v / total) * 100}%`, background: p.c }} />)}
      </div>
      <div className="legend">
        {parts.map((p) => <div key={p.k}><i style={{ background: p.c }} />{p.k}<br /><strong>{money(p.v)}</strong></div>)}
      </div>
    </div>
  );
}

/** Completed revenue by month. The current month is drawn in the accent; earlier months are muted. */
export function Trend({ rows }: { rows: { month: string; completed_revenue: number; completed_jobs: number }[] }) {
  const W = 720, H = 220, pad = { l: 44, r: 8, t: 16, b: 26 };
  const max = Math.max(...rows.map((r) => r.completed_revenue), 1);
  const nice = niceMax(max);
  const bw = (W - pad.l - pad.r) / rows.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / nice);
  const mon = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return (
    <figure className="trend" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Completed revenue by month">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(nice * f)} y2={y(nice * f)} stroke="var(--rule)" />
            <text x={pad.l - 6} y={y(nice * f) + 4} textAnchor="end">{moneyShort(nice * f)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = pad.l + i * bw + bw * 0.18, w = bw * 0.64, last = i === rows.length - 1;
          return (
            <g key={r.month}>
              <rect x={x} y={y(r.completed_revenue)} width={w} height={Math.max(0, y(0) - y(r.completed_revenue))} rx={3}
                fill={last ? "var(--glass)" : "color-mix(in srgb, var(--glass) 35%, var(--rule))"}>
                <title>{`${mon(r.month)}: ${money(r.completed_revenue)} from ${n(r.completed_jobs)} jobs`}</title>
              </rect>
              <text x={x + w / 2} y={H - 8} textAnchor="middle">{mon(r.month)}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= v * 1.05) ?? v;
}

export function Stat({ value, label, note, tone }: { value: React.ReactNode; label: string; note?: React.ReactNode; tone?: "up" | "down" }) {
  return (
    <div>
      <div className={`stat-value figure${tone ? " " + tone : ""}`}>{value}</div>
      <div className="stat-label">{label}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}
