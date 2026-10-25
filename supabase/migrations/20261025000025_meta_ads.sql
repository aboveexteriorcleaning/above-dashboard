-- Meta ads (read-only): daily results per ad, and the Ads tab numbers.

alter table public.ad_spend_daily
  add column if not exists adset_name  text,
  add column if not exists link_clicks int,
  add column if not exists reach       int,
  add column if not exists synced_at   timestamptz not null default now();
create index if not exists ad_spend_daily_day_idx on public.ad_spend_daily (day);

-- New customers (first-ever job at the address), from Jobber. Shared by the
-- Leads and Ads tabs.
create or replace view app.new_customer_bookings as
with job_home as (
  select j.id, j.created_at, j.total, app.home_key(p.street, j.client_id) h
  from public.jobs j left join public.properties p on p.id = j.property_id
  where coalesce(j.status, '') <> 'deleted' and not j.is_callback),
done_first as (
  select app.home_key(p.street, j.client_id) h, min(r.completed_at) f
  from app.job_revenue r join public.jobs j on j.id = r.job_id
  left join public.properties p on p.id = j.property_id group by 1),
first_job as (select h, min(created_at) t from job_home group by h)
select fj.h as home_key, fj.t as booked_at,
       (select coalesce(sum(jh.total), 0) from job_home jh
         where jh.h = fj.h and jh.created_at >= fj.t and jh.created_at < fj.t + interval '30 days') as value
from first_job fj left join done_first d using (h)
where d.f is null or d.f >= fj.t;
revoke all on app.new_customer_bookings from public, anon, authenticated;

create or replace function public.owner_ads(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  this_month date := date_trunc('month', (now() at time zone 'America/Los_Angeles'))::date;
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with nbk as materialized (select * from app.new_customer_bookings),
  ads as (select * from public.ad_spend_daily where day between p_from and p_to),
  nb as (select * from nbk
         where booked_at >= app.day_start(p_from) and booked_at < app.day_start(p_to + 1)),
  form_leads as (select count(*) n from app.quo_leads
                 where source = 'Form (auto-text)' and lead_at >= app.day_start(p_from) and lead_at < app.day_start(p_to + 1)),
  months as (select g::date m, app.day_start(g::date) s, app.day_start((g + interval '1 month')::date) e
             from generate_series(this_month - interval '11 months', this_month, interval '1 month') g),
  by_month as (
    select mm.m,
           (select coalesce(sum(spend), 0) from public.ad_spend_daily a where a.day >= mm.m and a.day < (mm.m + interval '1 month')::date) spend,
           (select coalesce(sum(meta_leads), 0) from public.ad_spend_daily a where a.day >= mm.m and a.day < (mm.m + interval '1 month')::date) leads,
           (select count(*) from nbk b where b.booked_at >= mm.s and b.booked_at < mm.e) new_customers,
           (select coalesce(sum(value), 0) from nbk b where b.booked_at >= mm.s and b.booked_at < mm.e) new_value
    from months mm)
  select jsonb_build_object(
    'spend', (select round(coalesce(sum(spend), 0), 2) from ads),
    'impressions', (select coalesce(sum(impressions), 0) from ads),
    'link_clicks', (select coalesce(sum(link_clicks), 0) from ads),
    'clicks', (select coalesce(sum(clicks), 0) from ads),
    'meta_leads', (select coalesce(sum(meta_leads), 0) from ads),
    'days_with_spend', (select count(distinct day) from ads where spend > 0),
    'form_leads', (select n from form_leads),
    'new_customers', (select count(*) from nb),
    'new_customer_value', (select round(coalesce(sum(value), 0), 2) from nb),
    'campaigns', coalesce((select jsonb_agg(x order by x.spend desc) from (
        select campaign_id, max(campaign_name) as name, round(sum(spend), 2) spend,
               sum(impressions) impressions, sum(link_clicks) link_clicks, sum(meta_leads) leads,
               min(day) first_day, max(day) last_day
        from ads group by campaign_id having sum(spend) > 0 or sum(meta_leads) > 0) x), '[]'::jsonb),
    'monthly', (select jsonb_agg(jsonb_build_object('month', m, 'spend', round(spend, 2), 'leads', leads,
                                                    'new_customers', new_customers, 'new_value', round(new_value, 2)) order by m) from by_month)
  ) into result;
  return result;
end $$;

create or replace function public.meta_freshness()
returns table (last_synced timestamptz, healthy boolean, connected boolean)
language sql stable security definer set search_path = '' as $$
  select s.last_success_at, (s.last_error is null or s.last_error_at < s.last_success_at), s.last_success_at is not null
  from (select 1) one left join public.sync_state s on s.source = 'meta'
  where app.is_owner()
$$;

revoke all on function public.owner_ads(date, date), public.meta_freshness() from public, anon;
grant execute on function public.owner_ads(date, date), public.meta_freshness() to authenticated;

-- Schedule: hourly (last 3 days), nightly (last 28 days, as Meta updates results).
create or replace function app.call_meta_sync(p_query text) returns void
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'sync_key';
  if k is null then raise notice 'sync_key missing in Vault; skipping'; return; end if;
  perform net.http_post(
    url := 'https://fmpbjesfoeupybflfrbd.supabase.co/functions/v1/meta-sync?' || p_query,
    headers := jsonb_build_object('x-sync-key', k, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000);
end $$;
revoke all on function app.call_meta_sync(text) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('meta-sync-hourly', '7 * * * *', $c$ select app.call_meta_sync('mode=incremental&days=3') $c$);
    perform cron.schedule('meta-sync-nightly', '37 11 * * *', $c$ select app.call_meta_sync('mode=incremental&days=28') $c$);
  end if;
end $$;

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
