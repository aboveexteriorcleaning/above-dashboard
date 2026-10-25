-- Growth: more lead measures (contact rate, attempts, unworked, lead-to-booking
-- time, revenue per lead by ZIP), ad results attributed through form leads, and
-- the Sales & quotes view.

drop materialized view app.quo_leads;
drop view app.quo_leads_live;
create view app.quo_leads_live as
with jr as materialized (select client_id, completed_at, revenue from app.job_revenue),
     cp as materialized (select distinct on (client_id) client_id, postal_code from public.properties order by client_id, id)
select y.*,
       -- outbound calls/texts by a person before the first two-way contact (or ever, if none)
       (select count(*) from public.communications c
         where c.contact_phone = y.contact_phone and c.direction = 'outbound' and not c.is_automated
           and c.occurred_at >= y.lead_at and (y.two_way_at is null or c.occurred_at < y.two_way_at))::int as attempts,
       -- human touches between first contact and booking
       case when y.booked_at is not null then
         (select count(*) from public.communications c
           where c.contact_phone = y.contact_phone and app.is_human_touch(c)
             and c.occurred_at >= y.lead_at and c.occurred_at <= y.booked_at)::int end as touches_before_booking,
       not exists (select 1 from public.communications c
                   where c.contact_phone = y.contact_phone and c.occurred_at >= y.lead_at and app.is_human_touch(c)) as unworked
