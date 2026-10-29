-- Meta form leads read from the lead Google Sheet (read-only), so quotes and
-- bookings can be tied to the ad each lead came from. Only what's needed is kept:
-- when, the phone (to match Jobber), and the ad / campaign / form. No names or emails.

create table if not exists public.meta_form_leads (
  id            text primary key,          -- Meta's lead id
  created_at    timestamptz not null,
  phone         text,                      -- +1XXXXXXXXXX
  ad_id         text,
  ad_name       text,
  adset_name    text,
  campaign_id   text,
  campaign_name text,
  form_name     text,
  platform      text,
  is_organic    boolean,
  sheet_tab     text,
  synced_at     timestamptz not null default now()
);
create index if not exists meta_form_leads_created_idx on public.meta_form_leads (created_at);
create index if not exists meta_form_leads_phone_idx on public.meta_form_leads (phone);
create index if not exists meta_form_leads_ad_idx on public.meta_form_leads (ad_id);
create index if not exists clients_phone_idx on public.clients (phone);
create index if not exists quotes_client_idx on public.quotes (client_id);
create index if not exists jobs_client_idx on public.jobs (client_id);

alter table public.meta_form_leads enable row level security;
revoke all on public.meta_form_leads from anon, authenticated;
grant select on public.meta_form_leads to authenticated;
create policy owners_read on public.meta_form_leads for select to authenticated using (app.is_owner());

-- Each lead's outcome. A person who submits more than once is counted once, for
-- the first ad they came from (first touch). Quotes and bookings use the same
-- windows as the Leads page: quoted within 60 days, booked within 90.
create or replace view app.meta_lead_outcomes as
with l as (
  select m.*, row_number() over (partition by coalesce(m.phone, m.id) order by m.created_at, m.id) = 1 as first_touch
  from public.meta_form_leads m),
cf as (
  select l.id, array_agg(cl.id) as client_ids
  from l join public.clients cl on cl.phone = l.phone
  where l.phone is not null group by l.id)
select l.id, l.created_at, l.phone, l.ad_id, l.ad_name, l.adset_name, l.campaign_id, l.campaign_name, l.form_name,
       l.is_organic, l.first_touch, cf.client_ids,
       case when l.first_touch then
         (select min(coalesce(q.sent_at, q.approved_at)) from public.quotes q
           where q.client_id = any(cf.client_ids) and coalesce(q.status, '') not in ('deleted', 'draft')
             and coalesce(q.sent_at, q.approved_at) between l.created_at - interval '1 day' and l.created_at + interval '60 days') end as quoted_at,
       case when l.first_touch then
         (select min(j.created_at) from public.jobs j
           where j.client_id = any(cf.client_ids) and coalesce(j.status, '') <> 'deleted' and not j.is_callback
             and j.created_at between l.created_at - interval '1 day' and l.created_at + interval '90 days') end as booked_at,
       case when l.first_touch then
         (select coalesce(sum(j.total), 0) from public.jobs j
           where j.client_id = any(cf.client_ids) and coalesce(j.status, '') <> 'deleted' and not j.is_callback
             and j.created_at between l.created_at - interval '1 day' and l.created_at + interval '90 days') end as booked_value
from l left join cf on cf.id = l.id;
revoke all on app.meta_lead_outcomes from public, anon, authenticated;

-- Owners: spend and results per ad for a period. Spend from Meta; leads, quotes
-- and bookings from the lead sheet, by the day the lead came in.
create or replace function public.owner_ads_by_ad(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with sp as (
    select ad_id, max(ad_name) as name, max(campaign_name) as campaign, sum(spend) as spend, sum(meta_leads) as meta_leads
    from public.ad_spend_daily where day between p_from and p_to group by ad_id),
  ld as (
    select coalesce(ad_id, 'organic') as ad_id, max(ad_name) as name, max(campaign_name) as campaign,
           count(*) as leads, count(*) filter (where not first_touch) as repeat_leads,
           count(*) filter (where client_ids is not null) as matched,
           count(quoted_at) as quoted, count(booked_at) as booked, coalesce(sum(booked_value), 0) as booked_value
    from app.meta_lead_outcomes
    where created_at >= app.day_start(p_from) and created_at < app.day_start(p_to + 1)
    group by 1),
  rows as (
    select coalesce(sp.ad_id, ld.ad_id) as ad_id,
           coalesce(ld.name, sp.name, case when ld.ad_id = 'organic' then 'Organic (no ad)' end) as name,
           coalesce(sp.campaign, ld.campaign) as campaign,
           round(coalesce(sp.spend, 0), 2) as spend, coalesce(sp.meta_leads, 0) as meta_leads,
           coalesce(ld.leads, 0) as leads, coalesce(ld.repeat_leads, 0) as repeat_leads, coalesce(ld.matched, 0) as matched,
           coalesce(ld.quoted, 0) as quoted, coalesce(ld.booked, 0) as booked, round(coalesce(ld.booked_value, 0), 2) as booked_value
    from sp full join ld on ld.ad_id = sp.ad_id
    where coalesce(sp.spend, 0) > 0 or coalesce(ld.leads, 0) > 0)
  select jsonb_build_object(
    'connected', exists (select 1 from public.meta_form_leads),
    'last_synced', (select last_success_at from public.sync_state where source = 'lead_sheet'),
    'ads', coalesce((select jsonb_agg(jsonb_build_object(
        'ad_id', ad_id, 'name', name, 'campaign', campaign, 'spend', spend, 'meta_leads', meta_leads,
        'leads', leads, 'repeat_leads', repeat_leads, 'matched', matched, 'quoted', quoted, 'booked', booked, 'booked_value', booked_value,
        'cost_per_lead', round(spend / nullif(leads, 0), 2),
        'cost_per_quoted', round(spend / nullif(quoted, 0), 2),
        'cost_per_booked', round(spend / nullif(booked, 0), 2),
        'roas', round(booked_value / nullif(spend, 0), 2)) order by spend desc, leads desc) from rows), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.owner_ads_by_ad(date, date) from public, anon;
grant execute on function public.owner_ads_by_ad(date, date) to authenticated;

-- Read the sheet every hour.
create or replace function app.call_lead_sheet_sync() returns void
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'sync_key';
  if k is null then return; end if;
  perform net.http_post(
    url := 'https://fmpbjesfoeupybflfrbd.supabase.co/functions/v1/leads-sheet-sync',
    headers := jsonb_build_object('x-sync-key', k, 'Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
end $$;
revoke all on function app.call_lead_sheet_sync() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('lead-sheet-sync-hourly', '41 * * * *', $c$ select app.call_lead_sheet_sync() $c$);
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
