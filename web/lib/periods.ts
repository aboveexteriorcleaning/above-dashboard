// Reporting periods, always on Pacific time (the business's day).

export type PeriodKey = "week" | "month" | "last-month" | "30d" | "ytd";

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "30d", label: "Last 30 days" },
  { key: "ytd", label: "Year to date" },
];

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
  const k = (PERIODS.find((p) => p.key === key)?.key ?? "month") as PeriodKey;
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
    default:
      from = iso(t.y, t.m, 1);
  }
  return { key: k, from, to, label: PERIODS.find((p) => p.key === k)!.label };
}
