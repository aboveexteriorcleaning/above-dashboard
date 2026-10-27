// Reporting periods, always on Pacific time (the business's day).

export type PeriodKey = "week" | "month" | "last-month" | "30d" | "ytd" | "linked" | "custom";
/** What to compare a custom range with. */
export type CompareMode = "prev" | "year" | "custom" | "none";
/** Period settings as they arrive in the page address. */
export type PeriodParams = { p?: string; from?: string; to?: string; cmp?: string; cf?: string; ct?: string };

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

export function resolvePeriod(input: string | PeriodParams | undefined, now: Date = new Date()): {
  key: PeriodKey; from: string; to: string; label: string; cmp?: CompareMode; compare?: { from: string; to: string } | null;
} {
  const params: PeriodParams = typeof input === "object" && input ? input : { p: input as string | undefined };
  const key = params.p;
  if (key === "custom") {
    const c = customRange(params);
    if (c) return c;
  }
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

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const EARLIEST = "2015-01-01";
const MAX_DAYS = 3 * 366;   // keep one page load to at most ~3 years of data
function validDate(d: string | undefined): d is string {
  if (!d || !ISO.test(d)) return false;
  const [y, m, dd] = parse(d);
  return iso(y, m, dd) === d && d >= EARLIEST && y <= 2100;
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
function validRange(a: string | undefined, b: string | undefined): [string, string] | null {
  if (!validDate(a) || !validDate(b)) return null;
  const [f, t] = a <= b ? [a, b] : [b, a];
  return daysBetween(f, t) <= MAX_DAYS ? [f, t] : null;
}
function customRange(q: PeriodParams) {
  const r = validRange(q.from, q.to);
  if (!r) return null;
  const cmp: CompareMode = q.cmp === "year" || q.cmp === "custom" || q.cmp === "none" ? q.cmp : "prev";
  const compare = cmp === "custom" ? validRange(q.cf, q.ct) : null;
  return { key: "custom" as PeriodKey, from: r[0], to: r[1], label: rangeLabel(r[0], r[1], true), cmp,
           compare: compare ? { from: compare[0], to: compare[1] } : null };
}

/** The address query that reproduces a period (for links that keep the period). */
export function periodQuery(p: Period): string {
  if (p.key !== "custom") return `p=${p.key}`;
  const q = new URLSearchParams({ p: "custom", from: p.from, to: p.to, cmp: p.cmp ?? "prev" });
  if (p.cmp === "custom" && p.compare) { q.set("cf", p.compare.from); q.set("ct", p.compare.to); }
  return q.toString();
}

/** "This month, Oct 1 to Oct 26" for presets; "Aug 1–31, 2025" for custom ranges. */
export function periodLine(p: Period, fmt: (iso: string) => string): string {
  return p.key === "custom" ? p.label : `${p.label}, ${fmt(p.from + "T12:00:00Z")} to ${fmt(p.to + "T12:00:00Z")}`;
}
/** Lowercase phrase for use mid-sentence: "this month", or "Aug 1–31, 2025". */
export const periodPhrase = (p: Period) => (p.key === "custom" ? p.label : p.label.toLowerCase());
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
  if (p.key === "custom") {
    let from: string, to: string;
    if (p.cmp === "none") return null;
    if (p.cmp === "custom") { if (!p.compare) return null; ({ from, to } = p.compare); }
    else if (p.cmp === "year") {
      const [fy2, fm2, fd2] = parse(p.from), [ty2, tm2, td2] = parse(p.to);
      from = iso(fy2 - 1, fm2, Math.min(fd2, lastDay(fy2 - 1, fm2)));
      to = iso(ty2 - 1, tm2, Math.min(td2, lastDay(ty2 - 1, tm2)));
    } else {   // the equal-length stretch right before
      const len = daysBetween(p.from, p.to);
      to = shift(p.from, -1); from = shift(to, -len);
    }
    return { from, to, label: rangeLabel(from, to, true) };
  }
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
