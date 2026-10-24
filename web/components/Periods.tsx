import Link from "next/link";
import { PERIODS, type PeriodKey } from "@/lib/periods";

export function Periods({ current, base }: { current: PeriodKey; base: string }) {
  return (
    <nav className="periods" aria-label="Reporting period">
      {PERIODS.map((p) => (
        <Link key={p.key} href={`${base}?p=${p.key}`} aria-current={p.key === current ? "true" : undefined}>{p.label}</Link>
      ))}
    </nav>
  );
}
