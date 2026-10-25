-- Business hours for speed to lead: 7am-7pm Pacific, every day.

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
       -- business hours: every day, 7am-7pm Pacific
       (extract(hour from l.lead_at at time zone 'America/Los_Angeles') between 7 and 18) as in_hours
from leads l
left join touch t on t.contact_phone = l.contact_phone
left join clients_for cf on cf.contact_phone = l.contact_phone
left join public.quo_phone_numbers pn on pn.id = l.phone_number_id;

revoke all on app.quo_leads from public, anon, authenticated;
