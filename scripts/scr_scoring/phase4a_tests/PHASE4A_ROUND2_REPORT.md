# Phase 4a Round 2 — Corrective Report

**Addresses all 7 items from Scott's review of the round-1 report.** Commit
hash for all round-2 analysis code: `32da6566834c5b2a139500bef1d5203ca74718e8`
(`scripts/scr_scoring/phase4a_tests/`, files prefixed `v2_`). Every script
was committed immediately after being written, before execution, specifically
to prevent a repeat of the context-compaction code loss that hit round 1's
tests 1/3/4/5. New trial rows `scr_trials` ids 14-22 hold this round's
pre-registrations and results; the superseded round-1 rows (ids 6-13) are
kept, each tagged `superseded_by` pointing at its replacement — not deleted.

**A bug was found and fixed mid-round, disclosed here rather than
papered over:** every round-2 script's development-period filter read
`as_of_date <= '2023-12-31'` with no lower bound, so the `CASE`-based period
split silently pulled 12 extra months of 2016 data into "development"
(`scr_scores` data starts 2016-01-31). Caught via test 7's episode-count
sanity check (months summed to 72, not the pre-registered 60), fixed by
adding `as_of_date >= '2017-01-01'` everywhere, and **every affected
`scr_results` row (trials 14-20) was deleted and regenerated from the
corrected queries** before any number below was written down. Test 6 turned
out to be unaffected in practice (its join to `ff3_factors`, which only has
2017+ rows, implicitly applied the correct bound) — confirmed and left as is.

---

## Item 1 — Provenance check

Full detail in `round2_provenance_check.md`. Summary: round 1 used the
original stored `scr_scores` rows throughout, for all 5 profile_versions,
and those rows are confirmed bit-for-bit identical to the canonical
(bug-fixed) generator:

| profile_version | diff vs. canonical generator | rows compared |
|---|---|---|
| `a_v1_hist` | 0 (already verified in the materialization-fix round, `scr_job_runs` id=5) | 77,142 |
| `a_v1_hist_rd` | 0 (`scr_job_runs` id=6) | 77,142 |
| `b_v1` | 0, after 3 real bugs fixed during that verification (`scr_job_runs` id=7) | 83,098 |
| `a_v1_hist_qqq_gate` | 0 — bit-for-bit copy of `a_v1_hist` by construction, re-confirmed fresh this round | 57,151 |
| `a_v1_hist_ff12` | 0 — regenerated from the current committed script into a scratch schema and diffed fresh this round | 57,151 |

**No `scr_scores_corrections` regeneration was needed** — every profile's
stored rows already match the canonical pipeline exactly. Everything below
uses the existing stored rows directly.

---

## Item 2 — Full reproducible rerun

All 8 tests (9 result sets, since test 8 is now split into kept-baseline +
new-Fool-restricted) were rerun end-to-end from committed code this round,
under commit `32da6566...`. New trial ids and what each covers:

| trial_id | test | profile_versions | rows in scr_results |
|---|---|---|---|
| 14 | 1 — Information Coefficients | all 5 | 100 |
| 15 | 2 — Quintile Portfolios | all 5 | 100 |
| 16 | 3 — Rule Breaker | all 5 | 100 |
| 17 | 4 — Sign-level Contribution (real Fama-MacBeth) | all 5 | 20 |
| 18 | 5 — Big Winners | all 5 | 136 |
| 19 | 6 — Carhart 4-factor (full loadings) | all 5 | 10 |
| 20 | 7 — Regime Split (real regime tables) | all 5 + episode counts | 91 |
| 21 | 8a — A-Fool full-universe baseline (kept) | all 5 | 100 |
| 22 | 8b — A-Fool Rule-Breaker-picks-restricted (new) | all 5 | 36 |

Superseded round-1 trials (6-13) are marked `superseded_by` in
`scr_trials.results` and left in place for audit.

---

## Item 3 — `a_v1_hist_ff12` added everywhere

