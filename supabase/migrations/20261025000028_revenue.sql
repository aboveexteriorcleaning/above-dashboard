-- Revenue: upsells, customers (retention and lifetime value), and plan extras.

-- Upsell lines on completed jobs: on-site upsells (paid services added on a quoted
-- job that weren't on the quote) and quote add-ons (optional quote items the
-- customer picked, which then appear on the job). Part of job revenue already;
-- never added to it a second time.
create or replace view app.upsell_lines as
select li.id, li.job_id, li.product_name, li.total_price, 'on_site'::text as kind
from public.job_line_items li
where li.is_onsite_upsell and li.total_price > 0
union all
select li.id, li.job_id, li.product_name, li.total_price, 'quote_add_on'
from public.job_line_items li
join public.jobs j on j.id = li.job_id
where li.total_price > 0 and not li.is_onsite_upsell
  and exists (select 1 from public.quote_line_items q
              where q.quote_id = j.quote_id and q.is_optional and q.product_name = li.product_name);
revoke all on app.upsell_lines from public, anon, authenticated;

create or replace function public.owner_upsells(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a timestamptz := app.day_start(p_from);
  b timestamptz := app.day_start(p_to + 1);
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with done as (select r.job_id, r.revenue from app.job_revenue r where r.completed_at >= a and r.completed_at < b),
  ups as (select u.* from app.upsell_lines u join done d on d.job_id = u.job_id),
  offers as (select j.upsell_offer from done d join public.jobs j on j.id = d.job_id),
  base as (   -- each upsold job's main service: its biggest non-upsell line
    select distinct on (li.job_id) li.job_id, app.service_category(li.product_name) cat
    from public.job_line_items li join done d on d.job_id = li.job_id
    where li.total_price > 0 and li.id not in (select id from ups)
    order by li.job_id, li.total_price desc),
  team as (select e.id, e.full_name, s.hours from public.employees e
           cross join lateral app.scorecard_for(e.id, p_from, p_to) s where e.active)
  select jsonb_build_object(
    'completed_jobs', (select count(*) from done),
    'upsold_jobs', (select count(distinct job_id) from ups),
    'revenue', (select round(coalesce(sum(total_price), 0), 2) from ups),
    'on_site', (select round(coalesce(sum(total_price), 0), 2) from ups where kind = 'on_site'),
    'quote_add_on', (select round(coalesce(sum(total_price), 0), 2) from ups where kind = 'quote_add_on'),
    'job_revenue', (select round(coalesce(sum(revenue), 0), 2) from done),
    'offers', (select jsonb_build_object(
        'recorded', count(*) filter (where upsell_offer is not null),
        'offered', count(*) filter (where upsell_offer in ('accepted', 'declined')),
        'accepted', count(*) filter (where upsell_offer = 'accepted'),
        'declined', count(*) filter (where upsell_offer = 'declined'),
        'not_a_fit', count(*) filter (where upsell_offer = 'not_a_fit')) from offers),
    'by_service', coalesce((select jsonb_agg(x order by x.revenue desc) from (
        select app.service_category(product_name) service, count(*) times, round(sum(total_price), 2) revenue
        from ups group by 1) x), '[]'::jsonb),
    'combos', coalesce((select jsonb_agg(x order by x.revenue desc) from (
        select coalesce(b.cat, 'Other') base, app.service_category(u.product_name) add_on,
               count(distinct u.job_id) jobs, round(sum(u.total_price), 2) revenue
        from ups u left join base b on b.job_id = u.job_id
        group by 1, 2 order by 4 desc limit 12) x), '[]'::jsonb),
    'by_person', coalesce((select jsonb_agg(x order by x.revenue desc) from (
        select t.full_name name,
               (select count(distinct d.job_id) from done d join app.job_credit c on c.job_id = d.job_id and c.employee_id = t.id) jobs,
               (select count(distinct u.job_id) from ups u join app.job_credit c on c.job_id = u.job_id and c.employee_id = t.id) upsold_jobs,
               (select round(coalesce(sum(u.total_price * c.share), 0), 2) from ups u join app.job_credit c on c.job_id = u.job_id and c.employee_id = t.id) revenue,
               t.hours
        from team t) x where x.jobs > 0), '[]'::jsonb)
  ) into result;
  return result;
end $$;

-- Customers, matched to a home by address.
create or replace view app.home_jobs as
select app.home_key(p.street, j.client_id) as home_key, r.job_id, r.completed_at, r.revenue
from app.job_revenue r join public.jobs j on j.id = r.job_id
left join public.properties p on p.id = j.property_id;
revoke all on app.home_jobs from public, anon, authenticated;

create or replace function public.owner_customers(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a timestamptz := app.day_start(p_from);
  b timestamptz := app.day_start(p_to + 1);
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with hj as materialized (select * from app.home_jobs),
  ranked as (select hj.*, row_number() over (partition by home_key order by completed_at) n,
                    lag(completed_at) over (partition by home_key order by completed_at) prev_at
             from hj),
  homes as (select home_key, min(completed_at) first_at, max(completed_at) last_at, count(*) jobs, sum(revenue) lifetime
            from hj group by home_key),
  period as (select r.*, h.first_at from ranked r join homes h using (home_key) where r.completed_at >= a and r.completed_at < b),
  cats as (select distinct app.home_key(p.street, j.client_id) home_key, app.service_category(li.product_name) cat
           from public.job_line_items li join public.jobs j on j.id = li.job_id
           left join public.properties p on p.id = j.property_id
           where j.completed_at is not null and not j.is_callback and li.total_price > 0
             and app.service_category(li.product_name) not in ('Plan discount', 'Other')),
  cohort as (   -- first job 12-24 months before the end of the period
    select h.*, (select min(r.completed_at) from ranked r where r.home_key = h.home_key and r.n = 2) second_at
    from homes h where h.first_at >= b - interval '24 months' and h.first_at < b - interval '12 months'),
  prior_year as (select distinct home_key from hj where completed_at >= b - interval '24 months' and completed_at < b - interval '12 months'),
  last_year as (select distinct home_key from hj where completed_at >= b - interval '12 months' and completed_at < b)
  select jsonb_build_object(
    'customers', (select count(distinct home_key) from period),
    'revenue', (select round(coalesce(sum(revenue), 0), 2) from period),
    'jobs', (select count(*) from period),
    'new_customers', (select count(distinct home_key) from period where first_at >= a),
    'new_revenue', (select round(coalesce(sum(revenue), 0), 2) from period where first_at >= a),
    'returning_revenue', (select round(coalesce(sum(revenue), 0), 2) from period where first_at < a),
    'first_job_avg', (select round(avg(revenue), 2) from period where n = 1),
    'reactivated', (select count(distinct home_key) from period where prev_at < completed_at - interval '18 months'),
    'reactivated_revenue', (select round(coalesce(sum(revenue), 0), 2) from period where prev_at < completed_at - interval '18 months'),
    'lifetime_avg', (select round(avg(lifetime), 2) from homes),
    'lifetime_avg_2yr', (select round(avg(lifetime), 2) from homes where first_at < now() - interval '24 months'),
    'all_customers', (select count(*) from homes),
    'repeat_rate', (select round(count(*) filter (where jobs >= 2)::numeric / nullif(count(*), 0), 3) from homes where first_at < now() - interval '12 months'),
    'repeat_base', (select count(*) from homes where first_at < now() - interval '12 months'),
    'second_job_rate', (select round(count(*) filter (where second_at < first_at + interval '12 months')::numeric / nullif(count(*), 0), 3) from cohort),
    'second_job_base', (select count(*) from cohort),
    'retention', (select round(count(*) filter (where home_key in (select home_key from last_year))::numeric / nullif(count(*), 0), 3) from prior_year),
    'retention_base', (select count(*) from prior_year),
    'days_between', (select round((percentile_cont(0.5) within group (order by extract(epoch from (completed_at - prev_at)) / 86400.0))::numeric, 0)
                     from ranked where prev_at is not null and completed_at - prev_at > interval '7 days'),
    'jobs_per_customer_12m', (select round(count(*)::numeric / nullif(count(distinct home_key), 0), 2) from hj where completed_at >= now() - interval '12 months'),
    'cross_service', (select round(count(*) filter (where c >= 2)::numeric / nullif(count(*), 0), 3) from (select home_key, count(*) c from cats group by 1) x),
    'top_customers', coalesce((select jsonb_agg(x order by x.lifetime desc) from (
        select h.home_key, h.jobs, round(h.lifetime, 2) lifetime, h.first_at, h.last_at,
               (select cl.name from public.jobs j join public.clients cl on cl.id = j.client_id
                 join hj on hj.job_id = j.id where hj.home_key = h.home_key order by j.completed_at desc limit 1) as name
        from homes h order by h.lifetime desc limit 10) x), '[]'::jsonb)
  ) into result;
  return result;
end $$;

-- Plan extras: monthly recurring equivalent, renewal and cancellation, what
-- plan members spend outside the plan, and plan vs non-plan lifetime value.
create or replace function public.owner_plan_extras(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a timestamptz := app.day_start(p_from);
  b timestamptz := app.day_start(p_to + 1);
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with ph as (select * from app.plan_homes),
  active as (select * from ph where status in ('on_schedule', 'booked_late', 'needs_date', 'not_booked')),
  due_passed as (select * from ph where due_date is not null and due_date < (now() at time zone 'America/Los_Angeles')::date),
  plan_home_keys as (select distinct home_key from ph),
  plan_job_ids as (select distinct job_id from app.plan_jobs),
  hj as (select * from app.home_jobs)
  select jsonb_build_object(
    'mrr', (select round(coalesce(sum(visit_value * services_per_year), 0) / 12, 2) from active),
    'avg_plan_value', (select round(avg(visit_value * services_per_year), 2) from active),
    'renewal_rate', (select round(count(*) filter (where status in ('on_schedule', 'booked_late') or next_visit is not null)::numeric
                                  / nullif(count(*), 0), 3) from due_passed),
    'renewal_base', (select count(*) from due_passed),
    'cancellation_rate', (select round(count(*) filter (where status in ('overdue', 'lapsed'))::numeric / nullif(count(*), 0), 3) from ph where visits_done > 0),
    'plan_upsell_revenue', (select round(coalesce(sum(revenue), 0), 2) from hj
                            where completed_at >= a and completed_at < b
                              and home_key in (select home_key from plan_home_keys)
                              and job_id not in (select job_id from plan_job_ids)),
    'plan_lifetime_avg', (select round(avg(t), 2) from (select home_key, sum(revenue) t from hj where home_key in (select home_key from plan_home_keys) group by 1) x),
    'non_plan_lifetime_avg', (select round(avg(t), 2) from (select home_key, sum(revenue) t from hj where home_key not in (select home_key from plan_home_keys) group by 1) x)
  ) into result;
  return result;
end $$;

revoke all on function public.owner_upsells(date, date), public.owner_customers(date, date), public.owner_plan_extras(date, date) from public, anon;
grant execute on function public.owner_upsells(date, date), public.owner_customers(date, date), public.owner_plan_extras(date, date) to authenticated;

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
