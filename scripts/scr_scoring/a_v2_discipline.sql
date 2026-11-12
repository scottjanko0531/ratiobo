-- Phase 4c: profile_version = 'a_v2_discipline' (configuration A2).
-- a_v1_hist_ff12 with sign 1 replaced by growth discipline:
--   percentile of (EBITDA growth YoY minus total-asset growth YoY), higher
--   is better. Signs 2, 3 and 6 are unchanged -- copied bit-for-bit from
--   a_v1_hist_ff12 (already stored), not re-derived, for the same
--   correctness-guarantee reason a_v1_hist_ff12 itself copied sign1/2/3
--   from a_v1_hist rather than recomputing them.
--
-- Growth-discipline inputs are read point-in-time from the materialized
-- scr_anchors_asof / scr_metric_ttm_asof tables (same source as
-- a_v1_hist_materialized.sql), scoped to the same company/as_of_date pairs
-- already present in a_v1_hist_ff12 (so the universe is identical by
-- construction -- no separate scr_universe_membership filter needed).
--
-- EBITDA growth YoY: ebitda.value_now/value_prior - 1, guarded by
-- value_prior not null/nonzero AND span_now/span_prior between 250-300
-- (the TTM-flow span guard used for every other YoY flow metric in this
-- codebase, e.g. rev_growth_fy). No operating_income fallback -- the spec
-- says "EBITDA growth YoY" specifically; b_v1's earnings_growth factor
-- falls back to operating_income, but that is b_v1's own documented
-- choice, not inherited here.
--
-- Total-asset growth YoY: total_assets.value_now/value_prior - 1, guarded
-- only by value_prior not null/nonzero -- NO span guard, because
-- total_assets is a balance-sheet point value, not a TTM-summed flow (same
-- treatment as asset_growth in b_v1.sql/b_v1_materialized.sql, which also
-- omits the span check for this exact reason).
--
-- growth_disc_raw = ebitda_growth - asset_growth; sign1 is its PLAIN
-- (non-inverted) percentile, since the spec states "higher is better" for
-- this quantity directly -- unlike b_v1's growth_discipline factor, which
-- is defined the other way around (asset_growth - earnings_growth,
-- inverted) and therefore happens to rank in the same economic direction
-- but via an unrelated formula; the two are not the same number and must
-- not be confused.
--
-- Run in :start_date/:end_date batches, AFTER a_v1_hist_ff12 has been
-- (re)computed for the same date range.
insert into scr_scores (company_id, as_of_date, profile_version, sign1, sign2, sign3, sign4, sign5, sign6, signs_met, composite, score, rule_breaker_pass, missing_inputs, raw_inputs, needs_review)
with base as (
  select a.company_id, a.as_of_date, a.sign2, a.sign3, a.sign6, a.missing_inputs, a.needs_review, a.raw_inputs
  from scr_scores a
  where a.profile_version = 'a_v1_hist_ff12' and a.as_of_date >= :start_date and a.as_of_date <= :end_date
),
anc as (
  select b.company_id, b.as_of_date, an.span_now, an.span_prior
  from base b
  left join scr_anchors_asof an on an.company_id = b.company_id and an.as_of_date = b.as_of_date
),
growth as (
  select anc.company_id, anc.as_of_date,
    case when eb.value_prior is not null and eb.value_prior <> 0
      and anc.span_now between 250 and 300 and anc.span_prior between 250 and 300
      then eb.value_now / eb.value_prior - 1 end as ebitda_growth,
    case when ta.value_prior is not null and ta.value_prior <> 0
      then ta.value_now / ta.value_prior - 1 end as asset_growth
  from anc
  left join scr_metric_ttm_asof eb on eb.company_id = anc.company_id and eb.as_of_date = anc.as_of_date and eb.metric = 'ebitda'
  left join scr_metric_ttm_asof ta on ta.company_id = anc.company_id and ta.as_of_date = anc.as_of_date and ta.metric = 'total_assets'
),
raw as (
  select b.*, g.ebitda_growth, g.asset_growth,
    case when g.ebitda_growth is not null and g.asset_growth is not null
      then g.ebitda_growth - g.asset_growth end as growth_disc_raw
  from base b
  join growth g on g.company_id = b.company_id and g.as_of_date = b.as_of_date
),
pcts as (
  select *,
    case when growth_disc_raw is not null then
      (2*rank() over (partition by as_of_date, (growth_disc_raw is not null) order by growth_disc_raw) + count(*) over (partition by as_of_date, growth_disc_raw) - 3)
        / (2.0*(count(*) over (partition by as_of_date, (growth_disc_raw is not null)) - 1)) * 100
    end as sign1_val
  from raw
),
composite_calc as (
  select *,
    (select avg(v) from (values (sign1_val),(sign2),(sign3),(sign6)) t(v) where v is not null) as composite_val,
    (select count(*) from (values (sign1_val),(sign2),(sign3),(sign6)) t(v) where v is not null) as n_signs_avail,
    (select count(*) from (values (sign1_val),(sign2),(sign3),(sign6)) t(v) where v is not null and v>=60) as n_signs_met
  from pcts
),
scored as (
  select *,
    case when composite_val is not null then
      round((2*rank() over (partition by as_of_date, (composite_val is not null) order by composite_val) + count(*) over (partition by as_of_date, composite_val) - 3) / (2.0*(count(*) over (partition by as_of_date, (composite_val is not null)) - 1)) * 100)
    end as score_val
  from composite_calc
)
select
  company_id, as_of_date, 'a_v2_discipline',
  round(sign1_val), sign2, sign3, null, null, sign6,
  n_signs_met, composite_val, score_val,
  (score_val is not null and score_val>=60 and n_signs_met=n_signs_avail and n_signs_avail>0),
  array_remove(
    array_cat(
      array_remove(array_remove(missing_inputs, 'rev_growth_fy'), 'rev_growth_qtr_yoy'),
      array[
        case when ebitda_growth is null then 'ebitda_growth_yoy' end,
        case when asset_growth is null then 'total_asset_growth_yoy' end
      ]
    ),
  null),
  (raw_inputs - 'rev_growth_fy' - 'rev_growth_qtr_yoy') || jsonb_build_object(
    'ebitda_growth_yoy', ebitda_growth, 'total_asset_growth_yoy', asset_growth, 'growth_disc_raw', growth_disc_raw
  ),
  needs_review
from scored
on conflict (company_id, as_of_date, profile_version) do nothing;
