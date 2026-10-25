-- The crew clock in for the DAY, not per job, so timesheets can't be attributed to
-- individual jobs. Per-job hours on "Your jobs" therefore always show the person's
-- scheduled visit time on that job (an estimate). Scorecard totals are unchanged:
-- people who clock in still use ALL their clocked time in the period.
create or replace function public.my_jobs(p_from date, p_to date)
returns table (job_id text, completed_at timestamptz, client_name text, job_title text,
               my_revenue numeric, my_hours numeric, hours_source text, crew_size int)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := app.my_employee_id();
begin
  if me is null then raise exception 'not authorised'; end if;
  return query
    select r.job_id, r.completed_at, cl.name, j.title,
           round(r.revenue * c.share, 2),
           round((select sum(vh.hours) from app.visit_hours vh
                  join public.visit_assignments va on va.visit_id = vh.visit_id and va.employee_id = me
                  where vh.job_id = r.job_id), 1),
           'scheduled'::text,
           round(1 / c.share)::int
    from app.job_revenue r
    join app.job_credit c on c.job_id = r.job_id and c.employee_id = me
    join public.jobs j on j.id = r.job_id
    left join public.clients cl on cl.id = r.client_id
    where r.completed_at >= app.day_start(p_from) and r.completed_at < app.day_start(p_to + 1)
    order by r.completed_at desc;
end $$;
