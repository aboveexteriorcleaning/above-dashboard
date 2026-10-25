-- Customers, counted by address (so duplicate client records in Jobber
-- don't look like first-time customers), with returning customers split:
--   came back on their own - any earlier completed job at the address, any
--                            service, and no plan visit this period
--   plan visits            - a scheduled plan visit (not the visit where the
--                            plan was first sold)

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
  homes_done as (   -- completed, non-callback jobs, matched to a home by address
    select app.home_key(p.street, j.client_id) as home_key, r.job_id, r.completed_at
    from app.job_revenue r join public.jobs j on j.id = r.job_id
    left join public.properties p on p.id = j.property_id),
  first_plan as (   -- the first plan job for each home + plan is the sale, not a plan visit
    select distinct on (home_key, service_line) job_id from app.plan_jobs
    order by home_key, service_line, coalesce(start_at, completed_at, created_at), created_at),
  plan_revisits as (select job_id from app.plan_jobs except select job_id from first_plan),
  clients as (
    select count(*) filter (where f >= a and f < b) new_clients,
           count(*) filter (where f < a and in_period and plan_visit) returning_plan,
           count(*) filter (where f < a and in_period and not plan_visit) returning_own
    from (select h.home_key, min(h.completed_at) f,
                 bool_or(h.completed_at >= a and h.completed_at < b) as in_period,
                 bool_or(h.completed_at >= a and h.completed_at < b
                         and h.job_id in (select job_id from plan_revisits)) as plan_visit
          from homes_done h group by h.home_key) x),
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
    'customers', jsonb_build_object('new', clients.new_clients,
                                    'returning', clients.returning_own + clients.returning_plan,
                                    'returning_own', clients.returning_own, 'returning_plan', clients.returning_plan,
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
  firsts as (select app.home_key(p.street, j.client_id) h, min(r.completed_at) f
             from app.job_revenue r join public.jobs j on j.id = r.job_id
             left join public.properties p on p.id = j.property_id group by 1),
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
