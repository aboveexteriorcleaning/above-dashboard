import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePeriod } from "./periods.ts";

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
