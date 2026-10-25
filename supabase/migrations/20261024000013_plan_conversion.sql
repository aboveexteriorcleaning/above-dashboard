-- Plan conversion: of the homes serviced (completed, non-callback job) in the
-- period, how many are on a plan right now. Also over the last 12 months.
-- Homes are matched by address, same as the plan sheet.

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
  ahead as (select generate_series(this_month, this_month + interval '5 months', interval '1 month')::date m),
  serviced as (   -- homes with a completed (non-callback) job, by address
    select distinct
           coalesce(nullif(lower(regexp_replace(trim(p.street), '\s+', ' ', 'g')), ''), 'client:' || r.client_id) as home_key,
           (r.completed_at >= a and r.completed_at < b) as in_period,
           (r.completed_at >= now() - interval '12 months') as in_12m
    from app.job_revenue r
    join public.jobs j on j.id = r.job_id
    left join public.properties p on p.id = j.property_id
    where r.completed_at >= least(a, now() - interval '12 months')),
  conv as (
    select count(distinct s.home_key) filter (where s.in_period) as serviced,
           count(distinct s.home_key) filter (where s.in_period and ac.home_key is not null) as on_plan,
           count(distinct s.home_key) filter (where s.in_12m) as serviced_12m,
           count(distinct s.home_key) filter (where s.in_12m and ac.home_key is not null) as on_plan_12m
    from serviced s left join (select distinct home_key from active) ac on ac.home_key = s.home_key)
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
    'conversion', (select jsonb_build_object(
        'serviced', serviced, 'on_plan', on_plan, 'rate', round(on_plan::numeric / nullif(serviced, 0), 3),
        'serviced_12m', serviced_12m, 'on_plan_12m', on_plan_12m,
        'rate_12m', round(on_plan_12m::numeric / nullif(serviced_12m, 0), 3)) from conv),
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
