-- Phase 4c: profile_version = 'a_v2_discipline_no6' (configuration A3).
-- a_v2_discipline WITHOUT sign 6 (sector-relative valuation) -- the
-- "overvalued" premium sign is dropped entirely, so expensive valuations
-- are no longer rewarded. sign1/sign2/sign3 are copied bit-for-bit from
-- a_v2_discipline (already stored); only composite/signs_met/score/
-- rule_breaker_pass are recomputed, now over 3 signs instead of 4 -- same
-- derive-don't-recompute pattern as a_v1_hist_ff12 deriving from a_v1_hist.
--
-- Run in :start_date/:end_date batches, AFTER a_v2_discipline has been
-- (re)computed for the same date range.
insert into scr_scores (company_id, as_of_date, profile_version, sign1, sign2, sign3, sign4, sign5, sign6, signs_met, composite, score, rule_breaker_pass, missing_inputs, raw_inputs, needs_review)
with base as (
  select a.company_id, a.as_of_date, a.sign1, a.sign2, a.sign3, a.missing_inputs, a.needs_review, a.raw_inputs
  from scr_scores a
  where a.profile_version = 'a_v2_discipline' and a.as_of_date >= :start_date and a.as_of_date <= :end_date
),
composite_calc as (
  select *,
    (select avg(v) from (values (sign1),(sign2),(sign3)) t(v) where v is not null) as composite_val,
    (select count(*) from (values (sign1),(sign2),(sign3)) t(v) where v is not null) as n_signs_avail,
    (select count(*) from (values (sign1),(sign2),(sign3)) t(v) where v is not null and v>=60) as n_signs_met
  from base
),
scored as (
  select *,
    case when composite_val is not null then
      round((2*rank() over (partition by as_of_date, (composite_val is not null) order by composite_val) + count(*) over (partition by as_of_date, composite_val) - 3) / (2.0*(count(*) over (partition by as_of_date, (composite_val is not null)) - 1)) * 100)
    end as score_val
  from composite_calc
)
select
  company_id, as_of_date, 'a_v2_discipline_no6',
  sign1, sign2, sign3, null, null, null,
  n_signs_met, composite_val, score_val,
  (score_val is not null and score_val>=60 and n_signs_met=n_signs_avail and n_signs_avail>0),
  missing_inputs,
  raw_inputs,
  needs_review
from scored
on conflict (company_id, as_of_date, profile_version) do nothing;
