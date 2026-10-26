-- Reviews can also come from the Places API (no approval needed): rating, total
-- count and the newest reviews. It doesn't include owner replies.
alter table public.google_review_totals add column if not exists source text not null default 'business_profile';

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
    'source', (select source from public.google_review_totals order by updated_at desc limit 1),
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
