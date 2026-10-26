-- Google Business Profile reviews (read-only), matched to jobs and crews.

alter table private.oauth_states add column if not exists provider text not null default 'jobber';

create table if not exists public.google_reviews (
  id            text primary key,
  location_id   text not null,
  stars         int check (stars between 1 and 5),
  reviewer_name text,
  comment       text,
  created_at    timestamptz not null,
  updated_at    timestamptz not null,
  replied_at    timestamptz,
  synced_at     timestamptz not null default now()
);
create index if not exists google_reviews_created_idx on public.google_reviews (created_at);

create table if not exists public.google_review_totals (
  location_id    text primary key,
  average_rating numeric(3,2),
  total_reviews  int,
  updated_at     timestamptz not null default now()
);

-- Which job (and so which crew) a review most likely belongs to.
create table if not exists public.google_review_matches (
  review_id  text primary key references public.google_reviews(id) on delete cascade,
  client_id  text references public.clients(id),
  job_id     text references public.jobs(id)
);

alter table public.google_reviews enable row level security;
alter table public.google_review_totals enable row level security;
alter table public.google_review_matches enable row level security;
revoke all on public.google_reviews, public.google_review_totals, public.google_review_matches from anon, authenticated;
grant select on public.google_reviews, public.google_review_totals, public.google_review_matches to authenticated;
create policy owners_read on public.google_reviews for select to authenticated using (app.is_owner());
create policy owners_read on public.google_review_totals for select to authenticated using (app.is_owner());
create policy owners_read on public.google_review_matches for select to authenticated using (app.is_owner());

-- Quo texts that contain a Google review link (flagged at sync; text isn't stored).
alter table public.communications add column if not exists is_review_request boolean not null default false;

-- Does a Google reviewer name match a Jobber client name?
-- Full name, or first name + last initial ("Jane D."). Placeholder "New Call" clients never match.
create or replace function app.reviewer_matches(p_client text, p_reviewer text) returns boolean
language sql immutable set search_path = '' as $$
  with n as (
    select regexp_split_to_array(trim(regexp_replace(lower(coalesce(p_client, '')), '[^a-z ]', '', 'g')), '\s+') c,
           regexp_split_to_array(trim(regexp_replace(lower(coalesce(p_reviewer, '')), '[^a-z ]', '', 'g')), '\s+') r)
  select coalesce(p_client, '') !~* '^new call' and array_length(c, 1) >= 2 and array_length(r, 1) >= 2
     and c[1] = r[1]
     and (c[array_length(c, 1)] = r[array_length(r, 1)]
          or (length(r[array_length(r, 1)]) = 1 and left(c[array_length(c, 1)], 1) = r[array_length(r, 1)]))
  from n
$$;

-- Match each review to the most recent job completed for a same-named client
-- in the 60 days before the review.
create or replace function app.refresh_reviews() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.google_review_matches;
  insert into public.google_review_matches (review_id, client_id, job_id)
  select distinct on (r.id) r.id, c.id, jr.job_id
  from public.google_reviews r
  join public.clients c on app.reviewer_matches(c.name, r.reviewer_name)
  join app.job_revenue jr on jr.client_id = c.id
   and jr.completed_at between r.created_at - interval '60 days' and r.created_at + interval '1 day'
  where r.reviewer_name is not null
  order by r.id, jr.completed_at desc;
end $$;
revoke all on function app.refresh_reviews() from public, anon, authenticated;

create or replace function public.owner_reviews(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a timestamptz := app.day_start(p_from);
  b timestamptz := app.day_start(p_to + 1);
  result jsonb;
begin
  if not app.is_owner() then raise exception 'not authorised'; end if;
  with rv as (select * from public.google_reviews where created_at >= a and created_at < b),
  done as (select count(*) n from app.job_revenue where completed_at >= a and completed_at < b),
  asked as (select count(distinct contact_phone) n from public.communications
            where is_review_request and occurred_at >= a and occurred_at < b),
  crew as (
    select pjd.employee_id, r.stars
    from rv r join public.google_review_matches m on m.review_id = r.id
    join app.person_job_days pjd on pjd.job_id = m.job_id)
  select jsonb_build_object(
    'connected', exists (select 1 from public.google_review_totals),
    'average_all', (select round(sum(average_rating * total_reviews) / nullif(sum(total_reviews), 0), 2) from public.google_review_totals),
    'total_all', (select sum(total_reviews) from public.google_review_totals),
    'reviews', (select count(*) from rv),
    'average', (select round(avg(stars), 2) from rv),
    'five_star', (select count(*) from rv where stars = 5),
    'low', (select count(*) from rv where stars <= 3),
    'completed_jobs', (select n from done),
    'replied', (select count(*) from rv where replied_at is not null),
    'reply_hours', (select round((percentile_cont(0.5) within group (order by extract(epoch from (replied_at - created_at)) / 3600.0))::numeric, 1)
                    from rv where replied_at is not null),
    'requests', (select n from asked),
    'matched', (select count(*) from rv r join public.google_review_matches m on m.review_id = r.id),
    'by_person', coalesce((select jsonb_agg(x order by x.reviews desc) from (
        select e.full_name name, count(*) reviews, round(avg(stars), 2) average, count(*) filter (where stars = 5) five_star
        from crew join public.employees e on e.id = crew.employee_id group by e.full_name) x), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select r.id, r.stars, r.reviewer_name, r.created_at, left(r.comment, 280) comment, r.replied_at is not null replied,
               (select string_agg(distinct e.full_name, ' & ') from app.person_job_days pjd join public.employees e on e.id = pjd.employee_id
                 where pjd.job_id = m.job_id) crew
        from rv r left join public.google_review_matches m on m.review_id = r.id
        order by r.created_at desc limit 20) x), '[]'::jsonb)
  ) into result;
  return result;
end $$;

-- A crew member's own reviews (matched to jobs they worked).
create or replace function public.my_reviews(p_from date, p_to date)
returns table (reviews int, average numeric, five_star int)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := app.my_employee_id();
begin
  if me is null then raise exception 'not authorised'; end if;
  return query
  select count(*)::int, round(avg(r.stars), 2), (count(*) filter (where r.stars = 5))::int
  from public.google_reviews r
  join public.google_review_matches m on m.review_id = r.id
  join app.person_job_days pjd on pjd.job_id = m.job_id and pjd.employee_id = me
  where r.created_at >= app.day_start(p_from) and r.created_at < app.day_start(p_to + 1);
end $$;

create or replace function public.google_freshness()
returns table (last_synced timestamptz, healthy boolean, connected boolean)
language sql stable security definer set search_path = '' as $$
  select s.last_success_at, (s.last_error is null or s.last_error_at < s.last_success_at), s.last_success_at is not null
  from (select 1) one left join public.sync_state s on s.source = 'google'
  where app.is_owner()
$$;

revoke all on function public.owner_reviews(date, date), public.my_reviews(date, date), public.google_freshness() from public, anon;
grant execute on function public.owner_reviews(date, date), public.my_reviews(date, date), public.google_freshness() to authenticated;

-- Every 3 hours (reviews don't change by the minute).
create or replace function app.call_google_sync() returns void
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'sync_key';
  if k is null then return; end if;
  perform net.http_post(
    url := 'https://fmpbjesfoeupybflfrbd.supabase.co/functions/v1/google-sync',
    headers := jsonb_build_object('x-sync-key', k, 'Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 300000);
end $$;
revoke all on function app.call_google_sync() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('google-sync-3h', '23 */3 * * *', $c$ select app.call_google_sync() $c$);
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
