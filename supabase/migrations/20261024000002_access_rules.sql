-- =====================================================================
-- Above Dashboard: access rules
-- ---------------------------------------------------------------------
--  Owners (Kale, Grady): read every table, manage team + settings.
--  Crew   (Connor, Sage): NO direct table access at all. They get data
--         only through the functions below, which return
--           * their own scorecard and job list (client NAME only), and
--           * company-wide totals with no per-person breakdown.
--  Anonymous visitors: nothing.
--  Source data is written only by the sync (service_role).
-- =====================================================================

-- 1. Start from zero: nobody but the sync can touch anything.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
revoke all on schema raw from anon, authenticated, public;
revoke all on all tables in schema raw from anon, authenticated, public;
revoke all on schema app from anon, public;
grant usage on schema app to authenticated;

alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- 2. Who is signed in?
create or replace function app.my_employee_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select e.id from public.employees e
  where e.auth_user_id = auth.uid() and e.active
$$;

create or replace function app.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.employees e
    where e.auth_user_id = auth.uid() and e.active and e.role = 'owner'
  )
$$;

grant execute on function app.my_employee_id() to authenticated;
grant execute on function app.is_owner()      to authenticated;

-- 3. Owners can read every table.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('grant select on public.%I to authenticated', t.tablename);
    execute format(
      'create policy owners_read on public.%I for select to authenticated using (app.is_owner())',
      t.tablename);
  end loop;
end $$;

-- Crew can read exactly one row of one table: their own employee record.
create policy self_read on public.employees
  for select to authenticated using (auth_user_id = auth.uid());

-- Owners manage team, pay and plan settings. Nothing else is writable.
grant insert, update on public.employees, public.employee_costs,
                        public.plan_products, public.branches to authenticated;
create policy owners_write_employees  on public.employees      for insert to authenticated with check (app.is_owner());
create policy owners_update_employees on public.employees      for update to authenticated using (app.is_owner()) with check (app.is_owner());
create policy owners_write_costs      on public.employee_costs for insert to authenticated with check (app.is_owner());
create policy owners_update_costs     on public.employee_costs for update to authenticated using (app.is_owner()) with check (app.is_owner());
create policy owners_write_plans      on public.plan_products  for insert to authenticated with check (app.is_owner());
create policy owners_update_plans     on public.plan_products  for update to authenticated using (app.is_owner()) with check (app.is_owner());
create policy owners_write_branches   on public.branches       for insert to authenticated with check (app.is_owner());
create policy owners_update_branches  on public.branches       for update to authenticated using (app.is_owner()) with check (app.is_owner());

-- =====================================================================
-- 4. Credit rules (internal; not callable by the app directly)
--    Each completed job's revenue is split between the people who worked
--    it, by clocked minutes on that job. If nobody clocked time against
--    it, it is split evenly across the people assigned to its visits.
-- =====================================================================
create or replace view app.job_revenue as
select j.id as job_id, j.completed_at, j.client_id,
       coalesce(sum(li.total_price) filter (where li.total_price is not null), j.total, 0) as revenue
from public.jobs j
left join public.job_line_items li on li.job_id = j.id
where j.completed_at is not null and not j.is_callback
group by j.id;

create or replace view app.job_credit as
with clocked as (
  select job_id, employee_id, sum(minutes) as mins
  from public.timesheet_entries
  where job_id is not null and not is_travel
  group by job_id, employee_id
), clocked_tot as (
  select job_id, sum(mins) as tot from clocked group by job_id
), assigned as (
  select distinct v.job_id, va.employee_id
  from public.visits v join public.visit_assignments va on va.visit_id = v.id
), assigned_cnt as (
  select job_id, count(*) as n from assigned group by job_id
)
select c.job_id, c.employee_id, c.mins / nullif(t.tot, 0) as share, c.mins / 60.0 as hours
from clocked c join clocked_tot t using (job_id)
where t.tot > 0
union all
select a.job_id, a.employee_id, 1.0 / n.n as share, 0::numeric as hours
from assigned a join assigned_cnt n using (job_id)
where not exists (select 1 from clocked_tot t where t.job_id = a.job_id and t.tot > 0);

