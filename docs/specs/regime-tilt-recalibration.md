# RatioBo — Regime Tilt Recalibration: Inflation-Level Gate, Blended Override, Revised Sleeve & Sector Weights

**Status:** v1.1 (Oct 29, 2026). Phase 1 is built, deployed and replicated. Next up: the Phase 1 follow-ups (§3.5), then Phase 2.
**Owner:** Scott
**Builder:** Claude Code
**Suggested location in repo:** `docs/specs/regime-tilt-recalibration.md`
**Decisions log:** `docs/specs/regime-tilt-recalibration-decisions.md`
**Source paper:** Bera, Harvey & Hooper, *Stagflation and Asset Management* (Man Group / Duke, Oct 23 2026). Keep a copy in `reference/` so the builder can cite tables by number.

---

## Changes from v1 → v1.1

1. **Phase order swapped.** The override mechanics (blend, turnover cap, minimum hold, carry rule) are now **Phase 2**. The high-inflation weight variants move to **Phase 3**.
   - **Why:** Phase 1's live reading is Contained, so the variants would resolve to `base` today and wouldn't change the next regime shift.
   - **What Phase 2 must do differently:** it's written against a `getWeightSet(key, variant)` lookup that returns the existing `REGIME_DEFAULT_WEIGHTS[key]` until Phase 3 fills in the variants.
2. **§3.4 expected live state corrected.** v1 said high inflation was confirmed Apr–Jun 2026. That came from a reconnaissance query that computed YoY by row offset, not by date. The missing Oct 2025 CPI print turned every later "YoY" into a 13-month change, overstating 2026 inflation by 0.3–0.6 points. The builder's date-matched computation is correct; §3.4 now records the real state.
3. **New §3.5: Phase 1 follow-ups.**
   - show the threshold margin and a "could confirm by" date on the tile
   - label the data month vs the classification month
   - fill the Oct 2025 gap with a single documented interpolation
4. **§1 and §0 updated** for what's already shipped: INDPRO history, the classifier, `inflation_regime_history` and the `/macro` tile.

---

## 0. Why this exists

The paper sorts 107 years of US data into three real-time regimes and measures real returns for 47 assets in each:

- **Overheating:** high inflation with healthy growth.
- **Stagflation:** high inflation with weak growth.
- **Contained:** everything else.

"High inflation" is defined by the **level** of inflation relative to its own trailing 10-year history, and it is confirmed with a lag. Three findings bear directly on RatioBo:

1. **The level of inflation changes what direction means.** Rising inflation from a low level is fine for stocks. Rising inflation from an already-high level is the worst case (Exhibit 7: S&P −8.0% real, 60/40 −7.7%). RatioBo's quadrants only measure direction, so they can't tell these apart.
2. **Commodities make their gains on the way into Stagflation and give them back once it's confirmed.** This held in all three case studies (Section 6), and broad commodities average −2.0% real inside confirmed Stagflation. RatioBo does the opposite: commodities are 20% in Reflation and 30% in Stagflation.
3. **The most reliable diversifiers across both inflation regimes were trend-following and quality / low-beta equity factors.** RatioBo has no sleeve for either.

### Current-state findings (reconnaissance, Oct 29 2026)

- **Both portfolios swap their full weights on every regime change.** `update-regime-portfolio-targets` writes the complete `REGIME_DEFAULT_WEIGHTS[key]` set to All Weather Alpha (`95fc88e6…`) and All Weather With Equity Tilting (`2ab7c628…`). Nothing blends.
- **Near-term can override structural outright.** Once the near-term signal's 3-day average confidence is at least 60% for 7 days, its regime replaces structural.
- **Shift history shows whipsaw.**
  - 9/18: moved to Disinflationary Boom (60% equity).
  - 10/21: moved to Stagflation (10% equity).
  - 10/30: near-term Reflation confirms at 65%, moving to 50% equity. Scott is not trading on it.
