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
- `supabase/migrations/` – database tables and access rules
- `supabase/tests/` – access-rule tests (run against a local Postgres)

## Running the access tests locally
```
psql -d testdb -f supabase/tests/supabase_stub.sql
psql -d testdb -f supabase/migrations/20261024000001_core_schema.sql
psql -d testdb -f supabase/migrations/20261024000002_access_rules.sql
psql -d testdb -f supabase/tests/access_rules_test.sql   # ends with ALL ACCESS TESTS PASSED
```
