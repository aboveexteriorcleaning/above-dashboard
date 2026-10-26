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
3. After that, pg_cron runs an incremental sync every 15 minutes and a wider pass nightly;
   webhooks keep it live in between. Jobs can't be filtered by "updated" in Jobber, so the
   regular sync reads jobs created/completed since the last run plus every job scheduled
   from 14 days ago to 90 days ahead (nightly: 60 days ago to 180 ahead).

Secrets (Supabase → Edge Functions → Secrets): `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`,
`JOBBER_SETUP_KEY`, `SYNC_KEY`. Vault secret `sync_key` (same value as `SYNC_KEY`) for the scheduler.

## Quo sync

`supabase/functions/quo-sync` reads Quo calls and texts. Quo API keys can't be
limited to reading, so `_shared/quo.ts` is the lock: it only sends GET requests,
and only to `/calls`, `/messages`, `/users` and `/phone-numbers`. Nothing in this
project sends texts, places calls, or changes anything in Quo.

Message text is never stored. Each outgoing text is reduced to two short
fingerprints, used only to recognise the automatic n8n text sent to new form
leads (so it doesn't count as a reply).

Setup: add the `QUO_API_KEY` secret in Supabase (Edge Functions → Secrets), deploy,
then run Actions → Sync → `quo-check`, then `quo-backfill`. After the import
finishes, the scheduler pulls new calls and texts every 5 minutes.

## Meta ads sync

`supabase/functions/meta-sync` reads daily ad results (spend, impressions,
clicks, Meta-reported leads) per ad. The system user token only has `ads_read`;
`_shared/meta.ts` is a second lock: GET only, only to Meta's Graph API, and only
to `act_<your account>` and `act_<your account>/insights`. A tripwire test fails
the deploy if Meta is referenced anywhere else.

Setup: add `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` (digits) as Supabase
secrets, deploy, then run Actions → Sync → `meta-check`, then `meta-backfill`.
After that it re-reads the last 3 days every hour and the last 28 days nightly.

## Google reviews sync

`supabase/functions/google-sync` reads Google Business Profile reviews. Google
has no read-only permission for Business Profile, so `_shared/google.ts` is the
lock: GET only, and only to list accounts, list locations, and list a
location's reviews. The single POST allowed is to Google's token endpoint. A
tripwire test fails the deploy if Google is reached from anywhere else.

Without Business Profile approval, set `GOOGLE_PLACE_ID` and `GOOGLE_PLACES_API_KEY`
instead: the sync reads the public listing (rating, review count, newest 5 reviews)
from the Places API with a key that can't change anything.

Setup for full access: Google must approve Business Profile API access for the Cloud project.
Then add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_SETUP_KEY`
secrets, deploy, open `<project>/functions/v1/google-connect?key=<GOOGLE_SETUP_KEY>`
once, and run Actions → Sync → `google-check`, then `google-sync`. After that it
reads new reviews every 3 hours. Quo texts with a Google review link are
flagged (the text isn't stored) for review-request conversion; run `quo-rescan`
once to flag the last 120 days.

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

## Web app (`web/`)
Next.js app with Supabase sign-in by email link. Pages:
- `/overview` (owners): revenue flow booked → completed → invoiced → paid, schedule ahead,
  quotes, customers, monthly trend, service/area breakdowns, unpaid invoices, request sources
- `/team` (owners): everyone's scorecards; who can sign in, roles, hourly cost, invites
- `/me` (everyone): own scorecard and jobs, plus company totals. No rankings.

All numbers come from database functions (`supabase/migrations/…06_dashboard_metrics.sql`),
so access rules apply on every request. `DEMO_MODE=1` shows sample data and reads nothing real.

Environment (Vercel): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` (production only; used only to send invites after an owner check).
Preview deployments: set `DEMO_MODE=1` and no service key.

Supabase Auth settings:
- Turn off public sign-ups (invites only).
- Email templates use `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=magiclink`
  (and `type=invite` for invites) so links work on any device.
