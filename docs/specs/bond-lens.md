# RatioBo — Bond Lens Overlay: Build Spec

**Status:** v2.1 (Oct 2026), approved after Step 0 reconnaissance. v2 made Bond Lens a per-portfolio, toggleable overlay that acts on that portfolio's bond holdings; v2.1 resolves the reconnaissance conflicts and locks the decisions below before Phase A.
**Owner:** Scott
**Builder:** Claude Code
**Suggested location in repo:** `docs/specs/bond-lens.md`
**Decisions log:** `docs/specs/bond-lens-decisions.md`

---

## 0. Changes from reconnaissance (v2 → v2.1)

Reconnaissance findings and Scott's decisions on each, in full in
`bond-lens-decisions.md`. Summary, in spec-section order:

1. **Settings split (§3.5).** `portfolios.use_bond_lens_overlay` (boolean,
   default `false`) is the single source of truth for on/off — same
   mechanism as `use_market_overlay`/`use_capex_overlay`. `bond_lens_portfolio_settings`
   holds everything else and has **no `enabled` column**. A portfolio with
   the flag on and no settings row uses the spec defaults below.
2. **Per-sleeve reallocation (§6.1–6.3)** is its own function, run after
   the existing overlay stack (`combineAllOverlays` + Market Conditions),
   operating on each in-scope bond holding's *post-multiplier* weight —
   resize/capex cuts on bond holdings are respected, not undone. The
   sleeve is **`nb` + `tip` combined**; that combined weight is fixed, but
   the split between the two buckets can shift (that's the TIPS tilt).
   Report the resulting `nb`/`tip` bucket weights alongside the original
   targets. **No cash interaction in v1** — Bond Lens never adds to or
   draws from cash; the spec's "route to cash if no eligible short
   instrument" fallback (§6.3) is dropped. Instead: don't shorten, set
   `target_reachable = false`, write a `gap_note`. Solved as a small LP
   minimizing total |Δweight| (duration/mix constraints are linear in
   weights) — see §6.3 for the library/greedy-algorithm choice, to be
   proposed in the Phase D plan.
3. **Classification (§6.1)** is a first deliverable **inside Phase A**,
   before `bond_instrument_meta` is touched: a worksheet covering every
   holding with `simulator_key` in (`nb`, `tip`) or `asset_type` in
   (`bond`, `cd`, `money_market`, `loan`), with a proposed `bond_type`,
   in-scope flag, and duration source. Scott confirms the worksheet before
   anything is written to `bond_instrument_meta`. Default proposals:

   | Holding type | Proposed treatment | Notes |
   |---|---|---|
   | BDCs (ARCC, BXSL) | Out of scope (`other`, equity-like) | |
   | DBMF | Out of scope (`other`, managed futures) | |
   | Private notes/loans | Out of scope | No market duration |
   | CDs | In scope only if `maturity_date` is populated | Otherwise out, and flagged |
   | Bond ETFs/funds | Effective duration entered manually with an `as_of` date | Stale warning after 90 days |
   | Individual bonds | Duration computed from coupon, maturity and yield | Excluded if those fields are missing |

   Separate, non-Bond-Lens ticket: `simulator_key = "nb"` currently mixes
   in BDCs and DBMF in the *existing* simulator too, distorting bucket
   math outside Bond Lens. Logged in `bond-lens-decisions.md` as a
   cleanup item for later, out of scope here.
4. **`solver_override_enabled` (§6.4) is removed from v1** — there is no
   live per-portfolio correlation-aware solver to override (confirmed in
   reconnaissance: `lib/riskParity.js` is asset-class-level, used only by
   `/macro`'s sandbox simulator, never a real portfolio's live targets).
   **`hedge_reliable` is still computed and displayed** — it already
   drives the "Bills / short TIPS" instrument preference inside the
   sleeve reallocation itself, so it has a real v1 effect without a solver.
5. **`macro_pillar_enabled` (§6.4) is deferred** until Market Conditions
   Phase 4 (the macro pillar) ships. **The curve regime classifier (§4.6)
   is still computed and shown** in the market view regardless.
6. **Normalization (§4.1, §4.3).** Carry, valuation, and term-premium
   modules keep **literal z-scores** ((x − mean) / stdev), not Market
   Conditions' percentile-rank convention — deliberate, because magnitude
   ("how cheap") matters here, not just rank. **Clip at ±3.** Window:
   2520 trading days, 756-day minimum — matches Market Conditions'
   window lengths, difference is the statistic, not the window.
7. **Auction data (§7, §8)** is a **display-only cross-check** next to
   term premium in the market view — not a score input in v1. In Phase E,
   test `bid_to_cover_ratio` and the `high_yield − avg_med_yield`
   dispersion proxy as candidate inputs and report whether either adds
   anything beyond ACM term premium. Source already exists and is
   populated: `treasury_auction_results` (`ingest-auction-results`,
   Treasury Fiscal Data API, since 2010).
8. **Infrastructure confirmed as-is**: FRED via `FRED_API_KEY`; Yahoo v8
   into `asset_price_history` with `.range()`-paginated backfills (the
   1000-row PostgREST cap bit the Market Conditions chart in exactly this
   way); `pg_cron` + edge functions, not Vercel cron. The weekly composite
   runs after Friday close, offset from Market Conditions' 22:30/22:40
   UTC jobs.

---

## 1. Purpose and how the overlay works

Bond Lens is an **overlay** that can be **turned on or off for each portfolio individually**. When it is on for a portfolio, it applies to **every bond holding in that portfolio**. When it is off, that portfolio is untouched.

The overlay works in two layers:

1. **Market signal (global, computed once).** A weekly read of the bond market that answers:
   - **How much duration to hold:** Short, Neutral, Extend, or Max extend.
   - **Which instrument:** nominal Treasuries, TIPS, or bills.
   - **Where on the curve:** 2y, 5y, 7y, or 10y.
   - **Whether bonds will hedge equities right now:** the stock-bond correlation regime.

   The signal is the same for every portfolio and doesn't depend on any holdings.

2. **Portfolio application (per portfolio, only where enabled).** For each portfolio with Bond Lens turned on:
   - identify its bond holdings,
   - measure the sleeve's current duration, instrument mix and maturity profile,
   - produce adjusted target weights for those holdings that move the sleeve toward the market signal.

The signal decomposes bond returns into:

- **What's knowable:** carry and rolldown.
- **What moves prices:** policy path vs. what's priced, valuation, and growth/inflation surprises.

A trend filter gates timing. A Howell-style yield-curve regime is a cross-check, not a driver.

### Scope rules

- **Off means off.** With Bond Lens disabled, a portfolio's outputs must be identical to a build without Bond Lens.
- **Bond sleeve only by default.** The overlay reshapes holdings *within* the bond sleeve. By default it does not change the sleeve's total weight or touch non-bond holdings.
- **Optional sub-toggles.** Effects that reach beyond the bond sleeve are separate per-portfolio sub-toggles, **off by default**:
  - the risk-parity correlation override,
  - the contribution to the market-conditions overlay.

  See Section 6.4.

### Non-goals

- No trade execution or order generation. The overlay outputs target weights and deltas only.
- No proprietary data (Howell/CrossBorder Global Liquidity, paid economic surprise indices).
- No point forecasts of yields.

---

## 2. Step 0: Repo reconnaissance (do first, before writing code)

Read the following and summarize back to Scott before building.

### Overlay framework

- How the market-conditions overlay is structured and attached to portfolios:
  - Is there already a per-portfolio enable/disable mechanism? If so, **Bond Lens must use the same mechanism**. Don't create a parallel one.
  - Where per-portfolio overlay settings are stored.
  - How the overlay order is defined (strategic allocation → solver → overlays).
  - How the equity cut is routed to the portfolio's cash bucket.

### Holdings model

- How holdings are stored: tickers, individual bonds/CUSIPs, funds.
- What asset-class, sub-type and duration metadata already exists.
- Whether there's an instrument/security master table.

### Data and solver

- **Scoring conventions:**
  - Market-conditions Phase 1–3 scales, z-score windows, tier mapping.
  - `risk_overlay_scores` schema.
- **Risk-parity solver:**
  - Where covariance is built.
  - Where overrides can be injected.
- **Existing data fetchers:**
  - FRED integration and API key location.
  - Price data source.
  - Scheduling approach (Supabase cron / edge functions vs. Vercel cron).
- **Existing rates work:**
  - The 10y → mortgage module.
  - Treasury auction bid-to-cover tracking.
  - Reuse yield ingestion rather than duplicating it.
- **Macro pillar curve inputs:** whether the market-conditions macro pillar already uses curve slope.

### Deliverable

A short reconnaissance note covering:

- the conventions you'll follow,
- how the per-portfolio toggle will be implemented,
- how bond holdings will be identified,
- any conflicts with this spec, with proposed adjustments.

Wait for approval before Phase A.

---

## 3. Data sources and storage (Phase A)

All sources are free. Verify that each series ID resolves; report any that fail.

### 3.1 FRED (daily unless noted)

| Purpose | Series IDs |
|---|---|
| Nominal curve | `DGS3MO`, `DGS1`, `DGS2`, `DGS3`, `DGS5`, `DGS7`, `DGS10`, `DGS30` |
| Real (TIPS) yields | `DFII5`, `DFII10` |
| Breakevens | `T5YIE`, `T10YIE`, `T5YIFR` (5y5y forward) |
| Policy rate | `DFF`, `SOFR` |
| Term premium (fallback) | `THREEFYTP10` (Kim-Wright 10y) |
| Growth nowcast | `GDPNOW` (~2011+) |
| Inflation | `PCEPILFE`, `CPIAUCSL`, `EXPINF1YR` (monthly) |

### 3.2 NY Fed

- **ACM term premium.** The primary term-premium source. Use the 10y column of `ACMTermPremium.xls`.
- **Holston-Laubach-Williams r-star.** Quarterly US series.
  - Apply a **one-quarter publication lag**.
  - Store the fetch date, since the series is revised.

### 3.3 Prices (existing RatioBo provider)

- Adjusted closes for `SPY`, `IEF`, `TLT`, `TIP`, `SHY`, `BIL`.
- Also pull adjusted closes for any bond ETFs/funds held in Bond Lens-enabled portfolios.

### 3.4 Synthetic bond returns

Build `price_par_bond(coupon, yield, years)` (semiannual) and use exact repricing to estimate constant-maturity total returns from FRED yields. Use it for:

- backtests before ETFs existed,
- cross-checks against ETF returns.

### 3.5 Storage

Follow the conventions found in Step 0. If none exist, use these tables.

**Global (market signal):**

- `bond_raw_series`: `series_id`, `obs_date`, `value`, `source`, `fetched_at`.
- `bond_signals`: `as_of_date`, one column per module output (Section 4), `inputs_hash`.
- `bond_lens_signal`: `as_of_date`, `duration_score`, `duration_stance`, `duration_multiplier`, `instrument_pref`, `maturity_pref`, `hedge_reliable`, `curve_regime`, `quadrant`, `explanation` (jsonb).

**Per portfolio (application):**

- `bond_lens_portfolio_settings` — **no `enabled` column** (v2.1): the
  single on/off switch is `portfolios.use_bond_lens_overlay`, same
  mechanism as the other overlays. A portfolio with the flag on and no
  row here uses the defaults below. `solver_override_enabled` is dropped
  entirely (v2.1 §6.4 — no solver exists to override). `macro_pillar_enabled`
  stays as a column, deferred/inert until Market Conditions Phase 4 ships.

  | Column | Default |
  |---|---|
  | `portfolio_id` | |
  | `benchmark_duration` | null → use the sleeve's strategic duration (6.1) |
  | `tips_split_when_tilted` | 0.60 |
  | `eligible_instruments` | null → held instruments plus the default substitute list (6.3) |
  | `include_credit` | `true` (6.2) |
  | `macro_pillar_enabled` | `false` |
  | `min_trade_threshold` | 0.5% of portfolio |
  | `updated_at`, `updated_by` | |

- `bond_lens_portfolio_adjustments`:
  - `portfolio_id`, `as_of_date`, `signal_as_of_date`
  - current sleeve stats: weight, duration, mix
  - target sleeve stats
  - per-holding rows: holding ID, current weight, target weight, delta, rationale
  - `target_reachable` (bool), `gap_note`

- `bond_lens_toggle_log`: `portfolio_id`, `action` (enabled / disabled / settings_changed), `old_value`, `new_value`, `changed_at`.

### Refresh cadence

- Ingest daily.
- Compute the global signal weekly (Friday close), with a provisional daily read for the UI.
- Recompute portfolio adjustments for enabled portfolios when any of these happens:
  - a new weekly signal is published,
  - the portfolio's holdings change,
  - the portfolio's Bond Lens settings change.

### Phase A acceptance

- All series ingested to their start dates.
- Gaps reported.
- Jobs idempotent.
- Settings and log tables created.

---

## 4. Signal modules (Phase B, global)

### Conventions for every module

- **Config:** all thresholds, windows and weights live in a single config module (e.g. `bondLensConfig.ts`). The defaults below are starting points; Phase E sets the final values.
- **Output:** each module returns a **score in [−2, +2]**, where positive means favorable to holding or extending duration, plus its raw inputs for the explanation text.
- **Normalization (v2.1, every "z-score" in this section):** literal z-score, `(x − mean) / stdev`, over a rolling **2520-trading-day window, 756-day minimum** — same window lengths as Market Conditions, but a genuine z-score rather than Market Conditions' percentile-rank convention, deliberately: magnitude ("how cheap") matters here, not just rank. **Clip the result to [−3, +3]** before folding it into a module score.

### 4.1 Carry and rolldown

For n ∈ {2, 5, 7, 10}:

- **Modified duration (par bond):** `D_mod = (1/y) * (1 − (1 + y/2)^(−2n))`
- **12-month carry and rolldown:** `CR_n = y_n + D_mod(n−1) * (y_n − y_(n−1))`, with `y_(n−1)` linearly interpolated.
- **Breakeven yield rise:** `BE_n = CR_n / D_mod(n)`
- **Efficiency:** `EFF_n = CR_n / D_mod(n)`, the carry earned per unit of rate risk.

**Output:**

- a per-maturity table,
- `carry_score`: z-score of (10y `CR` minus the 3m bill yield) over a rolling 10-year window.

### 4.2 Priced path vs. likely path

**Inputs:**

- **Priced path proxy:** `priced_hikes = DGS2 − DFF`. Positive means the market is pricing hikes.
- **Growth momentum:** `growth_mom` = 8-week change in `GDPNOW`. Before 2011, substitute the 3-month change in 5y breakevens plus curve momentum, and flag the result as degraded.
- **Inflation trend:** `infl_trend` = core PCE 3-month annualized minus the 12-month rate.

**Scoring:**

- **Bond-bullish:** the market prices hikes **and** the data are decelerating.
- **Bond-bearish:** the market prices cuts **and** the data are accelerating.
- **In between:** anything else.

Map the result to [−2, +2].

**Output:** `path_score`.

### 4.3 Valuation

**Real yield gap:** `DFII10 − rstar_HLW` (lagged), plus `DFII10` vs. its rolling 10-year mean. The score is the average of the two z-scores.

**Term premium:** z-score of the ACM 10y term premium over a rolling 10-year window. Fall back to `THREEFYTP10` if ACM is unavailable.

**Breakeven gap:** `inflation_view − T5YIFR`, where `inflation_view` = average of core PCE 12m and `EXPINF1YR`.

- Positive favors TIPS.
- This is an instrument signal, not a duration signal.

**Output:**

- `valuation_score`: real-yield and term-premium z-scores, equal-weighted.
- `breakeven_gap` in basis points.

### 4.4 Growth/inflation surprise quadrant and hedge reliability

**Quadrant**, using 8-week changes:

- **Growth axis:** `growth_mom`.
- **Inflation axis:** the change in `T5YIE` plus the sign of `infl_trend`.

| Quadrant | Growth | Inflation | Bond implication |
|---|---|---|---|
| Q1 | ↑ | ↓ | Mildly negative for nominals |
| Q2 | ↑ | ↑ | Negative for nominals; TIPS preferred |
| Q3 | ↓ | ↑ | TIPS best; nominal hedge weak |
| Q4 | ↓ | ↓ | Strongly positive for nominals |

Output: `quadrant`, `quadrant_score`.

**Hedge reliability:**

- Input: rolling 90-trading-day correlation of SPY vs. IEF daily returns. Use synthetic returns as the fallback.
- `hedge_reliable = false` when either condition holds:
  - the correlation is above +0.20, or
  - the quadrant is Q2 or Q3 **and** the correlation is above 0.
- Hysteresis: the flag only flips after 2 consecutive weekly reads.

### 4.5 Trend filter (timing gate)

Measured on the 10y total return (IEF adjusted close, or synthetic):

- **Time-series momentum:** 12-month total return minus the 12-month T-bill return.
- **Price trend:** price vs. its 200-trading-day moving average.

`trend_state`:

- `up` if both are positive,
- `down` if both are negative,
- `mixed` otherwise.

`trend_score`: +1.5 / 0 / −1.5 respectively.

### 4.6 Curve regime classifier (cross-check)

**Inputs** over a 63-trading-day window:

- `Δlevel = Δ DGS10`
- `Δslope = Δ (DGS10 − DGS5)`
- Store a 2s10s variant as well.

**Classification:**

- **Level:** `bull` if Δlevel < −10bp; `bear` if > +10bp.
- **Slope:** `steepening` if Δslope > +5bp; `flattening` if < −5bp.
- **Neutral:** if either leg is below its threshold.

**Persistence and transitions:**

- 2-week persistence before a regime is confirmed.
- Flag `bear_flattening → bull_flattening` as a late-cycle confirmation event.

**Output:** `curve_regime`, `regime_since`, `transition_flag`, and `curve_score`:

| Regime | curve_score |
|---|---|
| Bull flattening | +1 |
| Bull steepening | +0.5 |
| Neutral | 0 |
| Bear flattening | −0.5 |
| Bear steepening | −1 |

### Phase B acceptance

- **Unit tests** with hand-computed cases. A 5% 10y must give `D_mod ≈ 7.79` and `BE ≈ 0.64%`.
- **Module history charts** for sanity review.
- **Missing inputs** are reweighted and flagged, never silently zeroed.

---

## 5. Global composite signal (Phase C)

### 5.1 Duration score

```
duration_score =
    0.30 * valuation_score
  + 0.25 * path_score
  + 0.20 * carry_score
  + 0.15 * quadrant_score
  + 0.10 * curve_score
```

**Trend gate:**

- If `trend_state = down`, cap the score at **0**.
- If `trend_state = mixed`, cap it at **+0.75**.

### 5.2 Stance mapping

| duration_score | duration_stance | duration_multiplier |
|---|---|---|
| < −0.75 | Short | 0.5× |
| −0.75 to 0.5 | Neutral | 1.0× |
| 0.5 to 1.0 | Extend | 1.3× |
| > 1.0 **and** trend = up | Max extend | 1.6× |

### 5.3 Instrument preference

Evaluated in order; the first match wins:

1. `hedge_reliable = false` **and** stance ≤ Neutral → **Bills / short TIPS**.
2. `breakeven_gap > +25bp` **or** quadrant ∈ {Q2, Q3} → **TIPS-tilted**.
3. Otherwise → **Nominal-tilted**.

### 5.4 Maturity preference

The maturity with the highest `EFF_n` among {2, 5, 7, 10}. If the stance is Max extend, use **10y** instead.

### 5.5 Explanation

Generate a plain-English market paragraph from the module outputs. Example:

> "Duration: Neutral (score 0.35). Valuation favorable (real 10y 2.9% vs r-star 0.8%; term premium z +1.1), but trend is mixed, capping the score. Curve regime: bear flattening since Jan 2026. Stocks and bonds positively correlated (+0.31) — bonds not a reliable hedge; tilt toward TIPS. Best carry per unit risk: 5y (breakeven rise 1.1%)."

Store it in `explanation` (jsonb) as both text and structured drivers.

---

## 6. Per-portfolio application (Phase D)

Runs **only** for portfolios where `enabled = true`.

### 6.1 Identify the bond sleeve

Classify each holding. Use the existing security master or metadata found in Step 0. Where that's missing, add a small `bond_instrument_meta` table.

| Field | Values / notes |
|---|---|
| `is_bond` | bool |
| `bond_type` | `treasury_nominal`, `tips`, `bills_cash_like`, `agency_mbs`, `ig_corporate`, `muni`, `aggregate`, `high_yield`, `em_debt`, `other` |
| `effective_duration` | ETFs/funds: from metadata, refreshed periodically. Individual bonds: computed from coupon, maturity and yield. |
| `maturity_bucket` | 0–1y, 1–3y, 3–7y, 7–12y, 12y+ |
| `inflation_linked` | bool |

**Which holdings are in scope:**

| Holding type | Treatment |
|---|---|
| Treasuries, TIPS, bills/cash-like, agency MBS, aggregate | Always in scope |
| IG corporate, munis | In scope when `include_credit = true` (default). Their duration is managed; their credit exposure is left unchanged. |
| High yield, EM debt | **Excluded by default.** They behave more like risk assets. Report them as "excluded bond holdings". |
| Any holding the classifier can't identify | Excluded and flagged for Scott to classify. Never guessed. |

**Sleeve statistics:**

- Sleeve weight.
- Weighted effective duration.
- Mix: nominal, TIPS, bills, credit.
- Maturity-bucket profile.

**Benchmark duration:** if the portfolio setting is null, use the sleeve's duration under the portfolio's strategic allocation, before any overlay. This means "Neutral" leaves the sleeve where it was designed to sit.

### 6.2 Compute sleeve targets

Starting from the global signal:

- **Target duration:** `benchmark_duration × duration_multiplier`.
- **Target instrument mix:**
  - *TIPS-tilted:* `tips_split_when_tilted` of the nominal-plus-TIPS portion goes to TIPS.
  - *Bills / short TIPS:* shift duration risk into the shortest eligible holdings and TIPS.
  - *Nominal-tilted:* keep the existing mix.
- **Maturity focus:** concentrate any duration added or removed at `maturity_pref`.
- **Credit holdings:** only their duration is adjusted (6.1). Credit allocation is unchanged.

### 6.3 Translate targets into holding-level weights

Solve a small optimization over the in-scope bond holdings.

**Objective:** minimize turnover, i.e. the sum of |Δweight|.

**Constraints:**

- **Sleeve weight is fixed.** The total weight of in-scope holdings stays unchanged; this is the default scope rule.
- **Duration:** sleeve duration within ±0.25 years of target.
- **Mix:** instrument mix within ±5 percentage points of target.
- **Eligible instruments:** the portfolio's held in-scope instruments, plus `eligible_instruments`. When the setting is null, the default substitute list is BIL/SHY (bills), IEI or a 5y Treasury (5y), IEF (7–10y), TIP/SCHP (TIPS) and STIP (short TIPS).
- **No-trade band:** skip any change smaller than `min_trade_threshold`.
- **Proceeds:** proceeds from shortening duration go to short-duration bonds or bills inside the sleeve. **No cash interaction in v1** (v2.1) — if the portfolio holds no eligible short instrument to receive them, don't shorten: set `target_reachable = false` and write a `gap_note` naming the missing instrument, same as any other unreachable-target case. Bond Lens never touches the cash bucket.

**When the targets can't be reached:** if the eligible instruments can't hit the targets (e.g. no TIPS are held and none are eligible), get as close as possible.

- Set `target_reachable = false`.
- Write a `gap_note` naming the missing instrument type, e.g. "No TIPS exposure eligible; TIPS tilt not applied".

**Per-holding output:** current weight, target weight, delta, and a one-line rationale, e.g. "Shorten: duration stance Neutral→Short; proceeds to SHY".

**Holding churn down:** only publish new targets when the stance, instrument preference or maturity preference changes, **or** when drift from the current targets exceeds the no-trade band.

### 6.4 Optional sub-toggles (per portfolio, default off)

**`solver_override_enabled` — removed from v1 (v2.1).** No live per-portfolio
correlation-aware solver exists to override (confirmed in reconnaissance —
`lib/riskParity.js` is asset-class-level, used only by `/macro`'s sandbox
simulator). Deferred indefinitely, not just to a later phase; revisit only
if a real per-holding risk-parity solver is ever built elsewhere in the
app. **`hedge_reliable` is still computed and displayed in v1** — it
already drives the "Bills / short TIPS" instrument preference inside the
sleeve reallocation (§5.3), so it has a real effect without this sub-toggle.

**`macro_pillar_enabled` — deferred until Market Conditions Phase 4 ships
(v2.1).** The column stays on `bond_lens_portfolio_settings`, default
`false`, inert until then. **The curve regime classifier (§4.6) is still
computed and shown in the market view regardless** — only the
market-conditions-tier notch adjustment is gated on this flag. When on,
Bond Lens contributes at most ±1 notch to this portfolio's market-conditions exposure tier, through the macro pillar:

| Condition | Adjustment |
|---|---|
| `bear_flattening` for more than 6 months **and** quadrant Q2 | −1 notch cap |
| Confirmed `bear_flattening → bull_flattening` | −1 notch |
| Confirmed `bull_steepening` following a bull-flattening period | +1 notch |

If the macro pillar already uses curve slope, replace that input for this portfolio rather than double-counting it.

### 6.5 Overlay ordering

Follow the existing overlay stack found in Step 0. The default if none is defined:

**strategic allocation → risk-parity solver → market-conditions overlay → Bond Lens**

The market-conditions overlay may move equity to cash. Bond Lens then reshapes the bond sleeve that remains.

### 6.6 Toggle behavior

- **Turning on:** compute adjustments immediately using the latest global signal, and show a preview of the per-holding changes before they're saved as the portfolio's active targets.
- **Turning off:** revert the portfolio to its non-Bond-Lens targets immediately. Retain the history.
- **Logging:** record every enable, disable and settings change in `bond_lens_toggle_log`.

### 6.7 Edge cases

| Case | Behavior |
|---|---|
| No in-scope bond holdings | Status "No bond holdings in scope"; no-op. |
| Only excluded holdings (e.g. HY only) | Status reports the exclusions; no-op. |
| Missing duration metadata | Exclude the holding, flag it, and continue with the rest. |
| Global signal stale (>10 days) | Hold the last targets and show a stale warning. Never compute from partial data. |

### Phase D acceptance

- **Off portfolios:** outputs are identical to a build without Bond Lens. Test this explicitly.
- **On portfolios:** outputs reproduce deterministically for a given date and set of holdings.
- **Sleeve weight:** always unchanged in v1 — `solver_override_enabled` (the only mechanism that could have changed it) is removed (v2.1).
- **Sub-toggles:** have no effect when off.
- **Test portfolios:** a fixture set covering each of these:
  - Treasury-only
  - aggregate-fund-only
  - mixed Treasury/TIPS/corporate
  - no bonds
  - HY-only
  - unknown ticker

---

## 7. Backtest and validation (Phase E)

Run before any portfolio can enable Bond Lens with live targets.

### 7.1 Coverage

| Period | What's available |
|---|---|
| 1962+ | Curve and ACM term premium |
| 2003+ | TIPS and breakevens |
| 2011+ | GDPNow |

- **Full composite:** from 2003.
- **Reduced, flagged as degraded:** from 1990.
- **r-star caveat:** apply the r-star lag, and flag the revision bias that comes from using current vintages.

### 7.2 Signal tests

1. **Forward excess returns by stance.** Forward 10y excess returns (3, 6 and 12 months) bucketed by stance. Expect them to rise monotonically from Short to Max extend.
2. **Predictive power.** Hit rate and information coefficient (IC) of `duration_score` against 12-month forward excess returns.
3. **Baselines.** Compare against:
   - a constant 1.0× duration,
   - the trend filter alone,
   - valuation alone.

   The composite must beat constant duration on risk-adjusted return and must not be dominated by trend-only.
4. **Curve regime transitions.** Build a regime transition matrix. Report how often bear flattening led to bull flattening within 12 months, and SPY returns in the interim. Include 2023 as a case study.
5. **Hedge flag.** It must show `false` early in 2022.
6. **Sensitivity.** Vary each weight and threshold by ±50%, and flag any single-parameter dependence.
7. **Lookahead.** Audit that all inputs, including publication lags, were available as of each `as_of_date`.
7b. **Auction data as a candidate input (v2.1).** `treasury_auction_results`' `bid_to_cover_ratio` and the `high_yield − avg_med_yield` dispersion proxy are display-only in v1 (§8) — test both here as candidate `valuation_score`/`path_score` inputs and report whether either adds predictive power beyond ACM term premium. Promote only with an explicit decision logged in `bond-lens-decisions.md`, not silently.

### 7.3 Application tests (new in v2)

8. **Model portfolio simulations.** Run historical simulations on 3 model portfolios with Bond Lens on vs. off:
   - 60/40 with an aggregate bond fund,
   - risk parity with Treasuries and TIPS,
   - an income portfolio with corporates.

   Report the bond-sleeve return, the total portfolio drawdown, turnover, and the number of rebalances per year.
9. **Turnover.** Confirm the no-trade band keeps turnover reasonable. Target fewer than 6 sleeve rebalances per year in normal regimes.

### Phase E acceptance

- A written backtest report in `docs/`, with charts and recommended default weights.
- Scott approves before live use.

---

## 8. UI (Phase F)

### Portfolio settings

- A **Bond Lens on/off toggle**, using the same placement and style as the other overlays.
- Expandable settings:
  - benchmark duration,
  - TIPS split,
  - include credit,
  - eligible instruments,
  - no-trade band,
  - both sub-toggles, each with a one-line explanation of what it does.
- The enable flow shows a **preview** of per-holding changes before confirming.

### Portfolio view (when enabled)

- **Bond Lens card** showing:
  - the stance gauge,
  - the instrument and maturity preference,
  - the hedge reliability badge.
- **Sleeve before/after:** duration, mix and maturity profile, current vs. target.
- **Per-holding table:** current weight, target weight, delta, rationale.
- **Warnings** for:
  - excluded holdings,
  - unclassified tickers,
  - `target_reachable = false` gap notes,
  - a stale signal.

### Market view (global; always available, even with no portfolios enabled)

- A per-maturity carry/breakeven table.
- A growth/inflation quadrant plot with a 12-week trail.
- A 10y yield chart with curve-regime shading.
- Component score bars, with an indicator when the trend gate is binding.
- The explanation paragraph.
- **Auction cross-check (v2.1), display-only, next to term premium:** latest `bid_to_cover_ratio` and the dispersion proxy from `treasury_auction_results`. Not a score input in v1 (§7.2 test 7b).

Follow the existing overlay card styling, and make it mobile-friendly.

---

## 9. Build order and checkpoints

| Phase | Deliverable | Checkpoint |
|---|---|---|
| 0 | Reconnaissance note, including the toggle design and the bond-holding identification plan | Scott approves |
| A | Ingestion, signal tables, settings and log tables | Series coverage report |
| B | Six signal modules and tests | Module history charts reviewed |
| C | Global composite and explanation | Spot-check: Mar 2020, Jun 2022, Oct 2023, Sep 2024, today |
| E | Backtest report (signal and application tests) | Scott approves weights |
| D | Per-portfolio application, toggle, sub-toggles | Off = identical; fixture portfolios pass |
| F | UI: settings toggle, portfolio card, market view | Visual review |

E deliberately comes before D. No portfolio gets live Bond Lens targets until the signal has been validated.

---

## 10. Open decisions for Scott

1. **Default benchmark duration.** Should it be the strategic sleeve duration (the default), or a fixed number?
2. **TIPS split when tilted.** The default is 60/40.
3. **Credit holdings.** Should IG corporates and munis be in scope by default? The default is yes, with duration only.
4. **Default substitute instrument list** (6.3). Should the overlay be allowed to suggest instruments the portfolio doesn't currently hold?
5. **Solver override defaults.** The nominal bond risk cap (default 25%) and the redistribution split among TIPS, bills and gold.
6. **Bond return series.** ETF adjusted closes (the default) or synthetic returns.
7. **Fed pricing source.** Whether to later replace the 2y–EFFR proxy with SOFR-futures pricing.
