import Link from "next/link";
import { LINKED_PERIOD, PERIODS, type PeriodKey } from "@/lib/periods";

export function Periods({ current, base, linked = false }: { current: PeriodKey; base: string; linked?: boolean }) {
  return (
    <nav className="periods" aria-label="Reporting period">
      {(linked ? [...PERIODS, LINKED_PERIOD] : PERIODS).map((p) => (
        <Link key={p.key} href={`${base}?p=${p.key}`} aria-current={p.key === current ? "true" : undefined}>{p.label}</Link>
      ))}
    </nav>
  );
}
