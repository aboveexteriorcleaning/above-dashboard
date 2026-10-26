-- One definition of an open quote, used by Sales, the Overview and the alerts:
-- awaiting a response (or changes requested), sent, and not superseded: the same
-- customer hasn't approved another quote or had a job booked since it was sent
-- (e.g. they picked the other option). Values are before tax.

create or replace view app.open_quotes as
select qv.*, extract(day from now() - qv.sent_at)::int as days_waiting
from app.quote_values qv
where qv.status in ('awaiting_response', 'changes_requested') and qv.sent_at is not null
  and not exists (
    select 1 from public.quotes q2
    where q2.client_id = qv.client_id and q2.id <> qv.id and coalesce(q2.status, '') <> 'deleted'
      and coalesce(q2.approved_at, q2.converted_at) >= qv.sent_at - interval '1 day')
  and not exists (
    select 1 from public.jobs j
    where j.client_id = qv.client_id and coalesce(j.status, '') <> 'deleted' and not j.is_callback
      and j.created_at >= qv.sent_at - interval '1 day');
revoke all on app.open_quotes from public, anon, authenticated;

create or replace function public.owner_sales(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a timestamptz := app.day_start(p_from);
  b timestamptz := app.day_start(p_to + 1);
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with qv as materialized (select * from app.quote_values),
  sent as (select * from qv where coalesce(sent_at, approved_at) >= a and coalesce(sent_at, approved_at) < b),
  won as (select * from qv where approved_at >= a and approved_at < b),
  -- a human call/text to the client's phone in Quo, 2-7 days after sending, for quotes not approved within 2 days
  fu as (
    select s.id, s.value,
           (s.approved_at is null or s.approved_at > s.sent_at + interval '2 days') as needed,
           c.phone is not null as has_phone,
           exists (select 1 from public.communications m
                    where m.contact_phone = c.phone and app.is_human_touch(m)
                      and m.occurred_at >= s.sent_at + interval '1 day' and m.occurred_at <= s.sent_at + interval '7 days'
                      and (s.approved_at is null or m.occurred_at < s.approved_at)) as followed_up
    from sent s left join public.clients c on c.id = s.client_id
    where s.sent_at is not null and s.sent_at < now() - interval '7 days'),
  waiting as (select * from app.open_quotes)
  select jsonb_build_object(
    'sent', (select count(*) from sent),
    'sent_value', (select round(coalesce(sum(value), 0), 2) from sent),
    'approved', (select count(*) from won),
    'approved_value', (select round(coalesce(sum(value), 0), 2) from won),
    'avg_approved_value', (select round(avg(value), 2) from won),
    'days_to_approve', (select round((percentile_cont(0.5) within group (order by extract(epoch from (approved_at - sent_at)) / 86400.0))::numeric, 1)
                        from won where sent_at is not null and approved_at >= sent_at),
    'lost', (select count(*) from sent where status = 'archived' and approved_at is null),
    'lost_value', (select round(coalesce(sum(value), 0), 2) from sent where status = 'archived' and approved_at is null),
    -- still waiting: quotes sent this period, no reply, customer hasn't booked another option
    'waiting_period', (select jsonb_build_object('count', count(*), 'value', round(coalesce(sum(value), 0), 2))
                       from waiting where sent_at >= a and sent_at < b),
    -- open pipeline as of now: sent in the last 90 days
    'pipeline', (select jsonb_build_object(
        'count', count(*), 'value', round(coalesce(sum(value), 0), 2),
        'd0_7', round(coalesce(sum(value) filter (where days_waiting <= 7), 0), 2),
        'd8_30', round(coalesce(sum(value) filter (where days_waiting between 8 and 30), 0), 2),
        'd31_90', round(coalesce(sum(value) filter (where days_waiting between 31 and 90), 0), 2))
      from waiting where days_waiting <= 90),
    'stale', (select jsonb_build_object('count', count(*), 'value', round(coalesce(sum(value), 0), 2))
              from waiting where days_waiting > 90),
    'discount', (select jsonb_build_object(
        'pre_discount', round(coalesce(sum(pre_discount), 0), 2),
        'discount', round(coalesce(sum(discount), 0), 2),
        'plan_discount', round(coalesce(sum(plan_discount), 0), 2),
        'rate', round(coalesce(sum(discount), 0) / nullif(sum(pre_discount), 0), 3),
        'with_discount_sent', count(*) filter (where discount > 0),
        'with_discount_won', count(*) filter (where discount > 0 and approved_at is not null),
        'without_discount_sent', count(*) filter (where discount = 0),
        'without_discount_won', count(*) filter (where discount = 0 and approved_at is not null)) from sent),
    'follow_up', (select jsonb_build_object(
        'needed', count(*) filter (where needed and has_phone),
        'followed_up', count(*) filter (where needed and has_phone and followed_up),
        'no_phone', count(*) filter (where needed and not has_phone)) from fu),
    'by_salesperson', coalesce((select jsonb_agg(x order by x.approved_value desc) from (
        select coalesce(e.full_name, 'No salesperson set') as name,
               (select count(*) from sent s where s.salesperson_id is not distinct from e2.sid) as sent,
               (select count(*) from won w where w.salesperson_id is not distinct from e2.sid) as approved,
               (select round(coalesce(sum(value), 0), 2) from won w where w.salesperson_id is not distinct from e2.sid) as approved_value
        from (select distinct salesperson_id sid from sent union select distinct salesperson_id from won) e2
        left join public.employees e on e.id = e2.sid) x), '[]'::jsonb),
    'to_follow_up', coalesce((select jsonb_agg(x order by x.value desc) from (
        select w.id, cl.name as client_name, w.client_id, round(w.value, 2) as value, w.sent_at, w.days_waiting,
               (select max(m.occurred_at) from public.communications m
                 where m.contact_phone = cl.phone and app.is_human_touch(m) and m.occurred_at > w.sent_at) as last_contact
        from waiting w left join public.clients cl on cl.id = w.client_id
        where w.days_waiting between 2 and 60
        order by w.value desc limit 25) x), '[]'::jsonb)
  ) into result;
  return result;
end $$;

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
               (select coalesce(sum(o.value), 0) from app.open_quotes o where o.sent_at >= a and o.sent_at < b) open_value
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

create or replace function public.owner_alerts()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  st public.business_settings;
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  select * into st from public.business_settings limit 1;
  with recent_cb as (
    select count(*) filter (where created_at >= now() - interval '30 days')::numeric cb30,
           count(*) filter (where created_at >= now() - interval '120 days' and created_at < now() - interval '30 days')::numeric cb90
    from public.jobs where is_callback and coalesce(status, '') <> 'deleted'),
  recent_done as (
    select count(*) filter (where completed_at >= now() - interval '30 days')::numeric d30,
           count(*) filter (where completed_at >= now() - interval '120 days' and completed_at < now() - interval '30 days')::numeric d90
    from app.job_revenue),
  approvals as (
    select count(*) filter (where coalesce(sent_at, approved_at) >= now() - interval '30 days')::numeric s30,
           count(*) filter (where approved_at >= now() - interval '30 days')::numeric a30,
           count(*) filter (where coalesce(sent_at, approved_at) >= now() - interval '120 days' and coalesce(sent_at, approved_at) < now() - interval '30 days')::numeric s90,
           count(*) filter (where approved_at >= now() - interval '120 days' and approved_at < now() - interval '30 days')::numeric a90
    from public.quotes where coalesce(status, '') not in ('deleted', 'draft')),
  big_quotes as (
    select q.id from app.open_quotes q left join public.clients c on c.id = q.client_id
    where q.value >= 1000
      and q.sent_at < now() - interval '3 days' and q.sent_at > now() - interval '60 days'
      and not exists (select 1 from public.communications m where m.contact_phone = c.phone and app.is_human_touch(m) and m.occurred_at > q.sent_at)),
  next7 as (select coalesce(sum(vh.hours), 0) h from app.visit_hours vh join public.visits v on v.id = vh.visit_id
            where vh.start_at >= now() and vh.start_at < now() + interval '7 days' and v.completed_at is null),
  long_days as (
    select count(*) n from public.employees e
    cross join lateral app.commission_days(e.id, ((now() at time zone 'America/Los_Angeles')::date - 7), (now() at time zone 'America/Los_Angeles')::date) d
    where e.tracks_time and e.active and d.hours > 0
      and d.hours > coalesce((select sum(vh.hours) from public.visits v join public.visit_assignments va on va.visit_id = v.id and va.employee_id = e.id
                              join app.visit_hours vh on vh.visit_id = v.id
                              where (v.start_at at time zone 'America/Los_Angeles')::date = d.day), 0) + 1)
  select jsonb_build_object(
    'leads_waiting', (select count(*) from app.quo_leads where first_response_at is null and not waiting_on_them and lead_at > now() - interval '7 days'),
    'follow_ups_due', (select count(*) from app.quo_leads where fu1_open or fu2_open),
    'missed_not_returned', (select count(*) from app.quo_missed_calls where returned_at is null and occurred_at > now() - interval '3 days'),
    'big_quotes_no_follow_up', (select count(*) from big_quotes),
    'plans_need_booking', (select count(*) from app.plan_homes where status in ('not_booked', 'needs_date', 'overdue')),
    'long_crew_days', (select n from long_days),
    'next7_utilization', (select round(h / nullif(7 * st.work_days_per_week / 7.0 * st.crew_hours_per_day * st.trucks, 0), 3) from next7),
    'callback_rate_30', (select round(cb30 / nullif(d30, 0), 3) from recent_cb, recent_done),
    'callback_rate_prior', (select round(cb90 / nullif(d90, 0), 3) from recent_cb, recent_done),
    'approval_rate_30', (select round(a30 / nullif(s30, 0), 3) from approvals),
    'approval_rate_prior', (select round(a90 / nullif(s90, 0), 3) from approvals)
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
