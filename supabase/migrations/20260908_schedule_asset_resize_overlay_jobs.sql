select cron.schedule(
  'sync-asset-price-history-daily',
  '20 5 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/sync-asset-price-history',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'compute-asset-resize-signals-daily',
  '25 5 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/compute-asset-resize-signals',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
