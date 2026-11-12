-- Phase 4c: diff of scr_fwd_ret_mat_v2 (new, single-method build, see
-- fwd_ret_build.sql) against the original scr_fwd_ret_mat, on their
-- overlapping 2017-01-31..2023-12-31 window. Run after fwd_ret_build.sql.
--
-- Result (recorded by hand after running this once): every diff is
-- explained; none are unexplained bugs.
--
--   ret_1m:  178 diffs, all 178 at a delisted company (delisted_date not
--            null). Expected -- the old table has NO delisting rule at
--            all (it silently kept reusing the frozen pre-delisting price
--            forever); this build implements Scott's explicit exit-at-
--            final-price-then-ride-BIL rule instead, so any as_of/target
--            pair spanning a real delisting necessarily diffs.
--   ret_3m:  686 diffs, all explained the same way (0 non-delisted diffs).
--   ret_6m:  1384 diffs, all delisted (0 non-delisted).
--   ret_12m: 2852 diffs, all delisted (0 non-delisted).
--   ret_36m: 9460 diffs; 9456 delisted (same explanation, naturally a much
--            larger share at the 36m horizon since more delistings fall
--            inside a 3-year window); the remaining 4 are 2 companies
--            (738fcf0e-21eb-4bc7-a770-11171e8036c6,
--            8b9e7733-ad76-4500-b35d-bedc2ac33a4c) at as_of_date
--            2023-11-30 and 2023-12-31. Checked by hand: neither has a
--            delisted_date, but both have a scr_adjusted_prices feed that
--            stops in Nov 2025 -- over a year before the actual global
--            price frontier (max(date) across scr_adjusted_prices,
--            2026-11-06 as of this run) and well short of their 36-month
--            target dates (2026-11-30 / 2026-12-31, themselves PAST that
--            frontier). The old table has a non-null value here anyway,
--            confirming it never applied any "is this actually
--            observable yet" check at all -- it just took nearest-on-or-
--            before unconditionally, fabricating a "return" off a stale
--            price for a target date that, as of today, hasn't happened.
--            This build's one addition over the old convention -- the
--            global price-frontier gate -- is exactly what Scott's
--            holdout condition 1 asked for ("only use as-of dates whose
--            horizon is fully observable"), so withholding these 4 is
--            correct, not a bug.
--
-- Query used to reach the above:
select
  sum(case when round(coalesce(o.ret_1m,-999),8) != round(coalesce(v.ret_1m,-999),8) then 1 else 0 end) as diff_1m,
  sum(case when round(coalesce(o.ret_3m,-999),8) != round(coalesce(v.ret_3m,-999),8) then 1 else 0 end) as diff_3m,
  sum(case when round(coalesce(o.ret_6m,-999),8) != round(coalesce(v.ret_6m,-999),8) then 1 else 0 end) as diff_6m,
  sum(case when round(coalesce(o.ret_12m,-999),8) != round(coalesce(v.ret_12m,-999),8) then 1 else 0 end) as diff_12m,
  sum(case when round(coalesce(o.ret_36m,-999),8) != round(coalesce(v.ret_36m,-999),8) then 1 else 0 end) as diff_36m,
  count(*) as total
from scr_fwd_ret_mat o
join scr_fwd_ret_mat_v2 v on v.company_id = o.company_id and v.as_of_date = o.as_of_date;

-- Per-horizon split of diffs into delisted vs. non-delisted, to confirm
-- the above breakdown (the 36m query additionally filters by company to
-- name the 2 residual non-delisted cases):
select
  'ret_1m' as horizon, count(*) as diffs,
  sum(case when s.delisted_date is not null then 1 else 0 end) as delisted_diffs
from scr_fwd_ret_mat o
join scr_fwd_ret_mat_v2 v on v.company_id = o.company_id and v.as_of_date = o.as_of_date
left join scr_securities s on s.id = o.company_id
where round(coalesce(o.ret_1m,-999),8) != round(coalesce(v.ret_1m,-999),8)
union all
select 'ret_3m', count(*), sum(case when s.delisted_date is not null then 1 else 0 end)
from scr_fwd_ret_mat o join scr_fwd_ret_mat_v2 v on v.company_id=o.company_id and v.as_of_date=o.as_of_date
left join scr_securities s on s.id=o.company_id
where round(coalesce(o.ret_3m,-999),8) != round(coalesce(v.ret_3m,-999),8)
union all
select 'ret_6m', count(*), sum(case when s.delisted_date is not null then 1 else 0 end)
from scr_fwd_ret_mat o join scr_fwd_ret_mat_v2 v on v.company_id=o.company_id and v.as_of_date=o.as_of_date
left join scr_securities s on s.id=o.company_id
where round(coalesce(o.ret_6m,-999),8) != round(coalesce(v.ret_6m,-999),8)
union all
select 'ret_12m', count(*), sum(case when s.delisted_date is not null then 1 else 0 end)
from scr_fwd_ret_mat o join scr_fwd_ret_mat_v2 v on v.company_id=o.company_id and v.as_of_date=o.as_of_date
left join scr_securities s on s.id=o.company_id
where round(coalesce(o.ret_12m,-999),8) != round(coalesce(v.ret_12m,-999),8)
union all
select 'ret_36m', count(*), sum(case when s.delisted_date is not null then 1 else 0 end)
from scr_fwd_ret_mat o join scr_fwd_ret_mat_v2 v on v.company_id=o.company_id and v.as_of_date=o.as_of_date
left join scr_securities s on s.id=o.company_id
where round(coalesce(o.ret_36m,-999),8) != round(coalesce(v.ret_36m,-999),8);
