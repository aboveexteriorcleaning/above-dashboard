-- Access-rule tests. Every check raises an error if it fails.
\set ON_ERROR_STOP on
-- Same timezone everywhere the tests run (GitHub's database uses UTC).
set timezone = 'UTC';

-- ---------- every dashboard function runs without JIT (it adds ~1.5s per page) ----------
do $$
declare missing text;
begin
  select string_agg(p.proname, ', ') into missing
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app') and p.prokind = 'f'
    and not coalesce('jit=off' = any(p.proconfig), false);
  assert missing is null, format('functions without jit=off (re-run the jit block in your migration): %s', missing);
  raise notice 'ok  every dashboard function has jit off';
end $$;

-- ---------- every table must have access rules switched on ----------
do $$
declare missing text;
begin
  select string_agg(tablename, ', ') into missing
  from pg_tables where schemaname = 'public' and not rowsecurity;
  assert missing is null, format('tables without access rules: %s', missing);
  raise notice 'ok  every public table has access rules';
end $$;

-- ---------- sample data (fake people + fake clients) ----------
insert into auth.users values
 ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b'),
 ('00000000-0000-0000-0000-00000000000c'), ('00000000-0000-0000-0000-00000000000d'),
 ('00000000-0000-0000-0000-00000000000e');
insert into public.employees (id, full_name, jobber_user_id, auth_user_id, role) values
 ('11111111-0000-0000-0000-00000000000a','Kale (test)',  'U-K','00000000-0000-0000-0000-00000000000a','owner'),
 ('11111111-0000-0000-0000-00000000000b','Grady (test)', 'U-G','00000000-0000-0000-0000-00000000000b','owner'),
 ('11111111-0000-0000-0000-00000000000c','Connor (test)','U-C','00000000-0000-0000-0000-00000000000c','crew'),
 ('11111111-0000-0000-0000-00000000000d','Sage (test)',  'U-S','00000000-0000-0000-0000-00000000000d','crew');
-- user ...e has a login but is not on the team
insert into public.employee_costs values
 ('11111111-0000-0000-0000-00000000000c','2026-01-01',28),
 ('11111111-0000-0000-0000-00000000000d','2026-01-01',27);
insert into public.clients (id,name,email,phone) values
 ('C1','Test Client One','one@example.com','+15550000001'),
 ('C2','Test Client Two','two@example.com','+15550000002');
insert into public.quotes (id,client_id,salesperson_id,status,total,created_at,sent_at,approved_at) values
 ('Q1','C1','11111111-0000-0000-0000-00000000000a','converted',1000,'2026-10-01 18:00Z','2026-10-01 19:00Z','2026-10-02 20:00Z');
insert into public.quote_line_items values
 ('QL1','Q1','Softwash Roof Cleaning',1,1000,1000,false,0),
 ('QL2','Q1','Biannual Roof Cleaning Plan',1,-50,-50,false,1);
insert into public.jobs (id,client_id,quote_id,title,status,total,created_at,start_at,completed_at) values
 ('J1','C1','Q1','Roof (Connor+Sage)','archived',950,'2026-10-02','2026-10-10','2026-10-10 20:00Z'),
 ('J2','C2',null,'Windows (Sage only)','archived',400,'2026-10-03','2026-10-12','2026-10-12 20:00Z');
insert into public.job_line_items (id,job_id,product_name,total_price,is_plan_discount,is_onsite_upsell) values
 ('L1','J1','Softwash Roof Cleaning',1000,false,false),
 ('L2','J1','Biannual Roof Cleaning Plan',-50,true,false),
 ('L3','J1','Skylight Window Cleaning',60,false,true),
 ('L4','J2','Exterior Window Cleaning',400,false,false);
insert into public.visits (id,job_id,status) values ('V1','J1','completed'),('V2','J2','completed');
insert into public.visit_assignments values
 ('V1','11111111-0000-0000-0000-00000000000c'),('V1','11111111-0000-0000-0000-00000000000d'),
 ('V2','11111111-0000-0000-0000-00000000000d');
-- Connor clocked 3h on J1, Sage 1h on J1 -> Connor gets 75% credit
insert into public.timesheet_entries (id,employee_id,job_id,started_at,ended_at,minutes) values
 ('T1','11111111-0000-0000-0000-00000000000c','J1','2026-10-10 16:00Z','2026-10-10 19:00Z',180),
 ('T2','11111111-0000-0000-0000-00000000000d','J1','2026-10-10 16:00Z','2026-10-10 17:00Z',60),
 ('T3','11111111-0000-0000-0000-00000000000d','J2','2026-10-12 16:00Z','2026-10-12 18:00Z',120);
insert into raw.records (source,object_type,source_id,payload,received_via)
 values ('jobber','job','J1','{}','backfill');
-- what the sync does after every run
select app.refresh_derived();

-- helper to expect a failure
create function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'FAIL (should have been blocked): %', label;
exception when insufficient_privilege or raise_exception or others then
  if sqlerrm like 'FAIL (should%' then raise; end if;
  raise notice 'ok  blocked: %', label;
end $$;
grant execute on function pg_temp.expect_fail(text,text) to anon, authenticated;

-- ================= CONNOR (crew) =================
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
do $$
declare n int; r record;
begin
  select count(*) into n from public.jobs;              assert n = 0, 'crew saw jobs table';
  select count(*) into n from public.clients;           assert n = 0, 'crew saw clients table';
  select count(*) into n from public.timesheet_entries; assert n = 0, 'crew saw timesheets';
  select count(*) into n from public.employee_costs;    assert n = 0, 'crew saw pay';
  select count(*) into n from public.employees;         assert n = 1, 'crew saw other employees';
  select count(*) into n from public.client_profile_views; assert n = 0, 'crew saw audit log';

  select * into r from public.my_scorecard('2026-10-01','2026-10-31');
  assert r.completed_jobs = 1, 'connor job count';
  -- Even split: J1 (1010) had Connor + Sage assigned -> 505 each, whoever clocked more.
  assert r.revenue_credited = 505.00, format('connor revenue %s', r.revenue_credited);
  assert r.hours = 3.0 and r.hours_source = 'clocked', 'connor hours';
  assert r.revenue_per_hour = 168.33, format('connor per hour %s', r.revenue_per_hour);
  assert r.upsell_revenue = 30.00, format('connor upsell %s', r.upsell_revenue);       -- half of 60

  select count(*) into n from public.my_jobs('2026-10-01','2026-10-31');
  assert n = 1, 'connor should see only J1';
  select count(*) into n from public.my_jobs('2026-10-01','2026-10-31') where client_name = 'Test Client Two';
  assert n = 0, 'connor saw a client he did not work for';

  select * into r from public.company_summary('2026-10-01','2026-10-31');
  assert r.completed_revenue = 1410.00, format('company revenue %s', r.completed_revenue);
  assert r.active_plans = 1, 'active plans';
  raise notice 'ok  Connor: own scorecard, own jobs, company totals only';
end $$;
select pg_temp.expect_fail('select * from public.team_scorecards(''2026-10-01'',''2026-10-31'')', 'crew -> team rankings');
select pg_temp.expect_fail('select * from public.client_profile(''C1'')', 'crew -> client profile');
select pg_temp.expect_fail('select * from raw.records', 'crew -> raw data');
select pg_temp.expect_fail('select * from app.job_credit', 'crew -> internal credit table');
select pg_temp.expect_fail('select * from app.scorecard_for(''11111111-0000-0000-0000-00000000000d'',''2026-10-01'',''2026-10-31'')', 'crew -> Sage scorecard via internal fn');
select pg_temp.expect_fail('insert into public.jobs (id,created_at) values (''X'',now())', 'crew -> write job');
do $$ declare n int; begin
  update public.employees set role = 'owner' where auth_user_id = auth.uid();
  get diagnostics n = row_count;
  assert n = 0, 'crew promoted themselves to owner';
  raise notice 'ok  blocked: crew -> promote self to owner';
end $$;
reset role;

-- ================= SAGE (crew) sees her own, not Connor's =================
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d';
do $$ declare r record; n int; begin
  select * into r from public.my_scorecard('2026-10-01','2026-10-31');
  assert r.completed_jobs = 2, 'sage job count';
  assert r.revenue_credited = 905.00, format('sage revenue %s', r.revenue_credited); -- half of 1010 + all of 400
  assert r.hours = 3.0, format('sage hours %s (all clocked time in period)', r.hours);
  select count(*) into n from public.employees; assert n = 1, 'sage saw other employees';
  raise notice 'ok  Sage: own numbers only';
end $$;
reset role;

-- ================= LOGIN THAT IS NOT ON THE TEAM =================
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
select pg_temp.expect_fail('select * from public.my_scorecard(''2026-10-01'',''2026-10-31'')', 'stranger -> scorecard');
select pg_temp.expect_fail('select * from public.company_summary(''2026-10-01'',''2026-10-31'')', 'stranger -> company totals');
reset role;

-- ================= ANONYMOUS =================
set role anon;
reset request.jwt.claim.sub;
select pg_temp.expect_fail('select * from public.jobs', 'anon -> jobs');
select pg_temp.expect_fail('select * from public.company_summary(''2026-10-01'',''2026-10-31'')', 'anon -> company totals');
reset role;

-- ================= KALE (owner) =================
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare n int; r record; begin
  select count(*) into n from public.jobs;     assert n = 2, 'owner jobs';
  select count(*) into n from public.clients;  assert n = 2, 'owner clients';
  select count(*) into n from public.employees; assert n = 4, 'owner employees';
  select count(*) into n from public.team_scorecards('2026-10-01','2026-10-31'); assert n = 4, 'owner team view';
  select * into r from public.client_profile('C1');
  assert r.phone = '+15550000001', 'owner client contact';
  select count(*) into n from public.client_profile_views; assert n = 1, 'profile view logged';
  select * into r from public.team_scorecards('2026-10-01','2026-10-31') where full_name = 'Kale (test)';
  assert r.plans_sold = 1, 'kale plan credit';
  raise notice 'ok  Kale: everything, profile view logged';
end $$;
select pg_temp.expect_fail('insert into public.jobs (id,created_at) values (''X'',now())', 'owner -> write Jobber data (sync only)');
select pg_temp.expect_fail('delete from public.client_profile_views', 'owner -> erase audit log');
reset role;


-- ================= DASHBOARD v1: owner metrics, login linking =================
-- A new crew member set up by an owner, not yet signed in.
insert into auth.users values ('00000000-0000-0000-0000-00000000000f');
insert into public.employees (id, full_name, jobber_user_id, role, email)
  values ('11111111-0000-0000-0000-00000000000f','New Hire (test)','U-N','crew','newhire@example.com');

-- Connor: owner metrics are blocked; freshness is allowed; can't change own email.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.expect_fail('select public.owner_overview(''2026-10-01'',''2026-10-31'')', 'crew -> owner overview');
select pg_temp.expect_fail('select * from public.owner_monthly_trend(12)', 'crew -> owner trend');
do $$ begin perform * from public.data_freshness(); raise notice 'ok  crew -> data freshness allowed'; end $$;
do $$ declare n int; begin
  update public.employees set email = 'connor@evil.example' where auth_user_id = auth.uid();
  get diagnostics n = row_count; assert n = 0, 'crew changed own email';
  raise notice 'ok  blocked: crew -> change own email';
end $$;
reset role;

-- Stranger signs in with an email nobody set up: nothing linked.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
set request.jwt.claims = '{"email":"stranger@example.com"}';
do $$ declare r record; begin
  select * into r from public.link_my_login(); assert not r.linked, 'stranger got linked';
  raise notice 'ok  stranger -> not linked';
end $$;
reset role;

-- Stranger uses Connor's email, but Connor's profile is already linked to Connor: no hijack.
update public.employees set email = 'connor@example.com' where full_name = 'Connor (test)';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
set request.jwt.claims = '{"email":"connor@example.com"}';
do $$ declare r record; begin
  select * into r from public.link_my_login(); assert not r.linked, 'stranger hijacked a linked profile';
  raise notice 'ok  blocked: stranger -> hijack a linked profile';
end $$;
reset role;

-- New hire signs in with the email the owner entered (different case): linked as crew.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000f';
set request.jwt.claims = '{"email":"NewHire@Example.com"}';
do $$ declare r record; n int; begin
  select * into r from public.link_my_login();
  assert r.linked and r.role = 'crew', 'new hire not linked';
  select count(*) into n from public.employees; assert n = 1, 'new hire sees other employees';
  select count(*) into n from public.my_jobs('2026-10-01','2026-10-31'); assert n = 0, 'new hire sees jobs';
  raise notice 'ok  new hire linked as crew, sees only own (empty) data';
end $$;
reset role;

-- Kale (owner): overview numbers match the sample data.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare o jsonb; begin
  o := public.owner_overview('2026-10-01','2026-10-31');
  assert (o->'revenue'->>'completed')::numeric = 1410, format('overview completed %s', o->'revenue'->>'completed');
  assert (o->'revenue'->>'completed_jobs')::int = 2, 'overview job count';
  assert (o->'quotes'->>'sent')::int = 1 and (o->'quotes'->>'won')::int = 1, 'overview quotes';
  assert jsonb_array_length(o->'by_service') >= 1, 'overview by service';
  perform * from public.owner_monthly_trend(12);
  raise notice 'ok  Kale: owner overview + trend';
end $$;
-- An owner can't demote every owner (checked at commit, so run as its own statement).
select pg_temp.expect_fail('update public.employees set role = ''crew'' where role = ''owner''', 'owner -> demote every owner');
reset role;

-- Day boundaries are Pacific: a job finished 11pm Oct 31 Pacific counts in October.
insert into public.jobs (id,client_id,title,status,total,created_at,completed_at)
  values ('J9','C1','Late night (test)','archived',100,'2026-10-20','2026-11-01 06:00Z');
insert into public.job_line_items (id,job_id,product_name,total_price) values ('L9','J9','Pergola Cleaning',100);
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare o jsonb; begin
  o := public.owner_overview('2026-10-01','2026-10-31');
  assert (o->'revenue'->>'completed')::numeric = 1510, format('pacific boundary: %s', o->'revenue'->>'completed');
  raise notice 'ok  Pacific-time day boundaries';
end $$;
reset role;


-- ================= CREDIT RULE: even split; owners use scheduled time =================
-- September job worked by Kale (owner, doesn't clock in) and Connor (clocks in).
-- Kale also has a stray 0.5h timesheet that must be ignored.
insert into public.jobs (id,client_id,title,status,total,created_at,completed_at)
  values ('J10','C2','Owner + crew (test)','archived',800,'2026-09-10 18:00Z','2026-09-15 22:00Z');
insert into public.job_line_items (id,job_id,product_name,total_price) values ('L10','J10','Softwash Roof Cleaning',800);
insert into public.visits (id,job_id,status,start_at,end_at)
  values ('V10','J10','completed','2026-09-15 16:00Z','2026-09-15 18:30Z');           -- 2.5 h scheduled
insert into public.visits (id,job_id,status,start_at,end_at)
  values ('V11','J10','completed','2026-09-15 07:00Z','2026-09-16 06:59Z');           -- all-day: can't estimate
insert into public.visit_assignments values
  ('V10','11111111-0000-0000-0000-00000000000a'), ('V10','11111111-0000-0000-0000-00000000000c'),
  ('V11','11111111-0000-0000-0000-00000000000a');
insert into public.timesheet_entries (id,employee_id,job_id,started_at,ended_at,minutes) values
  ('T10','11111111-0000-0000-0000-00000000000c','J10','2026-09-15 16:00Z','2026-09-15 20:00Z',240),
  ('T11','11111111-0000-0000-0000-00000000000a','J10','2026-09-15 16:00Z','2026-09-15 16:30Z',30);  -- stray
update public.employees set tracks_time = false where role = 'owner';

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare k record; c record; begin
  select * into k from public.team_scorecards('2026-09-01','2026-09-30') where full_name = 'Kale (test)';
  select * into c from public.team_scorecards('2026-09-01','2026-09-30') where full_name = 'Connor (test)';
  assert k.revenue_credited = 400 and c.revenue_credited = 400, format('even split: kale %s connor %s', k.revenue_credited, c.revenue_credited);
  assert k.hours_source = 'scheduled' and k.hours = 2.5, format('kale hours %s (%s): stray timesheet must be ignored', k.hours, k.hours_source);
  assert k.unestimated_visits = 1, 'all-day visit should be counted as not estimable';
  assert k.revenue_per_hour = 160, format('kale per hour %s', k.revenue_per_hour);
  assert c.hours_source = 'clocked' and c.hours = 4 and c.revenue_per_hour = 100, format('connor %s h, %s/h', c.hours, c.revenue_per_hour);
  raise notice 'ok  even split; owner hours from schedule; stray owner timesheet ignored';
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
do $$ declare j record; begin
  select * into j from public.my_jobs('2026-09-01','2026-09-30');
  -- Day clock-ins aren't tied to jobs, so per-job hours are scheduled visit time (2.5h on V10).
  assert j.my_revenue = 400 and j.crew_size = 2 and j.my_hours = 2.5 and j.hours_source = 'scheduled',
    format('connor job row %s', row_to_json(j));
  raise notice 'ok  my_jobs shows even share, crew size and scheduled hours per job';
end $$;
reset role;


-- ================= COMMISSION vs HOURLY =================
-- Wages: Connor $20, Sage $21.
insert into public.employee_wages values
  ('11111111-0000-0000-0000-00000000000c','2026-01-01',20),
  ('11111111-0000-0000-0000-00000000000d','2026-01-01',21);
-- Sep 15: J10 (from the test above) = $800, Kale + Connor (2 people) -> 15% each = $120.
--         Connor clocked 4h x $20 = $80 -> commission day. Break-even 6.0h.
-- Sep 16: J11 = $500 solo Sage -> 20% = $100. Sage clocked 6h x $21 = $126 -> hourly day.
-- Sep 17: J12 = $1000, Connor + Sage + Kale (3) -> 10% each = $100.
--         Connor 3h x $20 = $60 -> commission; Sage 6h x $21 = $126 -> hourly.
insert into public.jobs (id,client_id,title,status,total,created_at,completed_at) values
  ('J11','C2','Solo (test)','archived',500,'2026-09-10 18:00Z','2026-09-18 22:00Z'),   -- marked complete 2 days late
  ('J12','C1','Three-person (test)','archived',1000,'2026-09-10 18:00Z','2026-09-17 23:00Z');
insert into public.job_line_items (id,job_id,product_name,total_price) values
  ('L11','J11','Exterior Window Cleaning',500), ('L12','J12','Softwash Siding Cleaning',1000);
insert into public.visits (id,job_id,status,start_at,end_at) values
  ('V12','J11','completed','2026-09-16 16:00Z','2026-09-16 22:00Z'),
  ('V13','J12','completed','2026-09-17 16:00Z','2026-09-17 19:00Z');
insert into public.visit_assignments values
  ('V12','11111111-0000-0000-0000-00000000000d'),
  ('V13','11111111-0000-0000-0000-00000000000c'),('V13','11111111-0000-0000-0000-00000000000d'),
  ('V13','11111111-0000-0000-0000-00000000000a');
insert into public.timesheet_entries (id,employee_id,started_at,ended_at,minutes) values      -- day clock-ins, no job
  ('T12','11111111-0000-0000-0000-00000000000d','2026-09-16 15:00Z','2026-09-16 21:00Z',360),
  ('T13','11111111-0000-0000-0000-00000000000c','2026-09-17 16:00Z','2026-09-17 19:00Z',180),
  ('T14','11111111-0000-0000-0000-00000000000d','2026-09-17 15:00Z','2026-09-17 21:00Z',360);

-- Connor sees his own days; not wages tables, not team commission.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
set request.jwt.claims = '{"email":"connor@example.com"}';
do $$ declare d record; s record; n int; begin
  select * into d from public.my_commission_days('2026-09-01','2026-09-30') where day = '2026-09-15';
  assert d.commission = 120 and d.hourly_pay = 80 and d.break_even_hours = 6 and d.commission_day,
    format('connor sep 15 %s', row_to_json(d));
  select * into d from public.my_commission_days('2026-09-01','2026-09-30') where day = '2026-09-17';
  assert d.commission = 100 and d.hourly_pay = 60 and d.commission_day, format('connor sep 17 %s', row_to_json(d));
  select * into s from public.my_commission_summary('2026-09-01','2026-09-30');
  assert s.commission_earned = 220 and s.commission_days = 2 and s.work_days = 2 and not s.missing_wage,
    format('connor summary %s', row_to_json(s));
  select count(*) into n from public.employee_wages; assert n = 0, 'crew can see wages';
  select count(*) into n from public.commission_rates; assert n = 0, 'crew can read rate table directly';
  raise notice 'ok  Connor: 2-person and 3-person commission days, own summary only';
end $$;
select pg_temp.expect_fail('select * from public.team_commission(''2026-09-01'',''2026-09-30'')', 'crew -> team commission');
select pg_temp.expect_fail('select * from app.commission_days(''11111111-0000-0000-0000-00000000000d'',''2026-09-01'',''2026-09-30'')', 'crew -> Sage commission via internal fn');
reset role;

-- Sage: solo job counts on the visit day (Sep 16) even though it was marked complete Sep 18.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d';
do $$ declare d record; s record; begin
  select * into d from public.my_commission_days('2026-09-01','2026-09-30') where day = '2026-09-16';
  assert d.jobs = 1 and d.commission = 100 and d.hourly_pay = 126 and not d.commission_day,
    format('sage sep 16 %s', row_to_json(d));
  select * into s from public.my_commission_summary('2026-09-01','2026-09-30');
  assert s.commission_earned = 0 and s.commission_days = 0 and s.work_days = 2, format('sage summary %s', row_to_json(s));
  raise notice 'ok  Sage: solo 20%% and 3-person 10%% both lose to hourly; job counted on visit day';
end $$;
reset role;

-- Owners see everyone who clocks in (not owners); missing wage is flagged, not guessed.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare n int; c record; begin
  select count(*) into n from public.team_commission('2026-09-01','2026-09-30') where full_name like 'Kale%';
  assert n = 0, 'owners should not appear in commission (they do not clock in)';
  select * into c from public.team_commission('2026-09-01','2026-09-30') where full_name = 'Connor (test)';
  assert c.commission_earned = 220 and c.commission_days = 2, format('team connor %s', row_to_json(c));
  raise notice 'ok  owners: team commission view';
end $$;
reset role;
delete from public.employee_wages where employee_id = '11111111-0000-0000-0000-00000000000d';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d';
do $$ declare s record; begin
  select * into s from public.my_commission_summary('2026-09-01','2026-09-30');
  assert s.missing_wage and s.commission_days = 0, 'no wage -> flagged, never counted as a commission day';
  raise notice 'ok  missing wage is flagged';
end $$;
reset role;


-- ================= QUOTES: sent and approved counted in their own periods =================
-- Already present: Q1 sent Oct 1, approved Oct 2.
insert into public.quotes (id,client_id,salesperson_id,status,total,created_at,sent_at,approved_at) values
 ('QS','C1','11111111-0000-0000-0000-00000000000a','converted',500,'2026-09-25 18:00Z','2026-09-25 19:00Z','2026-10-05 19:00Z'), -- Sep -> Oct
 ('QO','C2','11111111-0000-0000-0000-00000000000a','approved', 700,'2026-10-20 18:00Z','2026-10-20 19:00Z','2026-11-03 19:00Z'), -- Oct -> Nov
 ('QN','C2','11111111-0000-0000-0000-00000000000a','approved', 300,'2026-10-10 18:00Z', null,              '2026-10-10 20:00Z'), -- never sent
 ('QD','C2','11111111-0000-0000-0000-00000000000a','deleted',  900,'2026-10-11 18:00Z','2026-10-11 19:00Z', null);              -- deleted: ignored

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare o jsonb; k record; begin
  o := public.owner_overview('2026-10-01','2026-10-31');
  -- October sent: Q1, QO, QN (QD deleted). October approved: Q1, QS, QN.
  assert (o->'quotes'->>'sent')::int = 3 and (o->'quotes'->>'won')::int = 3,
    format('october quotes %s', o->'quotes');
  o := public.owner_overview('2026-09-01','2026-09-30');
  assert (o->'quotes'->>'sent')::int = 1 and (o->'quotes'->>'won')::int = 0, format('september quotes %s', o->'quotes');
  o := public.owner_overview('2026-11-01','2026-11-30');
  assert (o->'quotes'->>'sent')::int = 0 and (o->'quotes'->>'won')::int = 1, format('november quotes %s', o->'quotes');
  select * into k from public.team_scorecards('2026-10-01','2026-10-31') where full_name = 'Kale (test)';
  assert k.quotes_sent = 3 and k.quotes_approved = 3, format('team kale october %s of %s', k.quotes_approved, k.quotes_sent);
  raise notice 'ok  quotes: sent and approved each counted in their own period, on Overview and Team';
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
do $$ declare c record; begin
  select * into c from public.company_summary('2026-10-01','2026-10-31');
  assert c.quotes_sent = 3 and c.quotes_approved = 3, format('crew company totals %s of %s', c.quotes_approved, c.quotes_sent);
  raise notice 'ok  quotes: crew company totals use the same rule';
end $$;
reset role;

-- ---------- maintenance plans ----------
insert into public.clients (id,name) values ('C10','Plan A'),('C11','Plan A duplicate'),('C12','Old-style plan'),
  ('C13','Lapsed plan'),('C14','No plan'),('C15','Deleted plan');
insert into public.properties (id,client_id,street) values ('P10','C10','12 Elm St'),('P11','C11',' 12  ELM st '),
  ('P12','C12','99 Oak Ave'),('P13','C13','5 Pine Rd'),('P14','C14','7 Fir Ln'),('P15','C15','8 Ash Ct');
insert into public.jobs (id,client_id,property_id,title,status,total,created_at,start_at,completed_at) values
 ('JP10','C10','P10','Gutters','upcoming',300,now(),now() + interval '120 days',null),
 ('JP11','C11','P11','Gutters','upcoming',300,now(),now() + interval '130 days',null),
 ('JP12','C12','P12','6-Month Roof Maintenance Plan','upcoming',400,now(),now() + interval '90 days',null),
 ('JP13','C13','P13','Windows','archived',300,now() - interval '300 days',now() - interval '300 days',now() - interval '300 days'),
 ('JP14','C14','P14','Windows','upcoming',300,now(),now() + interval '30 days',null),
 ('JP15','C15','P15','Windows','deleted',300,now(),now() + interval '30 days',null);
insert into public.job_line_items (id,job_id,product_name,total_price) values
 ('LP10','JP10','Quarterly Gutter Plan',-40),('LP11','JP11','Quarterly Gutter Plan',-40),
 ('LP13','JP13','Biannual Window Cleaning Plan',-50),('LP14','JP14','Exterior Window Cleaning',300),
 ('LP15','JP15','Biannual Window Cleaning Plan',-50);
select app.refresh_derived();
do $$ declare pp record; begin
  select * into pp from public.plan_products where product_name = 'Quarterly Gutter Plan';
  assert pp.services_per_year = 4 and pp.service_line = 'roof' and pp.discount_per_visit = 40, format('auto catalog %s', pp);
  assert (select is_plan_discount from public.job_line_items where id = 'LP10'), 'new plan line flagged';
  assert app.plan_visits_per_year('Biannual Window Cleaning Plan') = 2 and app.plan_visits_per_year('Annual Roof Cleaning Plan') = 1
     and app.plan_visits_per_year('4-Month Roof Cleaning Plan') = 3 and app.plan_visits_per_year('Monthly Window Cleaning Plan') = 12, 'visits per year';
  raise notice 'ok  plans: new plan names join the catalog automatically';
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
do $$ declare c record; begin
  select * into c from public.company_summary('2026-10-01','2026-10-31');
  -- C1 (recent plan visit) + 12 Elm St once (two client records) + 99 Oak Ave (plan in title)
  assert c.active_plans = 3, format('active plans %s', c.active_plans);
  raise notice 'ok  plans: booked next visits count, once per address; lapsed, deleted and non-plan jobs do not';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert (public.owner_overview('2026-10-01','2026-10-31')->'customers'->>'active_plans')::int = 3, 'overview plans';
end $$;
reset role;

-- ---------- plans tab ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.expect_fail($q$select public.owner_plans('2026-10-01','2026-10-31')$q$, 'crew cannot see plan KPIs');
select pg_temp.expect_fail($q$select * from public.plan_customers()$q$, 'crew cannot see the plan customer list');
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare o jsonb; r record; begin
  select * into r from public.plan_customers() where client_id = 'C1';
  assert r.status = 'not_booked' and r.last_visit = '2026-10-10' and r.due_date = '2027-04-10', format('C1 row %s', r);
  select * into r from public.plan_customers() where street = '5 Pine Rd';
  assert r.status = 'overdue' and r.days_overdue > 0 and r.annual_value = 0, format('lapsing row %s', r);
  assert (select count(*) from public.plan_customers() where home_key = '12 elm st') = 1, 'duplicate clients collapse to one home';
  assert (select status from public.plan_customers() where street = '99 Oak Ave') = 'on_schedule', 'booked = on schedule';
  assert (select count(*) from public.plan_customers()) = 4, 'four plan homes';
  o := public.owner_plans('2026-10-01','2026-10-31');
  assert (o->>'revenue')::numeric = 1010 and (o->>'visits')::int = 1, format('plan revenue %s', o);
  assert (o->>'booked_ahead')::numeric = 1000 and (o->>'booked_ahead_visits')::int = 3, format('booked ahead %s', o);
  assert (o->>'homes')::int = 3 and (o->>'annual_value')::numeric = 3900, format('homes/annual %s', o);
  assert (o->>'discounts')::numeric = 50, format('discounts %s', o);
  assert jsonb_array_length(o->'monthly') = 12 and jsonb_array_length(o->'ahead') = 6, 'monthly + ahead lengths';
  assert (o->'status'->>'overdue')::int = 1, format('status counts %s', o->'status');
  raise notice 'ok  plans tab: revenue, booked ahead, annual value, and on-schedule flags';
  -- October: serviced homes = C1 (J1, on a plan) and C2 (J2, no plan) -> 1 of 2
  assert (o->'conversion'->>'serviced')::int = 2 and (o->'conversion'->>'on_plan')::int = 1
     and (o->'conversion'->>'rate')::numeric = 0.5, format('conversion %s', o->'conversion');
  raise notice 'ok  plans tab: plan conversion = serviced homes now on a plan';
end $$;
reset role;

-- ---------- who sold each plan ----------
insert into public.clients (id,name) values ('C20','Sold on site'),('C21','Sold then booked'),('C22','Not sold');
insert into public.properties (id,client_id,street) values ('P20','C20','1 Sale St'),('P21','C21','2 Sale St'),('P22','C22','3 Sale St');
insert into public.jobs (id,client_id,property_id,title,status,total,created_at,start_at,completed_at) values
 ('JS1','C20','P20','Windows','archived',350,'2026-10-01','2026-10-15 16:00Z','2026-10-15 22:00Z'),
 ('JS2','C21','P21','Windows','archived',400,'2026-10-01','2026-10-16 16:00Z','2026-10-16 20:00Z'),
 ('JS3','C21','P21','Windows','upcoming',350,'2026-10-16 20:05Z','2027-04-16 16:00Z',null),
 ('JS4','C22','P22','Windows','archived',300,'2026-10-01','2026-10-17 16:00Z','2026-10-17 20:00Z');
insert into public.job_line_items (id,job_id,product_name,total_price,created_at) values
 ('LS1a','JS1','Exterior Window Cleaning',400,'2026-10-01'),
 ('LS1b','JS1','Biannual Window Cleaning Plan',-50,'2026-10-15 21:55Z'),   -- added at the door
 ('LS2','JS2','Exterior Window Cleaning',400,'2026-10-01'),
 ('LS3a','JS3','Exterior Window Cleaning',400,'2026-10-16 20:05Z'),
 ('LS3b','JS3','Biannual Window Cleaning Plan',-50,'2026-10-16 20:05Z'),   -- next visit booked right after
 ('LS4','JS4','Exterior Window Cleaning',300,'2026-10-01');
insert into public.visits (id,job_id,status,start_at) values
 ('VS1','JS1','completed','2026-10-15 16:00Z'),('VS2','JS2','completed','2026-10-16 16:00Z'),
 ('VS3','JS3','scheduled','2027-04-16 16:00Z'),('VS4','JS4','completed','2026-10-17 16:00Z');
insert into public.visit_assignments values
 ('VS1','11111111-0000-0000-0000-00000000000c'),('VS1','11111111-0000-0000-0000-00000000000d'),
 ('VS2','11111111-0000-0000-0000-00000000000c'),('VS4','11111111-0000-0000-0000-00000000000c');
select app.refresh_derived();
do $$ declare s record; begin
  select * into s from app.plan_sales where home_key = '1 sale st';
  assert s.channel = 'on_site' and s.how = 'added_on_site', format('door sale %s', s);
  select * into s from app.plan_sales where home_key = '2 sale st';
  assert s.channel = 'on_site' and s.how = 'booked_after_visit' and s.sale_job_id = 'JS2', format('booked-after sale %s', s);
  select * into s from app.plan_sales where home_key = 'client:C1';
  assert s.channel = 'pre_job' and s.how = 'quote' and s.salesperson_id = '11111111-0000-0000-0000-00000000000a', format('quote sale %s', s);
  assert not (select attributed from app.plan_sales where home_key = '12 elm st'), 'no seller found = unattributed';
  raise notice 'ok  plan sales: quote, added at the door, and booked-after-visit are told apart';
end $$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
do $$ declare m record; begin
  select * into m from public.my_plan_sales('2026-10-01','2026-10-31');
  -- full credit for the two-person door sale + the booked-after sale
  assert m.plans_sold = 2 and m.on_site = 2 and m.pre_job = 0, format('connor sales %s', m);
  -- worked 1/2/3 Sale St (C1 was already on a plan): converted 2 of 3
  assert m.serviced_homes = 3 and m.converted_homes = 2, format('connor conversion %s', m);
  assert m.value_sold = 700 + 700, format('connor value %s', m.value_sold);
  raise notice 'ok  plan sales: crew sees their own credited sales and on-site conversion';
end $$;
select pg_temp.expect_fail($q$select * from public.team_plan_sales('2026-10-01','2026-10-31')$q$, 'crew cannot compare plan sales');
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare t record; o jsonb; begin
  select * into t from public.team_plan_sales('2026-10-01','2026-10-31') where full_name = 'Kale (test)';
  assert t.plans_sold = 1 and t.pre_job = 1 and t.value_sold = 1900, format('kale %s', t);
  select * into t from public.team_plan_sales('2026-10-01','2026-10-31') where full_name = 'Sage (test)';
  assert t.plans_sold = 1 and t.value_sold = 700 and t.converted_homes = 1, format('sage %s', t);
  assert (select sold_by from public.plan_customers() where street = '1 Sale St') = 'Connor (test) & Sage (test)', 'sheet sold by';
  o := public.owner_plans('2026-10-01','2026-10-31');
  -- 2 on site; pre-job = Kale's quote plus the earlier test plans that have no seller
  assert (o->'channels'->>'on_site')::int = 2
     and (o->'channels'->>'pre_job')::int - (o->'channels'->>'unattributed')::int = 1, format('channels %s', o->'channels');
  raise notice 'ok  plan sales: owners see everyone, the sheet shows who sold each plan';
end $$;
reset role;

-- ---------- first-time vs returning customers (November, by address) ----------
insert into public.clients (id,name) values ('C30','Returning'),('C32','Returning (duplicate record)'),
  ('C31','Plan visit'),('C33','Brand new'),('C34','Returning, sold a plan');
insert into public.properties (id,client_id,street) values ('P30','C30','4 Return St'),('P32','C32','4 return st'),
  ('P31','C31','5 Plan St'),('P33','C33','6 New St'),('P34','C34','7 Sold St');
insert into public.jobs (id,client_id,property_id,title,status,total,created_at,start_at,completed_at) values
 ('R1','C30','P30','Windows','archived',300,'2026-09-01','2026-09-05','2026-09-05 20:00Z'),
 ('R2','C32','P32','Roof','archived',800,'2026-11-02 18:00Z','2026-11-05','2026-11-05 20:00Z'),  -- other service, other record
 ('R3','C31','P31','Windows','archived',350,'2026-05-01','2026-05-10','2026-05-10 20:00Z'),
 ('R4','C31','P31','Windows','archived',350,'2026-05-10','2026-11-06','2026-11-06 20:00Z'),
 ('R5','C33','P33','Gutters','archived',250,'2026-11-02 18:00Z','2026-11-07','2026-11-07 20:00Z'),
 ('R6','C34','P34','Windows','archived',300,'2026-07-25','2026-08-01','2026-08-01 20:00Z'),
 ('R7','C34','P34','Windows','archived',350,'2026-11-02 18:00Z','2026-11-08','2026-11-08 20:00Z');
insert into public.job_line_items (id,job_id,product_name,total_price,created_at) values
 ('RL3','R3','Biannual Window Cleaning Plan',-50,'2026-05-01'),
 ('RL4','R4','Biannual Window Cleaning Plan',-50,'2026-05-10'),
 ('RL7','R7','Biannual Window Cleaning Plan',-50,'2026-11-08 19:00Z');
select app.refresh_derived();
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare c jsonb; begin
  c := public.owner_overview('2026-11-01','2026-11-30')->'customers';
  assert (c->>'new')::int = 1, format('new %s', c);
  assert (c->>'returning_own')::int = 2 and (c->>'returning_plan')::int = 1 and (c->>'returning')::int = 3, format('returning %s', c);
  assert (select new_clients from public.company_summary('2026-11-01','2026-11-30')) = 1, 'crew new customers by address';
  raise notice 'ok  customers: by address; returning split into on their own vs plan visits';
  -- November new-customer bookings from Jobber: only 6 New St. 4 Return St is a returning home on a
  -- duplicate client record, and 7 Sold St had a job in August.
  assert (public.owner_leads('2026-11-01','2026-11-30')->>'new_booked')::int = 1, 'new customers booked from Jobber';
  assert (public.owner_leads('2026-11-01','2026-11-30')->>'new_quoted')::int = 0, 'no new quotes in November';
end $$;
reset role;

-- ---------- Quo: leads, speed to lead, missed calls (December) ----------
insert into public.quo_phone_numbers (id, phone_number, name) values ('PN1', '+13605550100', 'Main line');
insert into public.quo_users (id, email, name) values ('USK', null, 'Kale (test)');
insert into public.clients (id, name, phone) values ('CA', 'Lead A', '+13605551001');
insert into public.quotes (id, client_id, status, total, created_at, sent_at) values ('QA', 'CA', 'awaiting_response', 500, '2026-12-02', '2026-12-02 19:00Z');
insert into public.jobs (id, client_id, title, status, total, created_at) values ('JA', 'CA', 'Roof', 'upcoming', 500, '2026-12-05 18:00Z');
insert into public.communications (id, kind, direction, contact_phone, occurred_at, answered_at, duration_sec, has_voicemail, quo_user_id, phone_number_id, text_head_hash, text_tail_hash) values
 ('cA',  'call',    'inbound',  '+13605551001', '2026-12-01 17:00Z', '2026-12-01 17:00:05Z', 120, false, 'USK', 'PN1', null, null),
 ('mB1', 'message', 'outbound', '+13605551002', '2026-12-02 18:00Z', null, null, false, 'USK', 'PN1', 'h1', 't1'),
 ('mB2', 'message', 'inbound',  '+13605551002', '2026-12-02 18:10Z', null, null, false, null,  'PN1', null, null),
 ('mB3', 'message', 'outbound', '+13605551002', '2026-12-02 18:30Z', null, null, false, 'USK', 'PN1', 'zz', 'yy'),
 ('mC1', 'message', 'outbound', '+13605551003', '2026-12-02 18:01Z', null, null, false, 'USK', 'PN1', 'h1', 't1'),
 ('mD1', 'message', 'outbound', '+13605551004', '2026-12-02 18:00Z', null, null, false, 'USK', 'PN1', 'h1', 't1'),
 ('cD2', 'call',    'outbound', '+13605551004', '2026-12-02 18:03Z', '2026-12-02 18:03:10Z', 60, false, 'USK', 'PN1', null, null),
 ('cE1', 'call',    'inbound',  '+13605551005', '2026-12-03 17:00Z', null, 30, true,  null,  'PN1', null, null),
 ('cE2', 'call',    'outbound', '+13605551005', '2026-12-03 17:20Z', '2026-12-03 17:20:05Z', 90, false, 'USK', 'PN1', null, null),
 ('cF',  'call',    'inbound',  '+13605551006', '2026-12-04 17:00Z', null, 0, false, null, 'PN1', null, null),
 ('cG',  'call',    'inbound',  '+15550000001', '2026-12-05 17:00Z', '2026-12-05 17:00:03Z', 60, false, 'USK', 'PN1', null, null);
select app.refresh_quo();
do $$ begin
  assert (select is_automated from public.communications where id = 'mB1') and (select is_automated from public.communications where id = 'mC1'), 'form auto-text detected';
  assert not (select is_automated from public.communications where id = 'mB3'), 'human reply is not automated';
  assert (select employee_id from public.communications where id = 'cA') = '11111111-0000-0000-0000-00000000000a', 'quo user linked to team member';
  assert (select client_id from public.communications where id = 'cA') = 'CA', 'caller linked to Jobber client';
  raise notice 'ok  quo: auto-texts spotted, people and customers linked';
end $$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.expect_fail($q$select public.owner_leads('2026-12-01','2026-12-31')$q$, 'crew cannot see lead numbers');
select pg_temp.expect_fail($q$select * from public.lead_list('2026-12-01','2026-12-31')$q$, 'crew cannot see the lead list');
do $$ begin
  assert (select count(*) from public.communications) = 0 and (select count(*) from public.quo_users) = 0, 'crew sees no calls or texts';
  raise notice 'ok  quo: crew cannot read calls, texts or Quo users';
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare o jsonb; p jsonb; begin
  o := public.owner_leads('2026-12-01','2026-12-31');
  assert (o->>'leads')::int = 5, format('leads %s', o->>'leads');        -- A, B, C, D, E (not the existing customer, not the hang-up)
  -- C got the auto-text and never answered: waiting on them, not on us
  assert (o->>'no_reply')::int = 0 and (o->>'responded')::int = 4 and (o->>'waiting_on_them')::int = 1, format('replies %s', o);
  assert (o->>'median_response_min')::numeric = 11.5, format('median %s', o->>'median_response_min');  -- 0, 3, 20, 20
  -- B got the auto-text at 18:00, replied 18:10, we answered 18:30: 20 min from their reply, not 30
  assert (select response_minutes from public.lead_list('2026-12-01','2026-12-31') where contact_phone = '+13605551002') = 20
     and (select clock_from from public.lead_list('2026-12-01','2026-12-31') where contact_phone = '+13605551002') = 'their reply', 'form lead clock starts at their reply';
  -- D: we called at 18:03 before they replied: 3 min from the auto-text
  assert (select response_minutes from public.lead_list('2026-12-01','2026-12-31') where contact_phone = '+13605551004') = 3, 'we reached out first';
  -- A called Dec 1 17:00, quote sent Dec 2 19:00 (26h, the slow bucket), booked
  assert (o->'quote_speed'->>'quoted')::int = 1 and (o->'quote_speed'->>'avg_hours')::numeric = 26
     and (o->'quote_speed'->>'slow_quoted')::int = 1 and (o->'quote_speed'->>'slow_booked')::int = 1
     and (o->'quote_speed'->>'fast_quoted')::int = 0, format('quote speed %s', o->'quote_speed');
  assert (o->'speed_booking'->>'fast_leads')::int = 2 and (o->'speed_booking'->>'fast_booked')::int = 1
     and (o->'speed_booking'->>'slow_leads')::int = 2 and (o->'speed_booking'->>'slow_booked')::int = 0, format('speed booking %s', o->'speed_booking');
  assert (o->>'within_5_min')::numeric = 0.5, format('within 5 %s', o->>'within_5_min');   -- A and D, of the 4 we could answer
  assert (o->>'quoted')::int = 1 and (o->>'booked')::int = 1 and (o->>'booked_value')::numeric = 500, format('funnel %s', o);
  -- Jobber-side: CA (first quote Dec 2, first job Dec 5) is a new customer quoted and booked in December
  assert (o->>'new_quoted')::int = 1 and (o->>'new_booked')::int = 1 and (o->>'new_booked_value')::numeric = 500
     and (o->>'new_quoted_booked')::int = 1 and (o->>'new_quoted_no_phone')::int = 0, format('jobber funnel %s', o);
  assert (o->'missed'->>'missed')::int = 2 and (o->'missed'->>'inbound_calls')::int = 4
     and (o->'missed'->>'returned')::int = 1 and (o->'missed'->>'not_returned')::int = 1
     and (o->'missed'->>'median_return_min')::numeric = 20, format('missed %s', o->'missed');
  select x into p from jsonb_array_elements(o->'people') x where x->>'name' = 'Kale (test)';
  assert (p->>'calls_answered')::int = 2 and (p->>'calls_made')::int = 2 and (p->>'texts_sent')::int = 1, format('kale %s', p);
  assert (select count(*) from public.lead_list('2026-12-01','2026-12-31')) = 5, 'lead list';
  assert (select source from public.lead_list('2026-12-01','2026-12-31') where contact_phone = '+13605551003') = 'Form (auto-text)', 'form source';
  -- 9am and 10am Pacific leads are in hours; add a 9:30pm one below and check it isn't
  assert (select bool_and(in_hours) from public.lead_list('2026-12-01','2026-12-31')), 'daytime leads in business hours';
  raise notice 'ok  quo: leads, speed to lead, missed calls and booked work';
end $$;
reset role;

insert into public.communications (id, kind, direction, contact_phone, occurred_at, answered_at, duration_sec, phone_number_id)
values ('cH', 'call', 'inbound', '+13605551008', '2026-12-07 05:30Z', '2026-12-07 05:30:02Z', 60, 'PN1');  -- Sun 9:30pm Pacific
select app.refresh_quo();
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert not (select in_hours from public.lead_list('2026-12-01','2026-12-31') where contact_phone = '+13605551008'), '9:30pm is after hours';
  raise notice 'ok  quo: business hours are 7am-7pm every day';
end $$;
reset role;

-- Form leads who went quiet: a follow-up after 24h isn't a reply.
insert into public.communications (id, kind, direction, contact_phone, occurred_at, answered_at, duration_sec, quo_user_id, phone_number_id, text_head_hash, text_tail_hash) values
 ('fJ1', 'message', 'outbound', '+13605551011', '2026-12-08 18:00Z', null, null, 'USK', 'PN1', 'h1', 't1'),  -- auto-text
 ('fJ2', 'message', 'outbound', '+13605551011', '2026-12-10 17:00Z', null, null, 'USK', 'PN1', 'f1', 'f2'),  -- our follow-up, 47h later
 ('fJ3', 'message', 'inbound',  '+13605551011', '2026-12-10 19:00Z', null, null, null,  'PN1', null, null),  -- they finally reply
 ('fJ4', 'message', 'outbound', '+13605551011', '2026-12-10 19:15Z', null, null, 'USK', 'PN1', 'g1', 'g2'),  -- we answer 15 min later
 ('fK1', 'message', 'outbound', '+13605551012', '2026-12-08 18:00Z', null, null, 'USK', 'PN1', 'h1', 't1'),  -- auto-text
 ('fK2', 'message', 'outbound', '+13605551012', '2026-12-10 17:00Z', null, null, 'USK', 'PN1', 'f1', 'f2');  -- follow-up, never answered
select app.refresh_quo();
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare r record; begin
  select * into r from public.lead_list('2026-12-01','2026-12-31') where contact_phone = '+13605551011';
  assert r.response_minutes = 15 and r.clock_from = 'their reply' and not r.waiting_on_them, format('late reply %s', r);
  select * into r from public.lead_list('2026-12-01','2026-12-31') where contact_phone = '+13605551012';
  assert r.waiting_on_them and r.response_minutes is null and r.first_response_at is null, format('never replied %s', r);
  raise notice 'ok  quo: follow-ups after 24h of silence do not count as a reply';
end $$;
reset role;

-- ---------- follow-ups (September, so every window has closed) ----------
insert into public.clients (id, name, phone) values ('CL1', 'Followed-up lead', '+13605552001');
insert into public.jobs (id, client_id, title, status, total, created_at) values ('JL1', 'CL1', 'Windows', 'upcoming', 400, '2026-09-05 18:00Z');
insert into public.communications (id, kind, direction, contact_phone, occurred_at, answered_at, duration_sec, quo_user_id, phone_number_id, text_head_hash, text_tail_hash) values
 ('u1a', 'message', 'outbound', '+13605552001', '2026-09-01 18:00Z', null, null, 'USK', 'PN1', 'h1', 't1'),   -- auto-text
 ('u1b', 'message', 'outbound', '+13605552001', '2026-09-02 19:00Z', null, null, 'USK', 'PN1', 'x1', 'x2'),   -- 1st follow-up (+25h)
 ('u1c', 'call',    'outbound', '+13605552001', '2026-09-03 20:00Z', null, 20,   'USK', 'PN1', null, null),   -- 2nd follow-up (+25h)
 ('u1d', 'message', 'inbound',  '+13605552001', '2026-09-03 21:00Z', null, null, null,  'PN1', null, null),   -- they reply
 ('u2a', 'message', 'outbound', '+13605552002', '2026-09-01 18:00Z', null, null, 'USK', 'PN1', 'h1', 't1'),   -- auto-text, never followed up
 ('u3a', 'message', 'outbound', '+13605552003', '2026-09-01 18:00Z', null, null, 'USK', 'PN1', 'h1', 't1'),   -- auto-text
 ('u3b', 'message', 'outbound', '+13605552003', '2026-09-02 18:30Z', null, null, 'USK', 'PN1', 'x1', 'x2'),   -- 1st follow-up only
 ('u4a', 'message', 'outbound', '+13605552004', '2026-09-01 18:00Z', null, null, 'USK', 'PN1', 'h1', 't1'),   -- auto-text
 ('u4b', 'message', 'inbound',  '+13605552004', '2026-09-01 20:00Z', null, null, null,  'PN1', null, null),   -- replied same day
 ('u4c', 'message', 'outbound', '+13605552004', '2026-09-01 20:05Z', null, null, 'USK', 'PN1', 'y1', 'y2');
select app.refresh_quo();
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare f jsonb; begin
  f := public.owner_leads('2026-09-01','2026-09-30')->'follow_up';
  assert (f->>'fu1_due')::int = 3 and (f->>'fu1_done')::int = 2, format('first follow-ups %s', f);    -- L1, L3 done; L2 missed; L4 replied
  assert (f->>'fu2_due')::int = 2 and (f->>'fu2_done')::int = 1, format('second follow-ups %s', f);   -- L1 done; L3 missed
  assert (f->>'followed_up')::int = 2 and (f->>'followed_up_replied')::int = 1 and (f->>'followed_up_booked')::int = 1, format('follow-up results %s', f);
  assert (select follow_up from public.lead_list('2026-09-01','2026-09-30') where contact_phone = '+13605552002') = 'Missed first follow-up', 'missed first';
  assert (select follow_up from public.lead_list('2026-09-01','2026-09-30') where contact_phone = '+13605552003') = 'Missed second follow-up', 'missed second';
  assert (select follow_up from public.lead_list('2026-09-01','2026-09-30') where contact_phone = '+13605552001') = 'Followed up twice', 'twice';
  assert (select follow_up from public.lead_list('2026-09-01','2026-09-30') where contact_phone = '+13605552004') is null, 'no follow-up needed';
  raise notice 'ok  quo: first and second follow-ups, and what they led to';
end $$;
reset role;

-- Never replied after both follow-ups; and a fast quote that booked.
insert into public.quotes (id, client_id, status, total, created_at, sent_at) values ('QL1', 'CL1', 'converted', 400, '2026-09-04', '2026-09-04 10:00Z');  -- 13h after their reply
insert into public.communications (id, kind, direction, contact_phone, occurred_at, quo_user_id, phone_number_id, text_head_hash, text_tail_hash) values
 ('u5a', 'message', 'outbound', '+13605552005', '2026-09-01 18:00Z', 'USK', 'PN1', 'h1', 't1'),
 ('u5b', 'message', 'outbound', '+13605552005', '2026-09-02 19:00Z', 'USK', 'PN1', 'x1', 'x2'),
 ('u5c', 'message', 'outbound', '+13605552005', '2026-09-03 20:00Z', 'USK', 'PN1', 'x3', 'x4');
select app.refresh_quo();
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare o jsonb; begin
  o := public.owner_leads('2026-09-01','2026-09-30');
  assert (o->>'not_converted')::int = 1 and (o->>'got_both_follow_ups')::int = 2, format('not converted %s', o->>'not_converted');
  assert (select follow_up from public.lead_list('2026-09-01','2026-09-30') where contact_phone = '+13605552005') = 'Followed up twice, never replied', 'never replied label';
  assert (o->'quote_speed'->>'fast_quoted')::int = 1 and (o->'quote_speed'->>'fast_booked')::int = 1
     and (o->'quote_speed'->>'avg_hours')::numeric = 13, format('fast quote %s', o->'quote_speed');
  raise notice 'ok  quo: never-replied leads, and time from first contact to quote';
end $$;
reset role;

-- ---------- Meta ads ----------
insert into public.ad_spend_daily (day, campaign_id, campaign_name, ad_id, ad_name, spend, impressions, clicks, link_clicks, meta_leads) values
 ('2026-10-05', 'CMP1', 'Roof cleaning', 'AD1', 'Roof A', 40.00, 5000, 120, 80, 3),
 ('2026-10-06', 'CMP1', 'Roof cleaning', 'AD1', 'Roof A', 35.50, 4200, 100, 70, 2),
 ('2026-10-06', 'CMP2', 'Christmas lights', 'AD2', 'Lights', 60.00, 9000, 210, 150, 4),
 ('2026-09-30', 'CMP2', 'Christmas lights', 'AD2', 'Lights', 99.00, 9000, 210, 150, 9);  -- outside October
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.expect_fail($q$select public.owner_ads('2026-10-01','2026-10-31')$q$, 'crew cannot see ad numbers');
do $$ begin
  assert (select count(*) from public.ad_spend_daily) = 0, 'crew cannot read ad spend';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare o jsonb; begin
  o := public.owner_ads('2026-10-01','2026-10-31');
  assert (o->>'spend')::numeric = 135.50 and (o->>'meta_leads')::int = 9 and (o->>'link_clicks')::int = 300, format('ads totals %s', o);
  assert jsonb_array_length(o->'campaigns') = 2 and (o->'campaigns'->0->>'name') = 'Roof cleaning', format('campaigns %s', o->'campaigns');
  assert (o->>'new_customers')::int = (public.owner_leads('2026-10-01','2026-10-31')->>'new_booked')::int, 'same new-customer count as the Leads tab';
  assert jsonb_array_length(o->'monthly') = 12, 'monthly';
  raise notice 'ok  meta: ad spend, leads and campaigns for owners only';
end $$;
reset role;

-- ---------- Growth: lead measures, ad attribution, sales & quotes ----------
insert into public.quotes (id, client_id, salesperson_id, status, subtotal, discount_amount, total, created_at, sent_at, approved_at) values
 ('QS1', 'C2', '11111111-0000-0000-0000-00000000000a', 'converted', 500, 0, 540, '2026-08-03', '2026-08-03 18:00Z', '2026-08-04 18:00Z'),
 ('QS2', 'C2', '11111111-0000-0000-0000-00000000000a', 'archived', 800, 80, 777, '2026-08-05', '2026-08-05 18:00Z', null),
 ('QS3', 'C2', null, 'awaiting_response', 300, 0, 324, '2026-08-10', '2026-08-10 18:00Z', null);
insert into public.quote_line_items values ('QS1a','QS1','Gutter Cleaning',1,500,500,false,0),('QS2a','QS2','Roof Softwash',1,800,800,false,0),('QS3a','QS3','Windows',1,300,300,false,0);
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.expect_fail($q$select public.owner_sales('2026-08-01','2026-08-31')$q$, 'crew cannot see sales numbers');
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare o jsonb; l jsonb; a jsonb; begin
  o := public.owner_sales('2026-08-01','2026-08-31');
  assert (o->>'sent')::int = 3 and (o->>'approved')::int = 1 and (o->>'approved_value')::numeric = 500, format('sales %s', o);
  assert (o->>'lost')::int = 1 and (o->>'lost_value')::numeric = 720, format('lost %s', o);
  assert (o->'discount'->>'rate')::numeric = 0.05 and (o->'discount'->>'with_discount_sent')::int = 1
     and (o->'discount'->>'without_discount_won')::int = 1, format('discount %s', o->'discount');
  assert (o->'by_salesperson'->0->>'name') = 'Kale (test)' and (o->'by_salesperson'->0->>'approved_value')::numeric = 500, format('by salesperson %s', o->'by_salesperson');
  l := public.owner_leads('2026-12-01','2026-12-31');
  assert (l->>'unworked')::int = 1 and (l->>'two_way')::int = 6, format('contact %s / %s', l->>'unworked', l->>'two_way');
  assert (l->>'lead_to_booking_days')::numeric = 4.0 and (l->>'touches_before_booking')::numeric = 1, format('lead to booking %s %s', l->>'lead_to_booking_days', l->>'touches_before_booking');
  a := public.owner_ads('2026-12-01','2026-12-31')->'attributed';
  assert (a->>'form_leads')::int = 5 and (a->>'booked')::int = 0, format('attributed %s', a);
  raise notice 'ok  growth: sales & quotes, lead contact measures, ad attribution';
end $$;
reset role;

-- ---------- Operations: crew economics and quality ----------
update public.jobs set job_number = 9002 where id = 'JS2';
insert into public.jobs (id, client_id, title, status, total, created_at, start_at) values
 ('CB1', 'C21', 'Callback - #9002', 'upcoming', 0, '2026-10-20 18:00Z', '2026-10-21 16:00Z');
insert into public.visits (id, job_id, status, start_at, end_at) values ('VCB1', 'CB1', 'scheduled', '2026-10-21 16:00Z', '2026-10-21 18:00Z');
insert into public.visit_assignments values ('VCB1', '11111111-0000-0000-0000-00000000000c');
select app.refresh_derived();
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.expect_fail($q$select public.owner_crews('2026-10-01','2026-10-31')$q$, 'crew cannot see crew economics');
select pg_temp.expect_fail($q$select public.owner_quality('2026-10-01','2026-10-31')$q$, 'crew cannot see quality numbers');
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare o jsonb; q jsonb; p jsonb; begin
  o := public.owner_crews('2026-10-01','2026-10-31');
  -- Connor: Oct 10 hourly 3h x $20 + $8/h burden = $84; Oct 15 half of $350 x 15% = $52.50; Oct 16 $400 x 20% = $80; Oct 17 $300 x 20% = $60
  assert (o->>'labor_cost')::numeric = 276.50, format('labor %s', o->>'labor_cost');
  assert (o->>'labor_unpriced_days')::int = 3, 'Sage has no wage on file: her days are flagged, not counted as $0';
  assert (o->>'revenue')::numeric = (public.owner_overview('2026-10-01','2026-10-31')->'revenue'->>'completed')::numeric, 'same completed revenue as the Overview';
  q := public.owner_quality('2026-10-01','2026-10-31');
  assert (q->>'callbacks')::int = 1 and (q->>'rework_hours')::numeric = 2, format('quality %s', q);
  assert (q->>'callback_cost')::numeric = 55, format('callback cost %s', q->>'callback_cost');   -- 2h x avg cost ($28 + $27) / 2
  select x into p from jsonb_array_elements(q->'by_person') x where x->>'name' = 'Connor (test)';
  assert (p->>'callbacks')::int = 1, format('connor callbacks %s', p);
  assert (q->'list'->0->>'original_crew') = 'Connor (test)', format('traced to crew %s', q->'list');
  raise notice 'ok  operations: labor cost, labor-only margins, callbacks traced to the crew';
end $$;
reset role;

-- ---------- Revenue: upsells, customers, plan extras ----------
update public.jobs set upsell_offer = 'accepted' where id = 'J1';
update public.jobs set upsell_offer = 'declined' where id = 'JS2';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.expect_fail($q$select public.owner_upsells('2026-10-01','2026-10-31')$q$, 'crew cannot see company upsells');
select pg_temp.expect_fail($q$select public.owner_customers('2026-10-01','2026-10-31')$q$, 'crew cannot see customer numbers');
select pg_temp.expect_fail($q$select public.owner_plan_extras('2026-10-01','2026-10-31')$q$, 'crew cannot see plan extras');
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare u jsonb; c jsonb; p jsonb; x jsonb; begin
  u := public.owner_upsells('2026-10-01','2026-10-31');
  -- the $60 skylight added on site to J1 (roof job, Connor + Sage)
  assert (u->>'revenue')::numeric = 60 and (u->>'upsold_jobs')::int = 1 and (u->'combos'->0->>'base') = 'Roof', format('upsells %s', u);
  select y into x from jsonb_array_elements(u->'by_person') y where y->>'name' = 'Connor (test)';
  assert (x->>'revenue')::numeric = 30, format('split credit %s', x);
  assert (u->'offers'->>'offered')::int = 2 and (u->'offers'->>'accepted')::int = 1, format('offers %s', u->'offers');
  c := public.owner_customers('2026-01-01','2026-12-31');
  assert (c->>'revenue')::numeric = (c->>'new_revenue')::numeric + (c->>'returning_revenue')::numeric, 'new + returning = all';
  assert (c->>'customers')::int > 0 and (c->>'lifetime_avg')::numeric > 0, format('customers %s', c);
  p := public.owner_plan_extras('2026-10-01','2026-10-31');
  assert round((p->>'mrr')::numeric * 12) = round((public.owner_plans('2026-10-01','2026-10-31')->>'annual_value')::numeric), format('mrr %s', p);
  raise notice 'ok  revenue: upsells with offers, customers, plan extras';
end $$;
reset role;

-- ---------- Financial, settings, alerts ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.expect_fail($q$select public.owner_financial('2026-10-01','2026-10-31')$q$, 'crew cannot see financials');
select pg_temp.expect_fail($q$select public.owner_alerts()$q$, 'crew cannot see alerts');
do $$ begin
  update public.business_settings set trucks = 9;
  assert (select count(*) from public.business_settings) = 0, 'crew cannot read settings';
  raise notice 'ok  crew cannot read or change settings';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare f jsonb; a jsonb; begin
  update public.business_settings set trucks = 2, crew_hours_per_day = 8, drive_hours_per_day = 1, work_weekdays = '{1,2,3,4,5}';
  -- Mon Oct 5 - Sun Oct 11 2026: 5 working days x (8 - 1 drive) x 2 trucks = 70
  f := public.owner_financial('2026-10-05','2026-10-11');
  assert (f->'settings'->>'trucks')::int = 2, 'owner can change settings';
  assert (f->>'available_hours')::numeric = 70, format('available hours %s', f->>'available_hours');
  assert (f->>'next7_available')::numeric = 70, format('next 7 days %s', f->>'next7_available');   -- any 7 days hold 5 weekdays
  assert app.workday_count('2026-10-24', '2026-10-25', '{1,2,3,4,5}') = 0, 'weekends are not work days';
  f := public.owner_financial('2026-10-01','2026-10-31');
  assert (f->>'revenue')::numeric = (public.owner_overview('2026-10-01','2026-10-31')->'revenue'->>'completed')::numeric, 'revenue matches overview';
  assert (f->>'snapshots')::int >= 1, 'forecast snapshot taken';
  a := public.owner_alerts();
  assert a ? 'leads_waiting' and a ? 'big_quotes_no_follow_up' and a ? 'next7_utilization', format('alerts %s', a);
  raise notice 'ok  financial: settings, capacity, revenue, alerts';
end $$;
reset role;

-- ---------- Google reviews ----------
do $$ begin
  assert app.reviewer_matches('Jane Doe', 'Jane D.') and app.reviewer_matches('Jane Doe', 'jane doe');
  assert not app.reviewer_matches('Jane Doe', 'Jane Smith') and not app.reviewer_matches('Anthony', 'Anthony')
     and not app.reviewer_matches('New Call +13605550000', 'New C.'), 'name matching';
  raise notice 'ok  reviews: reviewer names match full names or first name + last initial only';
end $$;
update public.clients set name = 'Jane Doe' where id = 'C20';      -- JS1 on Oct 15, Connor + Sage
insert into public.google_review_totals (location_id, average_rating, total_reviews, source, updated_at) values ('L1', 4.80, 120, 'places', now());
insert into public.google_reviews (id, location_id, stars, reviewer_name, comment, created_at, updated_at, replied_at) values
 ('GR1', 'L1', 5, 'Jane D.', 'Spotless windows', '2026-10-18 18:00Z', '2026-10-18 18:00Z', '2026-10-18 20:00Z'),
 ('GR2', 'L1', 2, 'John Smith', 'Late', '2026-10-20 18:00Z', '2026-10-20 18:00Z', null);
insert into public.communications (id, kind, direction, contact_phone, occurred_at, quo_user_id, phone_number_id, is_review_request)
values ('rr1', 'message', 'outbound', '+13605550777', '2026-10-16 18:00Z', 'USK', 'PN1', true);
select app.refresh_reviews();
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.expect_fail($q$select public.owner_reviews('2026-10-01','2026-10-31')$q$, 'crew cannot see company reviews');
do $$ declare m record; begin
  assert (select count(*) from public.google_reviews) = 0, 'crew cannot read reviews directly';
  select * into m from public.my_reviews('2026-10-01','2026-10-31');
  assert m.reviews = 1 and m.five_star = 1, format('connor own reviews %s', m);
  raise notice 'ok  reviews: crew see only reviews on their own jobs';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare r jsonb; p jsonb; begin
  r := public.owner_reviews('2026-10-01','2026-10-31');
  assert (r->>'reviews')::int = 2 and (r->>'average')::numeric = 3.5 and (r->>'five_star')::int = 1 and (r->>'average_all')::numeric = 4.8, format('reviews %s', r);
  assert (r->>'source') = 'places', 'source shown';
  assert (r->>'matched')::int = 1 and (r->>'requests')::int = 1 and (r->>'replied')::int = 1 and (r->>'reply_hours')::numeric = 2, format('reviews detail %s', r);
  select x into p from jsonb_array_elements(r->'by_person') x where x->>'name' = 'Connor (test)';
  assert (p->>'reviews')::int = 1, format('crew credit %s', r->'by_person');
  raise notice 'ok  reviews: rating, five-star, replies, requests, matched to the crew';
end $$;
reset role;

-- ---------- contact attempts (September form leads; every 7-day window is over) ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare r jsonb; begin
  r := public.owner_leads('2026-09-01','2026-09-30')->'reach';
  -- 2001: text + call, then they replied -> 2 attempts, reached
  -- 2002: never followed up -> 0, never reached;  2003: one follow-up -> 1, never reached
  -- 2004: replied to the auto-text on their own -> came back, 0 attempts;  2005: two follow-ups -> 2, never reached
  assert (r->>'leads')::int = 5 and (r->>'avg_attempts')::numeric = 1.0, format('reach %s', r);
  assert (r->>'two_three')::int = 1 and (r->>'came_back')::int = 1 and (r->>'never')::int = 3 and (r->>'first_try')::int = 0, format('reach buckets %s', r);
  raise notice 'ok  leads: contact attempts count only leads we had to chase, never-reached included';
end $$;
reset role;
-- a call, voicemail and text within 10 minutes count as one attempt; the call that gets through counts
insert into public.communications (id, kind, direction, contact_phone, occurred_at, answered_at, duration_sec, quo_user_id, phone_number_id) values
 ('at1', 'call',    'inbound',  '+13605553001', '2026-09-10 17:00Z', null, 30, null, 'PN1'),                       -- they call, we miss it (voicemail)
 ('at2', 'call',    'outbound', '+13605553001', '2026-09-10 18:00Z', null, 20, 'USK', 'PN1'),                       -- we call back, no answer
 ('at3', 'message', 'outbound', '+13605553001', '2026-09-10 18:02Z', null, null, 'USK', 'PN1'),                     -- + text right after
 ('at4', 'call',    'outbound', '+13605553001', '2026-09-11 17:00Z', '2026-09-11 17:00:05Z', 90, 'USK', 'PN1');     -- next day: answered
update public.communications set has_voicemail = true where id = 'at1';
select app.refresh_quo();
do $$ declare n int; begin
  select attempts into n from app.quo_leads where contact_phone = '+13605553001';   -- (checked as the database owner)
  assert n = 2, format('grouped attempts %s', n);
  raise notice 'ok  leads: touches within 10 minutes count once';
end $$;

-- ---------- open quotes: period, pipeline, stale, and the other-option rule ----------
insert into public.clients (id, name) values ('CW1', 'Waiting customer'), ('CW2', 'Picked the other option');
insert into public.quotes (id, client_id, status, subtotal, discount_amount, total, created_at, sent_at, approved_at) values
 ('QW1', 'CW1', 'awaiting_response', 400, 0, 432, now() - interval '10 days', now() - interval '10 days', null),
 ('QW2', 'CW1', 'awaiting_response', 900, 0, 972, now() - interval '200 days', now() - interval '200 days', null),
 ('QW3', 'CW2', 'awaiting_response', 700, 0, 756, now() - interval '5 days', now() - interval '5 days', null),
 ('QW4', 'CW2', 'approved', 500, 0, 540, now() - interval '5 days', now() - interval '5 days', now() - interval '4 days');
insert into public.quote_line_items values ('QW1a','QW1','Windows',1,400,400,false,0),('QW2a','QW2','Roof',1,900,900,false,0),
  ('QW3a','QW3','Roof premium',1,700,700,false,0),('QW4a','QW4','Roof basic',1,500,500,false,0);
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare o jsonb; begin
  o := public.owner_sales((now() - interval '30 days')::date, (now() at time zone 'America/Los_Angeles')::date);
  -- QW3 is the option CW2 didn't pick (they approved QW4), so it isn't waiting
  assert (o->'waiting_period'->>'count')::int = 1 and (o->'waiting_period'->>'value')::numeric = 400, format('waiting this period %s', o->'waiting_period');
  assert (o->'stale'->>'count')::int = 1 and (o->'stale'->>'value')::numeric = 900, format('stale %s', o->'stale');
  assert exists (select 1 from jsonb_array_elements(o->'to_follow_up') x where x->>'id' = 'QW1')
     and not exists (select 1 from jsonb_array_elements(o->'to_follow_up') x where x->>'id' = 'QW3'), 'follow-up list skips customers who booked';
  assert (public.owner_overview((now() - interval '30 days')::date, (now() at time zone 'America/Los_Angeles')::date)->'quotes'->>'open_value')::numeric = 400,
         'Overview still-waiting uses the same rule';
  raise notice 'ok  sales: still waiting by period, 90-day pipeline, stale quotes, other options dropped';
end $$;
reset role;

-- ---------- owners can view a crew member's page as them; crew can't ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d';   -- what Sage sees herself
do $$ declare r record; begin
  select * into r from public.my_scorecard('2026-10-01','2026-10-31');
  perform set_config('test.sage_rev', r.revenue_credited::text, false);
  perform set_config('test.sage_jobs', (select count(*) from public.my_jobs('2026-10-01','2026-10-31'))::text, false);
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
set request.headers = '{"x-view-as":"11111111-0000-0000-0000-00000000000d"}';
do $$ declare r record; begin
  select * into r from public.my_scorecard('2026-10-01','2026-10-31');
  assert r.revenue_credited = current_setting('test.sage_rev')::numeric, format('owner viewing Sage got %s', r.revenue_credited);
  assert (select count(*) from public.my_jobs('2026-10-01','2026-10-31')) = current_setting('test.sage_jobs')::int, 'owner sees Sage''s job list';
end $$;
set request.headers = '{"x-view-as":"not-a-uuid"}';
select pg_temp.expect_fail('select * from public.my_scorecard(''2026-10-01'',''2026-10-31'')', 'owner -> bad view-as id');
set request.headers = '{"x-view-as":"11111111-0000-0000-0000-0000000000ff"}';
select pg_temp.expect_fail('select * from public.my_scorecard(''2026-10-01'',''2026-10-31'')', 'owner -> unknown view-as id');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
set request.headers = '{"x-view-as":"11111111-0000-0000-0000-00000000000d"}';
do $$ declare r record; begin
  select * into r from public.my_scorecard('2026-10-01','2026-10-31');
  assert r.revenue_credited <> current_setting('test.sage_rev')::numeric, format('crew view-as must be ignored, got %s', r.revenue_credited);
  raise notice 'ok  view as: owners see a crew member''s page; crew can''t use it';
end $$;
reset request.headers;
reset role;

\echo ALL ACCESS TESTS PASSED
