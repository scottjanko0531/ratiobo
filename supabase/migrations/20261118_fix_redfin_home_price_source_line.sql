-- Debt-Cycle Metrics Integrity v2, Phase 7a (docs/specs/debt-metrics-integrity-v2.md).
-- "Home Price / Household Income (Redfin)"'s source_url was already stale/
-- wrong before this phase -- it pointed to FRED's MSPUS series page even
-- though the card's actual numerator has always come from Redfin's public
-- data (never MSPUS; the comment at computeRedfinHomePriceUpdate's
-- definition explains MSPUS covers new homes only, a different series).
-- Confirmed live (2026-11-18) the old redfin-public-data.s3-us-west-2...
-- path 403s because Redfin relaunched their Data Center in May 2026 under
-- a new bucket layout, not because the feed is gone -- the restorable
-- replacement is .../redfin_data_center/housing_market/monthly/country.csv.
-- Fixing source_url to point at the real, current source.
update public.big_cycle_metrics
  set source_url = 'https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_data_center/housing_market/monthly/country.csv'
  where key = 'home_price_income_ratio';
