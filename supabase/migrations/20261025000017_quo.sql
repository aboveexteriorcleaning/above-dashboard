-- Quo (calls + texts), read-only. Message text is never stored: only two
-- short fingerprints of it, used to spot the automated n8n lead text.

alter table public.communications
  add column if not exists status           text,
  add column if not exists quo_user_id      text,
  add column if not exists phone_number_id  text,
  add column if not exists conversation_id  text,
  add column if not exists answered_at      timestamptz,
  add column if not exists completed_at     timestamptz,
  add column if not exists has_voicemail    boolean not null default false,
  add column if not exists ai_handled       boolean not null default false,
  add column if not exists is_system        boolean not null default false,  -- sent by a Quo system actor
  add column if not exists text_head_hash   text,
  add column if not exists text_tail_hash   text,
  add column if not exists synced_at        timestamptz not null default now();
create index if not exists communications_occurred_idx on public.communications (occurred_at);
create index if not exists communications_kind_idx on public.communications (kind, direction, occurred_at);

create table if not exists public.quo_phone_numbers (
  id           text primary key,          -- PN...
  phone_number text,
  name         text,
  synced_at    timestamptz not null default now()
);
create table if not exists public.quo_users (
  id          text primary key,           -- US...
  email       text,
  name        text,
  role        text,
  employee_id uuid references public.employees(id),
  synced_at   timestamptz not null default now()
);

alter table public.quo_phone_numbers enable row level security;
alter table public.quo_users enable row level security;
revoke all on public.quo_phone_numbers, public.quo_users from anon, authenticated;
grant select on public.quo_phone_numbers, public.quo_users to authenticated;
create policy owners_read on public.quo_phone_numbers for select to authenticated using (app.is_owner());
create policy owners_read on public.quo_users for select to authenticated using (app.is_owner());

-- ---------------------------------------------------------------------
-- After each Quo sync: link people and customers, and flag automated texts.
-- ---------------------------------------------------------------------
create or replace function app.refresh_quo() returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Quo users -> team members, by email, then by name.
  update public.quo_users u
     set employee_id = coalesce(
       (select e.id from public.employees e where lower(e.email) = lower(u.email) limit 1),
       (select e.id from public.employees e where lower(e.full_name) = lower(u.name) limit 1));

  update public.communications c
     set employee_id = u.employee_id
    from public.quo_users u
   where u.id = c.quo_user_id and c.employee_id is distinct from u.employee_id;

  -- Phone number -> Jobber client (the one with the most jobs if several share it).
  update public.communications c
     set client_id = m.client_id
    from (select distinct on (cl.phone) cl.phone, cl.id as client_id
          from public.clients cl
          left join public.jobs j on j.client_id = cl.id
          where cl.phone is not null
          group by cl.phone, cl.id
          order by cl.phone, count(j.id) desc, cl.id) m
   where m.phone = c.contact_phone and c.client_id is distinct from m.client_id;

  -- Automated texts: sent by a Quo system actor, or the very first message to a
  -- number (nothing came before it) whose wording matches at least two other
  -- such first messages - that's the n8n auto-text to new form leads.
  with firsts as (
    select c.id, c.contact_phone, c.text_head_hash, c.text_tail_hash
    from public.communications c
    where c.kind = 'message' and c.direction = 'outbound' and c.contact_phone is not null
      and not exists (select 1 from public.communications p
                      where p.contact_phone = c.contact_phone and p.occurred_at < c.occurred_at)),
  templates as (
    select h from (
      select text_head_hash h, contact_phone from firsts where text_head_hash is not null
      union all
      select text_tail_hash, contact_phone from firsts where text_tail_hash is not null) x
    group by h having count(distinct contact_phone) >= 3),
  auto as (
    select f.id from firsts f
    where f.text_head_hash in (select h from templates) or f.text_tail_hash in (select h from templates))
  update public.communications c
     set is_automated = (c.is_system or c.ai_handled or c.id in (select id from auto))
   where c.is_automated <> (c.is_system or c.ai_handled or c.id in (select id from auto));
