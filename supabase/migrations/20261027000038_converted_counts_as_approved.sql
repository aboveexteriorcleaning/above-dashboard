-- A quote the team converted into a job without the customer clicking Approve
-- has no approval date in Jobber, but it was accepted. Count it as approved
-- when it was converted (or, if Jobber has no conversion date, when its job was
-- created), the way Jobber's own reports do. A real approval date from Jobber
-- always wins. approval_inferred marks the filled-in dates.

alter table public.quotes add column if not exists approval_inferred boolean not null default false;

create or replace function app.quote_fill_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.approved_at is not null and not (tg_op = 'UPDATE' and old.approval_inferred and new.approved_at = old.approved_at) then
    new.approval_inferred := false;                              -- Jobber's own approval date
  elsif new.approved_at is null and new.status = 'converted' then
    new.approved_at := coalesce(new.converted_at,
                                (select min(j.created_at) from public.jobs j where j.quote_id = new.id));
    new.approval_inferred := new.approved_at is not null;
  end if;
  return new;
end $$;
drop trigger if exists quote_fill_approval on public.quotes;
create trigger quote_fill_approval before insert or update on public.quotes
  for each row execute function app.quote_fill_approval();

-- A job created from a converted quote fills in that quote's date if it was still missing.
create or replace function app.job_fill_quote_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.quote_id is not null then
    update public.quotes set approved_at = approved_at
     where id = new.quote_id and approved_at is null and status = 'converted';
  end if;
  return new;
end $$;
drop trigger if exists job_fill_quote_approval on public.jobs;
create trigger job_fill_quote_approval after insert or update of quote_id on public.jobs
  for each row execute function app.job_fill_quote_approval();

revoke all on function app.quote_fill_approval(), app.job_fill_quote_approval() from public, anon, authenticated;

-- Fill in the quotes already synced.
update public.quotes set status = status where status = 'converted' and approved_at is null;

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
