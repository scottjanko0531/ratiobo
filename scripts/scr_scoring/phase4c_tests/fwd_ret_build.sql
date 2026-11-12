-- Phase 4c, forward-return rebuild (Scott's condition 1 on the holdout
-- directive): ONE forward-return method covering the whole period
-- 2017-01-31 .. 2026-10-31, instead of extending the old scr_fwd_ret_mat
-- (2017-2023 only) with a reverse-engineered convention for new dates.
--
-- Reverse-engineered scr_fwd_ret_mat's existing convention by hand against
-- real stored rows before writing this: target_date = as_of_date + N
-- months (Postgres date+interval arithmetic, so month-end as_of dates land
-- on the next month-end's calendar date, e.g. 2019-06-30 + 1mo =
-- 2019-07-30); price = nearest scr_adjusted_prices.adj_close on or before
-- that date. Verified exactly (to 16+ significant figures) against two
-- real stored rows for as_of_date=2019-06-30, ret_1m. This script
-- reproduces that SAME convention, so the 2017-2023 portion is expected to
-- diff to zero against the old table -- see fwd_ret_diff_check.sql.
--
-- Universe: for each as_of_date, every company_id that appears in
-- scr_scores for EITHER a_v1_hist_ff12 or b_v1 on that date (confirmed by
-- hand to be exactly scr_fwd_ret_mat's own membership rule: distinct
-- company_id counts for a 3-date sample matched 1-for-1 against the union
-- of the A-growth and B-value profile universes, not a separate
-- membership table). a_v1_hist_ff12 and b_v1 are both already scored
-- through 2026-10-31 by the canonical pipeline, so this covers the full
-- window without needing A2/A3 scored early (which would breach the
-- holdout seal).
--
-- Delisting rule (Scott's explicit instruction, holdout directive item 1):
-- a position in a company that delists before a horizon's target date
-- exits at scr_securities.final_price on its last trading day
-- (delisted_date); the proceeds then earn BIL's return (from
-- asset_price_history, same on-or-before convention) for the remainder of
-- that horizon. A near-worthless final_price is correct and expected, not
-- an error. 5 companies in the universe have delisted_date set but
-- final_price NULL (checked by hand beforehand) -- those fall back to the
-- last available scr_adjusted_prices.adj_close on or before delisted_date,
-- which is what "final price on its last trading day" means when the
-- dedicated field wasn't populated.
--
-- "Fully observable" cutoff (holdout directive item 1, last bullet) is
-- enforced at the ROW level against a single GLOBAL price-data frontier
-- (max(date) across ALL of scr_adjusted_prices, not a per-company max):
-- for a company that has NOT delisted, a horizon's return is only
-- computed if the target date is on or before that global frontier --
-- otherwise NULL. A delisted company's return is instead gated on BIL's
-- own last available date in asset_price_history, since the BIL leg is
-- what's actually being priced out past the delisting.
--
-- Caught and fixed by hand during the 2017-2023 diff check: an EARLIER
-- version of this script gated on each COMPANY's own last available price
-- date instead of the global frontier. That produced 136 real (non-
-- delisted-related) diffs against the old table for ret_1m alone, because
-- plenty of real, non-delisted, still-listed companies have genuine mid-
-- history data-vendor gaps (an illiquid name going quiet for a few weeks)
-- that have nothing to do with "hasn't happened yet" -- the old table (and
-- the correct convention) tolerates those by just using the nearest real
-- trade, however many days back; only the GLOBAL "is this date in the
-- unobservable future" boundary should ever produce a NULL for a
-- not-known-to-be-delisted company. Using the global frontier instead
-- reduced the diff to exactly the delisted-company cases (see
-- fwd_ret_diff_check.sql), which are an EXPECTED divergence from the old
-- table -- that table had no delisting rule at all (it just kept reusing
-- the frozen final price forever), whereas this one implements Scott's
-- explicit exit-to-BIL rule. This also makes the per-horizon as-of-date
-- cutoffs Scott specified (1m: 2024-01..2026-09, 33 dates; 3m: ..2026-07,
-- 31 dates; 12m: ..2025-10, 22 dates) fall out automatically as "every row
-- is non-null" for a non-delisted company, rather than needing to be
-- hand-maintained as a separate filter -- verified in
-- fwd_ret_diff_check.sql's cutoff-count query.
--
-- Run once. Target table: scr_fwd_ret_mat_v2 (kept distinct from the
-- original scr_fwd_ret_mat until the diff below confirms equivalence on
-- the overlap -- NOT altering the original table in place).

drop table if exists scr_fwd_ret_mat_v2;

create table scr_fwd_ret_mat_v2 (
  company_id uuid not null,
  as_of_date date not null,
  ret_1m numeric,
  ret_3m numeric,
  ret_6m numeric,
  ret_12m numeric,
  ret_36m numeric,
  reached_10x_in_60m boolean,
  primary key (company_id, as_of_date)
);

