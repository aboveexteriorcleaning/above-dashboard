-- Plan and upsell earnings per person.
--   Upsell earnings: commission on on-site upsell lines, at the same crew-size
--   rate as the rest of the job (solo 20%, two-person 15%, three+ 10%), each
--   person on the job at the full rate. Commission is only paid on days it beats
--   hourly, so upsells only add to pay on those days; both figures are returned.
--   Plan lines are left out here: plans pay their own bonus.
--   Plan earnings: a flat bonus per plan sold (business setting, $10), paid in
--   full to everyone credited with the sale, not split.

alter table public.business_settings
  add column if not exists plan_bonus numeric(8,2) not null default 10 check (plan_bonus between 0 and 1000);

create or replace function app.earnings_for(p_employee uuid, p_from date, p_to date)
returns table (upsell_value numeric, upsell_commission numeric, upsell_commission_all_days numeric,
               plans_sold numeric, plan_bonus_each numeric, plan_earnings numeric)
language sql stable security definer set search_path = '' as $$
  with ups as (
    select pjd.day, li.total_price * app.commission_rate(jc.crew, pjd.day) as c, li.total_price as v
    from app.person_job_days pjd
    join app.job_revenue r on r.job_id = pjd.job_id                -- completed, not callbacks
    join app.job_crew jc on jc.job_id = pjd.job_id
    join public.job_line_items li on li.job_id = pjd.job_id and li.is_onsite_upsell and li.total_price > 0
    where pjd.employee_id = p_employee and pjd.day between p_from and p_to
      and not exists (select 1 from public.plan_products pp where pp.product_name = li.product_name)),
  cd as (select day from app.commission_days(p_employee, p_from, p_to) where commission_day),
  st as (select plan_bonus from public.business_settings limit 1),
  ps as (select plans_sold from app.plan_sales_for(p_employee, p_from, p_to))
  select round(coalesce((select sum(v) from ups), 0), 2),
         round(coalesce((select sum(c) from ups where day in (select day from cd)), 0), 2),
         round(coalesce((select sum(c) from ups), 0), 2),
         ps.plans_sold, st.plan_bonus, round(ps.plans_sold * st.plan_bonus, 2)
  from ps, st
$$;
revoke all on function app.earnings_for(uuid, date, date) from public, anon, authenticated;

-- The signed-in person's own (or, for owners, the team member they're viewing).
create or replace function public.my_earnings(p_from date, p_to date)
returns table (upsell_value numeric, upsell_commission numeric, upsell_commission_all_days numeric,
               plans_sold numeric, plan_bonus_each numeric, plan_earnings numeric)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := app.my_employee_id();
begin
  if me is null then raise exception 'not authorised'; end if;
  return query select * from app.earnings_for(me, p_from, p_to);
end $$;
revoke all on function public.my_earnings(date, date) from public, anon;
grant execute on function public.my_earnings(date, date) to authenticated;

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
