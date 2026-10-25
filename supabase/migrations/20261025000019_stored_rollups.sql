-- Speed: the plan and lead calculations are worked out once after every sync
-- and stored, instead of being rebuilt (many times over) on every page load.
-- Each view keeps its logic under a *_live name; the old name now holds the
-- stored result, so every function that reads it is unchanged.

alter view app.plan_jobs rename to plan_jobs_live;
create materialized view app.plan_jobs as select * from app.plan_jobs_live;
create unique index on app.plan_jobs (job_id, service_line);
revoke all on app.plan_jobs, app.plan_jobs_live from public, anon, authenticated;

alter view app.plan_homes rename to plan_homes_live;
create materialized view app.plan_homes as select * from app.plan_homes_live;
create unique index on app.plan_homes (home_key, service_line);
revoke all on app.plan_homes, app.plan_homes_live from public, anon, authenticated;

alter view app.plan_sales rename to plan_sales_live;
create materialized view app.plan_sales as select * from app.plan_sales_live;
create unique index on app.plan_sales (home_key, service_line);
revoke all on app.plan_sales, app.plan_sales_live from public, anon, authenticated;

alter view app.plan_sale_credit rename to plan_sale_credit_live;
create materialized view app.plan_sale_credit as select * from app.plan_sale_credit_live;
create unique index on app.plan_sale_credit (home_key, service_line, employee_id);
revoke all on app.plan_sale_credit, app.plan_sale_credit_live from public, anon, authenticated;

alter view app.quo_leads rename to quo_leads_live;
create materialized view app.quo_leads as select * from app.quo_leads_live;
create unique index on app.quo_leads (contact_phone);
revoke all on app.quo_leads, app.quo_leads_live from public, anon, authenticated;

alter view app.quo_missed_calls rename to quo_missed_calls_live;
create materialized view app.quo_missed_calls as select * from app.quo_missed_calls_live;
create unique index on app.quo_missed_calls (id);
revoke all on app.quo_missed_calls, app.quo_missed_calls_live from public, anon, authenticated;

create or replace function app.refresh_rollups() returns void
language plpgsql security definer set search_path = '' as $$
begin
  refresh materialized view concurrently app.plan_jobs;
  refresh materialized view concurrently app.plan_homes;
  refresh materialized view concurrently app.plan_sales;
  refresh materialized view concurrently app.plan_sale_credit;
  refresh materialized view concurrently app.quo_leads;
  refresh materialized view concurrently app.quo_missed_calls;
end $$;
revoke all on function app.refresh_rollups() from public, anon, authenticated;

-- Refresh after every Jobber sync/webhook and every Quo sync.

create or replace function app.refresh_derived() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.sync_plan_catalog();

  -- Plan discount lines: name matches the plan catalog.
  update public.job_line_items li
     set is_plan_discount = exists (
       select 1 from public.plan_products pp where pp.product_name = li.product_name);

  -- On-site upsell: a paid line on a job that came from a quote, where that
  -- product was not on the quote (approved optional items count as
  -- quote-stage upsells instead, credited to the salesperson).
  update public.job_line_items li
     set is_onsite_upsell = (
       li.total_price > 0
       and j.quote_id is not null
       and not exists (
         select 1 from public.quote_line_items q
         where q.quote_id = j.quote_id and q.product_name = li.product_name))
    from public.jobs j
   where j.id = li.job_id;

  -- Callbacks: job titled "Callback – #<original job number>".
  update public.jobs j
     set is_callback = (j.title ~* '^\s*call\s*-?\s*back'),
         callback_of_job_id = (
           select o.id from public.jobs o
           where o.job_number = nullif(substring(j.title from '#\s*(\d+)'), '')::int
           limit 1)
   where j.title is not null;
  perform app.refresh_rollups();
end $$;
revoke all on function app.refresh_derived() from public, anon, authenticated;

