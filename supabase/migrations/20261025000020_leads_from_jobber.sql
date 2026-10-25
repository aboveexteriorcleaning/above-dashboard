-- Leads tab: "Got a quote" and "Booked" now come straight from Jobber (every
-- new customer, whatever channel they came from). Phone matching is kept only
-- for speed to lead, missed calls and the per-lead list.

create or replace function public.owner_leads(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a timestamptz := app.day_start(p_from);
  b timestamptz := app.day_start(p_to + 1);
  this_month date := date_trunc('month', (now() at time zone 'America/Los_Angeles'))::date;
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with l as (select * from app.quo_leads where lead_at >= a and lead_at < b),
  m as (select * from app.quo_missed_calls where occurred_at >= a and occurred_at < b),
  inbound as (select count(*) n from public.communications
              where kind = 'call' and direction = 'inbound' and occurred_at >= a and occurred_at < b),
  months as (select m, app.day_start(m) s, app.day_start((m + interval '1 month')::date) e
             from generate_series(this_month - interval '11 months', this_month, interval '1 month') g(m0),
                  lateral (select g.m0::date m) x),
  -- New customers, straight from Jobber (every channel, not just Quo):
  -- first quote ever / first job ever, for a client who hadn't had a completed job before.
  -- matched to a home by address, so duplicate client records don't look new
  job_home as (
    select j.id, j.client_id, j.created_at, j.total, j.status, j.is_callback, app.home_key(p.street, j.client_id) h
    from public.jobs j left join public.properties p on p.id = j.property_id),
  client_home as (
    select c.id client_id, c.phone,
           app.home_key((select p.street from public.properties p where p.client_id = c.id order by p.id limit 1), c.id) h
    from public.clients c),
  done_first as (
    select jh.h, min(r.completed_at) f from app.job_revenue r join job_home jh on jh.id = r.job_id group by jh.h),
  first_quote as (
    select ch.h, min(coalesce(q.sent_at, q.approved_at)) t, bool_or(ch.phone is not null) has_phone
    from public.quotes q join client_home ch on ch.client_id = q.client_id
    where coalesce(q.status, '') not in ('deleted', 'draft') and coalesce(q.sent_at, q.approved_at) is not null
    group by ch.h),
  new_quoted as (
    select fq.* from first_quote fq left join done_first d using (h) where d.f is null or d.f >= fq.t),
  live_jobs as (select * from job_home where coalesce(status, '') <> 'deleted' and not is_callback),
  first_job as (select h, min(created_at) t from live_jobs group by h),
  new_booked as (
    select fj.h, fj.t,
           (select coalesce(sum(lj.total), 0) from live_jobs lj
             where lj.h = fj.h and lj.created_at >= fj.t and lj.created_at < fj.t + interval '30 days') as value
    from first_job fj left join done_first d using (h)
    where d.f is null or d.f >= fj.t),
  by_month as (
    select mm.m,
           (select count(*) from app.quo_leads q where q.lead_at >= mm.s and q.lead_at < mm.e) leads,
           (select count(*) from new_quoted nq where nq.t >= mm.s and nq.t < mm.e) quoted,
           (select count(*) from new_booked nb where nb.t >= mm.s and nb.t < mm.e) booked
    from months mm)
  select jsonb_build_object(
    'leads', (select count(*) from l),
    'responded', (select count(*) from l where first_response_at is not null),
    'no_reply', (select count(*) from l where first_response_at is null),
    'median_response_min', (select round(percentile_cont(0.5) within group (order by response_minutes)::numeric, 1) from l where response_minutes is not null),
    'median_response_min_in_hours', (select round(percentile_cont(0.5) within group (order by response_minutes)::numeric, 1) from l where response_minutes is not null and in_hours),
    'within_5_min', (select round(count(*) filter (where response_minutes is not null and response_minutes <= 5)::numeric / nullif(count(*), 0), 3) from l),
    'quoted', (select count(*) from l where quoted_at is not null),
    'booked', (select count(*) from l where booked_at is not null),
    'booked_value', (select round(coalesce(sum(booked_value), 0), 2) from l),
    'new_quoted', (select count(*) from new_quoted where t >= a and t < b),
    'new_quoted_booked', (select count(*) from new_quoted nq where nq.t >= a and nq.t < b
                            and exists (select 1 from live_jobs lj where lj.h = nq.h and lj.created_at >= nq.t - interval '1 day')),
    'new_quoted_no_phone', (select count(*) from new_quoted nq where nq.t >= a and nq.t < b and not nq.has_phone),
    'new_booked', (select count(*) from new_booked where t >= a and t < b),
    'new_booked_value', (select round(coalesce(sum(value), 0), 2) from new_booked where t >= a and t < b),
    'by_source', coalesce((select jsonb_agg(x order by x.leads desc) from (
        select source, count(*) leads, count(*) filter (where booked_at is not null) booked,
               round(coalesce(sum(booked_value), 0), 2) booked_value
        from l group by source) x), '[]'::jsonb),
    'by_line', coalesce((select jsonb_agg(x order by x.leads desc) from (
        select coalesce(line_name, 'Unknown line') line, count(*) leads, count(*) filter (where booked_at is not null) booked
        from l group by 1) x), '[]'::jsonb),
    'missed', jsonb_build_object(
        'missed', (select count(*) from m),
        'inbound_calls', (select n from inbound),
        'voicemails', (select count(*) from m where has_voicemail),
        'returned', (select count(*) from m where returned_at is not null),
        'not_returned', (select count(*) from m where returned_at is null),
        'median_return_min', (select round(percentile_cont(0.5) within group (order by extract(epoch from (returned_at - occurred_at)) / 60.0)::numeric, 1)
                              from m where returned_at is not null)),
    'monthly', (select jsonb_agg(jsonb_build_object('month', m, 'leads', leads, 'quoted', quoted, 'booked', booked) order by m) from by_month),
    'people', coalesce((select jsonb_agg(x order by x.calls_answered + x.calls_made + x.texts_sent desc) from (
        select coalesce(e.full_name, 'Not linked to a team member') as name,
               count(*) filter (where c.kind = 'call' and c.direction = 'inbound' and c.answered_at is not null) calls_answered,
               count(*) filter (where c.kind = 'call' and c.direction = 'outbound') calls_made,
               count(*) filter (where c.kind = 'message' and c.direction = 'outbound' and not c.is_automated) texts_sent,
               (select count(*) from l where l.responded_by is not distinct from c.employee_id and l.first_response_at is not null) leads_first_reply,
               (select round(percentile_cont(0.5) within group (order by l.response_minutes)::numeric, 1) from l
                 where l.responded_by is not distinct from c.employee_id and l.response_minutes is not null) median_response_min
        from public.communications c left join public.employees e on e.id = c.employee_id
        where c.occurred_at >= a and c.occurred_at < b and not c.is_automated and c.quo_user_id is not null
        group by c.employee_id, e.full_name) x), '[]'::jsonb)
  ) into result;
  return result;
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'app') and p.prokind = 'f'
             and not coalesce('jit=off' = any(p.proconfig), false)
  loop
    execute format('alter function %s set jit = off', f.sig);
  end loop;
end $$;
