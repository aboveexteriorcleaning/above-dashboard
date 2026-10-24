-- =====================================================================
-- Sync support: token storage, OAuth state, derived flags
-- =====================================================================

-- Private schema: only the sync (service_role) can see it. Never exposed
-- through the app's API.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.integration_tokens (
  provider       text primary key,          -- 'jobber'
  access_token   text not null,
  refresh_token  text not null,
  expires_at     timestamptz not null,
  account_id     text,
  account_name   text,
  updated_at     timestamptz not null default now()
);

create table private.oauth_states (
  state          text primary key,
  code_verifier  text not null,
  created_at     timestamptz not null default now()
);

revoke all on all tables in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Derived flags, recomputed after every sync. Pure SQL so they are easy
-- to audit and re-run.
-- ---------------------------------------------------------------------
create or replace function app.refresh_derived() returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Plan discount lines: name matches the plan catalog.
  update public.job_line_items li
     set is_plan_discount = exists (
       select 1 from public.plan_products pp where pp.product_name = li.product_name);

  -- On-site upsell: a paid line on a job that came from a quote, where that
  -- product was not on the quote (approved optional items count as
  -- quote-stage upsells instead, credited to the salesperson).
  update public.job_line_items li
     set is_onsite_upsell = (
       li.total_price > 0
       and j.quote_id is not null
       and not exists (
         select 1 from public.quote_line_items q
         where q.quote_id = j.quote_id and q.product_name = li.product_name))
    from public.jobs j
   where j.id = li.job_id;

  -- Callbacks: job titled "Callback – #<original job number>".
  update public.jobs j
     set is_callback = (j.title ~* '^\s*call\s*-?\s*back'),
         callback_of_job_id = (
           select o.id from public.jobs o
           where o.job_number = nullif(substring(j.title from '#\s*(\d+)'), '')::int
           limit 1)
   where j.title is not null;
end $$;
revoke all on function app.refresh_derived() from public, anon, authenticated;
