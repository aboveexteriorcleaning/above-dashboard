import Link from "next/link";
import { LINKED_PERIOD, PERIODS, previousPeriod, type Period, type PeriodKey } from "@/lib/periods";

export function Periods({ current, base, linked = false, period }: { current: PeriodKey; base: string; linked?: boolean; period?: Period }) {
  const prev = period ? previousPeriod(period) : null;
  return (
    <div className="periods-wrap">
      <nav className="periods" aria-label="Reporting period">
        {(linked ? [...PERIODS, LINKED_PERIOD] : PERIODS).map((p) => (
          <Link key={p.key} href={`${base}?p=${p.key}`} aria-current={p.key === current ? "true" : undefined}>{p.label}</Link>
        ))}
      </nav>
      {prev && <div className="compare-note">Changes compare with {prev.label}</div>}
    </div>
  );
}
