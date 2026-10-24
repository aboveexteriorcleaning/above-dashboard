-- Access-rule tests. Every check raises an error if it fails.
\set ON_ERROR_STOP on

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
 ('Q1','C1','11111111-0000-0000-0000-00000000000a','converted',1000,'2026-10-01','2026-10-01','2026-10-02');
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
  assert r.revenue_credited = 757.50, format('connor revenue %s', r.revenue_credited); -- 75% of 1010
  assert r.clocked_hours = 3.0, 'connor hours';
  assert r.upsell_revenue = 45.00, format('connor upsell %s', r.upsell_revenue);       -- 75% of 60

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
  assert r.revenue_credited = 652.50, format('sage revenue %s', r.revenue_credited); -- 25% of 1010 + 400
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

\echo ALL ACCESS TESTS PASSED
