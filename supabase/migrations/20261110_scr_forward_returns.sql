-- Documents scr_forward_returns, which already exists live in the
-- xuutmtfrpaxrzhwwokpk project -- it was originally created ad-hoc via the
-- Supabase SQL tool during Phase 3 with no committed migration. Captured
-- here (via pg_get_viewdef on the live view, 2026-11-10) per the
-- reproducibility audit so the definition has a real commit/hash, not to
-- be re-applied: `create or replace view` is idempotent against the
-- already-live definition below, so running this migration is safe even
-- though it is not expected to change anything.
--
-- Computes forward returns (1/3/6/12/36-month) per (company_id,
-- as_of_date) from scr_adjusted_prices, for every row scr_universe_membership
-- has ever carried, used as the historical-backtest target variable. Each
-- horizon resolves to the nearest trading-day adjusted close at or before
-- the target date UNLESS that target date is beyond the company's last
-- tracked price AND that last-price date itself is near the data's own
-- global max date (within 20 days) -- i.e. a company still actively
-- trading as of the dataset's own edge gets a null for horizons beyond
-- "today", rather than a stale/incomplete return; a company whose last
-- price is well before the global max (delisted/acquired) instead resolves
-- using its own final price, correctly treating that as the realized
-- outcome. reached_10x_in_60m scans the 5-year-forward price path (not
-- just the horizon snapshots) for any day the price reached 10x the
-- as_of_date price, with the same "still live vs. actually ended" null
-- handling.
create or replace view scr_forward_returns as
with base as (
  select distinct x.company_id, x.as_of_date
  from (select company_id, as_of_date from scr_universe_membership) x
),
company_bounds as (
  select company_id, max(date) as last_price_date
  from scr_adjusted_prices
  group by company_id
),
globalmax as (
  select max(date) as max_date_overall from scr_adjusted_prices
),
anchor as (
  select b.company_id, b.as_of_date, cb.last_price_date, gm.max_date_overall,
    (select ap.adj_close from scr_adjusted_prices ap where ap.company_id=b.company_id and ap.date<=b.as_of_date order by ap.date desc limit 1) as price_now
  from base b
  left join company_bounds cb on cb.company_id=b.company_id
  cross join globalmax gm
),
horizons as (
  select a.company_id, a.as_of_date, a.last_price_date, a.max_date_overall, a.price_now, h.months, h.target_date
  from anchor a
  cross join lateral (values
    (1, a.as_of_date + interval '1 mon'),
    (3, a.as_of_date + interval '3 mons'),
    (6, a.as_of_date + interval '6 mons'),
    (12, a.as_of_date + interval '1 year'),
    (36, a.as_of_date + interval '3 years')
  ) h(months, target_date)
),
resolved as (
  select h.company_id, h.as_of_date, h.last_price_date, h.max_date_overall, h.price_now, h.months, h.target_date,
    case
      when h.last_price_date is null or h.price_now is null then null::numeric
      when h.target_date::date <= h.last_price_date then
        (select ap.adj_close from scr_adjusted_prices ap where ap.company_id=h.company_id and ap.date<=h.target_date order by ap.date desc limit 1)
      when h.last_price_date < (h.max_date_overall - interval '20 days') then
        (select ap.adj_close from scr_adjusted_prices ap where ap.company_id=h.company_id and ap.date=h.last_price_date)
      else null::numeric
    end as resolved_price,
    case
      when h.last_price_date is null or h.price_now is null then false
      when h.target_date::date <= h.last_price_date then true
      when h.last_price_date < (h.max_date_overall - interval '20 days') then true
      else false
    end as window_complete
  from horizons h
)
select
  company_id, as_of_date,
  max(case when months=1 and window_complete then resolved_price/price_now - 1 else null end) as ret_1m,
  max(case when months=3 and window_complete then resolved_price/price_now - 1 else null end) as ret_3m,
  max(case when months=6 and window_complete then resolved_price/price_now - 1 else null end) as ret_6m,
  max(case when months=12 and window_complete then resolved_price/price_now - 1 else null end) as ret_12m,
  max(case when months=36 and window_complete then resolved_price/price_now - 1 else null end) as ret_36m,
  case
    when (select max(cb2.last_price_date) from company_bounds cb2 where cb2.company_id=resolved.company_id) is null then null::boolean
    when (select cb2.last_price_date from company_bounds cb2 where cb2.company_id=resolved.company_id) < ((select gm2.max_date_overall from globalmax gm2) - interval '20 days') then
      (exists (
        select 1 from scr_adjusted_prices ap
        where ap.company_id=resolved.company_id and ap.date>=resolved.as_of_date and ap.date<=(resolved.as_of_date + interval '5 years')
          and (ap.adj_close / (select ap0.adj_close from scr_adjusted_prices ap0 where ap0.company_id=resolved.company_id and ap0.date<=resolved.as_of_date order by ap0.date desc limit 1)) >= 10
      ))
    when (resolved.as_of_date + interval '5 years')::date <= (select gm2.max_date_overall from globalmax gm2) then
      (exists (
        select 1 from scr_adjusted_prices ap
        where ap.company_id=resolved.company_id and ap.date>=resolved.as_of_date and ap.date<=(resolved.as_of_date + interval '5 years')
          and (ap.adj_close / (select ap0.adj_close from scr_adjusted_prices ap0 where ap0.company_id=resolved.company_id and ap0.date<=resolved.as_of_date order by ap0.date desc limit 1)) >= 10
      ))
    else null::boolean
  end as reached_10x_in_60m
from resolved
group by company_id, as_of_date;
