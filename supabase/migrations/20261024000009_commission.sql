-- =====================================================================
-- Commission vs hourly (owners' pay rule, Oct 24 2026)
--   Each person, each day (Pacific), is paid the HIGHER of:
--     * commission: for every job they worked that day, job value x rate for
--       that job's crew size (solo 20%, two 15%, three or more 10%), where job
--       value is the job's full pre-tax value (not their share of it), or
--     * hourly: hours clocked that day x their base wage.
--   A job counts on the day of its scheduled visit (not the day it was marked
--   complete). Only completed jobs count toward the period; "today" shows
--   everything scheduled today.
--   These are estimates to help the team, not payroll.
-- =====================================================================

create table public.commission_rates (
  effective_from date    not null,
  min_crew       int     not null check (min_crew >= 1),
  rate           numeric(5,4) not null check (rate >= 0 and rate <= 1),
  primary key (effective_from, min_crew)
);
insert into public.commission_rates values
  ('2020-01-01', 1, 0.20), ('2020-01-01', 2, 0.15), ('2020-01-01', 3, 0.10);

create table public.employee_wages (
  employee_id    uuid not null references public.employees(id) on delete cascade,
  effective_from date not null,
  hourly_wage    numeric(8,2) not null check (hourly_wage >= 0),
  primary key (employee_id, effective_from)
);

-- Owners only, like every other table; crew reach their own numbers through functions.
alter table public.commission_rates enable row level security;
alter table public.employee_wages   enable row level security;
revoke all on public.commission_rates, public.employee_wages from anon, authenticated;
grant select, insert, update on public.commission_rates, public.employee_wages to authenticated;
create policy owners_read  on public.commission_rates for select to authenticated using (app.is_owner());
create policy owners_write on public.commission_rates for insert to authenticated with check (app.is_owner());
create policy owners_edit  on public.commission_rates for update to authenticated using (app.is_owner()) with check (app.is_owner());
create policy owners_read  on public.employee_wages for select to authenticated using (app.is_owner());
create policy owners_write on public.employee_wages for insert to authenticated with check (app.is_owner());
create policy owners_edit  on public.employee_wages for update to authenticated using (app.is_owner()) with check (app.is_owner());

-- Rate for a crew size on a date: the latest rate set in effect, highest tier that applies.
create function app.commission_rate(p_crew int, p_day date) returns numeric
language sql stable security definer set search_path = '' as $$
  select cr.rate from public.commission_rates cr
  where cr.min_crew <= greatest(p_crew, 1)
    and cr.effective_from = (select max(effective_from) from public.commission_rates where effective_from <= p_day)
  order by cr.min_crew desc limit 1
$$;

create function app.wage_on(p_employee uuid, p_day date) returns numeric
language sql stable security definer set search_path = '' as $$
  select w.hourly_wage from public.employee_wages w
  where w.employee_id = p_employee and w.effective_from <= p_day
  order by w.effective_from desc limit 1
$$;

-- One person's jobs with the day they were worked and the crew size.
create view app.person_job_days as
select va.employee_id, v.job_id,
       min((v.start_at at time zone 'America/Los_Angeles')::date) as day
from public.visits v
join public.visit_assignments va on va.visit_id = v.id
where v.start_at is not null
group by va.employee_id, v.job_id;

create view app.job_crew as
select job_id, count(*)::int as crew from app.job_credit group by job_id;

-- ---------------------------------------------------------------------
-- Day-by-day commission vs hourly for one person.
-- ---------------------------------------------------------------------
create function app.commission_days(p_employee uuid, p_from date, p_to date)
returns table (day date, jobs int, job_value numeric, commission numeric, hours numeric,
               wage numeric, hourly_pay numeric, break_even_hours numeric, commission_day boolean)
language sql stable security definer set search_path = '' as $$
  with jd as (
    select pjd.day, count(*)::int as jobs, sum(r.revenue) as v,
           sum(r.revenue * app.commission_rate(jc.crew, pjd.day)) as c
    from app.person_job_days pjd
    join app.job_revenue r on r.job_id = pjd.job_id          -- completed, not callbacks
    join app.job_crew jc on jc.job_id = pjd.job_id
    where pjd.employee_id = p_employee and pjd.day between p_from and p_to
    group by pjd.day),
  hd as (
    select (t.started_at at time zone 'America/Los_Angeles')::date as day, sum(t.minutes) / 60.0 as h
    from public.timesheet_entries t
    where t.employee_id = p_employee
      and t.started_at >= app.day_start(p_from) and t.started_at < app.day_start(p_to + 1)
    group by 1),
  days as (
    select coalesce(jd.day, hd.day) as day, coalesce(jd.jobs, 0) as jobs, coalesce(jd.v, 0) as v,
           coalesce(jd.c, 0) as c, coalesce(hd.h, 0) as h
    from jd full join hd on hd.day = jd.day)
  select d.day, d.jobs, round(d.v, 2), round(d.c, 2), round(d.h, 2),
         app.wage_on(p_employee, d.day),
         round(d.h * app.wage_on(p_employee, d.day), 2),
         round(d.c / nullif(app.wage_on(p_employee, d.day), 0), 2),
         (app.wage_on(p_employee, d.day) is not null and d.c > 0 and d.c >= d.h * app.wage_on(p_employee, d.day))
  from days d
  order by d.day desc
$$;

create function app.commission_summary(p_employee uuid, p_from date, p_to date)
returns table (commission_earned numeric, commission_days int, work_days int, commission_if_all numeric,
               missing_wage boolean)
language sql stable security definer set search_path = '' as $$
  select round(coalesce(sum(commission) filter (where commission_day), 0), 2),
         count(*) filter (where commission_day)::int,
         count(*) filter (where hours > 0 or jobs > 0)::int,
         round(coalesce(sum(commission), 0), 2),
         bool_or(wage is null)
  from app.commission_days(p_employee, p_from, p_to)
$$;

revoke all on function app.commission_rate(int, date), app.wage_on(uuid, date),
  app.commission_days(uuid, date, date), app.commission_summary(uuid, date, date) from public, anon, authenticated;
revoke all on app.person_job_days, app.job_crew from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- What the app can call
-- ---------------------------------------------------------------------
create function public.my_commission_days(p_from date, p_to date)
returns table (day date, jobs int, job_value numeric, commission numeric, hours numeric,
               wage numeric, hourly_pay numeric, break_even_hours numeric, commission_day boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.my_employee_id() is null then raise exception 'not authorised'; end if;
  return query select * from app.commission_days(app.my_employee_id(), p_from, p_to);
end $$;

create function public.my_commission_summary(p_from date, p_to date)
returns table (commission_earned numeric, commission_days int, work_days int, commission_if_all numeric,
               missing_wage boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.my_employee_id() is null then raise exception 'not authorised'; end if;
  return query select * from app.commission_summary(app.my_employee_id(), p_from, p_to);
end $$;

-- Today, live: everything scheduled for me today, the commission it would pay,
-- and how many hours I can work and still come out ahead on commission.
create function public.my_today()
returns table (jobs int, job_value numeric, commission numeric, wage numeric,
               break_even_hours numeric, hours_so_far numeric)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := app.my_employee_id();
        today date := (now() at time zone 'America/Los_Angeles')::date;
begin
  if me is null then raise exception 'not authorised'; end if;
  return query
  with tj as (
    select pjd.job_id, j.total as v, jc.crew
    from app.person_job_days pjd
    join public.jobs j on j.id = pjd.job_id
    join app.job_crew jc on jc.job_id = pjd.job_id
    where pjd.employee_id = me and pjd.day = today
      and not j.is_callback and coalesce(j.status, '') <> 'deleted'),
  t as (select count(*)::int n, coalesce(sum(v), 0) v,
               coalesce(sum(v * app.commission_rate(crew, today)), 0) c from tj)
  select t.n, round(t.v, 2), round(t.c, 2), app.wage_on(me, today),
         round(t.c / nullif(app.wage_on(me, today), 0), 2),
         round(coalesce((select sum(te.minutes) / 60.0 from public.timesheet_entries te
                         where te.employee_id = me and te.started_at >= app.day_start(today)), 0), 2)
  from t;
end $$;

-- Owners: commission summary for everyone who clocks in.
create function public.team_commission(p_from date, p_to date)
returns table (employee_id uuid, full_name text, commission_earned numeric, commission_days int,
               work_days int, missing_wage boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  return query
    select e.id, e.full_name, s.commission_earned, s.commission_days, s.work_days, s.missing_wage
    from public.employees e
    cross join lateral app.commission_summary(e.id, p_from, p_to) s
    where e.active and e.tracks_time;
end $$;

revoke all on function public.my_commission_days(date,date), public.my_commission_summary(date,date),
  public.my_today(), public.team_commission(date,date) from public, anon;
grant execute on function public.my_commission_days(date,date), public.my_commission_summary(date,date),
  public.my_today(), public.team_commission(date,date) to authenticated;
