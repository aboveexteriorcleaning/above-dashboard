-- Maintenance plans, counted the way Above actually runs them.
--
-- 1. Any line item whose name ends in "Plan" is a plan, even if it isn't in
--    the catalog yet (e.g. "Annual Window Cleaning Plan", "Annual Roof
--    Cleaning Plan" were missing). New names are added automatically with
--    visits-per-year read from the name.
-- 2. A home is on a plan if its next plan visit is already booked, or it had
--    a plan visit within one plan cycle (+ grace). Jobs titled "... Plan"
--    count too, for older plans set up without a plan line.
-- 3. Counted once per address, because some customers have duplicate
--    client records in Jobber.

create or replace function app.plan_visits_per_year(p_name text) returns int
language sql immutable set search_path = '' as $$
  select case
    when p_name ~* 'monthly'                                   then 12
    when p_name ~* 'quarter'                                   then 4
    when p_name ~* '(4|four)[\s-]*month'                       then 3
    when p_name ~* 'bi-?annual|semi-?annual|(6|six)[\s-]*month' then 2
    when p_name ~* 'annual|yearly|(12|twelve)[\s-]*month'       then 1
    else 2 end
$$;

create or replace function app.plan_service_line(p_name text) returns text
language sql immutable set search_path = '' as $$
  select case when p_name ~* 'window' then 'window'
              when p_name ~* 'roof|gutter|moss' then 'roof'
              else 'other' end
$$;

create or replace function app.sync_plan_catalog() returns void
language sql security definer set search_path = '' as $$
  insert into public.plan_products (product_name, service_line, services_per_year, discount_per_visit)
  select n.name, app.plan_service_line(n.name), app.plan_visits_per_year(n.name), greatest(-min(n.price), 0)
  from (select product_name name, coalesce(total_price, 0) price from public.job_line_items
        union all
        select product_name, coalesce(total_price, 0) from public.quote_line_items) n
  where n.name ~* '\mplan\s*$'
  group by n.name
  on conflict (product_name) do nothing
$$;
revoke all on function app.sync_plan_catalog() from public, anon, authenticated;

insert into public.plan_products (product_name, service_line, services_per_year, discount_per_visit) values
  ('Annual Window Cleaning Plan', 'window', 1, 25),
  ('Annual Roof Cleaning Plan',   'roof',   1, 0)
on conflict (product_name) do nothing;

create or replace function app.active_plan_count() returns int
language sql stable security definer set search_path = '' as $$
  with plan_jobs as (
    select j.client_id, j.property_id, j.status, j.start_at, j.completed_at,
           pp.services_per_year, pp.grace_days
    from public.jobs j
    join public.job_line_items li on li.job_id = j.id
    join public.plan_products pp on pp.product_name = li.product_name
    union all
    select j.client_id, j.property_id, j.status, j.start_at, j.completed_at,
           app.plan_visits_per_year(j.title), 30
    from public.jobs j
    where j.title ~* '\mplan\M' and not j.is_callback),
  active as (
    select * from plan_jobs
    where coalesce(status, '') <> 'deleted'
      and (
        -- next plan visit is on the books
        (completed_at is null and coalesce(status, '') <> 'archived'
         and (start_at is null or start_at >= now() - interval '60 days'))
        -- or a plan visit happened within the last cycle
        or completed_at >= now() - make_interval(days => (365 / services_per_year) + grace_days)))
  select count(distinct coalesce(
           nullif(lower(regexp_replace(trim(p.street), '\s+', ' ', 'g')), ''),
           'client:' || a.client_id))::int
  from active a left join public.properties p on p.id = a.property_id
$$;
revoke all on function app.active_plan_count() from public, anon, authenticated;

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
end $$;
revoke all on function app.refresh_derived() from public, anon, authenticated;

create or replace function public.owner_overview(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a timestamptz := app.day_start(p_from); b timestamptz := app.day_start(p_to + 1);
        span int := (p_to - p_from) + 1;
        pa timestamptz := app.day_start(p_from - span); pb timestamptz := app.day_start(p_from);
        result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;

  with
  booked as (select coalesce(sum(total),0) v, count(*) n from public.jobs
             where created_at >= a and created_at < b and coalesce(status,'') <> 'deleted' and not is_callback),
  done as (select coalesce(sum(revenue),0) v, count(*) n from app.job_revenue where completed_at >= a and completed_at < b),
  done_prev as (select coalesce(sum(revenue),0) v from app.job_revenue where completed_at >= pa and completed_at < pb),
  inv as (select coalesce(sum(subtotal),0) v, coalesce(sum(total - balance),0) paid, coalesce(sum(total),0) t
          from public.invoices where issued_at >= a and issued_at < b and coalesce(status,'') not in ('draft','voided','deleted')),
  -- Sent and approved are counted independently, each in its own period.
  -- A quote approved without being sent counts as sent on its approval date.
  q as (select count(*) filter (where coalesce(sent_at, approved_at) >= a and coalesce(sent_at, approved_at) < b) sent,
               count(*) filter (where approved_at >= a and approved_at < b) sent_won,
               coalesce(sum(total) filter (where sent_at >= a and sent_at < b and approved_at is null
                                           and coalesce(status,'') not in ('deleted')), 0) open_value
        from public.quotes where coalesce(status,'') <> 'deleted'),
  turnaround as (
    select percentile_cont(0.5) within group (order by extract(epoch from (q.sent_at - r.created_at)) / 3600.0) h,
           count(*) n
    from public.quotes q join public.requests r on r.id = q.request_id
    where q.sent_at >= a and q.sent_at < b and q.sent_at > r.created_at),
  leads as (select count(*) n, count(*) filter (where is_qualified is not false) q from public.requests
            where created_at >= a and created_at < b),
  ahead as (select
      coalesce(sum(total) filter (where start_at < now() + interval '7 days'), 0) d7,
      coalesce(sum(total) filter (where start_at < now() + interval '14 days'), 0) d14,
      coalesce(sum(total), 0) d30,
      count(*) filter (where job_type = 'RECURRING') recurring_jobs
    from public.jobs where completed_at is null and start_at >= now() and start_at < now() + interval '30 days'
      and coalesce(status,'') not in ('deleted','archived')),
  ar as (select
      coalesce(sum(balance) filter (where due_at >= now() or due_at is null), 0) current_due,
      coalesce(sum(balance) filter (where due_at < now() and due_at >= now() - interval '30 days'), 0) d1_30,
      coalesce(sum(balance) filter (where due_at < now() - interval '30 days' and due_at >= now() - interval '60 days'), 0) d31_60,
      coalesce(sum(balance) filter (where due_at < now() - interval '60 days' and due_at >= now() - interval '90 days'), 0) d61_90,
      coalesce(sum(balance) filter (where due_at < now() - interval '90 days'), 0) d90p,
      count(*) filter (where balance > 0) open_invoices
    from public.invoices where balance > 0 and coalesce(status,'') not in ('draft','voided','deleted','bad_debt')),
  clients as (
    select count(*) filter (where f >= a and f < b) new_clients,
           count(*) filter (where f < a and l >= a and l < b) returning_clients
    from (select client_id, min(completed_at) f, max(completed_at) l from app.job_revenue group by client_id) x),
  plans as (select app.active_plan_count() active),
  callbacks as (select count(*) n from public.jobs where is_callback and created_at >= a and created_at < b)
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'days', span),
    'revenue', jsonb_build_object(
      'booked', round(booked.v, 2), 'booked_jobs', booked.n,
      'completed', round(done.v, 2), 'completed_jobs', done.n,
      'completed_prev_period', round(done_prev.v, 2),
      'invoiced', round(inv.v, 2),
      'paid_on_period_invoices', round(inv.paid, 2), 'invoiced_incl_tax', round(inv.t, 2),
      'avg_job_value', round(done.v / nullif(done.n, 0), 2)),
    'quotes', jsonb_build_object(
      'sent', q.sent, 'won', q.sent_won,
      'win_rate', round(q.sent_won::numeric / nullif(q.sent, 0), 3),
      'open_value', round(q.open_value, 2),
      'median_turnaround_hours', round(turnaround.h::numeric, 1), 'turnaround_sample', turnaround.n),
    'leads', jsonb_build_object('requests', leads.n),
    'booked_ahead', jsonb_build_object('d7', round(ahead.d7, 2), 'd14', round(ahead.d14, 2), 'd30', round(ahead.d30, 2),
                                       'recurring_jobs_in_window', ahead.recurring_jobs),
    'receivables', jsonb_build_object('current', round(ar.current_due, 2), 'd1_30', round(ar.d1_30, 2),
                                      'd31_60', round(ar.d31_60, 2), 'd61_90', round(ar.d61_90, 2),
                                      'd90_plus', round(ar.d90p, 2), 'open_invoices', ar.open_invoices),
    'customers', jsonb_build_object('new', clients.new_clients, 'returning', clients.returning_clients,
                                    'active_plans', plans.active),
    'quality', jsonb_build_object('callbacks', callbacks.n,
                                  'callback_rate', round(callbacks.n::numeric / nullif(done.n, 0), 3)),
    'by_service', coalesce((
      select jsonb_agg(x order by x.revenue desc) from (
        select li.product_name as service, round(sum(li.total_price), 2) as revenue, count(distinct li.job_id) as jobs
        from public.job_line_items li join app.job_revenue r on r.job_id = li.job_id
        where r.completed_at >= a and r.completed_at < b and li.total_price <> 0
        group by li.product_name) x), '[]'::jsonb),
    'by_zip', coalesce((
      select jsonb_agg(x order by x.revenue desc) from (
        select coalesce(p.postal_code, 'Unknown') as zip, coalesce(max(p.city), '') as city,
               round(sum(r.revenue), 2) as revenue, count(*) as jobs
        from app.job_revenue r join public.jobs j on j.id = r.job_id
        left join public.properties p on p.id = j.property_id
        where r.completed_at >= a and r.completed_at < b
        group by coalesce(p.postal_code, 'Unknown')) x), '[]'::jsonb),
    'lead_sources', coalesce((
      select jsonb_agg(x order by x.requests desc) from (
        select coalesce(nullif(trim(source), ''), 'Unknown') as source, count(*) as requests
        from public.requests where created_at >= a and created_at < b
        group by 1) x), '[]'::jsonb)
  ) into result
  from booked, done, done_prev, inv, q, turnaround, leads, ahead, ar, clients, plans, callbacks;
  return result;