from (
  select x.*,
         (select min(c.occurred_at) from public.communications c
           where c.contact_phone = x.contact_phone and c.occurred_at >= x.lead_at
             and ((c.kind = 'message' and c.direction = 'inbound')
                  or (c.kind = 'call' and c.answered_at is not null and not c.ai_handled))) as two_way_at,
         -- first response of any kind, automatic included (the auto-text itself for form leads)
         case when x.source = 'Form (auto-text)' then x.lead_at
              else (select min(c.occurred_at) from public.communications c
                     where c.contact_phone = x.contact_phone and c.occurred_at >= x.lead_at
                       and (c.direction = 'outbound' or (c.kind = 'call' and c.answered_at is not null))) end as first_any_response_at,
         -- completed (realized) revenue from this lead's Jobber client(s) within 180 days
         (select coalesce(sum(r.revenue), 0) from jr r
           where r.client_id = any(x.client_ids)
             and r.completed_at between x.lead_at - interval '1 day' and x.lead_at + interval '180 days') as realized_revenue,
         (select p.postal_code from cp p where p.client_id = any(x.client_ids)
           order by p.client_id limit 1) as zip
  from (select x.*,
       case when x.quoted_at is not null and x.contact_at is not null
            then greatest(extract(epoch from (x.quoted_at - x.contact_at)) / 3600.0, 0) end as hours_to_quote
from (
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
touch0 as (
  select l.contact_phone, l.lead_at, l.source,
         (select min(c.occurred_at) from public.communications c
          where c.contact_phone = l.contact_phone and c.occurred_at >= l.lead_at and c.direction = 'inbound') as first_inbound_at
  from leads l),
touch1 as (
  select t.*,
         -- any lead: first human touch after first contact
         (select c from public.communications c
          where c.contact_phone = t.contact_phone and c.occurred_at >= t.lead_at and app.is_human_touch(c)
          order by c.occurred_at, c.id limit 1) as c_any,
         -- form lead: we reached out within 24h of the auto-text, before they replied
         (select c from public.communications c
          where c.contact_phone = t.contact_phone and app.is_human_touch(c)
            and c.occurred_at >= t.lead_at and c.occurred_at < t.lead_at + interval '24 hours'
            and (t.first_inbound_at is null or c.occurred_at < t.first_inbound_at)
          order by c.occurred_at, c.id limit 1) as c_early,
         -- form lead: our first reply after theirs
         (select c from public.communications c
          where c.contact_phone = t.contact_phone and app.is_human_touch(c)
            and t.first_inbound_at is not null and c.occurred_at >= t.first_inbound_at
          order by c.occurred_at, c.id limit 1) as c_after
  from touch0 t),
-- When the clock starts:
--   called / texted in            -> their first contact
--   form lead, we reached out <24h -> the auto-text
--   form lead, they replied        -> their reply (later follow-ups with nothing
--                                     to reply to don't count)
--   form lead, never replied       -> not timed ("waiting on them")
touch as (
  select t.contact_phone, t.first_inbound_at,
         case when t.source <> 'Form (auto-text)' then t.c_any
              when (t.c_early).id is not null then t.c_early
              else t.c_after end as c,
         case when t.source <> 'Form (auto-text)' then t.lead_at
              when (t.c_early).id is not null then t.lead_at
              else t.first_inbound_at end as clock_start_at,
         case when t.source <> 'Form (auto-text)' or (t.c_early).id is not null then 'first contact'
              when t.first_inbound_at is not null then 'their reply' end as clock_from,
         (t.source = 'Form (auto-text)' and (t.c_early).id is null and t.first_inbound_at is null) as waiting_on_them
  from touch1 t),
-- Follow-up cadence for form leads that don't answer the auto-text:
--   1st follow-up due if no reply within 24h of the auto-text; done = a call or
--   text 12-48h after the auto-text, before they reply.
--   2nd follow-up due if no reply within 24h of the 1st; done = a call or text
--   12-48h after the 1st, before they reply.
fu1 as (
  select t.contact_phone, t.lead_at, t.first_inbound_at,
         (t.source = 'Form (auto-text)' and (t.first_inbound_at is null or t.first_inbound_at >= t.lead_at + interval '24 hours')) as fu1_due,
         (select min(c.occurred_at) from public.communications c
          where c.contact_phone = t.contact_phone and c.direction = 'outbound' and app.is_human_touch(c)
            and c.occurred_at >= t.lead_at + interval '12 hours' and c.occurred_at <= t.lead_at + interval '48 hours'
            and (t.first_inbound_at is null or c.occurred_at < t.first_inbound_at)) as fu1_at
  from touch0 t),
fu2 as (
  select f.*,
         (f.fu1_due and f.fu1_at is not null and (f.first_inbound_at is null or f.first_inbound_at >= f.fu1_at + interval '24 hours')) as fu2_due,
         (select min(c.occurred_at) from public.communications c
          where f.fu1_at is not null and c.contact_phone = f.contact_phone and c.direction = 'outbound' and app.is_human_touch(c)
            and c.occurred_at >= f.fu1_at + interval '12 hours' and c.occurred_at <= f.fu1_at + interval '48 hours'
            and (f.first_inbound_at is null or c.occurred_at < f.first_inbound_at)) as fu2_at
  from fu1 f),
fu as (
  select f.contact_phone,
         f.fu1_at, f.fu2_at,
         -- counted once it's done, or once its window has closed without a reply
         (f.fu1_due and (f.fu1_at is not null or ((f.first_inbound_at is null or f.first_inbound_at > f.lead_at + interval '48 hours')
                                                  and now() > f.lead_at + interval '48 hours'))) as fu1_counted,
         (f.fu2_due and (f.fu2_at is not null or ((f.first_inbound_at is null or f.first_inbound_at > f.fu1_at + interval '48 hours')
                                                  and now() > f.fu1_at + interval '48 hours'))) as fu2_counted,
         (f.fu1_due and f.fu1_at is null and f.first_inbound_at is null
          and now() >= f.lead_at + interval '24 hours' and now() <= f.lead_at + interval '48 hours') as fu1_open,
         (f.fu2_due and f.fu2_at is null and f.first_inbound_at is null
          and now() >= f.fu1_at + interval '24 hours' and now() <= f.fu1_at + interval '48 hours') as fu2_open,
         (f.fu1_at is not null and f.first_inbound_at > f.fu1_at) as replied_after_follow_up
  from fu2 f),
clients_for as (
  select l.contact_phone, array_agg(cl.id) as client_ids,
         (array_agg(cl.name order by (cl.name like 'New Call%'), cl.name))[1] as client_name
  from leads l join public.clients cl on cl.phone = l.contact_phone group by l.contact_phone)
select l.contact_phone, l.lead_at, l.source, l.phone_number_id, pn.name as line_name,
       cf.client_ids, cf.client_name,
       (t.c).occurred_at as first_response_at,
       case when (t.c).occurred_at is not null
            then greatest(extract(epoch from ((t.c).occurred_at - t.clock_start_at)) / 60.0, 0) end as response_minutes,
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
       -- business hours: every day, 7am-7pm Pacific
       (extract(hour from coalesce(t.clock_start_at, l.lead_at) at time zone 'America/Los_Angeles') between 7 and 18) as in_hours,
       t.clock_start_at, t.clock_from, t.waiting_on_them,
       fu.fu1_at, fu.fu2_at, fu.fu1_counted, fu.fu2_counted, fu.fu1_open, fu.fu2_open, fu.replied_after_follow_up,
       case when fu.fu2_open then 'Second follow-up due'
            when fu.fu1_open then 'First follow-up due'
            when fu.fu2_counted and fu.fu2_at is null then 'Missed second follow-up'
            when fu.fu1_counted and fu.fu1_at is null then 'Missed first follow-up'
            when fu.fu2_at is not null and t.first_inbound_at is null then 'Followed up twice, never replied'
            when fu.fu2_at is not null then 'Followed up twice'
            when fu.fu1_at is not null then 'Followed up once' end as follow_up,
       (fu.fu2_at is not null and t.first_inbound_at is null) as not_converted,
       t.first_inbound_at as contact_at
from leads l
left join touch t on t.contact_phone = l.contact_phone
left join clients_for cf on cf.contact_phone = l.contact_phone
left join fu on fu.contact_phone = l.contact_phone
left join public.quo_phone_numbers pn on pn.id = l.phone_number_id) x) x
) y;

create materialized view app.quo_leads as select * from app.quo_leads_live;
create unique index on app.quo_leads (contact_phone);
revoke all on app.quo_leads, app.quo_leads_live from public, anon, authenticated;

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
  lt as (select * from l where not waiting_on_them),   -- leads we could answer
  m as (select * from app.quo_missed_calls where occurred_at >= a and occurred_at < b),
  inbound as (select count(*) n from public.communications
              where kind = 'call' and direction = 'inbound' and occurred_at >= a and occurred_at < b),
  months as (select m, app.day_start(m) s, app.day_start((m + interval '1 month')::date) e
             from generate_series(this_month - interval '11 months', this_month, interval '1 month') g(m0),
                  lateral (select g.m0::date m) x),
  -- New customers, straight from Jobber (every channel, not just Quo):
  -- first quote ever / first job ever, for a client who hadn't had a completed job before.
  -- matched to a home by address, so duplicate client records don't look new
  job_home as (
    select j.id, j.client_id, j.created_at, j.total, j.status, j.is_callback, app.home_key(p.street, j.client_id) h
    from public.jobs j left join public.properties p on p.id = j.property_id),
  client_home as (
    select c.id client_id, c.phone,
           app.home_key((select p.street from public.properties p where p.client_id = c.id order by p.id limit 1), c.id) h
    from public.clients c),
  done_first as (
    select jh.h, min(r.completed_at) f from app.job_revenue r join job_home jh on jh.id = r.job_id group by jh.h),
  first_quote as (
    select ch.h, min(coalesce(q.sent_at, q.approved_at)) t, bool_or(ch.phone is not null) has_phone
    from public.quotes q join client_home ch on ch.client_id = q.client_id
    where coalesce(q.status, '') not in ('deleted', 'draft') and coalesce(q.sent_at, q.approved_at) is not null
    group by ch.h),
  new_quoted as (
    select fq.* from first_quote fq left join done_first d using (h) where d.f is null or d.f >= fq.t),
  live_jobs as (select * from job_home where coalesce(status, '') <> 'deleted' and not is_callback),
  first_job as (select h, min(created_at) t from live_jobs group by h),
  new_booked as (
    select fj.h, fj.t,
           (select coalesce(sum(lj.total), 0) from live_jobs lj
             where lj.h = fj.h and lj.created_at >= fj.t and lj.created_at < fj.t + interval '30 days') as value
    from first_job fj left join done_first d using (h)
    where d.f is null or d.f >= fj.t),
  by_month as (
    select mm.m,
           (select count(*) from app.quo_leads q where q.lead_at >= mm.s and q.lead_at < mm.e) leads,
           (select count(*) from new_quoted nq where nq.t >= mm.s and nq.t < mm.e) quoted,
           (select count(*) from new_booked nb where nb.t >= mm.s and nb.t < mm.e) booked
    from months mm)
  select jsonb_build_object(
    'leads', (select count(*) from l),
    'responded', (select count(*) from lt where first_response_at is not null),
    'no_reply', (select count(*) from lt where first_response_at is null),
    'waiting_on_them', (select count(*) from l where waiting_on_them),
    'follow_up', (select jsonb_build_object(
        'fu1_due', count(*) filter (where fu1_counted),
        'fu1_done', count(*) filter (where fu1_counted and fu1_at is not null),
        'fu2_due', count(*) filter (where fu2_counted),
        'fu2_done', count(*) filter (where fu2_counted and fu2_at is not null),
        'followed_up', count(*) filter (where fu1_at is not null),
        'followed_up_replied', count(*) filter (where replied_after_follow_up),
        'followed_up_booked', count(*) filter (where fu1_at is not null and booked_at is not null),
        'followed_up_matched', count(*) filter (where fu1_at is not null and client_ids is not null)) from l),
    'follow_ups_due_now', (select count(*) from app.quo_leads where fu1_open or fu2_open),
    'not_converted', (select count(*) from l where not_converted),
    'contact_rate', (select round(count(*) filter (where two_way_at is not null)::numeric / nullif(count(*), 0), 3) from l),
    'two_way', (select count(*) from l where two_way_at is not null),
    'avg_attempts', (select round(avg(attempts)::numeric, 1) from l where not waiting_on_them),
    'unworked', (select count(*) from l where unworked),
    'median_first_any_min', (select round((percentile_cont(0.5) within group (order by extract(epoch from (first_any_response_at - lead_at)) / 60.0))::numeric, 1)
                             from l where first_any_response_at is not null and source <> 'Form (auto-text)'),
    'lead_to_booking_days', (select round((percentile_cont(0.5) within group (order by extract(epoch from (booked_at - lead_at)) / 86400.0))::numeric, 1)
                             from l where booked_at is not null and booked_at >= lead_at),
    'touches_before_booking', (select round(avg(touches_before_booking)::numeric, 1) from l where touches_before_booking is not null),
    'by_zip', coalesce((select jsonb_agg(z order by z.leads desc) from (
        select zip, count(*) leads, count(*) filter (where booked_at is not null) booked,
               round(sum(realized_revenue), 2) revenue, round(sum(realized_revenue) / count(*), 2) revenue_per_lead
        from l where zip is not null group by zip having count(*) >= 2) z), '[]'::jsonb),
    'got_both_follow_ups', (select count(*) from l where fu2_at is not null),
    -- From their first call/text to us, to the first quote (matched by phone).
    'quote_speed', (select jsonb_build_object(
        'quoted', count(*),
        'avg_hours', round(avg(hours_to_quote)::numeric, 1),
        'median_hours', round((percentile_cont(0.5) within group (order by hours_to_quote))::numeric, 1),
        'fast_quoted', count(*) filter (where hours_to_quote <= 24),
        'fast_booked', count(*) filter (where hours_to_quote <= 24 and booked_at is not null),
        'slow_quoted', count(*) filter (where hours_to_quote > 24),
        'slow_booked', count(*) filter (where hours_to_quote > 24 and booked_at is not null))
      from l where hours_to_quote is not null),
    'median_response_min', (select round(percentile_cont(0.5) within group (order by response_minutes)::numeric, 1) from l where response_minutes is not null),
    'median_response_min_in_hours', (select round(percentile_cont(0.5) within group (order by response_minutes)::numeric, 1) from l where response_minutes is not null and in_hours),
    'within_5_min', (select round(count(*) filter (where response_minutes is not null and response_minutes <= 5)::numeric / nullif(count(*), 0), 3) from lt),
    'timed_leads', (select count(*) from lt),
    -- Does speed matter? Booked rates for leads answered within 5 minutes vs later
    -- (booked = matched to a Jobber job by phone, so only as complete as the phone data).
    'speed_booking', (select jsonb_build_object(
        'fast_leads', count(*) filter (where response_minutes <= 5),
        'fast_booked', count(*) filter (where response_minutes <= 5 and booked_at is not null),
        'slow_leads', count(*) filter (where response_minutes > 5),
        'slow_booked', count(*) filter (where response_minutes > 5 and booked_at is not null),
        'matched_leads', count(*) filter (where client_ids is not null)) from l),
    'quoted', (select count(*) from l where quoted_at is not null),
    'booked', (select count(*) from l where booked_at is not null),
    'booked_value', (select round(coalesce(sum(booked_value), 0), 2) from l),
    'new_quoted', (select count(*) from new_quoted where t >= a and t < b),
    'new_quoted_booked', (select count(*) from new_quoted nq where nq.t >= a and nq.t < b
                            and exists (select 1 from live_jobs lj where lj.h = nq.h and lj.created_at >= nq.t - interval '1 day')),
    'new_quoted_no_phone', (select count(*) from new_quoted nq where nq.t >= a and nq.t < b and not nq.has_phone),
    'new_booked', (select count(*) from new_booked where t >= a and t < b),
    'new_booked_value', (select round(coalesce(sum(value), 0), 2) from new_booked where t >= a and t < b),
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
    'monthly', (select jsonb_agg(jsonb_build_object('month', m, 'leads', leads, 'quoted', quoted, 'booked', booked) order by m) from by_month),
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
    -- Attributed through Meta form leads (auto-text leads matched to Jobber by phone)
    'attributed', (select jsonb_build_object(
        'form_leads', count(*),
        'matched', count(*) filter (where client_ids is not null),
        'quoted', count(*) filter (where quoted_at is not null),
        'booked', count(*) filter (where booked_at is not null),
        'booked_value', round(coalesce(sum(booked_value), 0), 2),
        'realized_revenue', round(coalesce(sum(realized_revenue), 0), 2))
      from app.quo_leads where source = 'Form (auto-text)' and lead_at >= app.day_start(p_from) and lead_at < app.day_start(p_to + 1)),
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

-- Sales & quotes. Quote value = non-optional line items less the quote discount, before tax.
create or replace view app.quote_values as
select q.id, q.client_id, q.salesperson_id, q.status, q.sent_at, q.approved_at, q.created_at,
       coalesce(sum(li.total_price) filter (where not li.is_optional), q.subtotal, 0) - coalesce(q.discount_amount, 0) as value,
       coalesce(sum(li.total_price) filter (where not li.is_optional and li.total_price > 0), 0) as pre_discount,
       coalesce(q.discount_amount, 0) + coalesce(-sum(li.total_price) filter (where not li.is_optional and li.total_price < 0), 0) as discount,
       coalesce(-sum(li.total_price) filter (where not li.is_optional and li.total_price < 0 and li.product_name in (select product_name from public.plan_products)), 0) as plan_discount
from public.quotes q left join public.quote_line_items li on li.quote_id = q.id
where coalesce(q.status, '') not in ('deleted', 'draft')
group by q.id;
revoke all on app.quote_values from public, anon, authenticated;

create or replace function public.owner_sales(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a timestamptz := app.day_start(p_from);
  b timestamptz := app.day_start(p_to + 1);
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with qv as materialized (select * from app.quote_values),
  sent as (select * from qv where coalesce(sent_at, approved_at) >= a and coalesce(sent_at, approved_at) < b),
  won as (select * from qv where approved_at >= a and approved_at < b),
  -- a human call/text to the client's phone in Quo, 2-7 days after sending, for quotes not approved within 2 days
  fu as (
    select s.id, s.value,
           (s.approved_at is null or s.approved_at > s.sent_at + interval '2 days') as needed,
           c.phone is not null as has_phone,
           exists (select 1 from public.communications m
                    where m.contact_phone = c.phone and app.is_human_touch(m)
                      and m.occurred_at >= s.sent_at + interval '1 day' and m.occurred_at <= s.sent_at + interval '7 days'
                      and (s.approved_at is null or m.occurred_at < s.approved_at)) as followed_up
    from sent s left join public.clients c on c.id = s.client_id
    where s.sent_at is not null and s.sent_at < now() - interval '7 days'),
  waiting as (
    select qv.*, extract(day from now() - qv.sent_at)::int as days_waiting
    from qv where status in ('awaiting_response', 'changes_requested') and sent_at is not null)
  select jsonb_build_object(
    'sent', (select count(*) from sent),
    'sent_value', (select round(coalesce(sum(value), 0), 2) from sent),
    'approved', (select count(*) from won),
    'approved_value', (select round(coalesce(sum(value), 0), 2) from won),
    'avg_approved_value', (select round(avg(value), 2) from won),
    'days_to_approve', (select round((percentile_cont(0.5) within group (order by extract(epoch from (approved_at - sent_at)) / 86400.0))::numeric, 1)
                        from won where sent_at is not null and approved_at >= sent_at),
    'lost', (select count(*) from sent where status = 'archived' and approved_at is null),
    'lost_value', (select round(coalesce(sum(value), 0), 2) from sent where status = 'archived' and approved_at is null),
    'waiting', (select jsonb_build_object(
        'count', count(*), 'value', round(coalesce(sum(value), 0), 2),
        'd0_7', round(coalesce(sum(value) filter (where days_waiting <= 7), 0), 2),
        'd8_30', round(coalesce(sum(value) filter (where days_waiting between 8 and 30), 0), 2),
        'd31_plus', round(coalesce(sum(value) filter (where days_waiting > 30), 0), 2)) from waiting),
    'discount', (select jsonb_build_object(
        'pre_discount', round(coalesce(sum(pre_discount), 0), 2),
        'discount', round(coalesce(sum(discount), 0), 2),
        'plan_discount', round(coalesce(sum(plan_discount), 0), 2),
        'rate', round(coalesce(sum(discount), 0) / nullif(sum(pre_discount), 0), 3),
        'with_discount_sent', count(*) filter (where discount > 0),
        'with_discount_won', count(*) filter (where discount > 0 and approved_at is not null),
        'without_discount_sent', count(*) filter (where discount = 0),
        'without_discount_won', count(*) filter (where discount = 0 and approved_at is not null)) from sent),
    'follow_up', (select jsonb_build_object(
        'needed', count(*) filter (where needed and has_phone),
        'followed_up', count(*) filter (where needed and has_phone and followed_up),
        'no_phone', count(*) filter (where needed and not has_phone)) from fu),
    'by_salesperson', coalesce((select jsonb_agg(x order by x.approved_value desc) from (
        select coalesce(e.full_name, 'No salesperson set') as name,
               (select count(*) from sent s where s.salesperson_id is not distinct from e2.sid) as sent,
               (select count(*) from won w where w.salesperson_id is not distinct from e2.sid) as approved,
               (select round(coalesce(sum(value), 0), 2) from won w where w.salesperson_id is not distinct from e2.sid) as approved_value
        from (select distinct salesperson_id sid from sent union select distinct salesperson_id from won) e2
        left join public.employees e on e.id = e2.sid) x), '[]'::jsonb),
    'to_follow_up', coalesce((select jsonb_agg(x order by x.value desc) from (
        select w.id, cl.name as client_name, w.client_id, round(w.value, 2) as value, w.sent_at, w.days_waiting,
               (select max(m.occurred_at) from public.communications m
                 where m.contact_phone = cl.phone and app.is_human_touch(m) and m.occurred_at > w.sent_at) as last_contact
        from waiting w left join public.clients cl on cl.id = w.client_id
        where w.days_waiting between 2 and 60
        order by w.value desc limit 25) x), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.owner_sales(date, date) from public, anon;
grant execute on function public.owner_sales(date, date) to authenticated;

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
