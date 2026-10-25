-- Who sold each plan.
--
-- A plan "sale" is the first plan job for a home + plan type. How it was sold:
--   pre-job  - the plan line was on the approved quote, or was on the job
--              before the visit day (signed up over the phone/email).
--              Credit: the quote's salesperson.
--   on-site  - the plan line was added on or after the visit day (tech sold
--              it at the door and added it to the job/invoice), or the first
--              plan job was booked within 2 days of a completed visit at the
--              same address (tech sold it and booked the next visit).
--              Credit: everyone assigned to that visit, split evenly.

create or replace function app.home_key(p_street text, p_client_id text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(lower(regexp_replace(trim(p_street), '\s+', ' ', 'g')), ''), 'client:' || p_client_id)
$$;

create or replace view app.plan_sales as
with first_job as (
  select distinct on (pj.home_key, pj.service_line) pj.*, j.quote_id
  from app.plan_jobs pj join public.jobs j on j.id = pj.job_id
  order by pj.home_key, pj.service_line, coalesce(pj.start_at, pj.completed_at, pj.created_at), pj.created_at),
facts as (
  select f.*,
    (select min(li.created_at) from public.job_line_items li
       join public.plan_products pp on pp.product_name = li.product_name
      where li.job_id = f.job_id) as line_added_at,
    exists (select 1 from public.quote_line_items qli
              join public.plan_products pp on pp.product_name = qli.product_name
             where qli.quote_id = f.quote_id) as on_quote,
    q.approved_at as quote_approved_at, q.salesperson_id,
    prior.id as prior_job_id, prior.completed_at as prior_completed_at
  from first_job f
  left join public.quotes q on q.id = f.quote_id
  left join lateral (
    select j2.id, j2.completed_at from public.jobs j2
    left join public.properties p2 on p2.id = j2.property_id
    where j2.id <> f.job_id and j2.completed_at is not null and not j2.is_callback
      and app.home_key(p2.street, j2.client_id) = f.home_key
      and j2.completed_at between f.created_at - interval '2 days' and f.created_at + interval '1 hour'
    order by j2.completed_at desc limit 1) prior on true),
classified as (
  select f.*,
    case
      when f.on_quote then 'quote'
      when f.line_added_at is not null and f.start_at is not null
           and f.line_added_at >= app.day_start((f.start_at at time zone 'America/Los_Angeles')::date) then 'added_on_site'
      when f.prior_job_id is not null then 'booked_after_visit'
      else 'on_job_before_visit'
    end as how
  from facts f)
select c.home_key, c.service_line, c.plan_name, c.services_per_year, c.client_id,
       round(coalesce(c.total, 0) * c.services_per_year, 2) as annual_value,
       c.how,
       case when c.how in ('added_on_site', 'booked_after_visit') then 'on_site' else 'pre_job' end as channel,
       case when c.how = 'booked_after_visit' then c.prior_job_id else c.job_id end as sale_job_id,
       case c.how
         when 'quote' then coalesce(c.quote_approved_at, c.created_at)
         when 'added_on_site' then c.line_added_at
         when 'booked_after_visit' then c.prior_completed_at
         else c.created_at end as sold_at,
       case when c.how in ('quote', 'on_job_before_visit') then c.salesperson_id end as salesperson_id,
       case when c.how in ('added_on_site', 'booked_after_visit')
            then exists (select 1 from public.visits v join public.visit_assignments va on va.visit_id = v.id
                         where v.job_id = case when c.how = 'booked_after_visit' then c.prior_job_id else c.job_id end)
            else c.salesperson_id is not null end as attributed
from classified c;

-- One row per person credited with a sale (shares add up to 1 per sale).
create or replace view app.plan_sale_credit as
select s.home_key, s.service_line, s.channel, s.sold_at, s.annual_value, e.employee_id,
       1.0 / count(*) over (partition by s.home_key, s.service_line) as share
from app.plan_sales s
join lateral (
  select va.employee_id from public.visits v join public.visit_assignments va on va.visit_id = v.id
  where s.channel = 'on_site' and v.job_id = s.sale_job_id
  union
  select s.salesperson_id where s.channel = 'pre_job' and s.salesperson_id is not null) e on true;

revoke all on app.plan_sales, app.plan_sale_credit from public, anon, authenticated;

-- Plan selling for one person in a period.
--   plans_sold     credited sales (a two-person crew sale counts 0.5 each)
--   value_sold     credited annual value of those plans (visit price x visits a year)
--   serviced_homes homes they worked at that weren't already on a plan
--   converted      of those, homes where they sold a plan on site
create or replace function app.plan_sales_for(p_employee uuid, p_from date, p_to date)
returns table (plans_sold numeric, on_site numeric, pre_job numeric, value_sold numeric,
               serviced_homes int, converted_homes int, conversion numeric)