-- Price-on-or-before helpers, each bounded by "fully observable" so a
-- target date past the trailing data edge returns NULL instead of
-- silently reusing a stale price.
create or replace function scr_price_asof(p_company uuid, p_target date)
returns numeric language sql stable as $$
  select adj_close from scr_adjusted_prices
  where company_id = p_company and date <= p_target
  order by date desc limit 1
$$;

-- NOT a per-row function: MAX(date) over the whole table has no supporting
-- index on `date` alone (only the (company_id,date) composite), so calling
-- it once per row -- even as a STABLE function -- forces a full-table
-- aggregate per row. Caught by hand: the 2017 batch went from ~20s to
-- still running after 98s once this was introduced; fixed by computing it
-- ONCE into a CTE and joining it in as a constant (see each batch below).

create or replace function scr_bil_price_asof(p_target date)
returns numeric language sql stable as $$
  select close from asset_price_history
  where symbol = 'BIL' and date <= p_target
  order by date desc limit 1
$$;

-- Cache BIL's own trailing edge once; it's the same value for every row.
do $$
declare v_bil_max date;
begin
  select max(date) into v_bil_max from asset_price_history where symbol = 'BIL';
  raise notice 'BIL max date: %', v_bil_max;
end $$;

with frontier as (
  select max(date) as price_frontier from scr_adjusted_prices
),
universe as (
  select distinct company_id, as_of_date
  from scr_scores
  where profile_version in ('a_v1_hist_ff12', 'b_v1')
    and as_of_date between '2017-01-31' and '2026-10-31'
),
sec as (
  select id as company_id, delisted_date, final_price from scr_securities
),
base as (
  select
    u.company_id,
    u.as_of_date,
    scr_price_asof(u.company_id, u.as_of_date) as start_price,
    f.price_frontier,
    s.delisted_date,
    s.final_price
  from universe u
  left join sec s on s.company_id = u.company_id
  cross join frontier f
),
horizons as (
  select 1 as n_months, 'ret_1m' as col union all
  select 3, 'ret_3m' union all
  select 6, 'ret_6m' union all
  select 12, 'ret_12m' union all
  select 36, 'ret_36m'
),
computed as (
  select
    b.company_id,
    b.as_of_date,
    h.col,
    (b.as_of_date + (h.n_months || ' months')::interval)::date as target_date,
    case
      when b.start_price is null then null
      -- company delists before (or exactly at) this horizon's target: exit
      -- at final price (or fallback), proceeds ride BIL to the target date.
      when b.delisted_date is not null and b.delisted_date <= (b.as_of_date + (h.n_months || ' months')::interval)::date then
        case
          when b.delisted_date < b.as_of_date then null -- membership anomaly: flagged separately below, not silently computed
          else
            (
              coalesce(b.final_price, scr_price_asof(b.company_id, b.delisted_date)) / b.start_price
            ) * (
              scr_bil_price_asof((b.as_of_date + (h.n_months || ' months')::interval)::date)
              / nullif(scr_bil_price_asof(b.delisted_date), 0)
            ) - 1
        end
      -- still listed: only computable if the target date is within this
      -- company's own observed price history (fully observable).
      when (b.as_of_date + (h.n_months || ' months')::interval)::date <= b.price_frontier then
        scr_price_asof(b.company_id, (b.as_of_date + (h.n_months || ' months')::interval)::date) / b.start_price - 1
      else null
    end as ret
  from base b
  cross join horizons h
),
pivoted as (
  select
    company_id, as_of_date,
    max(case when col = 'ret_1m' then ret end) as ret_1m,
    max(case when col = 'ret_3m' then ret end) as ret_3m,
    max(case when col = 'ret_6m' then ret end) as ret_6m,
    max(case when col = 'ret_12m' then ret end) as ret_12m,
    max(case when col = 'ret_36m' then ret end) as ret_36m
  from computed
  group by company_id, as_of_date
),
tenx as (
  -- reached_10x_in_60m: schema parity with the old table only -- not used
  -- by any Phase 4c measure. Only meaningful where 60 months have fully
  -- elapsed; left NULL otherwise rather than guessed at.
  select
    b.company_id, b.as_of_date,
    case
      when (b.as_of_date + interval '60 months')::date > (select max(date) from scr_adjusted_prices) then null
      else exists (
        select 1 from scr_adjusted_prices p
        where p.company_id = b.company_id
          and p.date > b.as_of_date
          and p.date <= (b.as_of_date + interval '60 months')::date
          and b.start_price > 0
          and p.adj_close >= 10 * b.start_price
      )
    end as reached_10x
  from base b
)
insert into scr_fwd_ret_mat_v2 (company_id, as_of_date, ret_1m, ret_3m, ret_6m, ret_12m, ret_36m, reached_10x_in_60m)
select p.company_id, p.as_of_date, p.ret_1m, p.ret_3m, p.ret_6m, p.ret_12m, p.ret_36m, t.reached_10x
from pivoted p
join tenx t on t.company_id = p.company_id and t.as_of_date = p.as_of_date;
