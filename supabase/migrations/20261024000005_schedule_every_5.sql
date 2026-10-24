-- The regular sync is now resumable: the scheduler checks in every 5 minutes.
-- A new sync cycle starts at most every ~15 minutes; a cycle too big for one call
-- continues on the next check. (Same job name -> pg_cron updates the existing job.)
select cron.schedule('jobber-sync-15min', '*/5 * * * *', $$ select app.call_sync('incremental') $$);
