// Reporting periods, always on Pacific time (the business's day).

export type PeriodKey = "week" | "month" | "last-month" | "30d" | "ytd" | "linked";

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "30d", label: "Last 30 days" },
  { key: "ytd", label: "Year to date" },
];

/** Day Jobber lead profiles started carrying the lead's phone number, so
 *  Quo leads can be matched to Jobber quotes and bookings from here on. */
export const LINKED_START = "2026-10-24";
/** Extra period, shown only on the Leads page. */
export const LINKED_PERIOD: { key: PeriodKey; label: string } = { key: "linked", label: "Since Oct 24" };

const TZ = "America/Los_Angeles";

/** Today's date in Pacific time as Y/M/D numbers. */
export function pacificToday(now: Date = new Date()): { y: number; m: number; d: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { y: +get("year"), m: +get("month"), d: +get("day"), dow: dows.indexOf(get("weekday")) };
}

const iso = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
};

export function resolvePeriod(key: string | undefined, now: Date = new Date()): { key: PeriodKey; from: string; to: string; label: string } {
  const k = ([...PERIODS, LINKED_PERIOD].find((p) => p.key === key)?.key ?? "month") as PeriodKey;
  const t = pacificToday(now);
  const today = iso(t.y, t.m, t.d);
  let from: string, to: string = today;
  switch (k) {
    case "week": { // Monday-start week
      const back = (t.dow + 6) % 7;
      from = iso(t.y, t.m, t.d - back);
      break;
    }
    case "last-month":
      from = iso(t.y, t.m - 1, 1);
      to = iso(t.y, t.m, 0);
      break;
    case "30d":
      from = iso(t.y, t.m, t.d - 29);
      break;
    case "ytd":
      from = iso(t.y, 1, 1);
      break;
    case "linked":
      from = LINKED_START < today ? LINKED_START : today;
      break;
    default:
      from = iso(t.y, t.m, 1);
  }
  return { key: k, from, to, label: [...PERIODS, LINKED_PERIOD].find((p) => p.key === k)!.label };
}

export type Period = ReturnType<typeof resolvePeriod>;
export type PrevPeriod = { from: string; to: string; label: string };

const parse = (d: string) => d.split("-").map(Number) as [number, number, number];
const shift = (d: string, days: number) => { const [y, m, dd] = parse(d); return iso(y, m, dd + days); };
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function rangeLabel(from: string, to: string, withYear = false) {
  const [fy, fm, fd] = parse(from), [ty, tm, td] = parse(to);
  const y = withYear ? `, ${ty}` : "";
  if (from === to) return `${MONTHS[fm - 1]} ${fd}${y}`;
  if (fm === tm && fy === ty) return `${MONTHS[fm - 1]} ${fd}–${td}${y}`;
  return `${MONTHS[fm - 1]} ${fd} – ${MONTHS[tm - 1]} ${td}${y}`;
}

/** The equal earlier period to compare against, like-for-like: this week so far
 *  vs the same days last week, this month so far vs the same days last month,
 *  last month vs the month before, the last 30 days vs the 30 before, and year
 *  to date vs the same dates last year. None for "Since Oct 24". */
export function previousPeriod(p: Period): PrevPeriod | null {
  const [fy, fm] = parse(p.from);
  const [ty, tm, td] = parse(p.to);
  let from: string, to: string, withYear = false;
  switch (p.key) {
    case "week": from = shift(p.from, -7); to = shift(p.to, -7); break;
    case "30d": from = shift(p.from, -30); to = shift(p.to, -30); break;
    case "month": {
      const py = fm === 1 ? fy - 1 : fy, pm = fm === 1 ? 12 : fm - 1;
      from = iso(py, pm, 1); to = iso(py, pm, Math.min(td, lastDay(py, pm)));
      break;
    }
    case "last-month": {
      const py = fm === 1 ? fy - 1 : fy, pm = fm === 1 ? 12 : fm - 1;
      from = iso(py, pm, 1); to = iso(py, pm, lastDay(py, pm));
      break;
    }
    case "ytd":
      from = iso(fy - 1, 1, 1); to = iso(ty - 1, tm, Math.min(td, lastDay(ty - 1, tm))); withYear = true;
      break;
    default: return null;
  }
  return { from, to, label: rangeLabel(from, to, withYear) };
}
