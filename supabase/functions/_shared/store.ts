// Saves Jobber records into our tables. Shared by the scheduled sync and
// the webhook receiver. Writes ONLY to our own database.
import { db, ensurePlaceholders, saveRaw, upsert } from "./db.ts";
import { mapClient, mapInvoice, mapJob, mapQuote, mapRequest, mapTimesheet } from "./mapping.ts";

type Via = "webhook" | "poll" | "backfill";

/** jobber user id -> employee uuid. New Jobber users are added as inactive
 *  crew; an owner turns them on and links their login in Settings. */
export async function employeeResolver(extraUsers: { id: string; name?: string }[] = []) {
  const sql = db();
  if (extraUsers.length) {
    await sql`
      insert into public.employees (full_name, jobber_user_id, role, active)
      select distinct on (u->>'id')   -- the same person often appears many times in one batch
             coalesce(u->>'name', 'Jobber user ' || (u->>'id')), u->>'id', 'crew', false
      from jsonb_array_elements(${sql.json(extraUsers as never)}) u
      order by u->>'id', (u->>'name') is null
      on conflict (jobber_user_id) do update
        set full_name = case when excluded.full_name like 'Jobber user %'
                             then public.employees.full_name else excluded.full_name end`;
  }
  const rows = await sql`select id, jobber_user_id from public.employees where jobber_user_id is not null`;
  const map = new Map(rows.map((r) => [r.jobber_user_id as string, r.id as string]));
  return (jobberId: string) => map.get(jobberId) ?? null;
}

export async function saveUsers(nodes: any[]) {
  await saveRaw("jobber", "user", nodes, "poll");
  await employeeResolver(nodes.map((u) => ({ id: u.id, name: u.name?.full })));
}

export async function saveClients(nodes: any[], via: Via) {
  await saveRaw("jobber", "client", nodes, via);
  await upsert("public.clients", nodes.map(mapClient));
}

export async function saveRequests(nodes: any[], via: Via) {
  await saveRaw("jobber", "request", nodes, via);
  const rows = nodes.map(mapRequest);
  await ensurePlaceholders("public.clients", rows.map((r) => r.client_id));
  await recordStatusChanges("request", rows.map((r) => ({ id: r.id, status: r.status })));
  await upsert("public.requests", rows);
}

export async function saveQuotes(nodes: any[], via: Via) {
  await saveRaw("jobber", "quote", nodes, via);
  const resolve = await employeeResolver(
    nodes.filter((n) => n.salesperson?.id).map((n) => ({ id: n.salesperson.id })));
  const mapped = nodes.map((n) => mapQuote(n, resolve));
  await ensurePlaceholders("public.clients", mapped.map((m) => m.quote.client_id));
  await ensurePlaceholders("public.requests", mapped.map((m) => m.quote.request_id));
  await recordStatusChanges("quote", mapped.map((m) => ({ id: m.quote.id, status: m.quote.status })));
  await upsert("public.quotes", mapped.map((m) => m.quote));
  await replaceChildren("public.quote_line_items", "quote_id",
    mapped.filter((m) => m.linesComplete).map((m) => m.quote.id), mapped.flatMap((m) => m.lines));
}

export async function saveJobs(nodes: any[], via: Via) {
  await saveRaw("jobber", "job", nodes, via);
  const mapped = nodes.map(mapJob);
  await ensurePlaceholders("public.clients", mapped.map((m) => m.job.client_id));
  await ensurePlaceholders("public.quotes", mapped.map((m) => m.job.quote_id));
  await upsert("public.properties", mapped.flatMap((m) => (m.property ? [m.property] : [])));
  await recordStatusChanges("job", mapped.map((m) => ({ id: m.job.id, status: m.job.status })));
  await upsert("public.jobs", mapped.map((m) => m.job));

  await replaceChildren("public.job_line_items", "job_id",
    mapped.filter((m) => m.linesComplete).map((m) => m.job.id), mapped.flatMap((m) => m.lines));
  await replaceChildren("public.visits", "job_id",
    mapped.filter((m) => m.visitsComplete).map((m) => m.job.id), mapped.flatMap((m) => m.visits));

  const assignments = mapped.flatMap((m) => m.assignments);
  const resolve = await employeeResolver(assignments.map((a) => ({ id: a.jobber_user_id })));
  const rows = assignments
    .map((a) => ({ visit_id: a.visit_id, employee_id: resolve(a.jobber_user_id) }))
    .filter((a) => a.employee_id) as { visit_id: string; employee_id: string }[];
  // Mirror un-assignments: for every visit whose full crew list we received, remove anyone
  // no longer on it. (Before this, people taken off a visit in Jobber stayed assigned here.)
  const complete = mapped.flatMap((m) => m.assignmentsCompleteFor);
  if (complete.length) {
    const sql = db();
    const keep = rows.map((r) => `${r.visit_id}|${r.employee_id}`);
    await sql`delete from public.visit_assignments
              where visit_id = any(${complete})
                and not ((visit_id || '|' || employee_id::text) = any(${keep}))`;
  }
  await upsert("public.visit_assignments", rows, ["visit_id", "employee_id"]);
}