end $$;
revoke all on function app.refresh_quo() from public, anon, authenticated;

-- A human touch: a person called or texted them, or picked up their call.
create or replace function app.is_human_touch(c public.communications) returns boolean
language sql immutable set search_path = '' as $$
  select not c.is_automated and (
    (c.direction = 'outbound' and (c.kind = 'message' or c.kind = 'call'))
    or (c.kind = 'call' and c.direction = 'inbound' and c.answered_at is not null))
$$;

-- ---------------------------------------------------------------------
-- Leads: a phone number we'd never dealt with, that wasn't already a
-- customer, and that actually reached us (a text, a real call or voicemail)
-- or got the automated form-lead text.
-- ---------------------------------------------------------------------
create or replace view app.quo_leads as
with firsts as (
  select distinct on (c.contact_phone) c.*
  from public.communications c
  where c.contact_phone ~ '^\+1\d{10}$'
    and c.contact_phone not in (select phone_number from public.quo_phone_numbers where phone_number is not null)
  order by c.contact_phone, c.occurred_at, c.id),
leads as (
  select f.contact_phone, f.occurred_at as lead_at, f.phone_number_id,
         case when f.kind = 'message' and f.direction = 'outbound' and f.is_automated then 'Form (auto-text)'
              when f.kind = 'call' and f.direction = 'inbound' then 'Called in'
              when f.kind = 'message' and f.direction = 'inbound' then 'Texted in'
              else 'We reached out' end as source
  from firsts f
  where not exists (   -- already a customer before this
          select 1 from public.clients cl join app.job_revenue r on r.client_id = cl.id
          where cl.phone = f.contact_phone and r.completed_at < f.occurred_at)
    and exists (       -- real two-way contact, or a form lead
          select 1 from public.communications c
          where c.contact_phone = f.contact_phone
            and ((c.kind = 'message' and c.direction = 'inbound')
                 or (c.kind = 'call' and c.direction = 'inbound' and (coalesce(c.duration_sec, 0) >= 20 or c.has_voicemail))
                 or (c.kind = 'call' and c.direction = 'outbound' and c.answered_at is not null and coalesce(c.duration_sec, 0) >= 20)
                 or (c.id = f.id and c.is_automated and c.kind = 'message')))),
touch as (
  select l.contact_phone,
         (select c from public.communications c
          where c.contact_phone = l.contact_phone and c.occurred_at >= l.lead_at and app.is_human_touch(c)
          order by c.occurred_at, c.id limit 1) as c
  from leads l),
clients_for as (
  select l.contact_phone, array_agg(cl.id) as client_ids,
         (array_agg(cl.name order by (cl.name like 'New Call%'), cl.name))[1] as client_name
  from leads l join public.clients cl on cl.phone = l.contact_phone group by l.contact_phone)
select l.contact_phone, l.lead_at, l.source, l.phone_number_id, pn.name as line_name,
       cf.client_ids, cf.client_name,
       (t.c).occurred_at as first_response_at,
       case when (t.c).occurred_at is not null
            then greatest(extract(epoch from ((t.c).occurred_at - l.lead_at)) / 60.0, 0) end as response_minutes,
       (t.c).employee_id as responded_by,
       (select min(coalesce(q.sent_at, q.approved_at)) from public.quotes q
         where q.client_id = any(cf.client_ids) and coalesce(q.status, '') <> 'deleted'
           and coalesce(q.sent_at, q.approved_at) between l.lead_at - interval '1 day' and l.lead_at + interval '60 days') as quoted_at,
       (select min(j.created_at) from public.jobs j
         where j.client_id = any(cf.client_ids) and coalesce(j.status, '') <> 'deleted' and not j.is_callback
           and j.created_at between l.lead_at - interval '1 day' and l.lead_at + interval '90 days') as booked_at,
       (select coalesce(sum(j.total), 0) from public.jobs j
         where j.client_id = any(cf.client_ids) and coalesce(j.status, '') <> 'deleted' and not j.is_callback
           and j.created_at between l.lead_at - interval '1 day' and l.lead_at + interval '90 days') as booked_value,
       -- business hours: Mon-Sat, 8am-6pm Pacific
       (extract(isodow from l.lead_at at time zone 'America/Los_Angeles') between 1 and 6
        and extract(hour from l.lead_at at time zone 'America/Los_Angeles') between 8 and 17) as in_hours