revoke all on app.job_revenue, app.job_credit from public, anon, authenticated;

-- Shared scorecard math, used by both the crew and owner functions.
create or replace function app.scorecard_for(p_employee uuid, p_from date, p_to date)
returns table (
  completed_jobs     int,
  revenue_credited   numeric,
  clocked_hours      numeric,
  revenue_per_hour   numeric,
  work_days          int,
  revenue_per_day    numeric,
  upsell_revenue     numeric,
  plans_sold         int,
  quotes_sent        int,
  quotes_approved    int,
  callbacks          int
)
language sql stable security definer set search_path = '' as $$
  with win as (
    select p_from::timestamptz as a, (p_to + 1)::timestamptz as b
  ), mine as (
    select r.job_id, r.revenue * c.share as rev
    from app.job_revenue r
    join app.job_credit c on c.job_id = r.job_id and c.employee_id = p_employee
    , win where r.completed_at >= win.a and r.completed_at < win.b
  ), hrs as (
    select coalesce(sum(t.minutes), 0) / 60.0 as h,
           count(distinct (t.started_at at time zone 'America/Los_Angeles')::date) as d
    from public.timesheet_entries t, win
    where t.employee_id = p_employee and t.started_at >= win.a and t.started_at < win.b
  ), ups as (
    select coalesce(sum(li.total_price * c.share), 0) as v
    from public.job_line_items li
    join public.jobs j on j.id = li.job_id
    join app.job_credit c on c.job_id = j.id and c.employee_id = p_employee
    , win where li.is_onsite_upsell and j.completed_at >= win.a and j.completed_at < win.b
  ), quote_ups as (
    select coalesce(sum(qli.total_price), 0) as v
    from public.quote_line_items qli join public.quotes q on q.id = qli.quote_id, win
    where qli.is_optional and q.salesperson_id = p_employee
      and q.approved_at >= win.a and q.approved_at < win.b
  ), qs as (
    select count(*) filter (where q.sent_at >= win.a and q.sent_at < win.b) as sent,
           count(*) filter (where q.approved_at >= win.a and q.approved_at < win.b) as approved,
           count(*) filter (where q.approved_at >= win.a and q.approved_at < win.b and exists (
             select 1 from public.quote_line_items qli
             join public.plan_products pp on pp.product_name = qli.product_name
             where qli.quote_id = q.id)) as plans
    from public.quotes q, win where q.salesperson_id = p_employee
  ), cb as (
    select count(*) as n
    from public.jobs cbj
    join app.job_credit c on c.job_id = cbj.callback_of_job_id and c.employee_id = p_employee
    , win where cbj.is_callback and cbj.created_at >= win.a and cbj.created_at < win.b
  )
  select (select count(distinct job_id) from mine)::int,
         round((select coalesce(sum(rev), 0) from mine), 2),
         round(hrs.h, 1),
         round((select coalesce(sum(rev), 0) from mine) / nullif(hrs.h, 0), 2),
         hrs.d::int,
         round((select coalesce(sum(rev), 0) from mine) / nullif(hrs.d, 0), 2),
         round(ups.v + quote_ups.v, 2),
         qs.plans::int, qs.sent::int, qs.approved::int, cb.n::int
  from hrs, ups, quote_ups, qs, cb
$$;
revoke all on function app.scorecard_for(uuid, date, date) from public, anon, authenticated;

-- =====================================================================
-- 5. What the app can call
-- =====================================================================

