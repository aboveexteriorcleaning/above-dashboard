-- =====================================================================
-- Above Dashboard: core schema
-- ---------------------------------------------------------------------
-- Design rules
--  * This database is a READ-ONLY COPY of Jobber / Quo / Meta / Sheets.
--    Nothing in here is ever written back to those systems.
--  * raw.*      : every record exactly as received (append-only).
--  * public.*   : cleaned tables the metrics are built on.
--  * Every business table carries branch_id so multi-location works later.
--  * Only the sync functions (service_role) write to source tables.
-- =====================================================================

create extension if not exists pgcrypto;

create schema if not exists raw;
create schema if not exists app;      -- helper functions (access checks)

-- ---------------------------------------------------------------------
-- Raw landing zone: append-only, lets us recompute anything later
-- ---------------------------------------------------------------------
create table raw.records (
  id           bigint generated always as identity primary key,
  source       text not null check (source in ('jobber','quo','meta','sheets')),
  object_type  text not null,                 -- 'job', 'quote', 'call', ...
  source_id    text not null,
  payload      jsonb not null,
  received_via text not null check (received_via in ('webhook','poll','backfill')),
  received_at  timestamptz not null default now()
);
create index on raw.records (source, object_type, source_id, received_at desc);

-- ---------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------
create table public.branches (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

create type public.app_role as enum ('owner','crew');

create table public.employees (
  id               uuid primary key default gen_random_uuid(),
  full_name        text not null,
  jobber_user_id   text unique,                       -- links stats to the person
  quo_user_id      text unique,
  auth_user_id     uuid unique,                       -- their dashboard login
  role             public.app_role not null default 'crew',
  branch_id        uuid references public.branches(id),
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

-- Pay data kept in its own table so it can be locked to owners only.
create table public.employee_costs (
  employee_id      uuid not null references public.employees(id) on delete cascade,
  effective_from   date not null,
  hourly_cost      numeric(10,2) not null check (hourly_cost >= 0), -- wage + burden
  primary key (employee_id, effective_from)
);

-- ---------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------
create table public.clients (
  id              text primary key,                  -- Jobber client id
  branch_id       uuid references public.branches(id),
  name            text not null,
  email           text,
  phone           text,
  lead_source     text,
  is_company      boolean default false,
  jobber_created_at timestamptz,
  synced_at       timestamptz not null default now()
);
create index on public.clients (phone);
create index on public.clients (lower(email));

create table public.properties (
  id           text primary key,
  client_id    text references public.clients(id),
  street       text,
  city         text,
  postal_code  text,
  synced_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Leads, quotes, jobs
-- ---------------------------------------------------------------------
create table public.requests (
  id           text primary key,
  branch_id    uuid references public.branches(id),
  client_id    text references public.clients(id),
  title        text,
  source       text,
  status       text,
  is_qualified boolean,                -- set by qualification rules, null = unreviewed
  disqualify_reason text,
  created_at   timestamptz not null,
  synced_at    timestamptz not null default now()
);

create table public.quotes (
  id                   text primary key,
  branch_id            uuid references public.branches(id),
  quote_number         text,
  client_id            text references public.clients(id),
  request_id           text references public.requests(id),
  salesperson_id       uuid references public.employees(id),
  status               text,
  subtotal             numeric(12,2),
  discount_amount      numeric(12,2),
  total                numeric(12,2),
  created_at           timestamptz not null,
  sent_at              timestamptz,
  approved_at          timestamptz,
  converted_at         timestamptz,
  lost_reason          text,
  synced_at            timestamptz not null default now()
);

create table public.quote_line_items (
  id           text primary key,
  quote_id     text not null references public.quotes(id) on delete cascade,
  product_name text not null,
  quantity     numeric(10,2),
  unit_price   numeric(12,2),
  total_price  numeric(12,2),
  is_optional  boolean not null default false,
  sort_order   int
);

create table public.jobs (
  id              text primary key,
  branch_id       uuid references public.branches(id),
  job_number      int,
  client_id       text references public.clients(id),
  property_id     text references public.properties(id),
  quote_id        text references public.quotes(id),
  title           text,
  status          text,
  job_type        text check (job_type in ('ONE_OFF','RECURRING')),
  is_callback     boolean not null default false,
  callback_of_job_id text references public.jobs(id),
  upsell_offer    text check (upsell_offer in ('accepted','declined','not_offered','not_a_fit')),
  total           numeric(12,2),        -- pre-tax value of work (booked)
  invoiced_total  numeric(12,2),
  created_at      timestamptz not null,
  start_at        timestamptz,
  completed_at    timestamptz,
  synced_at       timestamptz not null default now()
);
create index on public.jobs (completed_at);
create index on public.jobs (client_id);

create table public.job_line_items (
  id           text primary key,
  job_id       text not null references public.jobs(id) on delete cascade,
  product_name text not null,
  quantity     numeric(10,2),
  unit_price   numeric(12,2),
  total_price  numeric(12,2),
  created_at   timestamptz,
  -- derived by the sync, never by hand:
  is_plan_discount boolean not null default false,
  is_onsite_upsell boolean not null default false   -- on job but not on the approved quote
);

create table public.visits (
  id            text primary key,
  job_id        text not null references public.jobs(id) on delete cascade,
  start_at      timestamptz,
  end_at        timestamptz,
  completed_at  timestamptz,
  status        text,
  synced_at     timestamptz not null default now()
);

create table public.visit_assignments (
  visit_id     text not null references public.visits(id) on delete cascade,
  employee_id  uuid not null references public.employees(id),
  primary key (visit_id, employee_id)
);

create table public.timesheet_entries (
  id           text primary key,
  employee_id  uuid not null references public.employees(id),
  job_id       text references public.jobs(id),
  visit_id     text references public.visits(id),
  started_at   timestamptz not null,
  ended_at     timestamptz,
  minutes      numeric(8,2),
  is_travel    boolean not null default false,
  synced_at    timestamptz not null default now()
);
create index on public.timesheet_entries (employee_id, started_at);

create table public.invoices (
  id           text primary key,
  branch_id    uuid references public.branches(id),
  client_id    text references public.clients(id),
  job_id       text references public.jobs(id),
  status       text,
  issued_at    timestamptz,
  due_at       timestamptz,
  subtotal     numeric(12,2),
  total        numeric(12,2),
  balance      numeric(12,2),
  synced_at    timestamptz not null default now()
);

create table public.payments (
  id           text primary key,
  invoice_id   text references public.invoices(id),
  client_id    text references public.clients(id),
  amount       numeric(12,2) not null,
  paid_at      timestamptz not null,
  synced_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Plans: one row per plan product in the Jobber catalog
-- ---------------------------------------------------------------------
create table public.plan_products (
  product_name       text primary key,
  service_line       text not null,          -- 'roof' | 'window'
  services_per_year  int  not null check (services_per_year > 0),
  discount_per_visit numeric(10,2) not null,
  grace_days         int not null default 30
);

-- ---------------------------------------------------------------------
-- Communications (Quo) and marketing (Meta, lead sheets)
-- ---------------------------------------------------------------------
create table public.communications (
  id            text primary key,              -- Quo call/message id
  kind          text not null check (kind in ('call','message')),
  direction     text not null check (direction in ('inbound','outbound')),
  is_automated  boolean not null default false, -- n8n auto-text etc.
  answered      boolean,                        -- calls: two-way contact made
  employee_id   uuid references public.employees(id),
  contact_phone text,
  client_id     text references public.clients(id),
  occurred_at   timestamptz not null,
  duration_sec  int
);
create index on public.communications (contact_phone, occurred_at);

create table public.ad_spend_daily (
  day          date not null,
  campaign_id  text not null,
  campaign_name text,
  adset_id     text,
  ad_id        text not null,
  ad_name      text,
  spend        numeric(12,2) not null default 0,
  impressions  int,
  clicks       int,
  meta_leads   int,
  primary key (day, ad_id)
);

create table public.marketing_leads (
  id            text primary key,              -- Meta lead id or sheet row id
  source        text not null,                 -- 'meta_form' | 'website_form'
  created_at    timestamptz not null,
  campaign_id   text,
  ad_id         text,
  form_name     text,
  phone         text,
  email         text,
  is_test       boolean not null default false,
  matched_client_id text references public.clients(id),
  match_method  text                            -- 'phone' | 'email' | 'manual'
);

-- ---------------------------------------------------------------------
-- Event log + sync bookkeeping + privacy audit
-- ---------------------------------------------------------------------
create table public.entity_events (
  id           bigint generated always as identity primary key,
  entity_type  text not null,
  entity_id    text not null,
  event        text not null,                  -- 'status_changed', 'created', ...
  from_value   text,
  to_value     text,
  occurred_at  timestamptz not null,
  recorded_at  timestamptz not null default now()
);
create index on public.entity_events (entity_type, entity_id, occurred_at);

create table public.sync_state (
  source          text primary key,            -- 'jobber', 'quo', 'meta', 'sheets'
  last_success_at timestamptz,
  last_error      text,
  last_error_at   timestamptz,
  cursor          jsonb
);

create table public.client_profile_views (
  id          bigint generated always as identity primary key,
  employee_id uuid not null references public.employees(id),
  client_id   text not null references public.clients(id),
  viewed_at   timestamptz not null default now()
);
