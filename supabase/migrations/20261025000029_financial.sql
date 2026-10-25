-- Financial: owner settings, capacity and utilization, DSO, cancellations,
-- booking lead time, forecast tracking, and the Overview's alerts.

-- One row of owner-editable settings.
create table if not exists public.business_settings (
  id                  boolean primary key default true check (id),
  crew_hours_per_day  numeric(4,1) not null default 8 check (crew_hours_per_day between 1 and 16),
  work_days_per_week  int not null default 6 check (work_days_per_week between 1 and 7),
  trucks              int not null default 2 check (trucks between 1 and 50),
  updated_at          timestamptz not null default now()
);
insert into public.business_settings (id) values (true) on conflict do nothing;
alter table public.business_settings enable row level security;
revoke all on public.business_settings from anon, authenticated;
grant select, update on public.business_settings to authenticated;
create policy owners_read on public.business_settings for select to authenticated using (app.is_owner());
create policy owners_update on public.business_settings for update to authenticated using (app.is_owner()) with check (app.is_owner());

-- Daily snapshot of work booked for the next 30 days, to measure forecast accuracy later.
create table if not exists public.forecast_snapshots (
  day          date primary key,
  booked_30    numeric(12,2) not null,
  jobs_30      int not null,
  taken_at     timestamptz not null default now()
);
alter table public.forecast_snapshots enable row level security;
revoke all on public.forecast_snapshots from anon, authenticated;
grant select on public.forecast_snapshots to authenticated;
create policy owners_read on public.forecast_snapshots for select to authenticated using (app.is_owner());

create or replace function app.take_forecast_snapshot() returns void
language sql security definer set search_path = '' as $$
  insert into public.forecast_snapshots (day, booked_30, jobs_30)
  select (now() at time zone 'America/Los_Angeles')::date, coalesce(sum(j.total), 0), count(*)
  from public.jobs j
  where j.completed_at is null and coalesce(j.status, '') not in ('deleted', 'archived') and not j.is_callback
    and j.start_at >= now() and j.start_at < now() + interval '30 days'
  on conflict (day) do update set booked_30 = excluded.booked_30, jobs_30 = excluded.jobs_30, taken_at = now()
$$;
revoke all on function app.take_forecast_snapshot() from public, anon, authenticated;
select app.take_forecast_snapshot();

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('forecast-snapshot', '5 8 * * *', $c$ select app.take_forecast_snapshot() $c$);  -- ~1am Pacific
  end if;
end $$;

-- Working days (per the settings) between two dates, inclusive.
create or replace function app.work_days(p_from date, p_to date, p_per_week int) returns numeric
language sql immutable set search_path = '' as $$
  select round(((p_to - p_from + 1)::numeric) * p_per_week / 7.0, 1)
$$;