create or replace function app.refresh_quo() returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Quo users -> team members, by email, then by name.
  update public.quo_users u
     set employee_id = coalesce(
       (select e.id from public.employees e where lower(e.email) = lower(u.email) limit 1),
       (select e.id from public.employees e where lower(e.full_name) = lower(u.name) limit 1));

  update public.communications c
     set employee_id = u.employee_id
    from public.quo_users u
   where u.id = c.quo_user_id and c.employee_id is distinct from u.employee_id;

  -- Phone number -> Jobber client (the one with the most jobs if several share it).
  update public.communications c
     set client_id = m.client_id
    from (select distinct on (cl.phone) cl.phone, cl.id as client_id
          from public.clients cl
          left join public.jobs j on j.client_id = cl.id
          where cl.phone is not null
          group by cl.phone, cl.id
          order by cl.phone, count(j.id) desc, cl.id) m
   where m.phone = c.contact_phone and c.client_id is distinct from m.client_id;

  -- Automated texts: sent by a Quo system actor, or the very first message to a
  -- number (nothing came before it) whose wording matches at least two other
  -- such first messages - that's the n8n auto-text to new form leads.
  with firsts as (
    select c.id, c.contact_phone, c.text_head_hash, c.text_tail_hash
    from public.communications c
    where c.kind = 'message' and c.direction = 'outbound' and c.contact_phone is not null
      and not exists (select 1 from public.communications p
                      where p.contact_phone = c.contact_phone and p.occurred_at < c.occurred_at)),
  templates as (
    select h from (
      select text_head_hash h, contact_phone from firsts where text_head_hash is not null
      union all
      select text_tail_hash, contact_phone from firsts where text_tail_hash is not null) x
    group by h having count(distinct contact_phone) >= 3),
  auto as (
    select f.id from firsts f
    where f.text_head_hash in (select h from templates) or f.text_tail_hash in (select h from templates))
  update public.communications c
     set is_automated = (c.is_system or c.ai_handled or c.id in (select id from auto))
   where c.is_automated <> (c.is_system or c.ai_handled or c.id in (select id from auto));
  perform app.refresh_rollups();
end $$;
revoke all on function app.refresh_quo() from public, anon, authenticated;

-- Monthly tables: work out each month's Pacific start/end once.
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
  by_month as (
    select mm.m, count(q.contact_phone) leads, count(q.quoted_at) quoted, count(q.booked_at) booked
    from months mm left join app.quo_leads q on q.lead_at >= mm.s and q.lead_at < mm.e
    group by mm.m)
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

create or replace function public.owner_monthly_trend(p_months int default 12)
returns table (month date, completed_revenue numeric, completed_jobs int, booked_revenue numeric, quotes_sent int, quotes_won int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  return query
  with months as (
    select g::date as m, app.day_start(g::date) s, app.day_start((g + interval '1 month')::date) e
    from generate_series(
      date_trunc('month', (now() at time zone 'America/Los_Angeles'))::date - make_interval(months => p_months - 1),
      date_trunc('month', (now() at time zone 'America/Los_Angeles'))::date, interval '1 month') g),
  rev as (select mm.m, round(coalesce(sum(r.revenue), 0), 2) v, count(r.job_id)::int n
          from months mm left join app.job_revenue r on r.completed_at >= mm.s and r.completed_at < mm.e group by mm.m),
  bk as (select mm.m, round(coalesce(sum(j.total), 0), 2) v
         from months mm left join public.jobs j on j.created_at >= mm.s and j.created_at < mm.e
           and not j.is_callback and coalesce(j.status, '') <> 'deleted' group by mm.m),
  qs as (select mm.m,
                count(q.id) filter (where coalesce(q.sent_at, q.approved_at) >= mm.s and coalesce(q.sent_at, q.approved_at) < mm.e)::int sent,
                count(q.id) filter (where q.approved_at >= mm.s and q.approved_at < mm.e)::int won
         from months mm left join public.quotes q on coalesce(q.status, '') <> 'deleted'
           and (coalesce(q.sent_at, q.approved_at) >= mm.s and coalesce(q.sent_at, q.approved_at) < mm.e
                or q.approved_at >= mm.s and q.approved_at < mm.e)
         group by mm.m)
  select months.m, rev.v, rev.n, bk.v, qs.sent, qs.won
  from months join rev using (m) join bk using (m) join qs using (m)
  order by months.m;
end $$;

-- Postgres "JIT" compiles big queries before running them. For dashboard-sized
-- data that costs ~1.5s and saves nothing, so it's off for every dashboard
-- function. (A test checks every public function keeps this setting.)
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'app') and p.prokind = 'f'
  loop
    execute format('alter function %s set jit = off', f.sig);
  end loop;
  begin
    alter role authenticated set jit = off;
  exception when others then
    raise notice 'could not set jit for the authenticated role (fine: functions have it)';
  end;
end $$;
