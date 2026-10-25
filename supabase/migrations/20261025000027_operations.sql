-- Operations: crew economics (labor-only margins) and quality.
-- Labor cost = what each crew member is paid per day (the higher of commission
-- or hours x wage) plus any payroll burden (hourly cost above wage). Owners
-- aren't paid hourly, so their time isn't costed. Materials aren't included yet.

create or replace function app.crew_pay_days(p_from date, p_to date)
returns table (employee_id uuid, day date, hours numeric, pay numeric, labor_cost numeric)
language sql stable security definer set search_path = '' as $$
  select e.id, d.day, d.hours,
         case when d.wage is not null then greatest(d.commission, d.hourly_pay) end,
         case when d.wage is not null then greatest(d.commission, d.hourly_pay)
              + greatest(coalesce((select c.hourly_cost from public.employee_costs c
                                    where c.employee_id = e.id and c.effective_from <= d.day
                                    order by c.effective_from desc limit 1), d.wage) - d.wage, 0) * d.hours end
  from public.employees e
  cross join lateral app.commission_days(e.id, p_from, p_to) d
  where e.tracks_time
$$;
revoke all on function app.crew_pay_days(date, date) from public, anon, authenticated;

-- Each completed job in the period with its share of crew labor cost
-- (a person's day is split across that day's jobs by job value).
create or replace function app.job_economics(p_from date, p_to date)
returns table (job_id text, completed_at timestamptz, revenue numeric, labor_cost numeric,
               scheduled_person_hours numeric, crew int, crew_key text, work_day date)
language sql stable security definer set search_path = '' as $$
  with pay as (select * from app.crew_pay_days(p_from, p_to)),
  jd as (
    select pjd.employee_id, pjd.day, pjd.job_id, r.revenue
    from app.person_job_days pjd join app.job_revenue r on r.job_id = pjd.job_id
    where pjd.day between p_from and p_to),
  dt as (select employee_id, day, sum(revenue) tot, count(*) n from jd group by 1, 2),
  labor as (
    select jd.job_id,
           sum(p.labor_cost * case when dt.tot > 0 then jd.revenue / dt.tot else 1.0 / dt.n end) as labor
    from jd join dt using (employee_id, day)
    join pay p on p.employee_id = jd.employee_id and p.day = jd.day
    group by jd.job_id),
  crew as (
    select job_id, count(*)::int crew, string_agg(employee_id::text, ',' order by employee_id) crew_key, min(day) as day
    from app.person_job_days group by job_id),
  sched as (select job_id, sum(hours) h from app.visit_hours group by job_id)
  select r.job_id, r.completed_at, r.revenue, coalesce(l.labor, 0),
         s.h * coalesce(c.crew, 1), coalesce(c.crew, 0), c.crew_key,
         coalesce(c.day, (r.completed_at at time zone 'America/Los_Angeles')::date)
  from app.job_revenue r
  left join labor l on l.job_id = r.job_id
  left join crew c on c.job_id = r.job_id
  left join sched s on s.job_id = r.job_id
  where r.completed_at >= app.day_start(p_from) and r.completed_at < app.day_start(p_to + 1)
$$;
revoke all on function app.job_economics(date, date) from public, anon, authenticated;