language sql stable security definer set search_path = '' as $$
  with win as (select app.day_start(p_from) a, app.day_start(p_to + 1) b),
  mine as (
    select c.* from app.plan_sale_credit c, win
    where c.employee_id = p_employee and c.sold_at >= win.a and c.sold_at < win.b),
  worked as (
    select distinct app.home_key(p.street, j.client_id) as home_key,
           app.day_start((coalesce(v.start_at, j.start_at, j.completed_at) at time zone 'America/Los_Angeles')::date) as visit_day
    from public.jobs j
    join public.visits v on v.job_id = j.id
    join public.visit_assignments va on va.visit_id = v.id and va.employee_id = p_employee
    left join public.properties p on p.id = j.property_id, win
    where j.completed_at >= win.a and j.completed_at < win.b
      and not j.is_callback and coalesce(j.status, '') <> 'deleted'),
  eligible as (   -- not already on a plan when they got there
    select distinct w.home_key from worked w
    where not exists (select 1 from app.plan_sales s where s.home_key = w.home_key and s.sold_at < w.visit_day)),
  converted as (
    select distinct e.home_key from eligible e
    join app.plan_sale_credit c on c.home_key = e.home_key and c.employee_id = p_employee and c.channel = 'on_site')
  select round(coalesce((select sum(share) from mine), 0), 2),
         round(coalesce((select sum(share) from mine where channel = 'on_site'), 0), 2),
         round(coalesce((select sum(share) from mine where channel = 'pre_job'), 0), 2),
         round(coalesce((select sum(share * annual_value) from mine), 0), 2),
         (select count(*) from eligible)::int,
         (select count(*) from converted)::int,
         round((select count(*) from converted)::numeric / nullif((select count(*) from eligible), 0), 3)
$$;
revoke all on function app.plan_sales_for(uuid, date, date) from public, anon, authenticated;

create or replace function public.my_plan_sales(p_from date, p_to date)
returns table (plans_sold numeric, on_site numeric, pre_job numeric, value_sold numeric,
               serviced_homes int, converted_homes int, conversion numeric)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := app.my_employee_id();
begin
  if me is null then raise exception 'not authorised'; end if;
  return query select * from app.plan_sales_for(me, p_from, p_to);
end $$;

create or replace function public.team_plan_sales(p_from date, p_to date)
returns table (employee_id uuid, full_name text, plans_sold numeric, on_site numeric, pre_job numeric,
               value_sold numeric, serviced_homes int, converted_homes int, conversion numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  return query
  select e.id, e.full_name, s.*
  from public.employees e cross join lateral app.plan_sales_for(e.id, p_from, p_to) s
  where e.active and (s.plans_sold > 0 or s.serviced_homes > 0)
  order by s.plans_sold desc, e.full_name;
end $$;

revoke all on function public.my_plan_sales(date, date), public.team_plan_sales(date, date) from public, anon;
grant execute on function public.my_plan_sales(date, date), public.team_plan_sales(date, date) to authenticated;

-- Plans tab: sales by channel.
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
    'channels', (select jsonb_build_object(
        'on_site', count(*) filter (where channel = 'on_site'),
        'pre_job', count(*) filter (where channel = 'pre_job'),
        'unattributed', count(*) filter (where not attributed))
      from app.plan_sales where sold_at >= a and sold_at < b),
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

-- Plan customer sheet: add who sold it, how, and when.
drop function public.plan_customers();
create function public.plan_customers()
returns table (home_key text, service_line text, plan_name text, services_per_year int,
               client_id text, client_name text, phone text, email text, street text, city text,
               last_visit date, next_visit date, next_job_id text, next_job_number int, due_date date,
               status text, days_overdue int, visits_done int, revenue_to_date numeric,
               visit_value numeric, annual_value numeric, signed_up date,
               sold_by text, sale_channel text, sold_on date)
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
         (h.signed_up_at at time zone 'America/Los_Angeles')::date,
         (select string_agg(e.full_name, ' & ' order by e.full_name)
            from app.plan_sale_credit pc join public.employees e on e.id = pc.employee_id
           where pc.home_key = h.home_key and pc.service_line = h.service_line),
         s.channel,
         (s.sold_at at time zone 'America/Los_Angeles')::date
  from app.plan_homes h
  left join app.plan_sales s on s.home_key = h.home_key and s.service_line = h.service_line
  left join public.clients c on c.id = h.client_id
  left join public.properties p on p.id = h.property_id
  order by h.home_key, h.service_line;
end $$;
revoke all on function public.plan_customers() from public, anon;
grant execute on function public.plan_customers() to authenticated;
