// Runs the real save code against a local test database.
//   SUPABASE_DB_URL=postgres://postgres@localhost:54329/synctest deno test -A tests/store_integration_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { db } from "../_shared/db.ts";
import {
  refreshDerived, saveClients, saveJobs, saveQuotes, saveRequests, saveTimesheets, saveUsers,
} from "../_shared/store.ts";

const users = [{ id: "U-CONNOR", name: { full: "Connor (test)" } }, { id: "U-SAGE", name: { full: "Sage (test)" } },
               { id: "U-KALE", name: { full: "Kale (test)" } }];
const quote = {
  id: "Q1", quoteNumber: "1", quoteStatus: "converted", createdAt: "2026-10-01T00:00:00Z", sentAt: "2026-10-01T01:00:00Z",
  client: { id: "C1" }, request: { id: "R1" }, salesperson: { id: "U-KALE" },
  amounts: { subtotal: 1000, discountAmount: 0, total: 1084 },
  lastTransitioned: { approvedAt: "2026-10-02T00:00:00Z", convertedAt: "2026-10-02T00:01:00Z" },
  lineItems: { nodes: [
    { id: "QL1", name: "Softwash Roof Cleaning", quantity: 1, unitPrice: 1000, totalPrice: 1000, optional: false },
    { id: "QL2", name: "Biannual Roof Cleaning Plan", quantity: 1, unitPrice: -50, totalPrice: -50, optional: false },
  ] },
};
const job = (lines: any[]) => ({
  id: "J1", jobNumber: 101, title: "Roof", jobStatus: "archived", jobType: "ONE_OFF",
  createdAt: "2026-10-02T00:01:00Z", startAt: "2026-10-10T07:00:00Z", completedAt: "2026-10-10T20:00:00Z", total: 1100,
  client: { id: "C1" }, quote: { id: "Q1" }, property: { id: "P1", address: { street1: "1 Test St", city: "Lacey", postalCode: "98516" } },
  lineItems: { nodes: lines },
  visits: { nodes: [{ id: "V1", startAt: "2026-10-10T16:00:00Z", endAt: "2026-10-10T20:00:00Z", completedAt: "2026-10-10T20:00:00Z",
    visitStatus: "COMPLETED", assignedUsers: { nodes: [{ id: "U-CONNOR" }, { id: "U-SAGE" }] } }] },
});
const baseLines = [
  { id: "L1", name: "Softwash Roof Cleaning", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
  { id: "L2", name: "Biannual Roof Cleaning Plan", quantity: 1, unitPrice: -50, totalPrice: -50 },
  { id: "L3", name: "Skylight Window Cleaning", quantity: 2, unitPrice: 30, totalPrice: 60 },   // added on site
];
const callbackJob = { ...job([]), id: "J2", jobNumber: 102, title: "Callback - #101", total: 0,
  lineItems: { nodes: [] }, visits: { nodes: [] }, quote: null };

Deno.test({ name: "save Jobber records end to end", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const sql = db();
  await saveUsers(users);
  // Children arrive before parents (as can happen with webhooks): placeholders must cover it.
  await saveJobs([job(baseLines), callbackJob], "backfill");
  await saveQuotes([quote], "backfill");
  await saveRequests([{ id: "R1", title: "Quo Request", requestStatus: "converted", source: "Quo ",
    createdAt: "2026-09-30T00:00:00Z", client: { id: "C1" } }], "backfill");
  await saveClients([{ id: "C1", name: "Test Client", isCompany: false, createdAt: "2026-09-30T00:00:00Z",
    emails: [{ address: "Test@Example.com", primary: true }], phones: [{ number: "(360) 555-0101", primary: true }] }], "backfill");
  await saveTimesheets([
    { id: "T1", startAt: "2026-10-10T16:00:00Z", endAt: "2026-10-10T19:00:00Z", user: { id: "U-CONNOR" }, job: { id: "J1" }, visit: { id: "V1" } },
    { id: "T2", startAt: "2026-10-10T16:00:00Z", endAt: "2026-10-10T17:00:00Z", user: { id: "U-SAGE" }, job: { id: "J1" }, visit: { id: "V1" } },
  ], "backfill");
  await refreshDerived();

  const [c] = await sql`select name, email, phone from public.clients where id = 'C1'`;
  assertEquals(c, { name: "Test Client", email: "test@example.com", phone: "+13605550101" });

  const [j] = await sql`select total::float, quote_id, property_id from public.jobs where id = 'J1'`;
  assertEquals(j, { total: 1010, quote_id: "Q1", property_id: "P1" });

  const flags = await sql`select id, is_plan_discount, is_onsite_upsell from public.job_line_items where job_id='J1' order by id`;
  assertEquals(flags.map((f) => [f.id, f.is_plan_discount, f.is_onsite_upsell]),
    [["L1", false, false], ["L2", true, false], ["L3", false, true]]);

  const [cb] = await sql`select is_callback, callback_of_job_id from public.jobs where id = 'J2'`;
  assertEquals(cb, { is_callback: true, callback_of_job_id: "J1" });

  const [{ n: assigned }] = await sql`select count(*)::int n from public.visit_assignments where visit_id = 'V1'`;
  assertEquals(assigned, 2);
  const [q] = await sql`select e.full_name from public.quotes q join public.employees e on e.id = q.salesperson_id where q.id='Q1'`;
  assertEquals(q.full_name, "Kale (test)");
  const [{ n: newEmployeesActive }] = await sql`select count(*)::int n from public.employees where active`;
  assertEquals(newEmployeesActive, 0, "new Jobber users must start inactive until an owner turns them on");

  // Re-sync: same data again is harmless; a line deleted in Jobber disappears here too.
  await saveJobs([job(baseLines.slice(0, 2))], "poll");
  await refreshDerived();
  const lines = await sql`select id from public.job_line_items where job_id = 'J1' order by id`;
  assertEquals(lines.map((l) => l.id), ["L1", "L2"]);
  const [{ n: ts }] = await sql`select count(*)::int n from public.timesheet_entries where visit_id = 'V1'`;
  assertEquals(ts, 2, "timesheets keep their visit link through a re-sync");

  // Status history is recorded once per change.
  await saveJobs([{ ...job(baseLines), jobStatus: "requires_invoicing" }], "webhook");
  const ev = await sql`select from_value, to_value from public.entity_events where entity_type='job' and entity_id='J1' order by id`;
  assertEquals(ev.map((e) => [e.from_value, e.to_value]), [[null, "archived"], ["archived", "requires_invoicing"]]);

  const [{ n: raw }] = await sql`select count(*)::int n from raw.records`;
  console.log(`raw records kept: ${raw}`);
  await sql.end();
}});