-- Service category from a line item name.
create or replace function app.service_category(p_name text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_name ~* 'plan' then 'Plan discount'
    when p_name ~* 'christmas|holiday|light' then 'Christmas lights'
    when p_name ~* 'window|screen' then 'Windows'
    when p_name ~* 'gutter' then 'Gutters'
    when p_name ~* 'roof|moss' then 'Roof'
    when p_name ~* 'siding|house wash|soft ?wash' then 'House wash'
    when p_name ~* 'concrete|pressure|driveway|patio|deck|fence|sidewalk|paver' then 'Pressure washing'
    when p_name ~* 'solar' then 'Solar panels'
    else 'Other' end
$$;

create or replace function public.owner_crews(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with je as materialized (select * from app.job_economics(p_from, p_to)),
  pay as materialized (select * from app.crew_pay_days(p_from, p_to)),
  team as (select s.hours, s.hours_source from public.employees e
           cross join lateral app.scorecard_for(e.id, p_from, p_to) s where e.active),
  -- scheduled vs clocked, per crew member per day
  sched_day as (
    select va.employee_id, (v.start_at at time zone 'America/Los_Angeles')::date as day, sum(vh.hours) as h
    from public.visits v join public.visit_assignments va on va.visit_id = v.id
    join app.visit_hours vh on vh.visit_id = v.id
    join public.employees e on e.id = va.employee_id and e.tracks_time
    where v.start_at >= app.day_start(p_from) and v.start_at < app.day_start(p_to + 1)
    group by 1, 2),
  sv as (select coalesce(p.employee_id, s.employee_id) employee_id, coalesce(p.day, s.day) as day,
                coalesce(s.h, 0) as scheduled, coalesce(p.hours, 0) as clocked
         from pay p full join sched_day s on s.employee_id = p.employee_id and s.day = p.day),
  weeks as (
    select t.employee_id, date_trunc('week', t.started_at at time zone 'America/Los_Angeles') wk, sum(t.minutes) / 60.0 h
    from public.timesheet_entries t join public.employees e on e.id = t.employee_id and e.tracks_time
    where t.started_at >= app.day_start(p_from) and t.started_at < app.day_start(p_to + 1)
    group by 1, 2),
  lines as (
    select app.service_category(li.product_name) cat, je.job_id, li.total_price,
           je.labor_cost * li.total_price / nullif(je.revenue, 0) labor
    from je join public.job_line_items li on li.job_id = je.job_id),
  tiers as (
    select case when revenue < 300 then 1 when revenue < 600 then 2 when revenue < 1000 then 3 when revenue < 2000 then 4 else 5 end t, je.*
    from je)
  select jsonb_build_object(
    'revenue', (select round(coalesce(sum(revenue), 0), 2) from je),
    'jobs', (select count(*) from je),
    'field_hours', (select round(coalesce(sum(hours), 0), 1) from team),
    'labor_cost', (select round(coalesce(sum(labor_cost), 0), 2) from pay),
    'labor_unpriced_days', (select count(*) from pay where labor_cost is null),
    'crew_days', (select count(distinct (work_day, crew_key)) from je where crew_key is not null),
    'work_days', (select count(distinct work_day) from je),
    'scheduled_hours', (select round(coalesce(sum(scheduled), 0), 1) from sv),
    'clocked_hours', (select round(coalesce(sum(clocked), 0), 1) from sv),
    'over_days', coalesce((select jsonb_agg(x order by x.day desc) from (
        select sv.day, e.full_name as name, round(sv.scheduled, 1) scheduled, round(sv.clocked, 1) clocked
        from sv join public.employees e on e.id = sv.employee_id
        where sv.scheduled > 0 and sv.clocked > sv.scheduled + 1
        order by sv.day desc limit 15) x), '[]'::jsonb),
    'overtime_hours', (select round(coalesce(sum(greatest(h - 40, 0)), 0), 1) from weeks),
    'paid_hours', (select round(coalesce(sum(h), 0), 1) from weeks),
    'by_service', coalesce((select jsonb_agg(x order by x.revenue desc) from (
        select cat as service, count(distinct job_id) jobs, round(sum(total_price), 2) revenue, round(coalesce(sum(labor), 0), 2) labor
        from lines group by cat having sum(total_price) <> 0) x), '[]'::jsonb),
    'by_size', coalesce((select jsonb_agg(x order by x.t) from (
        select t, count(*) jobs, round(sum(revenue), 2) revenue, round(sum(labor_cost), 2) labor,
               round(sum(revenue) / nullif(sum(scheduled_person_hours), 0), 2) revenue_per_hour
        from tiers group by t) x), '[]'::jsonb)
  ) into result;
  return result;
end $$;

-- Quality: callbacks, who they trace back to, and what they cost.
create or replace function public.owner_quality(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a timestamptz := app.day_start(p_from);
  b timestamptz := app.day_start(p_to + 1);
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with cb as (
    select j.id, j.job_number, j.title, j.created_at, j.callback_of_job_id, cl.name client_name,
           (select sum(h.hours) from app.visit_hours h where h.job_id = j.id)
             * greatest((select count(distinct va.employee_id) from public.visits v
                         join public.visit_assignments va on va.visit_id = v.id where v.job_id = j.id), 1) as rework_hours
    from public.jobs j left join public.clients cl on cl.id = j.client_id
    where j.is_callback and coalesce(j.status, '') <> 'deleted' and j.created_at >= a and j.created_at < b),
  done as (select count(*) n from app.job_revenue where completed_at >= a and completed_at < b),
  avg_cost as (
    select avg(coalesce(c.hourly_cost, w.hourly_wage)) v
    from public.employees e
    left join lateral (select hourly_cost from public.employee_costs c where c.employee_id = e.id order by effective_from desc limit 1) c on true
    left join lateral (select hourly_wage from public.employee_wages w where w.employee_id = e.id order by effective_from desc limit 1) w on true
    where e.active and e.tracks_time),
  -- per person: jobs they did that were completed in the period, and callbacks on those jobs
  person as (
    select pjd.employee_id, count(distinct r.job_id) jobs,
           count(distinct c.id) callbacks
    from app.person_job_days pjd
    join app.job_revenue r on r.job_id = pjd.job_id and r.completed_at >= a and r.completed_at < b
    left join public.jobs c on c.callback_of_job_id = r.job_id and c.is_callback and coalesce(c.status, '') <> 'deleted'
    group by pjd.employee_id)
  select jsonb_build_object(
    'callbacks', (select count(*) from cb),
    'completed_jobs', (select n from done),
    'rework_hours', (select round(coalesce(sum(rework_hours), 0), 1) from cb),
    'callback_cost', (select round(coalesce(sum(rework_hours), 0) * coalesce((select v from avg_cost), 0), 2) from cb),
    'unlinked', (select count(*) from cb where callback_of_job_id is null),
    'list', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select cb.id, cb.job_number, cb.client_name, cb.created_at, o.job_number original_job_number,
               (select string_agg(distinct e.full_name, ' & ') from public.visits v
                 join public.visit_assignments va on va.visit_id = v.id join public.employees e on e.id = va.employee_id
                 where v.job_id = cb.callback_of_job_id) as original_crew,
               round(cb.rework_hours, 1) rework_hours
        from cb left join public.jobs o on o.id = cb.callback_of_job_id) x), '[]'::jsonb),
    'by_person', coalesce((select jsonb_agg(x order by x.jobs desc) from (
        select e.full_name as name, p.jobs, p.callbacks, round(p.callbacks::numeric / nullif(p.jobs, 0), 3) rate
        from person p join public.employees e on e.id = p.employee_id where e.active) x), '[]'::jsonb)
  ) into result;
  return result;
end $$;

revoke all on function public.owner_crews(date, date), public.owner_quality(date, date) from public, anon;
grant execute on function public.owner_crews(date, date), public.owner_quality(date, date) to authenticated;

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
