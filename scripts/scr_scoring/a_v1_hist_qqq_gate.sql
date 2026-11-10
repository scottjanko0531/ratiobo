-- Phase 3 historical scoring pipeline: profile_version = 'a_v1_hist_qqq_gate'.
-- Committed retroactively per the 2026-11-10 reproducibility audit.
--
-- Derivation only -- this is NOT an independent rescoring from
-- scr_fundamentals. It is a direct copy of every a_v1_hist row's
-- sign1/sign2/sign3/sign6/composite/score/signs_met/rule_breaker_pass/
-- missing_inputs/needs_review (bit-for-bit identical), with one extra key
-- -- qqq_ret_1y (QQQ's trailing 1-year total return as of that as_of_date,
-- from asset_price_history.close, which is Yahoo's dividend-adjusted
-- adjclose -- see scr_trials for the total-return confirmation) -- merged
-- into raw_inputs for reference/gating context. Run this AFTER a_v1_hist
-- itself has been (re)computed for the same date range, since it reads
-- a_v1_hist directly rather than recomputing anything from fundamentals.
insert into scr_scores (company_id, as_of_date, profile_version, sign1, sign2, sign3, sign4, sign5, sign6, signs_met, composite, score, rule_breaker_pass, missing_inputs, raw_inputs, needs_review)
select
  a.company_id, a.as_of_date, 'a_v1_hist_qqq_gate',
  a.sign1, a.sign2, a.sign3, a.sign4, a.sign5, a.sign6,
  a.signs_met, a.composite, a.score, a.rule_breaker_pass, a.missing_inputs,
  a.raw_inputs || jsonb_build_object('qqq_ret_1y', q.qqq_ret_1y),
  a.needs_review
from scr_scores a
left join lateral (
  select (cur.close/y1.close - 1) as qqq_ret_1y
  from (select close from asset_price_history where symbol='QQQ' and date<=a.as_of_date order by date desc limit 1) cur,
       (select close from asset_price_history where symbol='QQQ' and date<=a.as_of_date - interval '1 year' order by date desc limit 1) y1
) q on true
where a.profile_version='a_v1_hist'
  and a.as_of_date >= :start_date and a.as_of_date <= :end_date
on conflict (company_id, as_of_date, profile_version) do nothing;