from leads l
left join touch t on t.contact_phone = l.contact_phone
left join clients_for cf on cf.contact_phone = l.contact_phone
left join public.quo_phone_numbers pn on pn.id = l.phone_number_id;

-- Missed calls and whether someone got back to them.
create or replace view app.quo_missed_calls as
select c.id, c.contact_phone, c.occurred_at, c.has_voicemail, c.phone_number_id, c.client_id,
       (select min(t.occurred_at) from public.communications t
         where t.contact_phone = c.contact_phone and t.occurred_at > c.occurred_at and app.is_human_touch(t)) as returned_at
from public.communications c
where c.kind = 'call' and c.direction = 'inbound' and c.answered_at is null and not c.ai_handled
  and c.contact_phone ~ '^\+1\d{10}$';

revoke all on app.quo_leads, app.quo_missed_calls from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Owner functions
-- ---------------------------------------------------------------------
create or replace function public.owner_leads(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a timestamptz := app.day_start(p_from);
  b timestamptz := app.day_start(p_to + 1);
  this_month date := date_trunc('month', (now() at time zone 'America/Los_Angeles'))::date;
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with l as (select * from app.quo_leads where lead_at >= a and lead_at < b),
  m as (select * from app.quo_missed_calls where occurred_at >= a and occurred_at < b),
  inbound as (select count(*) n from public.communications
              where kind = 'call' and direction = 'inbound' and occurred_at >= a and occurred_at < b),
  months as (select generate_series(this_month - interval '11 months', this_month, interval '1 month')::date m)
  select jsonb_build_object(
    'leads', (select count(*) from l),
    'responded', (select count(*) from l where first_response_at is not null),
    'no_reply', (select count(*) from l where first_response_at is null),
    'median_response_min', (select round(percentile_cont(0.5) within group (order by response_minutes)::numeric, 1) from l where response_minutes is not null),
    'median_response_min_in_hours', (select round(percentile_cont(0.5) within group (order by response_minutes)::numeric, 1) from l where response_minutes is not null and in_hours),
    'within_5_min', (select round(count(*) filter (where response_minutes is not null and response_minutes <= 5)::numeric / nullif(count(*), 0), 3) from l),
    'quoted', (select count(*) from l where quoted_at is not null),
    'booked', (select count(*) from l where booked_at is not null),
    'booked_value', (select round(coalesce(sum(booked_value), 0), 2) from l),
    'by_source', coalesce((select jsonb_agg(x order by x.leads desc) from (
        select source, count(*) leads, count(*) filter (where booked_at is not null) booked,
               round(coalesce(sum(booked_value), 0), 2) booked_value
        from l group by source) x), '[]'::jsonb),
    'by_line', coalesce((select jsonb_agg(x order by x.leads desc) from (
        select coalesce(line_name, 'Unknown line') line, count(*) leads, count(*) filter (where booked_at is not null) booked
        from l group by 1) x), '[]'::jsonb),
    'missed', jsonb_build_object(
        'missed', (select count(*) from m),
        'inbound_calls', (select n from inbound),
        'voicemails', (select count(*) from m where has_voicemail),
        'returned', (select count(*) from m where returned_at is not null),
        'not_returned', (select count(*) from m where returned_at is null),
        'median_return_min', (select round(percentile_cont(0.5) within group (order by extract(epoch from (returned_at - occurred_at)) / 60.0)::numeric, 1)
                              from m where returned_at is not null)),
    'monthly', (select jsonb_agg(jsonb_build_object(
        'month', mm.m,
        'leads', (select count(*) from app.quo_leads q where q.lead_at >= app.day_start(mm.m) and q.lead_at < app.day_start((mm.m + interval '1 month')::date)),
        'quoted', (select count(*) from app.quo_leads q where q.quoted_at is not null and q.lead_at >= app.day_start(mm.m) and q.lead_at < app.day_start((mm.m + interval '1 month')::date)),
        'booked', (select count(*) from app.quo_leads q where q.booked_at is not null and q.lead_at >= app.day_start(mm.m) and q.lead_at < app.day_start((mm.m + interval '1 month')::date)))
        order by mm.m) from months mm),
    'people', coalesce((select jsonb_agg(x order by x.calls_answered + x.calls_made + x.texts_sent desc) from (
        select coalesce(e.full_name, 'Not linked to a team member') as name,
               count(*) filter (where c.kind = 'call' and c.direction = 'inbound' and c.answered_at is not null) calls_answered,
               count(*) filter (where c.kind = 'call' and c.direction = 'outbound') calls_made,
               count(*) filter (where c.kind = 'message' and c.direction = 'outbound' and not c.is_automated) texts_sent,
               (select count(*) from l where l.responded_by is not distinct from c.employee_id and l.first_response_at is not null) leads_first_reply,
               (select round(percentile_cont(0.5) within group (order by l.response_minutes)::numeric, 1) from l
                 where l.responded_by is not distinct from c.employee_id and l.response_minutes is not null) median_response_min
        from public.communications c left join public.employees e on e.id = c.employee_id
        where c.occurred_at >= a and c.occurred_at < b and not c.is_automated and c.quo_user_id is not null
        group by c.employee_id, e.full_name) x), '[]'::jsonb)
  ) into result;
  return result;
end $$;

create or replace function public.lead_list(p_from date, p_to date)
returns table (contact_phone text, client_name text, client_id text, lead_at timestamptz, source text, line_name text,
               first_response_at timestamptz, response_minutes numeric, responded_by text,
               quoted_at timestamptz, booked_at timestamptz, booked_value numeric, in_hours boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  return query
  select l.contact_phone, l.client_name, l.client_ids[1], l.lead_at, l.source, l.line_name,
         l.first_response_at, round(l.response_minutes::numeric, 1), e.full_name,
         l.quoted_at, l.booked_at, round(l.booked_value, 2), l.in_hours
  from app.quo_leads l left join public.employees e on e.id = l.responded_by
  where l.lead_at >= app.day_start(p_from) and l.lead_at < app.day_start(p_to + 1)
  order by l.lead_at desc;
end $$;

create or replace function public.quo_freshness()
returns table (last_synced timestamptz, healthy boolean, connected boolean)
language sql stable security definer set search_path = '' as $$
  select s.last_success_at, (s.last_error is null or s.last_error_at < s.last_success_at), s.last_success_at is not null
  from (select 1) one left join public.sync_state s on s.source = 'quo'
  where app.is_owner()
$$;

revoke all on function public.owner_leads(date, date), public.lead_list(date, date), public.quo_freshness() from public, anon;
grant execute on function public.owner_leads(date, date), public.lead_list(date, date), public.quo_freshness() to authenticated;

-- ---------------------------------------------------------------------
-- Schedule: every 5 minutes (the function does nothing until the history
-- import has finished).
-- ---------------------------------------------------------------------
create or replace function app.call_quo_sync(p_mode text) returns void
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'sync_key';
  if k is null then raise notice 'sync_key missing in Vault; skipping'; return; end if;
  perform net.http_post(
    url := 'https://fmpbjesfoeupybflfrbd.supabase.co/functions/v1/quo-sync?mode=' || p_mode,
    headers := jsonb_build_object('x-sync-key', k, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000);
end $$;
revoke all on function app.call_quo_sync(text) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('quo-sync-5min', '2-59/5 * * * *', $c$ select app.call_quo_sync('incremental') $c$);
  end if;
end $$;
