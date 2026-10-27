-- Upsell conversion per person: of the completed jobs they worked, how many had a
-- paid service added on site. Shared jobs count for everyone on them (same as
-- the Upsells number). Quote add-ons aren't included: those are sold by the
-- quote's salesperson before the job. Once crews fill in the Jobber "Upsell
-- offer" field, offered / accepted counts show alongside.
create or replace function app.upsell_rate_for(p_employee uuid, p_from date, p_to date)
returns table (jobs int, upsold_jobs int, rate numeric, offered int, accepted int)
language sql stable security definer set search_path = '' as $$
  with mine as (
    select distinct r.job_id
    from app.job_revenue r
    join app.job_credit c on c.job_id = r.job_id and c.employee_id = p_employee
    where r.completed_at >= app.day_start(p_from) and r.completed_at < app.day_start(p_to + 1)),
  flags as (
    select m.job_id,
           exists (select 1 from public.job_line_items li
                   where li.job_id = m.job_id and li.is_onsite_upsell and li.total_price > 0) as upsold,
           j.upsell_offer
    from mine m join public.jobs j on j.id = m.job_id)
  select count(*)::int, (count(*) filter (where upsold))::int,
         round((count(*) filter (where upsold))::numeric / nullif(count(*), 0), 3),
         (count(*) filter (where upsell_offer in ('accepted', 'declined')))::int,
         (count(*) filter (where upsell_offer = 'accepted'))::int
  from flags
$$;
revoke all on function app.upsell_rate_for(uuid, date, date) from public, anon, authenticated;

-- The signed-in person's own rate (or, for owners, the team member they're viewing).
create or replace function public.my_upsell_rate(p_from date, p_to date)
returns table (jobs int, upsold_jobs int, rate numeric, offered int, accepted int)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := app.my_employee_id();
begin
  if me is null then raise exception 'not authorised'; end if;
  return query select * from app.upsell_rate_for(me, p_from, p_to);
end $$;

-- Owners: everyone's rate for the Team table.
create or replace function public.team_upsell_rates(p_from date, p_to date)
returns table (employee_id uuid, jobs int, upsold_jobs int, rate numeric, offered int, accepted int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  return query select e.id, u.* from public.employees e
               cross join lateral app.upsell_rate_for(e.id, p_from, p_to) u where e.active;
end $$;

revoke all on function public.my_upsell_rate(date, date), public.team_upsell_rates(date, date) from public, anon;
grant execute on function public.my_upsell_rate(date, date), public.team_upsell_rates(date, date) to authenticated;

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
