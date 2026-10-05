-- holdings_valued: track realized gain/loss on sold units, not just the
-- open position's unrealized gain.
--
-- Bug: net_gain was `current_value - cost_basis`, where cost_basis is the
-- average-cost basis of the CURRENTLY HELD quantity only. The moment a
-- position's quantity drops to 0 (fully sold, or a loan's principal fully
-- repaid), cost_basis and current_value both go to 0, so net_gain reports
-- $0 -- silently discarding whatever gain or loss was actually realized on
-- the sale. Every "Total Gain" display in the app (app/portfolios/page.jsx,
-- app/holdings/page.jsx, app/dashboard/page.jsx, app/accounts/page.jsx,
-- components/HoldingDetailDrawer.jsx) computes
-- `net_gain + total_dividends + total_interest - total_fees`, so a closed
-- position's income survived in that sum while its realized loss vanished
-- -- e.g. a bond ETF bought, paid a dividend, then sold at a loss would
-- show up as a net positive contributor.
--
-- Fix: add a sell-side aggregate (total_sell_proceeds, total_units_sold)
-- symmetric with the existing buy-side one, using the SAME blended
-- average-cost-per-unit the view already uses for the open position's
-- cost_basis (no chronological lot-matching -- consistent with how
-- cost_basis itself is already a simple blended average, not FIFO/LIFO).
-- realized_gain = proceeds from every affects_quantity=-1 transaction
-- (sell/principal/transfer_out) minus that quantity's share of the
-- all-time average buy cost. net_gain becomes unrealized + realized, so
-- every existing "Total Gain" call site is correct automatically -- no
-- app code changes needed. unrealized_gain and realized_gain are also
-- exposed separately for anything that wants the breakdown.
--
-- Verified against the bug report: TLT bought 1208sh @ $82.735 ($99,943.88),
-- paid a $380.14 dividend, fully sold 1208sh @ $78.19 ($94,451.57).
-- Old net_gain: $0.00 (position closed, cost_basis/current_value both 0).
-- New net_gain: $94,451.57 - $99,943.88 = -$5,492.31 (realized loss),
-- matching the actual round-trip loss on the position.

create or replace view public.holdings_valued as
with txn_agg as (
  select
    t.holding_id,
    sum(case when tt.affects_quantity = 1
      then coalesce(t.amount, t.quantity * t.price_per_unit, 0) + coalesce(t.fees, 0)
      else 0 end) as total_buy_cost,
    sum(case when tt.affects_quantity = 1
      then coalesce(t.quantity, 0)
      else 0 end) as total_units_bought,
    sum(case when tt.affects_quantity = -1
      then coalesce(t.amount, t.quantity * t.price_per_unit, 0) - coalesce(t.fees, 0)
      else 0 end) as total_sell_proceeds,
    sum(case when tt.affects_quantity = -1
      then coalesce(t.quantity, 0)
      else 0 end) as total_units_sold,
    sum(case when tt.code = 'dividend' then coalesce(t.amount, 0) else 0 end) as total_dividends,
    sum(case when tt.code = 'interest' then coalesce(t.amount, 0) else 0 end) as total_interest,
    sum(case when tt.code = 'fee' then coalesce(t.amount, 0) else 0 end) as total_fees
  from transactions t
  join transaction_types tt on tt.code = t.txn_type
  group by t.holding_id
),
calcs as (
  select
    h.id,
    h.user_id,
    h.account_id,
    h.symbol,
    h.asset_type,
    h.name,
    h.quantity,
    h.notes,
    h.created_at,
    h.updated_at,
    h.price_override,
    h.simulator_key,
    h.interest_rate,
    h.maturity_date,
    md.dividend_yield,
    coalesce(h.price_override, md.price) as effective_price,
    md.fetched_at as last_price_sync,
    ta.total_buy_cost,
    ta.total_units_bought,
    ta.total_sell_proceeds,
    ta.total_units_sold,
    ta.total_dividends,
    ta.total_interest,
    ta.total_fees,
    case
      when h.asset_type = 'cash' then h.quantity
      when coalesce(ta.total_units_bought, 0) > 0 then ta.total_buy_cost / ta.total_units_bought * h.quantity
      else 0
    end as cost_basis_raw,
    case
      when h.asset_type <> 'cash' and coalesce(ta.total_units_bought, 0) > 0
        then coalesce(ta.total_sell_proceeds, 0) - (ta.total_buy_cost / ta.total_units_bought) * coalesce(ta.total_units_sold, 0)
      else 0
    end as realized_gain_raw
  from holdings h
  left join market_data md on md.symbol = h.symbol and md.asset_type = h.asset_type
  left join txn_agg ta on ta.holding_id = h.id
)
select
  id,
  user_id,
  account_id,
  symbol,
  asset_type,
  name,
  quantity,
  price_override,
  round(cost_basis_raw, 2) as cost_basis,
  round(coalesce(quantity * effective_price, cost_basis_raw, 0), 2) as current_value,
  round(coalesce(quantity * effective_price, cost_basis_raw, 0) - cost_basis_raw + realized_gain_raw, 2) as net_gain,
  case
    when asset_type <> 'cash' and coalesce(total_buy_cost, 0) <> 0
      then round((coalesce(quantity * effective_price, cost_basis_raw, 0) - cost_basis_raw + realized_gain_raw) / total_buy_cost * 100, 2)
    when asset_type = 'cash' and cost_basis_raw <> 0
      then round((coalesce(quantity * effective_price, cost_basis_raw, 0) - cost_basis_raw + realized_gain_raw) / cost_basis_raw * 100, 2)
    else null
  end as net_gain_pct,
  coalesce(total_dividends, 0) as total_dividends,
  coalesce(total_interest, 0) as total_interest,
  coalesce(total_fees, 0) as total_fees,
  effective_price as market_price,
  last_price_sync,
  simulator_key,
  interest_rate,
  maturity_date,
  dividend_yield,
  round(realized_gain_raw, 2) as realized_gain,
  round(coalesce(quantity * effective_price, cost_basis_raw, 0) - cost_basis_raw, 2) as unrealized_gain
from calcs;