-- Anyone signed in: MY scorecard. The employee is always taken from the
-- login, never from a parameter, so nobody can ask for someone else's.
create function public.my_scorecard(p_from date, p_to date)
returns table (completed_jobs int, revenue_credited numeric, clocked_hours numeric,
               revenue_per_hour numeric, work_days int, revenue_per_day numeric,
               upsell_revenue numeric, plans_sold int, quotes_sent int,
               quotes_approved int, callbacks int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.my_employee_id() is null then raise exception 'not authorised'; end if;
  return query select * from app.scorecard_for(app.my_employee_id(), p_from, p_to);
end $$;

-- Anyone signed in: MY jobs. Client name only: no phone, email or address.
create function public.my_jobs(p_from date, p_to date)
returns table (job_id text, completed_at timestamptz, client_name text,
               job_title text, my_revenue numeric, my_hours numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.my_employee_id() is null then raise exception 'not authorised'; end if;
  return query
    select r.job_id, r.completed_at, cl.name, j.title,
           round(r.revenue * c.share, 2), round(c.hours, 1)
    from app.job_revenue r
    join app.job_credit c on c.job_id = r.job_id and c.employee_id = app.my_employee_id()
    join public.jobs j on j.id = r.job_id
    left join public.clients cl on cl.id = r.client_id
    where r.completed_at >= p_from::timestamptz and r.completed_at < (p_to + 1)::timestamptz
    order by r.completed_at desc;
end $$;

-- Anyone signed in: company totals. Deliberately NO per-person breakdown.
create function public.company_summary(p_from date, p_to date)
returns table (completed_revenue numeric, completed_jobs int, new_clients int,
               quotes_sent int, quotes_approved int, quote_approval_rate numeric,
               booked_next_30_days numeric, active_plans int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.my_employee_id() is null then raise exception 'not authorised'; end if;
  return query
  with win as (select p_from::timestamptz a, (p_to + 1)::timestamptz b),
  rev as (select coalesce(sum(revenue),0) v, count(*) n from app.job_revenue, win
          where completed_at >= win.a and completed_at < win.b),
  firsts as (select client_id, min(completed_at) f from app.job_revenue group by client_id),
  nc as (select count(*) n from firsts, win where f >= win.a and f < win.b),
  qs as (select count(*) filter (where sent_at >= win.a and sent_at < win.b) s,
                count(*) filter (where approved_at >= win.a and approved_at < win.b) ap
         from public.quotes, win),
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

-- Owners only: everyone's scorecards side by side.
create function public.team_scorecards(p_from date, p_to date)
returns table (employee_id uuid, full_name text, completed_jobs int, revenue_credited numeric,
               clocked_hours numeric, revenue_per_hour numeric, work_days int,
               revenue_per_day numeric, upsell_revenue numeric, plans_sold int,
               quotes_sent int, quotes_approved int, callbacks int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  return query
    select e.id, e.full_name, s.*
    from public.employees e
    cross join lateral app.scorecard_for(e.id, p_from, p_to) s
    where e.active;
end $$;

-- Owners only: full client profile, and every view is logged.
create function public.client_profile(p_client_id text)
returns table (client_id text, name text, email text, phone text, lead_source text,
               lifetime_revenue numeric, completed_jobs int, first_job timestamptz,
               last_job timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  insert into public.client_profile_views (employee_id, client_id)
    values (app.my_employee_id(), p_client_id);
  return query
    select c.id, c.name, c.email, c.phone, c.lead_source,
           round(coalesce(sum(r.revenue),0),2), count(r.job_id)::int,
           min(r.completed_at), max(r.completed_at)
    from public.clients c
    left join app.job_revenue r on r.client_id = c.id
    where c.id = p_client_id
    group by c.id;
end $$;

revoke all on function public.my_scorecard(date,date), public.my_jobs(date,date),
  public.company_summary(date,date), public.team_scorecards(date,date),
  public.client_profile(text) from public, anon;
grant execute on function public.my_scorecard(date,date), public.my_jobs(date,date),
  public.company_summary(date,date), public.team_scorecards(date,date),
  public.client_profile(text) to authenticated;

-- 6. Plan catalog, from the Jobber products list (24 Oct 2026).
insert into public.plan_products (product_name, service_line, services_per_year, discount_per_visit) values
  ('Biannual Roof Cleaning Plan',   'roof',   2, 50),
  ('4-Month Roof Cleaning Plan',    'roof',   3, 75),
  ('Biannual Window Cleaning Plan', 'window', 2, 50),
  ('Quarterly Window Cleaning Plan','window', 4, 75),
  ('Monthly Window Cleaning Plan',  'window',12, 100);
