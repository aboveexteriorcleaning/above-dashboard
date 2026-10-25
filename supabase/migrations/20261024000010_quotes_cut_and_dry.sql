-- =====================================================================
-- Quotes, counted "cut and dry" (owners' decision, Oct 24 2026):
--   * Sent: counted in the period the quote was sent.
--   * Approved: counted in the period it was approved, whenever it was sent.
--   * Approval rate = approved in period / sent in period. Early and late
--     approvals average out over time.
--   * A quote approved without ever being sent counts as sent on its approval date.
-- Same rule on every page: Overview, monthly trend, crew company totals, Team.
-- =====================================================================

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
  plans as (
    select count(distinct j.client_id) active
    from public.job_line_items li
    join public.plan_products pp on pp.product_name = li.product_name
    join public.jobs j on j.id = li.job_id
    where j.completed_at is not null
      and j.completed_at >= now() - make_interval(days => (365 / pp.services_per_year) + pp.grace_days)),
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

create or replace function public.owner_monthly_trend(p_months int default 12)
returns table (month date, completed_revenue numeric, completed_jobs int, booked_revenue numeric, quotes_sent int, quotes_won int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  return query
  with months as (
    select generate_series(
      date_trunc('month', (now() at time zone 'America/Los_Angeles'))::date - make_interval(months => p_months - 1),
      date_trunc('month', (now() at time zone 'America/Los_Angeles'))::date, interval '1 month')::date as m)
  select m.m,
    (select round(coalesce(sum(r.revenue),0),2) from app.job_revenue r
      where r.completed_at >= app.day_start(m.m) and r.completed_at < app.day_start((m.m + interval '1 month')::date)),
    (select count(*)::int from app.job_revenue r
      where r.completed_at >= app.day_start(m.m) and r.completed_at < app.day_start((m.m + interval '1 month')::date)),
    (select round(coalesce(sum(j.total),0),2) from public.jobs j
      where j.created_at >= app.day_start(m.m) and j.created_at < app.day_start((m.m + interval '1 month')::date)
        and not j.is_callback and coalesce(j.status,'') <> 'deleted'),
    (select count(*)::int from public.quotes q
      where coalesce(q.sent_at, q.approved_at) >= app.day_start(m.m)
        and coalesce(q.sent_at, q.approved_at) < app.day_start((m.m + interval '1 month')::date)
        and coalesce(q.status,'') <> 'deleted'),
    (select count(*)::int from public.quotes q
      where q.approved_at >= app.day_start(m.m) and q.approved_at < app.day_start((m.m + interval '1 month')::date)
        and coalesce(q.status,'') <> 'deleted')
  from months m order by m.m;
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
  plans as (
    select count(distinct j.client_id) n
    from public.job_line_items li
    join public.plan_products pp on pp.product_name = li.product_name
    join public.jobs j on j.id = li.job_id
    where j.completed_at is not null
      and j.completed_at >= now() - make_interval(days => (365 / pp.services_per_year) + pp.grace_days))
  select round(rev.v,2), rev.n::int, nc.n::int, qs.s::int, qs.ap::int,
         round(qs.ap::numeric / nullif(qs.s,0), 3), round(booked.v,2), plans.n::int
  from rev, nc, qs, booked, plans;
end $$;

create or replace function app.scorecard_for(p_employee uuid, p_from date, p_to date)
returns table (
  completed_jobs      int,
  revenue_credited    numeric,
  hours               numeric,
  hours_source        text,     -- 'clocked' or 'scheduled'
  unestimated_visits  int,      -- scheduled-time people only: visits with no usable time window
  revenue_per_hour    numeric,
  work_days           int,
  revenue_per_day     numeric,
  upsell_revenue      numeric,
  plans_sold          int,
  quotes_sent         int,
  quotes_approved     int,
  callbacks           int
)
language sql stable security definer set search_path = '' as $$
  with win as (select app.day_start(p_from) as a, app.day_start(p_to + 1) as b),
  me as (select coalesce(tracks_time, true) as clocks from public.employees where id = p_employee),
  mine as (
    select r.job_id, r.revenue * c.share as rev
    from app.job_revenue r
    join app.job_credit c on c.job_id = r.job_id and c.employee_id = p_employee, win
    where r.completed_at >= win.a and r.completed_at < win.b),
  clocked as (
    select coalesce(sum(t.minutes), 0) / 60.0 as h,
           count(distinct (t.started_at at time zone 'America/Los_Angeles')::date) as d
    from public.timesheet_entries t, win
    where t.employee_id = p_employee and t.started_at >= win.a and t.started_at < win.b),
  scheduled as (
    select coalesce(sum(vh.hours), 0) as h,
           count(distinct (vh.start_at at time zone 'America/Los_Angeles')::date) filter (where vh.start_at is not null) as d,
           count(*) filter (where vh.hours is null) as missing
    from app.visit_hours vh
    join public.visit_assignments va on va.visit_id = vh.visit_id and va.employee_id = p_employee
    where vh.job_id in (select job_id from mine)),
  t as (
    select case when me.clocks then clocked.h else scheduled.h end as h,
           case when me.clocks then clocked.d else scheduled.d end as d,
           case when me.clocks then 'clocked' else 'scheduled' end as src,
           case when me.clocks then 0 else scheduled.missing end as missing
    from me, clocked, scheduled),
  ups as (
    select coalesce(sum(li.total_price * c.share), 0) as v
    from public.job_line_items li
    join public.jobs j on j.id = li.job_id
    join app.job_credit c on c.job_id = j.id and c.employee_id = p_employee, win
    where li.is_onsite_upsell and j.completed_at >= win.a and j.completed_at < win.b),
  quote_ups as (
    select coalesce(sum(qli.total_price), 0) as v
    from public.quote_line_items qli join public.quotes q on q.id = qli.quote_id, win
    where qli.is_optional and q.salesperson_id = p_employee
      and q.approved_at >= win.a and q.approved_at < win.b),
  qs as (
    select count(*) filter (where coalesce(q.sent_at, q.approved_at) >= win.a
                              and coalesce(q.sent_at, q.approved_at) < win.b) as sent,
           count(*) filter (where q.approved_at >= win.a and q.approved_at < win.b) as approved,
           count(*) filter (where q.approved_at >= win.a and q.approved_at < win.b and exists (
             select 1 from public.quote_line_items qli
             join public.plan_products pp on pp.product_name = qli.product_name
             where qli.quote_id = q.id)) as plans
    from public.quotes q, win where q.salesperson_id = p_employee and coalesce(q.status,'') <> 'deleted'),
  cb as (
    select count(*) as n
    from public.jobs cbj
    join app.job_credit c on c.job_id = cbj.callback_of_job_id and c.employee_id = p_employee, win
    where cbj.is_callback and cbj.created_at >= win.a and cbj.created_at < win.b),
  rev as (select coalesce(sum(rev), 0) as v, count(distinct job_id) as n from mine)
  select rev.n::int, round(rev.v, 2), round(t.h, 1), t.src, t.missing::int,
         round(rev.v / nullif(t.h, 0), 2), t.d::int, round(rev.v / nullif(t.d, 0), 2),
         round(ups.v + quote_ups.v, 2), qs.plans::int, qs.sent::int, qs.approved::int, cb.n::int
  from rev, t, ups, quote_ups, qs, cb
$$;
