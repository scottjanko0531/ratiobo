-- Alpaca brokerage integration, Phase 1 (read-only sync). sync-alpaca-
-- account pulls Alpaca's own view of positions/cash/activity into the
-- existing accounts/holdings/transactions tables on a daily cron -- see
-- the Phase 1 plan for the full design. No order placement here.

alter table accounts
  add column if not exists sync_provider text,
  add column if not exists external_account_id text,
  add column if not exists last_synced_at timestamptz;
comment on column accounts.sync_provider is 'Which external brokerage API (if any) owns this account''s holdings/transactions, e.g. ''alpaca''. Null = manually maintained (the existing, still-default path).';
comment on column accounts.last_synced_at is 'Null means "never synced" -- sync-alpaca-account branches on this to decide between a one-time beg_bal snapshot (first run) and an incremental activity pull (every run after).';

alter table transactions
  add column if not exists external_id text;
create unique index if not exists transactions_external_id_key
  on transactions (external_id) where external_id is not null;
comment on column transactions.external_id is 'Idempotency key for synced transactions (e.g. Alpaca''s own activity id). Null for every manually-entered transaction.';

create table if not exists alpaca_sync_job_runs (
  id          bigint generated always as identity primary key,
  job_name    text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running','ok','error')),
  detail      jsonb not null default '{}'
);
create index if not exists alpaca_sync_job_runs_job_started_idx on alpaca_sync_job_runs (job_name, started_at desc);
comment on table alpaca_sync_job_runs is 'One row per sync-alpaca-account invocation, same shape as rb_job_runs/bond_lens_job_runs.';

alter table alpaca_sync_job_runs enable row level security;
create policy alpaca_sync_job_runs_read on alpaca_sync_job_runs for select to authenticated using (true);
