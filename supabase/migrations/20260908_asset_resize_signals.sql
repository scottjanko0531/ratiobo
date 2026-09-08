create table asset_resize_signals (
  symbol text not null,
  date date not null,
  rule_type text not null,
  reduced boolean not null,
  exposure_multiplier numeric not null,
  indicator_value numeric,
  created_at timestamptz not null default now(),
  primary key (symbol, date)
);

comment on table asset_resize_signals is 'VAMS-equivalent Bottom-Up overlay spec: daily computed resize state per symbol (from asset_resize_rule_config), written by compute-asset-resize-signals. Drives the exposure_multiplier used in computeAllocationDeltas (lib/simulatorKeys.js) to scale a holding''s target allocation below its regime-driven bucket target. indicator_value is the raw signal reading at that date (current MA, drawdown-from-peak, or vol-ratio depending on rule_type) -- kept for display/audit ("why is this Reduced") rather than only the boolean.';

alter table asset_resize_signals enable row level security;

create policy asset_resize_signals_read on asset_resize_signals
  for select to authenticated using (true);

create index asset_resize_signals_symbol_date_idx on asset_resize_signals (symbol, date desc);
