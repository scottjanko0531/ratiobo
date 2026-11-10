-- Phase 3 historical scoring pipeline: profile_version = 'a_v1_hist_ff12'.
-- Built 2026-11-10 to replace the undocumented, unrecoverable
-- a_v1_hist_sic shadow variant (see scr_trials -- a_v1_hist_sic is
-- RETIRED, rows kept but not reused).
--
-- Derivation only -- NOT an independent rescoring from scr_fundamentals
-- (revised 2026-11-10 after an initial from-scratch recomputation proved
-- prohibitively slow during a period of degraded database I/O; deriving
-- from a_v1_hist directly is both much cheaper AND gives a stronger
-- correctness guarantee -- sign1/sign2/sign3 are copied bit-for-bit from
-- a_v1_hist by construction, not independently recomputed and hoped to
-- match).
--
-- Copies company_id/as_of_date/sign1/sign2/sign3/signs_met's non-sign6
-- inputs and raw_inputs' ev_sales/price_sales straight from a_v1_hist
-- (already computed there -- no need to re-derive TTM windows from
-- scr_fundamentals at all). Only Sign 6 (valuation) is re-ranked: within
-- the company's Fama-French 12-industry group (mapped via the official
-- Ken French SIC-range classification in ff12_industry_ranges) when that
-- group has >=8 peers in the a_growth universe on that as_of_date,
-- otherwise falling back to the identical full-universe percentile
-- a_v1_hist itself used (ev_sales/price_sales ranked across the whole
-- date's universe). Composite/score/signs_met/rule_breaker_pass are
-- recomputed downstream of this new Sign 6, since score is a percentile of
-- composite across the full universe that date and is therefore sensitive
-- to every company's Sign 6, not just the directly rebucketed companies'.
--
-- Run AFTER a_v1_hist itself has been (re)computed for the same date
-- range. Run in :start_date/:end_date batches.
insert into scr_scores (company_id, as_of_date, profile_version, sign1, sign2, sign3, sign4, sign5, sign6, signs_met, composite, score, rule_breaker_pass, missing_inputs, raw_inputs, needs_review)
with base as (
  select a.company_id, a.as_of_date, a.sign1, a.sign2, a.sign3, a.missing_inputs, a.needs_review,
    (a.raw_inputs->>'ev_sales')::numeric as ev_sales,
    (a.raw_inputs->>'price_sales')::numeric as price_sales,
    a.raw_inputs as base_raw_inputs,
    coalesce(r.ff12, 'Other') as ff12
  from scr_scores a
  join scr_securities sec on sec.id = a.company_id
  left join lateral (
    select ff12 from ff12_industry_ranges rr
    where sec.sic_code ~ '^[0-9]+$' and sec.sic_code::integer between rr.sic_lo and rr.sic_hi
    limit 1
  ) r on true
  where a.profile_version='a_v1_hist' and a.as_of_date >= :start_date and a.as_of_date <= :end_date
),
ff12_counts as (
  select as_of_date, ff12, count(*) as n_ff12 from base group by as_of_date, ff12
),
pcts as (
  select b.*, fc.n_ff12,
    case when ev_sales is not null then (2*rank() over (partition by b.as_of_date, (ev_sales is not null) order by ev_sales) + count(*) over (partition by b.as_of_date, ev_sales) - 3) / (2.0*(count(*) over (partition by b.as_of_date, (ev_sales is not null)) - 1)) * 100 end as p_evs_full,
    case when price_sales is not null then (2*rank() over (partition by b.as_of_date, (price_sales is not null) order by price_sales) + count(*) over (partition by b.as_of_date, price_sales) - 3) / (2.0*(count(*) over (partition by b.as_of_date, (price_sales is not null)) - 1)) * 100 end as p_ps_full,
    case when ev_sales is not null then (2*rank() over (partition by b.as_of_date, b.ff12, (ev_sales is not null) order by ev_sales) + count(*) over (partition by b.as_of_date, b.ff12, ev_sales) - 3) / (2.0*(count(*) over (partition by b.as_of_date, b.ff12, (ev_sales is not null)) - 1)) * 100 end as p_evs_ff12,
    case when price_sales is not null then (2*rank() over (partition by b.as_of_date, b.ff12, (price_sales is not null) order by price_sales) + count(*) over (partition by b.as_of_date, b.ff12, price_sales) - 3) / (2.0*(count(*) over (partition by b.as_of_date, b.ff12, (price_sales is not null)) - 1)) * 100 end as p_ps_ff12
  from base b
  join ff12_counts fc on fc.as_of_date=b.as_of_date and fc.ff12=b.ff12
),
signs as (
  select *,
    case when n_ff12 >= 8 then
      (select round(avg(v)) from (values (p_evs_ff12),(p_ps_ff12)) t(v) where v is not null)
    else
      (select round(avg(v)) from (values (p_evs_full),(p_ps_full)) t(v) where v is not null)
    end as sign6,
    (n_ff12 >= 8) as used_ff12_rank
  from pcts
),
composite_calc as (
  select *,
    (select avg(v) from (values (sign1),(sign2),(sign3),(sign6)) t(v) where v is not null) as composite_val,
    (select count(*) from (values (sign1),(sign2),(sign3),(sign6)) t(v) where v is not null) as n_signs_avail,
    (select count(*) from (values (sign1),(sign2),(sign3),(sign6)) t(v) where v is not null and v>=60) as n_signs_met
  from signs
),
scored as (
  select *,
    case when composite_val is not null then
      round((2*rank() over (partition by as_of_date, (composite_val is not null) order by composite_val) + count(*) over (partition by as_of_date, composite_val) - 3) / (2.0*(count(*) over (partition by as_of_date, (composite_val is not null)) - 1)) * 100)
    end as score_val
  from composite_calc
)
select
  company_id, as_of_date, 'a_v1_hist_ff12',
  sign1, sign2, sign3, null, null, sign6,
  n_signs_met, composite_val, score_val,
  (score_val is not null and score_val>=60 and n_signs_met=n_signs_avail and n_signs_avail>0),
  missing_inputs,
  base_raw_inputs || jsonb_build_object(
    'ff12', ff12, 'n_ff12', n_ff12, 'used_ff12_rank', used_ff12_rank,
    'p_evs_ff12', p_evs_ff12, 'p_ps_ff12', p_ps_ff12, 'p_evs_full', p_evs_full, 'p_ps_full', p_ps_full
  ),
  needs_review
from scored
on conflict (company_id, as_of_date, profile_version) do nothing;
