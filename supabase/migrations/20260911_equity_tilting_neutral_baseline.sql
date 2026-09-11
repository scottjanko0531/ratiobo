-- "All Weather With Equity Tilting" (regime_driven) was left with an empty
-- target_allocations, unlike its sibling "All Weather Alpha" which already
-- carries a neutral starting baseline. Without a baseline, Portfolio Actions
-- has nothing to diff against and renders nothing until a regime confirms.
-- Seed it with the same neutral bucket weights Alpha uses so sleeve-tilt
-- recommendations render immediately; per-symbol equity-sector tilting within
-- the eq bucket still only activates once a regime confirms and
-- portfolio_sector_targets is consulted (unchanged, by design).
update portfolios
set target_allocations = '{"em":5,"eq":20,"nb":20,"com":12,"gld":12,"tip":20,"cash":3,"intl":8}'::jsonb
where id = '2ab7c628-63b6-43c1-8f3a-226a59e9d9ac'
  and target_allocations = '{}'::jsonb;
