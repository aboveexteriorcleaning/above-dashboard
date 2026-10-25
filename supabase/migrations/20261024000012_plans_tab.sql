-- Plans tab (owners only): plan revenue, monthly plan revenue, plan visits
-- booked ahead, and one row per home-on-a-plan with whether its next visit
-- is on the books.
--
-- A "plan job" is a job with a plan line item (see plan_products, which
-- fills itself from any line named "... Plan"), or, for older plans set up
-- without a plan line, a job whose title says "Plan".
-- A "plan home" is one address + service line (roof / window), so duplicate
-- client records in Jobber collapse into one row, and a home with both a
-- roof and a window plan gets one row for each.

create or replace view app.plan_jobs as
with lines as (
  select li.job_id, pp.product_name as plan_name, pp.service_line, pp.services_per_year,
         pp.grace_days, greatest(-coalesce(li.total_price, 0), 0) as discount
  from public.job_line_items li
  join public.plan_products pp on pp.product_name = li.product_name
  union all
  select j.id, j.title, app.plan_service_line(j.title), app.plan_visits_per_year(j.title), 30, 0
  from public.jobs j
  where j.title ~* '\mplan\M'
    and not exists (select 1 from public.job_line_items li
                    join public.plan_products pp on pp.product_name = li.product_name
                    where li.job_id = j.id)
)
select distinct on (l.job_id, l.service_line)
       l.job_id, l.plan_name, l.service_line, l.services_per_year, l.grace_days, l.discount,
       j.job_number, j.client_id, j.property_id, j.status, j.start_at, j.completed_at, j.created_at,
       j.total,
       r.revenue,   -- completed, pre-tax; null until the job is completed
       coalesce(nullif(lower(regexp_replace(trim(p.street), '\s+', ' ', 'g')), ''),
                'client:' || j.client_id) as home_key,
       (j.completed_at is null and coalesce(j.status, '') <> 'archived'
        and (j.start_at is null or j.start_at >= now() - interval '60 days')) as is_open
from lines l
join public.jobs j on j.id = l.job_id
left join public.properties p on p.id = j.property_id
left join app.job_revenue r on r.job_id = j.id
where coalesce(j.status, '') <> 'deleted' and not j.is_callback
order by l.job_id, l.service_line, l.services_per_year desc;

create or replace view app.plan_homes as
with agg as (
  select home_key, service_line,
         max(completed_at) as last_visit_at,
         min(start_at) filter (where is_open and start_at is not null) as next_visit_at,
         bool_or(is_open and start_at is null) as has_unscheduled,
         count(*) filter (where completed_at is not null)::int as visits_done,
         coalesce(sum(revenue) filter (where completed_at is not null), 0) as revenue_to_date,
         min(created_at) as signed_up_at
  from app.plan_jobs group by 1, 2),
latest as (   -- the plan as it stands now: the most recent (or upcoming) plan job
  select distinct on (home_key, service_line)
         home_key, service_line, plan_name, services_per_year, grace_days, client_id, property_id,
         total as visit_value
  from app.plan_jobs
  order by home_key, service_line, coalesce(start_at, completed_at, created_at) desc nulls last),
nxt as (
  select distinct on (home_key, service_line)
         home_key, service_line, job_id as next_job_id, job_number as next_job_number
  from app.plan_jobs where is_open
  order by home_key, service_line, start_at nulls last),
dated as (
  select a.*, l.plan_name, l.services_per_year, l.grace_days, l.client_id, l.property_id, l.visit_value,
         n.next_job_id, n.next_job_number,
         (a.last_visit_at at time zone 'America/Los_Angeles')::date as last_visit,
         (a.next_visit_at at time zone 'America/Los_Angeles')::date as next_visit,
         (a.last_visit_at at time zone 'America/Los_Angeles')::date + (365 / l.services_per_year) as due_date,
         (now() at time zone 'America/Los_Angeles')::date as today
  from agg a
  join latest l using (home_key, service_line)
  left join nxt n using (home_key, service_line))
select d.*,
       case
         when d.next_visit is not null and (d.due_date is null or d.next_visit <= d.due_date + d.grace_days) then 'on_schedule'
         when d.next_visit is not null then 'booked_late'
         when d.has_unscheduled then 'needs_date'
         when d.due_date is null or d.today <= d.due_date + d.grace_days then 'not_booked'
         when d.today <= d.due_date + 180 then 'overdue'
         else 'lapsed'
       end as status
from dated d;

revoke all on app.plan_jobs, app.plan_homes from public, anon, authenticated;

-- Homes on a plan = every plan home except overdue and lapsed ones.
create or replace function app.active_plan_count() returns int
language sql stable security definer set search_path = '' as $$
  select count(distinct home_key)::int from app.plan_homes
  where status in ('on_schedule', 'booked_late', 'needs_date', 'not_booked')
$$;
revoke all on function app.active_plan_count() from public, anon, authenticated;