- **The 10/21 shift came from a carry-forward, not a fresh reading.** Both structural axes were inside their dead bands (GDP gap −0.11 against a 0.80 band; CPI gap +0.14 against a 1.00 band), so `structuralKeyForPersist` fell back to `lastConfirmedKey`.
- **The paper's framework disagrees with structural on both axes.**
  - Inflation reads Contained, with a fresh Overheating candidate (§3.4).
  - Growth is clearly not weak: IP YoY is +2.25% against a 0.52% 10-year CAGR.
- **Nominal bonds are long duration only.** The `nb` sleeve holds just TLT. There's no short or intermediate option.
- **The Stagflation sector table has no consumer staples.** It doesn't include XLP, and XLP isn't held.
- **The CPI series has a real gap.** `CPIAUCSL` is missing Oct 2025 (government shutdown). Any calculation that walks the series by row instead of by date is wrong for every month after it. This is now a standing rule (§3.1).

---

## 1. Goals / non-goals

**Goals**

1. ~~Add the paper's inflation-level classifier as a slow-moving conditioning variable.~~ Done in Phase 1.
2. Replace the near-term full override with a confidence-scaled blend, a turnover cap and a minimum time between shifts.
3. Stop carry-forward structural readings from triggering new shifts.
4. Use the classifier to pick high-inflation variants of the Reflation and Stagflation weight sets.
5. Revise the sleeve weights and the Equity Tilting sector tables to match the paper's evidence.
6. Generalize the per-bucket instrument targets so the `nb` sleeve can prefer short or intermediate duration by regime.
7. (Phase 5) Add a trend sleeve.

**Non-goals**

- Changing the near-term or medium-term Forward Signal composites themselves.
- Changing Disinflationary Boom (`rg_fi`) or Deflationary Bust (`fg_fi`) weights. The paper's "Contained" bucket doesn't separate these two.
- Any trade execution. Targets only.

---

## 2. Phase 0 — Manual hold

1. **Migration:** add `portfolios.regime_auto_shift boolean not null default true`.
2. **Hold behavior in `update-regime-portfolio-targets`:** when the flag is `false`, keep running the signal clock exactly as today (state, history, notifications), but don't write `target_allocations` or `current_regime_key`.
   - Insert into `portfolio_regime_shifts` with a new column `applied boolean default true`, set to `false` here, so there's a record of what would have happened.
   - Send one notification per event: "Shift to X suppressed — auto-shift is off for Y."
3. **UI:** add a toggle on `/portfolios` next to each regime-driven portfolio's regime badge.
4. **Tests:** a held portfolio's targets don't change; the signal clock advances the same as for an unheld portfolio.

**Shipped.**

---

## 3. Phase 1 — Inflation-level classifier (**complete**, follow-ups in §3.5)

### 3.1 Data

- **INDPRO history:** FRED `INDPRO` monthly from 1919 is in `bond_raw_series` (`series_id = 'INDPRO'`), kept current by the existing nightly cron. Done.
- **CPI:** FRED's seasonally adjusted `CPIAUCSL` is used as-is.
- **Standing rule: every lag, YoY and window calculation matches by date, never by row offset.** Any function or SQL that touches these series must follow it. Add a test that feeds a series with a missing month and checks that the next month's YoY spans exactly 12 calendar months.
- **Gaps:** skip YoY when either endpoint is missing, and leave missing months out of the percentile window. The one exception is the Oct 2025 CPI interpolation in §3.5.

### 3.2 Rules (as built; matches the paper)