export async function saveInvoices(nodes: any[], via: Via) {
  await saveRaw("jobber", "invoice", nodes, via);
  const rows = nodes.map(mapInvoice);
  await ensurePlaceholders("public.clients", rows.map((r) => r.client_id));
  await ensurePlaceholders("public.jobs", rows.map((r) => r.job_id));
  await recordStatusChanges("invoice", rows.map((r) => ({ id: r.id, status: r.status })));
  await upsert("public.invoices", rows);
}

export async function saveTimesheets(nodes: any[], via: Via) {
  await saveRaw("jobber", "timesheet", nodes, via);
  const resolve = await employeeResolver(nodes.filter((n) => n.user?.id).map((n) => ({ id: n.user.id })));
  const rows = nodes.map((n) => mapTimesheet(n, resolve)).filter((r) => r !== null);
  await ensurePlaceholders("public.jobs", rows.map((r) => r!.job_id));
  // Visits referenced by a timesheet may belong to a job not synced yet; drop the link rather than fail.
  const sql = db();
  const known = new Set((await sql`select id from public.visits where id = any(${rows.map((r) => r!.visit_id).filter(Boolean) as string[]})`)
    .map((r) => r.id as string));
  await upsert("public.timesheet_entries", rows.map((r) => ({ ...r!, visit_id: r!.visit_id && known.has(r!.visit_id) ? r!.visit_id : null })));
}

/** Save child rows (line items, visits). Deletions made in Jobber are mirrored ONLY
 *  for parents whose full list we received (`completeParentIds`); for a parent whose
 *  list was cut short, nothing is deleted. */
async function replaceChildren(table: string, parentCol: string, completeParentIds: string[], rows: Record<string, unknown>[]) {
  const sql = db();
  if (completeParentIds.length > 0) {
    const keep = rows.map((r) => r.id as string);
    await sql`delete from ${sql(table)}
              where ${sql(parentCol)} = any(${completeParentIds}) and not (id = any(${keep}))`;
  }
  await upsert(table, rows);
}

/** Event log: write a row whenever a status differs from what we had. */
async function recordStatusChanges(entity: string, items: { id: string; status: string | null }[]) {
  if (items.length === 0) return;
  const sql = db();
  const table = { request: "requests", quote: "quotes", job: "jobs", invoice: "invoices" }[entity]!;
  await sql`
    insert into public.entity_events (entity_type, entity_id, event, from_value, to_value, occurred_at)
    select ${entity}, x.id, 'status_changed', t.status, x.status, now()
    from jsonb_to_recordset(${sql.json(items as never)}) as x(id text, status text)
    left join ${sql("public." + table)} t on t.id = x.id
    where t.id is null or t.status is distinct from x.status`;
}

export async function refreshDerived() {
  await db()`select app.refresh_derived()`;
}

export async function markSync(source: string, ok: boolean, error?: string, cursor?: unknown) {
  const sql = db();
  if (ok) {
    await sql`insert into public.sync_state (source, last_success_at, cursor)
              values (${source}, now(), ${sql.json((cursor ?? null) as never)})
              on conflict (source) do update set last_success_at = now(),
                cursor = coalesce(excluded.cursor, public.sync_state.cursor)`;
  } else {
    await sql`insert into public.sync_state (source, last_error, last_error_at)
              values (${source}, ${error ?? "unknown"}, now())
              on conflict (source) do update set last_error = excluded.last_error, last_error_at = now()`;
  }
}
