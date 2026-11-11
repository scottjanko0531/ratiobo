# Phase 4a Test Battery — Final Report

**Scope:** 8 pre-registered tests (`scr_trials` ids 6-13) across 4 `profile_version`s
(`a_v1_hist`, `a_v1_hist_rd`, `a_v1_hist_qqq_gate` — collectively "a_growth" — and
`b_v1`), development period (2017-01 to 2021-12) run first and unchanged thereafter,
validation period (2022-01 to 2023-12) run second with no methodology tuning based on
its results, holdout period (2024-01+) never queried. All numeric results are stored
in `scr_results` keyed by `trial_id`; headline summaries are also stored in
`scr_trials.results`. Commit hash for the analysis code written/committed this
session: `1328b1536960d5aa67e1aabface6962950e83ee8`
(`scripts/scr_scoring/phase4a_tests/`).

**Known gaps, disclosed up front (not silently patched):**
- Tests 1, 3, 4, 5 (trials 6, 8, 9, 10) were originally run before a context-compaction
  event in this working session; their exact executed SQL was not preserved. The
  committed `.sql` files in this directory are post-hoc reconstructions from each
  trial's pre-registered methodology text, spot-checked against the stored
  `scr_results` rows. Test 1 and Test 3 reconstructions match the stored numbers
  **exactly**. Test 4's point estimates match exactly but its standard errors/t-stats
  could not be reconstructed (the original SE methodology is unrecovered — treat
  Test 4 significance claims as from the original run only). Test 5's base rates match
  in direction/shape but not exact value (likely a different null-gate upstream of
  `reached_10x_in_60m`). See `README.md` and each file's header for detail.
- Test 5's `big_winner_rate_by_quintile` result rows carry no needs_review filter split
  — they were computed once for the full ("all") universe only.
- Test 2 (trial 7, Quintile Portfolios) has the same code-provenance gap as tests
  1/3/4/5 but is not reconstructed in this directory since it is used only as an input
  to tests 6-8, whose reconstructions already exercise the same quintile-construction
  logic.

---

## Cross-cutting headline

The single clearest pattern across all 8 tests: **`b_v1` (the value/quality profile)
shows directionally consistent, often strengthening signal between development and
validation; the three `a_growth` profiles show signal that is weak-to-absent in
development and frequently flips sign (the wrong way) in validation.** This shows up
independently in the IC test, the rule-breaker test, the sign-contribution test, the
big-winners test, and the A-fool comparison. None of the 4 profiles clears
conventional significance on the central long-short spread test (Test 2) in either
period, and no Fama-French alpha is significant for any profile/period. The with/without
`needs_review` filter never flips a conclusion anywhere in the battery — all qualitative
findings below are robust to that filter.

---

## Profile: a_growth (`a_v1_hist`, `a_v1_hist_rd`, `a_v1_hist_qqq_gate`)

These three profiles share the same underlying 6-sign input and move together on
every test (their composite formulas differ only at the margin — Rule Breaker gating,
R&D treatment, QQQ-gate — which rarely changes the sign or significance of a result).

**Headline finding:** no test finds a significant positive score→return relationship
in validation; several tests find a significant *negative* one.

**Evidence for a real signal (development period only):**
- Test 3 (Rule Breaker, trial 8): `rule_breaker_pass=true` names beat the rest by
  +6.7%/12m (t=1.28, not significant) and +1.1%/1m (t=1.89, marginal).
- Test 4 (Sign contribution, trial 9): sign2 and sign3 are positively correlated with
  above-median 12m returns in development (sign2 t≈2.8-3.0 depending on profile), and
  stay positive in validation too (sign2 t≈1.2-1.7, sign3 t≈2.5).
- Test 8 (A-fool, trial 13): Q5 beats the full-universe baseline in development at
  every horizon sampled (+4.2-4.3%/12m, t≈0.92-0.92, not significant).

**Evidence against (development→validation changes):**
- Test 1 (IC, trial 6): 12m IC goes from +0.002 (dev, insignificant) to **-0.073 to
  -0.077** (val, NW t≈-2.8 to -2.85, significant) across all three profiles. The score
  is significantly *negatively* related to forward return in validation.
- Test 2 (Quintile spread, trial 7): Q5-Q1 12m spread flips from +4.2% gross (dev) to
  **-3.5%** gross (val); neither is significant (t=0.51 dev, t=-1.17 val), but the sign
  flip is consistent with Test 1.
- Test 3 (Rule Breaker, trial 8): the +6.7%/12m development spread flips to **-5.0%**
  in validation (t=-1.23, not significant).
- Test 4 (Sign contribution, trial 9): sign1 is near-zero in development (t=-1.02) but
  becomes **strongly, significantly negative in validation (t≈-13.8)**; sign6 similarly
  flips from near-zero (t=-0.03 dev) to **strongly negative (t≈-7.2 val)**. These two
  signs appear to actively work against the composite out of sample.
- Test 5 (Big winners, trial 10): 10x-hit rate by score quintile is **U-shaped**, not
  monotonic, in development — Q1 (worst score) hits 10x about as often as Q5 (best
  score), both well above Q2-Q4. The cross-sectional z-score-diff confirms no real
  separation in development (t≈-1.0, insignificant); validation's apparent positive
  result (t≈3.0) rests on only 20 winner-observations total.
