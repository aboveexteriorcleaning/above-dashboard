import Link from "next/link";
import { LINKED_PERIOD, PERIODS, previousPeriod, type Period, type PeriodKey } from "@/lib/periods";

// Preset periods, plus a Custom picker: any date range, compared with the stretch
// right before it, the same dates a year earlier, any other dates, or nothing.
// It's a plain form (no scripts): applying it reloads the page with the dates in the address.
export function Periods({ current, base, linked = false, period }: { current: PeriodKey; base: string; linked?: boolean; period?: Period }) {
  const prev = period ? previousPeriod(period) : null;
  const isCustom = current === "custom";
  const cmp = period?.cmp ?? "year";
  return (
    <div className="periods-wrap">
      <div className="periods-row">
        <nav className="periods" aria-label="Reporting period">
          {(linked ? [...PERIODS, LINKED_PERIOD] : PERIODS).map((p) => (
            <Link key={p.key} href={`${base}?p=${p.key}`} aria-current={p.key === current ? "true" : undefined}>{p.label}</Link>
          ))}
        </nav>
        {period && (
          <details className="custom-range" open={undefined}>
            <summary aria-current={isCustom ? "true" : undefined}>{isCustom ? period.label : "Custom"}</summary>
            <form method="get" action={base} className="custom-form">
              <input type="hidden" name="p" value="custom" />
              <fieldset>
                <legend>Show</legend>
                <label>From<input type="date" name="from" defaultValue={period.from} required min="2015-01-01" /></label>
                <label>To<input type="date" name="to" defaultValue={period.to} required min="2015-01-01" /></label>
              </fieldset>
              <fieldset>
                <legend>Compare with</legend>
                <select name="cmp" defaultValue={cmp} aria-label="Compare with">
                  <option value="year">Same dates a year earlier</option>
                  <option value="prev">The same length of time just before</option>
                  <option value="custom">Other dates…</option>
                  <option value="none">No comparison</option>
                </select>
                <div className="cmp-dates">
                  <label>From<input type="date" name="cf" defaultValue={period.compare?.from ?? prev?.from ?? ""} min="2015-01-01" /></label>
                  <label>To<input type="date" name="ct" defaultValue={period.compare?.to ?? prev?.to ?? ""} min="2015-01-01" /></label>
                </div>
              </fieldset>
              <button className="btn" type="submit">Apply</button>
              <p className="muted small">Up to 3 years at a time.</p>
            </form>
          </details>
        )}
      </div>
      {prev && <div className="compare-note">Changes compare with {prev.label}</div>}
    </div>
  );
}
