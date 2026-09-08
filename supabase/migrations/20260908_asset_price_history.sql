create table if not exists asset_price_history (
  id bigint generated always as identity primary key,
  symbol text not null,
  date date not null,
  close numeric not null,
  source text not null default 'yahoo_finance',
  fetched_at timestamptz not null default now(),
  unique (symbol, date)
);

comment on table asset_price_history is 'Daily (dividend/split-adjusted) close price history per symbol, backfilled from Yahoo Finance''s v8 chart endpoint (same query1/query2 fallback already used by sync-market-data''s spot-price fetch, extended to range=max). Built for the VAMS-equivalent (Volatility-Adjusted Momentum Signal) backtest spec: Ratiobo previously had no daily price series at all (sync-market-data overwrites a spot price; asset_return_history holds only annual strategic-asset returns for the simulator). close is Yahoo''s adjclose when available (dividend/split-adjusted, needed for accurate rolling return calcs on distributing ETFs like VT/GLDM), falling back to raw close otherwise.';

alter table asset_price_history enable row level security;

create policy asset_price_history_read on asset_price_history
  for select to authenticated using (true);

create index if not exists asset_price_history_symbol_date_idx on asset_price_history (symbol, date);