- Test 6 (Fama-French, trial 11): no significant alpha in either period (|t|<1.0); low
  R² throughout (0.01-0.05), meaning the 3 factors explain almost none of the monthly
  spread's variance either way.
- Test 7 (Regime split, trial 12): no bull/bear cell reaches significance; spreads are
  small and inconsistent in sign across regimes and periods.
- Test 8 (A-fool, trial 13): Q5 **underperforms** the naive full-universe baseline in
  validation (-2.2% gross/12m, t≈-1.49 to -1.63), the opposite of development's
  direction (though neither crosses the conventional 5% two-tailed threshold).

**With/without needs_review:** no qualitative flip in any test; magnitudes move by
single-digit percent of their own value at most (e.g. Test 1's 12m IC: -0.0731 "all" vs
-0.0738 "excl_review" in validation).

---

## Profile: `b_v1`

**Headline finding:** the only profile with a cross-sectional relationship that holds
up, and in several tests strengthens, from development into validation — though it
still never clears the long-short-spread significance bar after costs (Test 2), and its
Fama-French fit collapses out of sample (Test 6).

**Evidence for:**
- Test 1 (IC, trial 6): 12m IC goes from +0.007 (dev, insignificant) to **+0.051**
  (val, NW t=2.97, significant) — the only profile with a significant *positive* IC in
  either period.
- Test 3 (Rule Breaker proxy — Q5 vs rest, trial 8): positive in both periods and
  *strengthens*: t=0.92 (12m dev) → t=1.94 (12m val); t=0.62 (1m dev) → t=1.87 (1m val).
- Test 4 (Sign/factor contribution, trial 9): `factor_size` is consistently negative
  (small-cap tilt, as expected) in both periods; `factor_fcf_yield`,
  `factor_profitability`, `factor_price_book`, `factor_trailing_pe`, and
  `factor_growth_discipline` are all positive in both periods and get *more*
  significant in validation (e.g. `factor_fcf_yield` t=1.39 dev → t=6.40 val;
  `factor_profitability` t=1.32 dev → t=8.65 val). Only `factor_drawdown_recovery` stays
  flat/insignificant throughout.
- Test 5 (Big winners, trial 10): monotonic 10x-hit rate by quintile in development
  (Q1 2.0% → Q5 3.7%), and the strongest single result in the whole battery: winners'
  mean standardized score exceeds the rest of the universe by +0.22, NW t≈5.9-6.0,
  n=907-909 winner-observations (development). Validation direction is the same
  (+0.37 to +0.56, t≈1.1-1.75) but on only 9-10 winner-observations, so underpowered.
- Test 8 (A-fool, trial 13): Q5 beats the naive full-universe baseline in validation at
  12m with gross t=2.07 (significant), the only significant gross result anywhere in
  Test 8; net-of-cost t=1.60 (not significant — the 25bps/side single-leg cost erodes
  most but not all of the edge).

**Evidence against:**
- Test 2 (Quintile spread, trial 7): 12m Q5-Q1 spread is positive in both periods
  (+9.1% gross dev, +1.4% gross val) but never significant (t=0.83 dev, t=0.51 val);
  after the 25bps/side cost (the highest cost tier, reflecting b_v1's lower-turnover
  value/quality universe), breakeven cost is 228bps/side in development but drops to
  36bps/side in validation — the margin for error shrinks sharply out of sample.
- Test 6 (Fama-French, trial 11): development has the highest R² of any cell in the
  battery (0.31) with a notably negative market/SMB/HML loading (mkt beta=-0.56,
  t=-1.74, marginal) — but this entire factor relationship **collapses in validation**
  (R²=0.05, all betas insignificant, alpha still insignificant). Whatever the factor
  exposure was capturing in development did not persist.
- Test 7 (Regime split, trial 12): development-bear shows a large positive spread
  (+10.1% gross) but on only 6 months, nowhere near significant (t=0.96) — suggestive,
  not evidentiary.

**With/without needs_review:** no qualitative flip; e.g. Test 1's validation 12m IC is
+0.0514 ("all") vs +0.0494 ("excl_review"); Test 9's factor coefficients move by low
single-digit percent.

---

## Bottom line

Of the 4 profiles tested across 8 methodologically varied angles, only `b_v1` shows a
cross-sectional relationship between its score/factors and forward returns that is
*consistent in sign* and *often strengthens* from development to validation (Tests 1,
3, 4, 5, 8). It still fails to produce a statistically significant, cost-net long-short
spread (Test 2) or a stable factor-model fit (Test 6) — so "consistent direction" should
not be read as "proven, tradeable edge." The three `a_growth` profiles show the
opposite pattern on several of the same tests: weak-to-absent signal in development
that flips to a significant *negative* relationship in validation (Tests 1, 4), which is
a materially more concerning result than simple non-significance, since it indicates
the composite's current construction (specifically sign1 and sign6, per Test 4) may be
actively working against forward returns out of sample rather than merely failing to
help.

Per the governing gate, this concludes Phase 4a. No Phase 4b work (gradient boosting,
neural nets, or any other model-complexity increase) proceeds until this report is
reviewed.