-- Plan KPIs for a period, plus monthly history and the months ahead.
create or replace function public.owner_plans(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a timestamptz := app.day_start(p_from);
  b timestamptz := app.day_start(p_to + 1);
  this_month date := date_trunc('month', (now() at time zone 'America/Los_Angeles'))::date;
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;

  with pj as (select distinct on (job_id) * from app.plan_jobs order by job_id),   -- one row per job
  done as (select * from pj where completed_at >= a and completed_at < b),
  company as (select coalesce(sum(revenue), 0) v from app.job_revenue where completed_at >= a and completed_at < b),
  discounts as (select coalesce(sum(discount), 0) v from app.plan_jobs where completed_at >= a and completed_at < b),
  homes as (select * from app.plan_homes),
  active as (select * from homes where status in ('on_schedule', 'booked_late', 'needs_date', 'not_booked')),
  signups as (
    select count(*) n from (select home_key, min(signed_up_at) s from homes group by home_key) x
    where s >= a and s < b),
  months as (select generate_series(this_month - interval '11 months', this_month, interval '1 month')::date m),
  ahead as (select generate_series(this_month, this_month + interval '5 months', interval '1 month')::date m)
  select jsonb_build_object(
    'revenue', (select round(coalesce(sum(revenue), 0), 2) from done),
    'visits', (select count(*) from done),
    'share_of_revenue', (select round(coalesce(sum(revenue), 0) / nullif((select v from company), 0), 3) from done),
    'discounts', (select round(v, 2) from discounts),
    'avg_visit', (select round(avg(revenue), 2) from done),
    'annual_value', (select round(coalesce(sum(visit_value * services_per_year), 0), 2) from active),
    'booked_ahead', (select round(coalesce(sum(total), 0), 2) from pj where is_open and start_at >= now()),
    'booked_ahead_visits', (select count(*) from pj where is_open and start_at >= now()),
    'revenue_to_date', (select round(coalesce(sum(revenue), 0), 2) from pj where completed_at is not null),
    'homes', (select count(distinct home_key) from active),
    'signups', (select n from signups),
    'status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
               from (select status, count(*) n from homes group by status) s),
    'by_plan', coalesce((
      select jsonb_agg(x order by x.homes desc, x.plan) from (
        select h.plan_name as plan, h.services_per_year as per_year, count(*) as homes,
               (select round(coalesce(sum(d.revenue), 0), 2) from done d where d.plan_name = h.plan_name) as revenue
        from active h group by h.plan_name, h.services_per_year) x), '[]'::jsonb),
    'monthly', (
      select jsonb_agg(jsonb_build_object(
        'month', m.m,
        'completed_revenue', (select round(coalesce(sum(revenue), 0), 2) from pj
                              where completed_at >= app.day_start(m.m) and completed_at < app.day_start((m.m + interval '1 month')::date)),
        'completed_jobs', (select count(*) from pj
                           where completed_at >= app.day_start(m.m) and completed_at < app.day_start((m.m + interval '1 month')::date)))
        order by m.m) from months m),
    'ahead', (
      select jsonb_agg(jsonb_build_object(
        'month', m.m,
        'value', (select round(coalesce(sum(total), 0), 2) from pj
                  where is_open and start_at >= greatest(app.day_start(m.m), now())
                    and start_at < app.day_start((m.m + interval '1 month')::date)),
        'visits', (select count(*) from pj
                   where is_open and start_at >= greatest(app.day_start(m.m), now())
                     and start_at < app.day_start((m.m + interval '1 month')::date)))
        order by m.m) from ahead m)
  ) into result;
  return result;
end $$;

-- The plan customer sheet: one row per home and plan.
create or replace function public.plan_customers()
returns table (home_key text, service_line text, plan_name text, services_per_year int,
               client_id text, client_name text, phone text, email text, street text, city text,
               last_visit date, next_visit date, next_job_id text, next_job_number int, due_date date,
               status text, days_overdue int, visits_done int, revenue_to_date numeric,
               visit_value numeric, annual_value numeric, signed_up date)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  return query
  select h.home_key, h.service_line, h.plan_name, h.services_per_year,
         h.client_id, c.name, c.phone, c.email, p.street, p.city,
         h.last_visit, h.next_visit, h.next_job_id, h.next_job_number, h.due_date,
         h.status, greatest(h.today - h.due_date, 0)::int,
         h.visits_done, round(h.revenue_to_date, 2), round(h.visit_value, 2),
         case when h.status in ('overdue', 'lapsed') then 0::numeric
              else round(h.visit_value * h.services_per_year, 2) end,
         (h.signed_up_at at time zone 'America/Los_Angeles')::date
  from app.plan_homes h
  left join public.clients c on c.id = h.client_id
  left join public.properties p on p.id = h.property_id
  order by h.home_key, h.service_line;
end $$;

revoke all on function public.owner_plans(date, date), public.plan_customers() from public, anon;
grant execute on function public.owner_plans(date, date), public.plan_customers() to authenticated;
