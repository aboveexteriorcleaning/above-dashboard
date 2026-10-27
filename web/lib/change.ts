// Period-over-period change shown beside a number.
export type Change = { text: string; tone: "good" | "bad" | "flat"; title: string } | null;
type Better = "up" | "down" | "none";
type Num = number | null | undefined;

const ok = (v: Num): v is number => v != null && Number.isFinite(v);
function toneOf(diff: number, better: Better): "good" | "bad" | "flat" {
  if (diff === 0 || better === "none") return "flat";
  return (diff > 0) === (better === "up") ? "good" : "bad";
}

/** Percent change of a count or amount. `better` says which way is good news. */
export function pct(cur: Num, prev: Num, better: Better = "up", fmt: (n: number) => string = String): Change {
  if (!ok(cur) || !ok(prev)) return null;
  if (prev === 0) return cur === 0 ? null : { text: "new", tone: toneOf(cur, better), title: `Previous period: ${fmt(0)}` };
  const ch = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  const arrow = ch > 0 ? "▲" : ch < 0 ? "▼" : "";
  return { text: `${arrow} ${Math.abs(ch)}%`.trim(), tone: toneOf(ch, better), title: `Previous period: ${fmt(prev)}` };
}

/** Change of a rate (0.42 = 42%), in percentage points, since a percent of a percent is confusing. */
export function pts(cur: Num, prev: Num, better: Better = "up"): Change {
  if (!ok(cur) || !ok(prev)) return null;
  const ch = Math.round((cur - prev) * 100);
  const arrow = ch > 0 ? "▲" : ch < 0 ? "▼" : "";
  return { text: `${arrow} ${Math.abs(ch)} pts`.trim(), tone: toneOf(ch, better), title: `Previous period: ${Math.round(prev * 100)}%` };
}
