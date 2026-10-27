import { test } from "node:test";
import assert from "node:assert/strict";
import { previousPeriod, resolvePeriod } from "./periods.ts";

// 2026-10-24 21:30 UTC = Sat Oct 24, 2:30pm Pacific
const sat = new Date("2026-10-24T21:30:00Z");
// 2026-11-01 06:30 UTC = Sat Oct 31, 11:30pm Pacific (still October locally)
const lateHalloween = new Date("2026-11-01T06:30:00Z");

test("this month", () => assert.deepEqual(
  [resolvePeriod("month", sat).from, resolvePeriod("month", sat).to], ["2026-10-01", "2026-10-24"]));
test("week starts Monday", () => assert.equal(resolvePeriod("week", sat).from, "2026-10-19"));
test("last month", () => assert.deepEqual(
  [resolvePeriod("last-month", sat).from, resolvePeriod("last-month", sat).to], ["2026-09-01", "2026-09-30"]));
test("30 days includes today", () => assert.equal(resolvePeriod("30d", sat).from, "2026-09-25"));
test("year to date", () => assert.equal(resolvePeriod("ytd", sat).from, "2026-01-01"));
test("unknown period falls back to this month", () => assert.equal(resolvePeriod("nope", sat).key, "month"));
test("uses Pacific date, not UTC, late at night", () => {
  const p = resolvePeriod("month", lateHalloween);
  assert.deepEqual([p.from, p.to], ["2026-10-01", "2026-10-31"]);
});
test("Sunday belongs to the week that started Monday", () =>
  assert.equal(resolvePeriod("week", new Date("2026-10-25T20:00:00Z")).from, "2026-10-19"));

test("since Oct 24: from the day lead profiles carried phone numbers", () => {
  const r = resolvePeriod("linked", new Date("2026-10-25T18:00:00Z"));
  assert.equal(r.from, "2026-10-24");
  assert.equal(r.to, "2026-10-25");
  assert.equal(r.label, "Since Oct 24");
});

// ---------- comparisons ----------
const mon = new Date("2026-10-26T20:00:00Z");   // Mon Oct 26, Pacific
const prev = (k: string, now: Date) => { const p = previousPeriod(resolvePeriod(k, now)); return p && [p.from, p.to, p.label]; };
test("this week so far vs the same days last week", () => assert.deepEqual(prev("week", sat), ["2026-10-12", "2026-10-17", "Oct 12–17"]));
test("this week on a Monday vs last Monday", () => assert.deepEqual(prev("week", mon), ["2026-10-19", "2026-10-19", "Oct 19"]));
test("this month so far vs the same days last month", () => assert.deepEqual(prev("month", mon), ["2026-09-01", "2026-09-26", "Sep 1–26"]));
test("month comparison stops at the shorter month's end", () =>
  assert.deepEqual(prev("month", new Date("2026-03-31T19:00:00Z")), ["2026-02-01", "2026-02-28", "Feb 1–28"]));
test("January compares with December", () =>
  assert.deepEqual(prev("month", new Date("2027-01-10T19:00:00Z")), ["2026-12-01", "2026-12-10", "Dec 1–10"]));
test("last month vs the month before", () => assert.deepEqual(prev("last-month", mon), ["2026-08-01", "2026-08-31", "Aug 1–31"]));
test("last 30 days vs the 30 before", () => assert.deepEqual(prev("30d", mon), ["2026-08-28", "2026-09-26", "Aug 28 – Sep 26"]));
test("year to date vs the same dates last year", () => assert.deepEqual(prev("ytd", mon), ["2025-01-01", "2025-10-26", "Jan 1 – Oct 26, 2025"]));
test("no comparison for Since Oct 24", () => assert.equal(previousPeriod(resolvePeriod("linked", mon)), null));

// ---------- custom ranges ----------
import { periodQuery } from "./periods.ts";
const custom = (q: Record<string, string>) => resolvePeriod({ p: "custom", ...q }, mon);
test("custom range: August vs the same dates a year earlier", () => {
  const p = custom({ from: "2026-08-01", to: "2026-08-31", cmp: "year" });
  assert.deepEqual([p.key, p.from, p.to, p.label], ["custom", "2026-08-01", "2026-08-31", "Aug 1–31, 2026"]);
  assert.deepEqual(previousPeriod(p), { from: "2025-08-01", to: "2025-08-31", label: "Aug 1–31, 2025" });
});
test("custom range: compare with the equal stretch right before", () =>
  assert.deepEqual(previousPeriod(custom({ from: "2026-08-01", to: "2026-08-31", cmp: "prev" })),
    { from: "2026-07-01", to: "2026-07-31", label: "Jul 1–31, 2026" }));
test("custom range: compare with any dates", () =>
  assert.deepEqual(previousPeriod(custom({ from: "2026-08-01", to: "2026-08-31", cmp: "custom", cf: "2024-08-01", ct: "2024-08-31" })),
    { from: "2024-08-01", to: "2024-08-31", label: "Aug 1–31, 2024" }));
test("custom range: no comparison", () => assert.equal(previousPeriod(custom({ from: "2026-08-01", to: "2026-08-31", cmp: "none" })), null));
test("custom range: leap day a year earlier becomes Feb 28", () =>
  assert.equal(previousPeriod(custom({ from: "2028-02-01", to: "2028-02-29", cmp: "year" }))!.to, "2027-02-28"));
test("custom range: reversed dates are swapped", () => assert.equal(custom({ from: "2026-08-31", to: "2026-08-01" }).from, "2026-08-01"));
test("custom range: bad or huge ranges fall back to this month", () => {
  assert.equal(custom({ from: "2026-02-30", to: "2026-03-05" }).key, "month");
  assert.equal(custom({ from: "2015-01-01", to: "2026-01-01" }).key, "month");
  assert.equal(custom({ from: "x", to: "y" }).key, "month");
});
test("links keep a custom period", () =>
  assert.equal(periodQuery(custom({ from: "2026-08-01", to: "2026-08-31", cmp: "year" })), "p=custom&from=2026-08-01&to=2026-08-31&cmp=year"));
