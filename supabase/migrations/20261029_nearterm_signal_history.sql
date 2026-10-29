-- Near-Term signal: 3-day smoothing + daily history. See the approved
-- plan for full context -- today's 7-day pending streak (Reflation,
-- fired 2026-10-22, due to confirm today) reset because one morning's
-- raw confidence read 59%, one point below the 60% floor, driven by
-- same-day commodity/FX price movement (WTI/copper/DXY), not a real
-- trend reversal. This table is the permanent daily record the
-- trailing-average smoothing reads from -- genuinely append-only
-- (mirrors rb_scores/mc_signal_log's no-update/no-delete trigger
-- pattern), not an overwrite-on-conflict snapshot like
-- gauge_daily_snapshots -- the whole point is an audit trail a same-day
-- rerun can't silently erase.

create table nearterm_signal_history (
  snapshot_date date primary key,
  key           text,
  confidence    int,
  created_at    timestamptz not null default now()
);

create or replace function nearterm_signal_history_immutable() returns trigger
set search_path = ''
as $$
begin
  raise exception 'nearterm_signal_history is append-only: % is not allowed', TG_OP;
end;
$$ language plpgsql;

create trigger nearterm_signal_history_no_update before update on nearterm_signal_history
  for each row execute function nearterm_signal_history_immutable();
create trigger nearterm_signal_history_no_delete before delete on nearterm_signal_history
  for each row execute function nearterm_signal_history_immutable();

alter table nearterm_signal_history enable row level security;
create policy nearterm_signal_history_read on nearterm_signal_history for select to authenticated using (true);