`m` is the month being classified. `t = m − 2` is the data month (the paper's 2-month publication lag).

| Signal | Definition |
|---|---|
| CPI YoY | `CPI[t]/CPI[t−12] − 1` |
| High inflation | CPI YoY at `t` > 75th percentile of CPI YoY over months `t−120 … t−1` (trailing 10 years, excluding `t`) |
| IP YoY | `IP[t]/IP[t−12] − 1` |
| IP trailing CAGR | `(IP[t]/IP[t−120])^(1/10) − 1` |
| Weak growth | IP YoY at `t` < IP trailing CAGR at `t` |
| Raw state | `high & weak` → `stagflation`; `high & !weak` → `overheating`; `!high` → `contained` |
| Confirmed state | A raw state must appear 3 months in a row. The first two candidate months keep the prior confirmed state, the new state starts in the third, and earlier months are never relabeled. |
| Acceleration, horizon h ∈ {3, 6, 9} | `(CPI[t]/CPI[t−h] − 1) > (CPI[t−h]/CPI[t−2h] − 1)` |
| Acceleration vote | `accelerating` if at least 2 of the 3 horizons say accelerating, `decelerating` if at least 2 say decelerating. A missing horizon becomes `mixed`. |

**Why the 3-horizon vote:** the paper's Table B4 shows the 3-month split flips sign in Overheating. The paper's headline uses 6 months only.

### 3.3 Code (as built)

- **Classifier:** `classifyInflationRegime` in `supabase/functions/_shared/inflationRegime.ts`, the single source of truth.
- **Storage and schedule:** the `inflation_regime_history` table is written by `update-inflation-regime`, which runs nightly at 23:30 UTC on weekdays. That's after the FRED pull and before the regime and portfolio jobs.
- **Pagination:** INDPRO reads paginate explicitly, because PostgREST's row cap was silently truncating at about 1,000 rows. Any future full-history read of `bond_raw_series` must paginate the same way.
- **Regime analysis:** `get-regime-analysis` writes `infl_level_state`, `infl_candidate_state`, `infl_candidate_count` and `infl_accel_vote` to `dalio_regime_analysis`, and adds SIGNAL 1b to Clio's prompt.
- **`/macro` tile:** shows the confirmed state, candidate progress, CPI vs its 75th percentile, IP vs its CAGR and the acceleration vote.

### 3.4 Acceptance (met)

- **Replication against real FRED data:**
  - Stagflation starts in Sep 1969, Apr 1974 and Oct 1979 hit exactly; end dates landed within 1–3 months.
  - Overheating 2021–22 and Stagflation 2023–24 both confirmed inside the paper's windows.
- **Live state (corrected from v1).**
  - The confirmed state is **Contained**.
  - A candidate run reached 2 of 3 (May 2026 CPI 4.17% vs a 3.42% threshold), then broke when the June data came in at 3.46% vs 3.59%.
  - The September data (3.72% vs 3.59%, a margin of +0.13 points) started a new **Overheating candidate, 1 of 3**.
  - If it confirms, it's Overheating, not Stagflation, because IP is +2.25% vs a 0.52% CAGR.
  - CPI has stayed within about ±0.5 points of its threshold all year.

### 3.5 Phase 1 follow-ups (**shipped**)

1. **Threshold margin.** `cpi_margin = cpi_yoy − cpi_p75` on `inflation_regime_history` and the tile. |margin| < 0.25 points (D-9) marks the reading "borderline" in both the tile and Clio's SIGNAL 1b block.
2. **Could-confirm date.** When `candidate_count` is 1 or 2 (and the candidate differs from the confirmed state), the tile shows an estimated confirmation date — 2nd Wednesday of the month after the confirming print, labeled "est." (no real BLS release-calendar data source; the estimate approximates BLS's usual ~2-week publication lag closely enough for a UI hint).
3. **Data month vs. classification month,** labeled explicitly everywhere this reading is shown (tile and Clio's prompt): "Sep 2026 data → Nov 2026 classification."
4. **Oct 2025 CPI gap** interpolated as the geometric mean of Sep/Nov 2025, inside `classifyInflationRegime`'s own input only — never written to `bond_raw_series`. One-off, hardcoded to this date (D-0), not a general gap-filling policy. Re-ran the full history afterward; the historical replication windows are unchanged, and the previously-`mixed` Jun/Sep 2026 acceleration votes now resolve.

**Checkpoint passed:** re-run of Sep–Nov 2026 shown to Scott; proceeding to Phase 2.

---

## 4. Phase 2 — Override and shift mechanics (moved up from v1 Phase 3)

### 4.0 Weight lookup seam

- **New lookup.** Add `getWeightSet(key, variant)` in `lib/simulatorKeys.js`, plus its mirror in `_shared`. Until Phase 3 it ignores `variant` and returns `REGIME_DEFAULT_WEIGHTS[key]`.
- **Route everything through it.** Every weight lookup in `update-regime-portfolio-targets`, the `/macro` simulator and `run-backtest` goes through this function. Phase 3 then only changes what the function returns.
- **`variant` is computed now and stored.** `high` when `infl_level_state` is `overheating` or `stagflation`, otherwise `base`. It's stored but has no effect yet.

### 4.1 Structural carry-forward doesn't trigger shifts

- **Record the source.** Persist `structural_key_source` on `dalio_regime_analysis`, with values `crossover`, `leaning`, `carry` or `null`. It comes from the existing precedence in `get-regime-analysis` around lines 1302–1307.
- **Only fresh readings can move the base.** In `update-regime-portfolio-targets`, a `carry` key never moves a portfolio off its current base. It only holds the current base.

### 4.2 Blended near-term override

- **Keep the confirmation gate.** The 3-day smoothing, the 60% floor and the 7-day rule decide whether near-term is active at all.
- **Blend when active.** Targets become:

  ```
  W = W_struct + λ · (W_near − W_struct)
  W_struct = getWeightSet(structuralKey, variant)
  W_near   = getWeightSet(nearKey, variant)
  λ = clamp((smoothedConf − 50) / 50, 0, λ_max)    // λ_max = 0.5 (D-2)
  ```

  Round to whole percentages and push the rounding remainder into cash.
- **Effect.** At 65% confidence, λ = 0.30, so near-term moves the portfolio 30% of the way toward its set. It never moves more than halfway.
- **Store the blend.** Persist it on the portfolio as `regime_blend jsonb`, e.g. `{struct_key, struct_source, variant, near_key, near_conf, lambda}`. `current_regime_key` keeps the structural key for display.
- **Show it in the UI.** Portfolio Actions and the `/portfolios` regime badge show the blend, e.g. "Stagflation base, 30% toward Reflation (near-term 65%)".
- **Sector tilts.** Equity Tilting's sector tilts within the `eq` bucket follow the same λ: a blend of the structural and near-term sector tables.

### 4.3 Turnover cap and minimum hold

- **Turnover cap.** Total one-way turnover per shift, Σ|Δw|/2, is at most 15 percentage points (D-3). If a target change needs more, move partway now and finish on the next daily runs, still capped at 15 points per run.
- **Minimum hold.** After an applied shift, wait at least 21 days before the next one (D-4).
  - **Exception:** structural (from a `crossover`) and near-term agree on a key that differs from the current one.
- **Change to the variant only.** If a shift is triggered only by `infl_level_state` changing, apply it once the paper's own 3-month confirmation is done; the 21-day hold doesn't apply.

### 4.4 Acceptance

- **Tests:** λ scaling; the turnover cap's multi-day convergence; the minimum hold and its agreement exception; `carry` never moving a portfolio; the `getWeightSet` seam returning today's weights unchanged.
- **Replay** 9/1–10/31/2026 from `nearterm_signal_history` and `dalio_regime_analysis` through the new rules. Report:
  - number of applied shifts (today's rules: 3)
  - peak and trough equity weight
  - total turnover
  - the resulting targets for 10/31
- **Expected direction:** the 10/21 move (a carry) is blocked, and the 10/30 Reflation confirmation becomes a partial blend capped at 15 points of turnover.

**Checkpoint:** show Scott the replay.

---

## 5. Phase 3 — High-inflation weight variants (moved down from v1 Phase 2)

### 5.1 Structure

- **Variants.** `getWeightSet(key, variant)` now returns `REGIME_WEIGHT_SETS[key][variant]`.
  - Only `rg_ri` and `fg_ri` get a `high` variant. `rg_fi` and `fg_fi` stay `base` only.
- **Acceleration modifier.** It applies only inside the `high` variants (§5.2). A `mixed` vote means no modifier.
- **Keep the copies in sync.** Weights are mirrored in `lib/simulatorKeys.js`, `update-regime-portfolio-targets` and `run-backtest`. Add a test that fails if the copies drift.

### 5.2 Proposed weights (% of portfolio). Decision D-1: Scott confirms or edits.

| Set | eq | intl | em | nb | tip | com | gld | cash | Total |
|---|---|---|---|---|---|---|---|---|---|
| `rg_ri` base (unchanged) | 20 | 10 | 20 | 0 | 15 | 20 | 10 | 5 | 100 |
| `rg_ri` high | 15 | 8 | 7 | 0 | 20 | 20 | 20 | 10 | 100 |
| `rg_ri` high + decelerating | 20 | 10 | 10 | 0 | 15 | 20 | 20 | 5 | 100 |
| `fg_ri` base (new, replaces current) | 25 | 5 | 0 | 20 | 15 | 10 | 15 | 10 | 100 |
| `fg_ri` high | 15 | 5 | 0 | 15 | 20 | 12 | 20 | 13 | 100 |
| `fg_ri` high + accelerating | 15 | 5 | 0 | 15 | 15 | 12 | 25 | 13 | 100 |
| `fg_ri` high + decelerating | 15 | 5 | 0 | 15 | 25 | 12 | 15 | 13 | 100 |
| `rg_fi`, `fg_fi` | unchanged | | | | | | | | |

**Rationale.** All figures are from the paper; table numbers are given so they can be checked.

- **`rg_ri` high:** equity is cut from 50% to 30%. In Overheating, the S&P earns −0.2% overall and −8.0% when inflation is accelerating (Exhibit 7). Gold rises to 20% (+14.2%, +17.9% accelerating). Nominal bonds stay at 0% (30-year −6.4%, −13.7% accelerating).
- **`rg_ri` high + decelerating:** equity goes back to 40%. The S&P earns +10.4% and 60/40 +7.5% in decelerating Overheating.
- **`fg_ri` high:** commodities are cut from 30% to 12% (broad −2.0%, energy futures −23.8%, industrial metals −8.4%). Gold drops from 30% to 20% for concentration reasons. Equity rises from 10% to 20% (S&P +0.7%, not worse than bonds). Nominal bonds go from 0% to 15%, held short or intermediate per Phase 4 (2-year +1.7%, 5-year +0.9%).
- **Acceleration tilts within `fg_ri`:** gold +16.9% accelerating vs +2.9% decelerating; TIPS −2.0% accelerating vs +5.5% decelerating.
- **`fg_ri` base:** this is "growth falling, inflation rising, but the level isn't high," which the paper would call Contained, where returns are broadly positive. So it gets a moderated defensive mix rather than the current 10%-equity / 60%-real-assets set.
  - This is a judgment call; flag it in the decisions log.
  - **This set applies today.** Structural is Stagflation and the paper's state is Contained, so it takes effect as soon as Phase 3 ships.
- **Trend:** these sets assume no trend sleeve. Phase 5 carves 5–10% for trend out of cash and TIPS in the `high` variants.

### 5.3 Acceptance (met)

- Every set sums to 100, enforced by a test.
- `/macro`'s Positioning Signal and `/portfolios`' regime badge show the variant in use, e.g. "high-inflation, decelerating". (Not the standalone `/simulator` page specifically — "the macro simulator" read as the Positioning Signal feature on `/macro` itself, where Portfolio Actions' own variant display already lives per Phase 2.)
- A literal "re-run the Phase 2 replay" doesn't apply the way it did in v1 — Phase 2's one-off replay was superseded by the Shadow Targets Log. The `phase2` vs. `phase3` shadow lanes now serve as the ongoing live comparison instead; see the Shadow Targets Log spec.

**Shipped 2026-10-30.** D-1 confirmed as tabled (see decisions log). `regime_phase3_weights` (renamed same day from `regime_variants_enabled` — its real scope is the whole D-1 weight-set revision, not just the variant tier; default `false` for both portfolios) is a second, independent safety lever from `regime_auto_shift`: with it off, the live job uses the frozen pre-Phase-3 weight sets entirely, so re-enabling auto-shift alone tests Phase 2's rules against the original numbers. The live function always stores the real computed variant in `regime_blend.variant` regardless of the flag. The `phase3` shadow lane always computes the real variant, ignoring that flag (per the Shadow Targets Log spec's `variants_flag_off` code). The `legacy` shadow lane was also found to need its own frozen weight copy, decoupled from the shared `getWeightSet` — see the decisions log.

---

## 6. Phase 4 — Per-bucket instrument targets (sectors and bond duration)

### 6.1 Generalize `portfolio_sector_targets`

- **Add two columns** to `portfolio_sector_targets`: `bucket text not null default 'eq'` and `variant text not null default 'base'`. Update the unique key to `(portfolio_id, bucket, symbol, regime_key, variant)`.
- **Resolve the lookup:** first `(regime_key, variant)`, then fall back to `(regime_key, 'base')`.
- **Update readers.** Every place that reads the table (`app/portfolios/page.jsx`, `analyze-portfolio-health`) must filter by `bucket = 'eq'` for the existing sector logic.

### 6.2 Equity Tilting sector tables (% of the `eq` bucket). Decision D-5.

XLP is new. Scott has to add the holding before targets that include it can be acted on; until then, show its weight as "unheld target".

**`fg_ri` / high and base (both proposed):**

| Ticker | XLV | XLP | XLE | XLF | XLY | XLB | XLK | XLI | XLC |
|---|---|---|---|---|---|---|---|---|---|
| Weight | 18 | 15 | 15 | 11 | 10 | 9 | 9 | 8 | 5 |

Sums to 100.

- **Healthcare** +5.7% real: up from 16 to 18.
- **Staples** (non-durables) +5.3%: new at 15.
- **Energy equities** +5.7%: fine, but 24% was concentrated, so cut to 15.
- **Telecom** −2.9%: XLC cut from 9 to 5.

**`rg_ri` / high (new; `rg_ri` / base keeps the current table):**

| Ticker | XLE | XLI | XLK | XLF | XLY | XLB | XLV | XLC |
|---|---|---|---|---|---|---|---|---|
| Weight | 22 | 16 | 15 | 15 | 10 | 9 | 7 | 6 |

Sums to 100.

- **Energy** +9.6% in Overheating: the clear winner.
- **Chemicals** −1.0% and **telecom** −2.5%: trimmed.

**Caveat (put in the UI tooltip):** the paper uses French 12-industry portfolios, which map only roughly to SPDR sectors. For example, Wholesale/Retail and Consumer Durables are both inside XLY.

### 6.3 Nominal-bond duration by regime. Decision D-6.

Add `bucket = 'nb'` rows for both portfolios:

| Regime / variant | TLT | IEI (3–7 yr) |
|---|---|---|
| `fg_fi` (all variants) | 100 | 0 |
| `rg_fi` (all variants) | 60 | 40 |
| `fg_ri` (all variants) | 0 | 100 |
| `rg_ri` (all variants) | n/a (nb = 0) | n/a |

- IEI is new; Scott has to add the holding.
- **If `use_bond_lens_overlay` is on, Bond Lens governs duration.** Skip the `nb` bucket rows and say so in Portfolio Actions. Confirm against `docs/specs/bond-lens-decisions.md` that Bond Lens's sleeve math is unaffected.

---

## 7. Phase 5 — Trend sleeve (separate checkpoint; touches the simulator)

1. **New simulator key `trend`.** Add it to the bucket list in `lib/simulatorKeys.js`, `RegimeSimulator`, `run-backtest`, `all-weather-alpha-backtest`, `riskParity` and the `alt_` exclusion logic. Return history:
   - DBMF from 2019
   - before that, SG Trend Index or a documented proxy — the builder proposes the proxy, and Scott approves it.
2. **Weights.** Trend gets 7% in `rg_ri` high, 10% in `fg_ri` high and 5% in `fg_ri` base, funded pro rata from cash and TIPS. The paper's evidence: multi-asset trend +13.5% in Stagflation and +7.4% in Overheating.
3. **Reclassify DBMF.** `bond-lens.md` §0 already flags DBMF mis-tagged as `nb`. Move it to `trend` as part of this phase.
4. **Quality factor:** no new sleeve. Add `QUAL` as an `eq`-bucket instrument for All Weather Alpha in the `high` variants via §6.1 (VTI 60 / QUAL 40). Decision D-7.

---

## 8. Phase 6 — Validation backtest

- **Extend `all-weather-alpha-backtest`** to run old rules against new rules, monthly, over 2004–2026 (the span of `macro_regime_history`). Use the existing asset return history.
- **Report:**
  - CAGR, volatility, max drawdown, worst 12 months
  - turnover per year and number of regime shifts
  - time spent in each regime and variant
- **Acceptance:** fewer shifts and less turnover, with max drawdown no worse.
  - State plainly that 2004–2026 contains only one high-inflation stretch (2021–24), so return differences aren't statistically meaningful. The goal is lower whipsaw, not proving alpha.

---

## 9. Decisions for Scott

| ID | Decision | Default proposed |
|---|---|---|
| D-0 | Interpolate the Oct 2025 CPI gap for the classifier only (§3.5) | Yes, geometric mean of Sep/Nov 2025 — **shipped** |
| D-1 | Sleeve weights in §5.2, including the new `fg_ri` base | As tabled |
| D-2 | λ_max for near-term blending (§4.2) | 0.5 |
| D-3 | Turnover cap per shift (§4.3) | 15 percentage points one-way |
| D-4 | Minimum hold between shifts (§4.3) | 21 days, with the agreement exception |
| D-5 | Sector tables in §6.2, and adding XLP | As tabled; Scott buys XLP |
| D-6 | `nb` duration split in §6.3, and adding IEI | As tabled; skipped when Bond Lens is on |
| D-7 | Trend proxy, trend weights, QUAL split (§7) | As written |
| D-8 | Whether `rg_fi` / `fg_fi` should get variants later | No; revisit after Phase 6 |
| D-9 | Borderline band for the CPI margin flag (§3.5) | ±0.25 points — **shipped** |

---

## 10. Phase order and checkpoints

1. ~~Phase 0: hold flag.~~ Shipped.
2. ~~Phase 1: classifier, data, tile, replication.~~ Done.
3. ~~Phase 1 follow-ups (§3.5): margin, confirm date, labels, Oct 2025 interpolation.~~ Shipped.
4. ~~Phase 2: weight seam, carry rule, blend, turnover cap, minimum hold.~~ Shipped (the Shadow Targets Log superseded the one-off replay).
5. ~~Phase 3: weight variants (D-1), `regime_phase3_weights`.~~ Shipped.
6. ~~Phase 4 §6.1/§6.2: sector tables (D-5), `regime_phase4_sectors`.~~ Shipped 2026-10-31,
   shadow-only. §6.3 (duration) explicitly skipped — see decisions log; both
   regime-driven portfolios run Bond Lens, which governs duration instead.
7. **Phase 5:** trend sleeve. Stop.
8. **Phase 6:** validation backtest. Final report.

For every phase:
- Start from a plan.
- Run the vitest suite and `npx next build`.
- Ship migrations as dated files in `supabase/migrations/`.
- Deploy only after Scott approves; a push to `main` deploys to production.
