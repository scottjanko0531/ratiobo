-- Static regime -> equity-sector weight lookup for "All Weather With Equity
-- Tilting" (portfolio_id below). Not computed or written per regime-change
-- event -- it's a fixed thesis table read at display time, keyed by
-- whichever regime is currently confirmed on the portfolio
-- (portfolios.current_regime_key). Each regime's 8 weights sum to 100
-- (% of the portfolio's own `eq` bucket target, not of the whole portfolio).
create table if not exists portfolio_sector_targets (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  symbol text not null,
  regime_key text not null check (regime_key in ('rg_fi', 'rg_ri', 'fg_ri', 'fg_fi')),
  target_pct_of_bucket numeric not null,
  updated_at timestamptz not null default now(),
  unique (portfolio_id, symbol, regime_key)
);

insert into portfolio_sector_targets (portfolio_id, symbol, regime_key, target_pct_of_bucket)
values
  -- rg_fi: Disinflationary Boom
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLK', 'rg_fi', 22),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLY', 'rg_fi', 18),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLC', 'rg_fi', 14),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLF', 'rg_fi', 14),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLI', 'rg_fi', 12),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLV', 'rg_fi', 10),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLB', 'rg_fi', 6),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLE', 'rg_fi', 4),
  -- rg_ri: Reflation
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLE', 'rg_ri', 18),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLF', 'rg_ri', 16),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLI', 'rg_ri', 15),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLB', 'rg_ri', 13),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLK', 'rg_ri', 12),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLY', 'rg_ri', 11),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLC', 'rg_ri', 8),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLV', 'rg_ri', 7),
  -- fg_ri: Stagflation
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLE', 'fg_ri', 24),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLV', 'fg_ri', 16),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLB', 'fg_ri', 13),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLF', 'fg_ri', 10),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLK', 'fg_ri', 10),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLC', 'fg_ri', 9),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLI', 'fg_ri', 9),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLY', 'fg_ri', 9),
  -- fg_fi: Deflationary Bust
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLV', 'fg_fi', 24),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLK', 'fg_fi', 16),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLC', 'fg_fi', 13),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLF', 'fg_fi', 11),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLI', 'fg_fi', 10),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLY', 'fg_fi', 10),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLB', 'fg_fi', 8),
  ('2ab7c628-63b6-43c1-8f3a-226a59e9d9ac', 'XLE', 'fg_fi', 8)
on conflict (portfolio_id, symbol, regime_key) do update set target_pct_of_bucket = excluded.target_pct_of_bucket;
