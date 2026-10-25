const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export const money = (v: number | null | undefined) => (v == null ? "—" : usd0.format(v));
export const moneyExact = (v: number | null | undefined) => (v == null ? "—" : usd2.format(v));
export const n = (v: number | null | undefined) => (v == null ? "—" : num.format(v));
export const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

/** "$12.4k" style for tight spaces. */
export function moneyShort(v: number | null | undefined) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 10_000) return `$${Math.round(v / 1000)}k`;
  if (a >= 1_000) return `$${(v / 1000).toFixed(1)}k`;
  return usd0.format(v);
}

/** 11.25 -> "11 hr 15 min" (exact, for goals people watch). */
export function hm(h: number | null | undefined) {
  if (h == null) return "—";
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60), mm = total % 60;
  return mm ? `${hh} hr ${mm} min` : `${hh} hr`;
}

export function hours(h: number | null | undefined) {
  if (h == null) return "—";
  if (h < 48) return `${num.format(h)} hr`;
  return `${num.format(h / 24)} days`;
}

export function timeAgo(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function shortDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" }).format(new Date(iso));
}

/** Change vs. a previous value, as a signed percentage, or null when there's nothing to compare. */
export function change(now: number, before: number) {
  if (!before) return null;
  return (now - before) / before;
}

/** Minutes as a short duration: "4 min", "2.5 hr", "3 days". */
export function minutes(m: number | null | undefined) {
  if (m == null) return "—";
  if (m < 1) return "under 1 min";
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 48 * 60) return `${Math.round((m / 60) * 10) / 10} hr`;
  return `${Math.round((m / 1440) * 10) / 10} days`;
}