end $$;


create or replace function public.company_summary(p_from date, p_to date)
returns table (completed_revenue numeric, completed_jobs int, new_clients int,
               quotes_sent int, quotes_approved int, quote_approval_rate numeric,
               booked_next_30_days numeric, active_plans int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.my_employee_id() is null then raise exception 'not authorised'; end if;
  return query
  with win as (select app.day_start(p_from) a, app.day_start(p_to + 1) b),
  rev as (select coalesce(sum(revenue),0) v, count(*) n from app.job_revenue, win
          where completed_at >= win.a and completed_at < win.b),
  firsts as (select client_id, min(completed_at) f from app.job_revenue group by client_id),
  nc as (select count(*) n from firsts, win where f >= win.a and f < win.b),
  qs as (select count(*) filter (where coalesce(sent_at, approved_at) >= win.a and coalesce(sent_at, approved_at) < win.b) s,
                count(*) filter (where approved_at >= win.a and approved_at < win.b) ap
         from public.quotes, win where coalesce(status,'') <> 'deleted'),
  booked as (select coalesce(sum(j.total),0) v from public.jobs j
             where j.completed_at is null and j.start_at >= now() and j.start_at < now() + interval '30 days'),
  plans as (select app.active_plan_count() n)
  select round(rev.v,2), rev.n::int, nc.n::int, qs.s::int, qs.ap::int,
         round(qs.ap::numeric / nullif(qs.s,0), 3), round(booked.v,2), plans.n::int
  from rev, nc, qs, booked, plans;
end $$;


-- Fill in plan names already in the data.
select app.sync_plan_catalog();
select app.refresh_derived();
