// Live updates. Jobber pings this URL when something changes; we verify the
// signature, then READ the changed record back from Jobber and save it.
import { db, saveRaw } from "../_shared/db.ts";
import { query } from "../_shared/jobber.ts";
import { hmacSha256Base64, safeEqual } from "../_shared/pkce.ts";
import {
  refreshDerived, saveClients, saveInvoices, saveJobs, saveQuotes, saveRequests,
} from "../_shared/store.ts";

const ok = () => new Response("ok");

Deno.serve(async (req) => {
  const body = await req.text();
  const sig = req.headers.get("X-Jobber-Hmac-SHA256") ?? "";
  const expected = await hmacSha256Base64(Deno.env.get("JOBBER_CLIENT_SECRET") ?? "", body);
  if (!sig || !safeEqual(sig, expected)) return new Response("bad signature", { status: 401 });

  const evt = JSON.parse(body)?.data?.webHookEvent;
  if (!evt?.topic || !evt?.itemId) return ok();

  const sql = db();
  const [tok] = await sql`select account_id from private.integration_tokens where provider = 'jobber'`;
  if (tok?.account_id && evt.accountId && evt.accountId !== tok.account_id) return ok(); // not our account

  await saveRaw("jobber", "webhook_event", [{ id: evt.itemId, ...evt }], "webhook");

  const topic: string = evt.topic;
  const id: string = evt.itemId;

  if (topic === "APP_DISCONNECT") {
    await sql`delete from private.integration_tokens where provider = 'jobber'`;
    await sql`insert into public.sync_state (source, last_error, last_error_at)
              values ('jobber', 'Jobber access was disconnected', now())
              on conflict (source) do update set last_error = excluded.last_error, last_error_at = now()`;
    return ok();
  }

  const [entity, action] = [topic.split("_")[0], topic.split("_").slice(1).join("_")];
  const tables: Record<string, string> = { CLIENT: "clients", REQUEST: "requests", QUOTE: "quotes", JOB: "jobs", INVOICE: "invoices" };

  try {
    if (action === "DESTROY" && tables[entity] && entity !== "CLIENT") {
      await sql`update ${sql("public." + tables[entity])} set status = 'deleted' where id = ${id}`;
    } else if (entity === "CLIENT") {
      const d = await query("client", { id }); if (d.client) await saveClients([d.client], "webhook");
    } else if (entity === "REQUEST") {
      const d = await query("request", { id }); if (d.request) await saveRequests([d.request], "webhook");
    } else if (entity === "QUOTE") {
      const d = await query("quote", { id }); if (d.quote) await saveQuotes([d.quote], "webhook");
    } else if (entity === "JOB") {
      const d = await query("job", { id }); if (d.job) await saveJobs([d.job], "webhook");
    } else if (entity === "VISIT") {
      const v = await query("visit", { id });
      const jobId = v.visit?.job?.id;
      if (jobId) { const d = await query("job", { id: jobId }); if (d.job) await saveJobs([d.job], "webhook"); }
    } else if (entity === "INVOICE") {
      const d = await query("invoice", { id }); if (d.invoice) await saveInvoices([d.invoice], "webhook");
    }
    await refreshDerived();
  } catch (e) {
    // Never make Jobber retry forever; the 15-minute sync will catch it up.
    console.error("webhook handling failed", topic, id, (e as Error).message);
  }
  return ok();
});
