-- ============================================================
-- Surface Dalio's three classic big-debt-cycle monitors explicitly on the
-- Big Cycle debt panel. All three now exist as Macro indicators (one
-- source); this seeds the Big Cycle rows that update-big-cycle-metrics'
-- macro cross-reference will populate on each refresh (two pages).
--   1) Debt service vs. revenue      -> interest_expense_revenue_pct
--   2) Auction supply vs. demand     -> treasury_bid_to_cover, indirect_bidder_share
--   3) Fed printing to cover the gap -> already covered (fed_balance_sheet_gdp,
--      soma_long_duration_delta)
-- ============================================================

insert into public.big_cycle_metrics
  (cycle_id, key, label, source_name, source_url, refresh_method, sort_order, last_updated)
values
  ('da204e3f-ae22-47dd-95bb-2844d4f75685', 'interest_expense_revenue_pct',
   'Interest Expense % of Federal Revenue',
   'Macro dashboard, Long-Term Debt Cycle layer (FRED A091RC1Q027SBEA / FYFR)', null,
   'api_macro_xref', 16, now()),
  ('da204e3f-ae22-47dd-95bb-2844d4f75685', 'treasury_bid_to_cover',
   'Treasury Bid-to-Cover (10Y)',
   'Macro dashboard, Long-Term Debt Cycle layer (Treasury Fiscal Data auctions_query)', null,
   'api_macro_xref', 17, now()),
  ('da204e3f-ae22-47dd-95bb-2844d4f75685', 'indirect_bidder_share',
   'Indirect Bidder Share (10Y/30Y)',
   'Macro dashboard, Sovereign Risk panel (Treasury Fiscal Data auctions_query)', null,
   'api_macro_xref', 18, now())
on conflict (key) do nothing;