create or replace function public.owner_financial(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a timestamptz := app.day_start(p_from);
  b timestamptz := app.day_start(p_to + 1);
  today date := (now() at time zone 'America/Los_Angeles')::date;
  st public.business_settings;
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  select * into st from public.business_settings limit 1;
  with done as (select * from app.job_revenue where completed_at >= a and completed_at < b),
  pay as (select * from app.crew_pay_days(p_from, p_to)),
  inv as (select * from public.invoices where issued_at >= a and issued_at < b and coalesce(status, '') not in ('draft', 'voided', 'deleted')),
  booked as (select * from public.jobs where created_at >= a and created_at < b and not is_callback),
  first_visit as (select v.job_id, min(v.start_at) s from public.visits v group by v.job_id),
  sched_past as (   -- visit hours (truck time) of visits in the period
    select coalesce(sum(vh.hours), 0) h from app.visit_hours vh where vh.start_at >= a and vh.start_at < b),
  sched_next as (
    select coalesce(sum(vh.hours) filter (where vh.start_at < now() + interval '7 days'), 0) h7,
           coalesce(sum(vh.hours) filter (where vh.start_at < now() + interval '14 days'), 0) h14
    from app.visit_hours vh join public.visits v on v.id = vh.visit_id
    where vh.start_at >= now() and v.completed_at is null),
  econ as (select je.*, p.postal_code zip from app.job_economics(p_from, p_to) je
           join public.jobs j on j.id = je.job_id left join public.properties p on p.id = j.property_id),
  snaps as (   -- forecasts from 30+ days ago whose 30-day window has finished
    select s.day, s.booked_30,
           (select coalesce(sum(r.revenue), 0) from app.job_revenue r
             where r.completed_at >= app.day_start(s.day) and r.completed_at < app.day_start(s.day + 30)) actual
    from public.forecast_snapshots s where s.day <= today - 30 order by s.day desc limit 6)
  select jsonb_build_object(
    'settings', jsonb_build_object('crew_hours_per_day', st.crew_hours_per_day, 'work_days_per_week', st.work_days_per_week, 'trucks', st.trucks),
    'revenue', (select round(coalesce(sum(revenue), 0), 2) from done),
    'invoiced', (select round(coalesce(sum(subtotal), 0), 2) from inv),
    'collected', (select round(coalesce(sum(total - coalesce(balance, 0)), 0), 2) from inv),
    'labor_cost', (select round(coalesce(sum(labor_cost), 0), 2) from pay),
    'headcount', (select count(*) from public.employees where active),
    'field_headcount', (select count(distinct va.employee_id) from public.visits v join public.visit_assignments va on va.visit_id = v.id
                        where v.start_at >= a and v.start_at < b),
    'open_ar', (select round(coalesce(sum(balance), 0), 2) from public.invoices where balance > 0 and coalesce(status, '') not in ('draft', 'voided', 'deleted', 'bad_debt')),
    'invoiced_90d', (select round(coalesce(sum(total), 0), 2) from public.invoices where issued_at >= now() - interval '90 days' and coalesce(status, '') not in ('draft', 'voided', 'deleted')),
    'available_hours', round(app.work_days(p_from, least(p_to, today), st.work_days_per_week) * st.crew_hours_per_day * st.trucks, 1),
    'scheduled_hours', (select round(h, 1) from sched_past),
    'next7_available', round(7 * st.work_days_per_week / 7.0 * st.crew_hours_per_day * st.trucks, 1),
    'next7_booked', (select round(h7, 1) from sched_next),
    'next14_available', round(14 * st.work_days_per_week / 7.0 * st.crew_hours_per_day * st.trucks, 1),
    'next14_booked', (select round(h14, 1) from sched_next),
    'booked_jobs', (select count(*) from booked),
    'cancelled_jobs', (select count(*) from booked where completed_at is null and (status = 'deleted' or status = 'archived')),
    'cancelled_value', (select round(coalesce(sum(total), 0), 2) from booked where completed_at is null and (status = 'deleted' or status = 'archived')),
    'booking_lead_days', (select round((percentile_cont(0.5) within group (order by extract(epoch from (fv.s - bk.created_at)) / 86400.0))::numeric, 1)
                          from booked bk join first_visit fv on fv.job_id = bk.id where fv.s >= bk.created_at),
    'by_zip', coalesce((select jsonb_agg(x order by x.revenue desc) from (
        select coalesce(zip, 'Unknown') zip, count(*) jobs, round(sum(revenue), 2) revenue, round(sum(revenue - labor_cost), 2) gross_after_labor
        from econ group by 1 order by 3 desc limit 15) x), '[]'::jsonb),
    'forecast', coalesce((select jsonb_agg(x order by x.day desc) from (select day, booked_30, round(actual, 2) actual from snaps) x), '[]'::jsonb),
    'snapshots', (select count(*) from public.forecast_snapshots)
  ) into result;
  return result;
end $$;

-- Owner alerts for the Overview: things that need attention now.
create or replace function public.owner_alerts()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  st public.business_settings;
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  select * into st from public.business_settings limit 1;
  with recent_cb as (
    select count(*) filter (where created_at >= now() - interval '30 days')::numeric cb30,
           count(*) filter (where created_at >= now() - interval '120 days' and created_at < now() - interval '30 days')::numeric cb90
    from public.jobs where is_callback and coalesce(status, '') <> 'deleted'),
  recent_done as (
    select count(*) filter (where completed_at >= now() - interval '30 days')::numeric d30,
           count(*) filter (where completed_at >= now() - interval '120 days' and completed_at < now() - interval '30 days')::numeric d90
    from app.job_revenue),
  approvals as (
    select count(*) filter (where coalesce(sent_at, approved_at) >= now() - interval '30 days')::numeric s30,
           count(*) filter (where approved_at >= now() - interval '30 days')::numeric a30,
           count(*) filter (where coalesce(sent_at, approved_at) >= now() - interval '120 days' and coalesce(sent_at, approved_at) < now() - interval '30 days')::numeric s90,
           count(*) filter (where approved_at >= now() - interval '120 days' and approved_at < now() - interval '30 days')::numeric a90
    from public.quotes where coalesce(status, '') not in ('deleted', 'draft')),
  big_quotes as (
    select q.id from app.quote_values q left join public.clients c on c.id = q.client_id
    where q.status in ('awaiting_response', 'changes_requested') and q.value >= 1000
      and q.sent_at < now() - interval '3 days' and q.sent_at > now() - interval '60 days'
      and not exists (select 1 from public.communications m where m.contact_phone = c.phone and app.is_human_touch(m) and m.occurred_at > q.sent_at)),
  next7 as (select coalesce(sum(vh.hours), 0) h from app.visit_hours vh join public.visits v on v.id = vh.visit_id
            where vh.start_at >= now() and vh.start_at < now() + interval '7 days' and v.completed_at is null),
  long_days as (
    select count(*) n from public.employees e
    cross join lateral app.commission_days(e.id, ((now() at time zone 'America/Los_Angeles')::date - 7), (now() at time zone 'America/Los_Angeles')::date) d
    where e.tracks_time and e.active and d.hours > 0
      and d.hours > coalesce((select sum(vh.hours) from public.visits v join public.visit_assignments va on va.visit_id = v.id and va.employee_id = e.id
                              join app.visit_hours vh on vh.visit_id = v.id
                              where (v.start_at at time zone 'America/Los_Angeles')::date = d.day), 0) + 1)
  select jsonb_build_object(
    'leads_waiting', (select count(*) from app.quo_leads where first_response_at is null and not waiting_on_them and lead_at > now() - interval '7 days'),
    'follow_ups_due', (select count(*) from app.quo_leads where fu1_open or fu2_open),
    'missed_not_returned', (select count(*) from app.quo_missed_calls where returned_at is null and occurred_at > now() - interval '3 days'),
    'big_quotes_no_follow_up', (select count(*) from big_quotes),
    'plans_need_booking', (select count(*) from app.plan_homes where status in ('not_booked', 'needs_date', 'overdue')),
    'long_crew_days', (select n from long_days),
    'next7_utilization', (select round(h / nullif(7 * st.work_days_per_week / 7.0 * st.crew_hours_per_day * st.trucks, 0), 3) from next7),
    'callback_rate_30', (select round(cb30 / nullif(d30, 0), 3) from recent_cb, recent_done),
    'callback_rate_prior', (select round(cb90 / nullif(d90, 0), 3) from recent_cb, recent_done),
    'approval_rate_30', (select round(a30 / nullif(s30, 0), 3) from approvals),
    'approval_rate_prior', (select round(a90 / nullif(s90, 0), 3) from approvals)
  ) into result;
  return result;
end $$;

revoke all on function public.owner_financial(date, date), public.owner_alerts() from public, anon;
grant execute on function public.owner_financial(date, date), public.owner_alerts() to authenticated;

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
