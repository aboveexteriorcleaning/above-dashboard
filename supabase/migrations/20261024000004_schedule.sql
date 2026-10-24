-- Runs the Jobber sync every 15 minutes, plus a nightly pass that re-reads
-- the last 3 days as a safety net. The sync key is read from Supabase Vault
-- (secret name: sync_key), so it never appears in this repo.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function app.call_sync(p_mode text) returns void
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'sync_key';
  if k is null then raise notice 'sync_key missing in Vault; skipping'; return; end if;
  perform net.http_post(
    url := 'https://fmpbjesfoeupybflfrbd.supabase.co/functions/v1/jobber-sync?mode=' || p_mode,
    headers := jsonb_build_object('x-sync-key', k, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000);
end $$;
revoke all on function app.call_sync(text) from public, anon, authenticated;

select cron.schedule('jobber-sync-15min', '*/15 * * * *', $$ select app.call_sync('incremental') $$);
select cron.schedule('jobber-sync-nightly', '17 10 * * *', $$ select app.call_sync('nightly') $$); -- 3:17am Pacific (PDT)
