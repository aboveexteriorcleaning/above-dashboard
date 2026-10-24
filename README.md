# Above Dashboard

Live KPI dashboard for Above Exterior Cleaning.

## Ground rules
- **Read-only.** The dashboard copies data from Jobber, Quo, Meta and the lead
  Google Sheets. It never creates, edits or deletes anything in those systems,
  and never sends messages.
- **Access is enforced in the database**, not just hidden in the UI:
  - Owners (Kale, Grady): everything, including client profiles (every view is logged).
  - Crew (Connor, Sage): their own scorecard and job list (client names only),
    plus company totals. No rankings, no other people's numbers.
- **Secrets never go in this repo.** Tokens and keys live in Supabase secrets
  and Vercel environment variables only.

## Layout
- `supabase/migrations/` – database tables, access rules, sync support, schedule
- `supabase/functions/` – Jobber connect, OAuth callback, sync and webhook receiver
  - `_shared/readonly_guard.ts` refuses any GraphQL mutation before it leaves the server
  - `_shared/queries.ts` is the complete list of queries the sync may run
- `supabase/tests/` – access-rule tests (run against a local Postgres)
- `supabase/functions/tests/` – sync unit + database integration tests

## Jobber sync
1. `jobber-sync?mode=check` compares our queries to Jobber's live schema. Writes nothing.
2. `jobber-sync?mode=backfill&only=<users|clients|requests|quotes|jobs|invoices|timesheets>`
   pulls history one type at a time, then `?mode=backfill&only=done` marks it complete.
3. After that, pg_cron runs an incremental sync every 15 minutes and a 3-day overlap pass nightly;
   webhooks keep it live in between.

Secrets (Supabase → Edge Functions → Secrets): `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`,
`JOBBER_SETUP_KEY`, `SYNC_KEY`. Vault secret `sync_key` (same value as `SYNC_KEY`) for the scheduler.

## Running the access tests locally
```
psql -d testdb -f supabase/tests/supabase_stub.sql
psql -d testdb -f supabase/migrations/20261024000001_core_schema.sql
psql -d testdb -f supabase/migrations/20261024000002_access_rules.sql
psql -d testdb -f supabase/tests/access_rules_test.sql   # ends with ALL ACCESS TESTS PASSED
```

## Running the sync tests
```
cd supabase/functions
deno test tests/sync_test.ts
SUPABASE_DB_URL=postgres://postgres@localhost:5432/synctest deno test -A tests/store_integration_test.ts
```
