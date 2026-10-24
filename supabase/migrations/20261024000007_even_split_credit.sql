-- =====================================================================
-- Credit rule (decided by the owners, Oct 24 2026)
--   * Every completed job's revenue is split EVENLY among the people
--     assigned to its visits. Clocked time does not change the split.
--   * Revenue per hour:
--       - people who clock in:   credited revenue / ALL hours they clocked in the period
--       - people who don't:      credited revenue / scheduled time on their assigned
--                                visits of those same jobs (shown as an estimate)
--   * "Clocks in" is a per-person setting. Owners start with it off, so a stray
--     owner timesheet is ignored.
-- =====================================================================

alter table public.employees add column if not exists tracks_time boolean not null default true;
update public.employees set tracks_time = (role <> 'owner');

-- Scheduled length of each visit, in hours. Visits without a real time window
-- (all-day, missing or over 12 hours) are left out of estimates and counted instead.
create or replace view app.visit_hours as
select v.id as visit_id, v.job_id,
       case when v.start_at is not null and v.end_at is not null
             and v.end_at > v.start_at
             and v.end_at - v.start_at <= interval '12 hours'
            then extract(epoch from (v.end_at - v.start_at)) / 3600.0 end as hours,
       v.start_at
from public.visits v;
revoke all on app.visit_hours from public, anon, authenticated;

-- Even split among everyone assigned to the job's visits.
drop function if exists public.team_scorecards(date, date);
drop function if exists public.my_scorecard(date, date);
drop function if exists app.scorecard_for(uuid, date, date);
drop function if exists public.my_jobs(date, date);
drop view if exists app.job_credit;

create view app.job_credit as
with assigned as (
  select distinct v.job_id, va.employee_id
  from public.visits v join public.visit_assignments va on va.visit_id = v.id
)
select a.job_id, a.employee_id, 1.0 / count(*) over (partition by a.job_id) as share
from assigned a;
revoke all on app.job_credit from public, anon, authenticated;

-- ---------------------------------------------------------------------
create function app.scorecard_for(p_employee uuid, p_from date, p_to date)
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
    select count(*) filter (where q.sent_at >= win.a and q.sent_at < win.b) as sent,
           count(*) filter (where q.approved_at >= win.a and q.approved_at < win.b) as approved,
           count(*) filter (where q.approved_at >= win.a and q.approved_at < win.b and exists (
             select 1 from public.quote_line_items qli
             join public.plan_products pp on pp.product_name = qli.product_name
             where qli.quote_id = q.id)) as plans
    from public.quotes q, win where q.salesperson_id = p_employee),
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
revoke all on function app.scorecard_for(uuid, date, date) from public, anon, authenticated;

create function public.my_scorecard(p_from date, p_to date)
returns table (completed_jobs int, revenue_credited numeric, hours numeric, hours_source text,
               unestimated_visits int, revenue_per_hour numeric, work_days int, revenue_per_day numeric,
               upsell_revenue numeric, plans_sold int, quotes_sent int, quotes_approved int, callbacks int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.my_employee_id() is null then raise exception 'not authorised'; end if;
  return query select * from app.scorecard_for(app.my_employee_id(), p_from, p_to);
end $$;

create function public.team_scorecards(p_from date, p_to date)
returns table (employee_id uuid, full_name text, completed_jobs int, revenue_credited numeric,
               hours numeric, hours_source text, unestimated_visits int, revenue_per_hour numeric,
               work_days int, revenue_per_day numeric, upsell_revenue numeric, plans_sold int,
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

-- My jobs: my share is the even split; hours are what I clocked on that job,
-- or my scheduled visit time if I don't clock in.
create function public.my_jobs(p_from date, p_to date)
returns table (job_id text, completed_at timestamptz, client_name text, job_title text,
               my_revenue numeric, my_hours numeric, hours_source text, crew_size int)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := app.my_employee_id(); clocks boolean;
begin
  if me is null then raise exception 'not authorised'; end if;
  select coalesce(tracks_time, true) into clocks from public.employees where id = me;
  return query
    select r.job_id, r.completed_at, cl.name, j.title,
           round(r.revenue * c.share, 2),
           round(case when clocks
                   then (select sum(t.minutes) / 60.0 from public.timesheet_entries t
                         where t.job_id = r.job_id and t.employee_id = me)
                   else (select sum(vh.hours) from app.visit_hours vh
                         join public.visit_assignments va on va.visit_id = vh.visit_id and va.employee_id = me
                         where vh.job_id = r.job_id) end, 1),
           case when clocks then 'clocked' else 'scheduled' end,
           round(1 / c.share)::int
    from app.job_revenue r
    join app.job_credit c on c.job_id = r.job_id and c.employee_id = me
    join public.jobs j on j.id = r.job_id
    left join public.clients cl on cl.id = r.client_id
    where r.completed_at >= app.day_start(p_from) and r.completed_at < app.day_start(p_to + 1)
    order by r.completed_at desc;
end $$;

revoke all on function public.my_scorecard(date,date), public.team_scorecards(date,date),
  public.my_jobs(date,date) from public, anon;
grant execute on function public.my_scorecard(date,date), public.team_scorecards(date,date),
  public.my_jobs(date,date) to authenticated;