Included in tests 1, 2, 3, 4, 5, 6, and 8 (both 8a and 8b) — every test where
an a_growth profile appears. **New finding, not visible in round 1:**
`a_v1_hist_ff12` shows a consistently *milder* validation-period reversal
than the other three a_growth profiles on every test that showed a reversal
— IC validation t=-1.63 (vs -2.82 to -2.85 for the other three, and not
significant for ff12 alone), Q5-Q1 spread t=-0.53 (vs -1.0 to -1.3), rule
breaker spread t=-0.44 (vs -1.1 to -1.2), A-fool baseline t=-0.65 (vs -1.3 to
-1.6). The industry-neutral sign6 (valuation) ranking that ff12 uses instead
of a_v1_hist's full-universe ranking appears to partially — not fully —
insulate the composite from whatever is driving the other three profiles'
reversal.

---

## Item 4 — Test 7 redone against real regime tables

Schema verified directly before use (not assumed from the relayed
description):

- **`mc_signal_log`** (8,313 daily rows, 1993-2026): a clean 5-level ordinal
  `tier` column with a verified 1:1 map to `exposure_multiplier` — FULL=1.0,
  NORMAL=0.8, CAUTIOUS=0.6, DEFENSIVE=0.4, RISK_OFF=0.25. This *is* RatioBo's
  own market-conditions tier. Favorable = tier in (FULL, NORMAL), i.e.
  exposure_multiplier ≥ 0.8. (One isolated data-corruption row was found in
  this table — composite/tier text fields with absurd lengths from an
  apparent runaway numeric computation — dated outside both test periods, so
  it doesn't affect this test, but is worth a separate data-quality look.)
- **`macro_regime_history`** (90 quarterly rows, 2004-2026): `market_key` in
  {rg_ri, rg_fi, fg_ri, fg_fi}, a growth/inflation quadrant. Used as a
  secondary cut; episode counts reported, not analyzed further given even
  smaller per-bucket counts.

**Episode counts** (development 60 months, validation 24 months, confirmed
after the lower-bound fix): dev favorable=46 / unfavorable=14; val
favorable=10 / unfavorable=14. Small, especially in validation — descriptive
only, as flagged in the pre-registration.

**Answer to the specific question asked** ("does Profile A's top quintile
or rule_breaker_pass perform better when the market-conditions tier is
favorable?"): directionally yes, in both periods, but not significantly.
a_v1_hist's Q5-Q1 spread gross t-stat is 0.76 in favorable-development
months vs. 0.21 in unfavorable ones; in validation it's -0.05 (favorable)
vs. -1.32 (unfavorable) — i.e. the validation-period damage concentrates
more heavily in unfavorable-tier months, consistent with (not independent
confirmation of) the broader reversal story. No bucket reaches conventional
significance on a gross basis.

---

## Item 5 — Test 8 redone with Fool-restricted universe (baseline kept)

**Test 8a** (trial 21): the original full-universe-equal-weight baseline,
kept under its own trial id exactly as instructed, with `a_v1_hist_ff12`
added. Results unchanged in substance from round 1.

**Test 8b** (trial 22, new): schema verified — `scr_universe_history` has
exactly one `source` value, `rb_fool_recs` (210 rows, `added_date` spanning
2005-01-18 to 2026-10-20), and `scr_universe_closed_events` tracks closures
by `source_rec_id` (43 rows). **Survivor-bias finding, verified not
assumed:** both tables were populated in a single backfill batch on
2026-11-05, and the closed-events table has *no* closure data before
2025-07-29. This confirms the relayed "~July 2025" cutoff and pins it to an
exact date — and it means both pre-registered periods (2017-2021, 2022-2023)
are **entirely** survivor-biased for this test, since any closure before
2025-07-29 is invisible and would make a since-dropped pick look
"still active." Every row in `scr_results` for trial 22 is flagged
`survivor_biased: true`.

With that caveat stated plainly: restricted to the tiny Fool-tracked
universe (avg. 34-41 active a_growth picks per date, ~5 per date for b_v1),
`rule_breaker_pass=true` vs. the rest is **significantly negative** for all
four a_growth profiles in *both* periods (12m t ranging -1.3 to -3.6) —
consistent with, and somewhat stronger than, the full-universe test 3
result. b_v1's proxy is positive in development (t=2.19, only 8 usable
dates) with validation unavailable (too few dates where the tiny
b_v1-overlap universe split into both a pass and non-pass group).

---

## Item 6 — Effective N everywhere; real cluster-robust SEs for test 4

Every `scr_results` row from this round carries an explicit `effective_n`
field (= number of independent months/dates underlying the statistic, not
raw row count) alongside every t-stat.

**Test 4 (trial 17) is the core fix.** Round 1's reconstruction computed 4
independent univariate point-biserial correlations per predictor — which is
why its point estimates matched the lost original run but its standard
errors didn't: a marginal correlation and a coefficient from a joint model
diverge whenever predictors are mutually correlated (sign1-3/sign6 plausibly
are). This round fits a genuine **multivariate** per-date OLS (Fama-MacBeth)
— all predictors together in one model per date — via a plpgsql
normal-equations solver (`fm_ols_coef2`, unit-tested against a known-answer
case before use), so no row-level panel data ever left the database.
Coefficients are aggregated via Newey-West HAC (lag=0) across dates, the
standard construction for cluster-robust-by-date inference in a panel.
`effective_n` = `n_dates` (60 development, 24 validation), explicitly not
the ~170-545 average row-count per date that listwise deletion leaves after
requiring all 4 (or 7, for b_v1) predictors to be simultaneously non-null —
disclosed as a real, if expected, consequence of a joint model versus the
single `score` column test 1 uses.

**This produced a materially sharper finding than round 1**: in the joint
model, `sign1` is already significantly *negative* in development
(a_v1_hist t=-2.64) once sign2/sign3/sign6 are controlled for — round 1's
marginal correlation masked this (t=-1.02, insignificant) because sign1 is
itself positively correlated with sign2, which has a strong positive
marginal effect. `sign6` goes from a small positive loading in development
(t≈1.4-1.8) to a strongly negative one in validation (t≈-7.2 to -10.0) for
all four a_growth profiles. For b_v1, the joint model surfaces two
genuinely new findings invisible in round 1's marginal correlations:
`factor_drawdown_recovery` flips from insignificant in development to
significantly negative in validation (t=-3.90), and `factor_growth_discipline`
flips from insignificant to significantly positive (t=3.77).

---

## Item 7 — Test 6: full factor loadings, HML/momentum explicitly

Added the Carhart momentum factor (UMD) to the FF3 regression (Ken French's
`F-F_Momentum_Factor.csv`, same holdout-safety discipline: filtered to
2017-01–2023-12 before any other row was read, source file deleted after).
Full loadings for every profile/period are in `scr_results` trial 19.

**Direct answer to the question asked:** the a_growth validation reversal is
**not** explained by HML. HML betas in validation are small and
statistically insignificant for all four a_growth profiles (β≈-0.05 to
+0.01, t≈0.1–0.6) — there is no meaningful growth/value regime loading here.
Instead, **momentum (UMD) is significantly negative in validation** for
`a_v1_hist`, `a_v1_hist_rd`, `a_v1_hist_qqq_gate`, and `a_v1_hist_ff12` alike
(β≈-0.22 to -0.28, t≈-2.0 to -2.5, all significant at conventional levels) —
the long-short spread portfolio behaved as an anti-momentum bet during
2022-23. Even after controlling for all four factors, alpha remains
negative in validation (though not individually significant), so some
residual decay is not explained by any of the four factors — but the
dominant, statistically supported factor story is **momentum, not value**.
For b_v1, no factor loading is significant in validation, and
development's notable negative market/SMB/HML loadings (R²=0.31) do not
persist (R² falls to 0.07) — nothing systematic to report there beyond
round 1's finding.

---

## Updated bottom line

Round 2 sharpens, rather than overturns, round 1's conclusion. `b_v1`
remains the only profile with a cross-sectional relationship that holds up
(often strengthens) from development to validation, now further supported
by a joint multivariate factor model (`factor_size`, `factor_price_book`
both significant in both periods) rather than marginal correlations alone.
The three original a_growth profiles' validation-period reversal is now
better understood on two fronts: (1) it is driven at the sign level
specifically by `sign1` and `sign6`, and `sign1`'s damage is partly masked
in development by its positive correlation with `sign2` — a joint model is
needed to see it; (2) at the factor level, it is a **momentum**
phenomenon, not a value/growth (HML) one. `a_v1_hist_ff12`'s industry-neutral
valuation ranking shows a consistently milder version of the same reversal
across every test — worth a closer look as a candidate mitigation, not a
fix. The new Fool-restricted test (8b) finds the same negative
rule-breaker-pass signal within the tracked-picks subset, in both periods,
though every number there is disclosed as fully survivor-biased pending more
tracking history past 2025-07-29.

Per the governing gate, this still stops here — no Phase 4b work.
