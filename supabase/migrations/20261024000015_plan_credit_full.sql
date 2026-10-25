-- Plan sales: everyone on the visit gets full credit (1 plan and its full
-- yearly value each), instead of splitting it between the crew.
create or replace view app.plan_sale_credit as
select s.home_key, s.service_line, s.channel, s.sold_at, s.annual_value, e.employee_id,
       1.0::numeric as share
from app.plan_sales s
join lateral (
  select va.employee_id from public.visits v join public.visit_assignments va on va.visit_id = v.id
  where s.channel = 'on_site' and v.job_id = s.sale_job_id
  union
  select s.salesperson_id where s.channel = 'pre_job' and s.salesperson_id is not null) e on true;
revoke all on app.plan_sale_credit from public, anon, authenticated;
