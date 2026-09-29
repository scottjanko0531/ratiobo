# Market Conditions Overlay — Spec (as built, mc-1.4.0)

**Project:** RatioBo
**Module:** `market-conditions` (tactical exposure + entry-timing overlay)
**Stack:** Next.js (Vercel) · Supabase (Postgres, Edge Functions, pg_cron) · TypeScript
**Status:** Phases 1–3 built. Updated 2026-09-29 to reflect the as-built system.

This document is the source of truth for **what the system does now**. The reasoning, test results, and history behind each change live in `docs/market-conditions/DECISIONS.md`. Where this spec and the code disagree, raise it rather than guessing.

---

## 0. Working rules for Claude Code

1. **Read before building.** Reuse existing tables, clients, components, and conventions.
2. **Phase by phase.** Stop after each phase or validation round for review.
3. **All parameters live in `MC_CONFIG`.** No magic numbers in indicator code. Any parameter change bumps `config_version`.
4. **No lookahead.** Calculations for date `t` use only data published by the close of `t`. Signals apply to positions on `t+1`.
5. **Idempotent jobs.** Upsert by primary key; never delete series or price rows.
6. **mc-1.3.0 tier parameters are frozen.** No further tuning on SPX history. New components enter only through a pre-registered keep-or-drop test (Section 9).
7. **Log every decision** in `DECISIONS.md`, including rejected ideas and failed tests.

---

## 1. Purpose

Once per trading day, produce two independent outputs for U.S. equities (SPY as the reference):

| Output | Question | Values |
|---|---|---|
| **Exposure tier** | How much equity risk to carry? | `FULL`, `NORMAL`, `CAUTIOUS`, `DEFENSIVE`, `RISK_OFF` → `exposure_multiplier` |
| **Entry signal** | Is now a good moment to add new capital? | `ADD`, `WAIT`, `NEUTRAL` |

The overlay scales the equity sleeve between the Dalio regime engine (strategic allocation) and the risk-parity solver (weights). It never picks securities or places trades.

Validated purpose: **reduce drawdowns at equal or lower turnover than a 200-day rule, with a small return give-up vs buy-and-hold.** Its edge over the plain 200-day rule is concentrated in severe bear markets; it is marginal since 2009.

---

## 2. Architecture (as built)

```
pg_cron (weekdays)
  22:30 UTC ─► Edge Function market-conditions-ingest
                 SPY → asset_price_history (existing table, Yahoo v8 chart API)
                 FRED + CBOE series → mc_series_daily
  22:40 UTC ─► Edge Function market-conditions-compute
                 full deterministic recompute → market_conditions_scores
                 append latest → mc_signal_log (append-only)
                                        │
          ┌─────────────────────────────┼──────────────────────────┐
          ▼                             ▼                          ▼
  Dashboard card + /market-conditions   mc_signal_log_live   risk-parity solver
  (direct Supabase reads, Recharts)     (live record view)   (Phase 6, pending)
```

- Shared logic: `supabase/functions/_shared/marketConditions/` (config, normalize, trend, stress, oscillators, scoring / `stepTierState`, entry signals).
- `market-conditions-compute` doubles as the backfill: it always recomputes full history deterministically, in chronological order.
- Job status is written to `mc_job_runs`.

---

## 3. Data

| Input | Series | Source | Used for |
|---|---|---|---|
| SPY | adj. close | Yahoo v8 (via `asset_price_history`) | Trend, oscillators, backtests |
| QQQ, IWM, EFA | adj. close | Yahoo v8 | Cross-market validation only |
| VIX | `VIXCLS` | FRED | Stress S5, S6, fast-path fallback |
| VIX 3-month | `^VIX3M` | CBOE / Yahoo (from 2006-07-17) | Stress S1, veto, fast-path |
| Baa – 10y spread | `BAA10Y` | FRED (daily from 1986) | Stress S2, S3, credit veto, fast-path |
| HY OAS | `BAMLH0A0HYM2` | FRED (rolling ~3-year window only) | Ingested for reference; **not scored** |
| T-bill yield | `DTB3` | FRED | Backtest cash return |

Rules:
- Store raw values untouched; transforms happen in compute.
- **Forward-fill:** carry the last *published* value forward up to 3 trading days (respecting `published_at`). Beyond that, exclude the input and record it in `flags.stale_inputs`.
- Yahoo does **not** cover delisted tickers. Any constituent-level history built on it is survivorship-biased.
- Keys in env vars (`FRED_API_KEY`, etc.). Never commit keys.

---

## 4. Database

| Object | Purpose |
|---|---|
| `asset_price_history` | Existing RatioBo price table (SPY, QQQ, IWM, EFA, sector SPDRs, RSP) |
| `mc_series_daily` | Raw macro/volatility series: `(series_id, date)` PK, `published_at`, `value`, `source` |
| `market_conditions_scores` | Daily output: trend state, pillar scores, composite, `raw_tier`, `tier`, `exposure_multiplier`, `entry_signal`, `entry_reason`, `veto_active`, `flags`, `components`, `config_version` |
| `mc_signal_log` | **Append-only** (UPDATE/DELETE raise errors at the DB level). One row per date as first written. Contains backfilled history. |
| `mc_signal_log_live` | View: rows where `computed_at::date <= date + 4 days`, i.e. written by a nightly run near the signal date. **The true out-of-sample record. All live performance tracking uses this view.** |
| `mc_job_runs` | Job status, row counts, missing inputs |

RLS: authenticated users can read; only the service role writes.

Not built (breadth rejected): `mc_universe`, `mc_breadth_daily`.

---

## 5. Scoring

All sub-indicators produce a score in **[−1, +1]**, where +1 is supportive.

### 5.1 Normalization principle
- Indicators with a **natural fixed reference point** (trend distance, momentum, VIX term structure) use **absolute mappings**.
- Indicators whose meaning is **relative to history** (credit spread level, VIX level, realized vol) use a **rolling percentile** over 2,520 trading days, minimum 756 days of history. Score = `2·pct − 1`, inverted where higher is worse.
- Inputs with insufficient history are excluded, and weights renormalize within the pillar (recorded in `components`).

### 5.2 Trend pillar

| ID | Indicator | Mapping |
|---|---|---|
| T1 | `close / SMA200 − 1` | Linear: ≥ +5% → +1, ≤ −5% → −1 (`t1BoundPct` in config) |
| T2 | SMA200 20-day slope | +1 if rising, −1 if falling |
| T3 | 12-1 month return ÷ 252-day annualized vol | Clipped to [−1, 1] |
| T4 | 10-month rule (month-end close vs 10-month SMA) | +1 / −1 |

**Trend state** (`trendBand` = 0.02):
- `UP`: close > SMA200 × (1 + band) **and** SMA200 slope > 0
- `DOWN`: close < SMA200 × (1 − band) **and** slope < 0
- `DOWN → MIXED`: close > SMA200 × (1 + band) for 3 consecutive days, regardless of slope
- Otherwise the prior state is kept (sticky).

### 5.3 Stress pillar

| ID | Indicator | Mapping | Pillar weight |
|---|---|---|---|
| S1 | `VIX / VIX3M` | Absolute: ≤ 0.85 → +1, ≥ 1.05 → −1, linear between (from 2006) | Level group |
| S2 | `BAA10Y` level | Inverted percentile | Level group |
| S4 | SPY 20-day realized vol | Inverted percentile | Level group |
| S5 | `VIXCLS` level | Inverted percentile | Level group |
| S3 | `BAA10Y` 20-day change | Inverted percentile | Change group |
| S6 | `VIXCLS` 20-day change | Inverted percentile | Change group |

Level group (S1, S2, S4, S5) = 50% of the pillar; change group (S3, S6) = 50%.

### 5.4 Scored pillars and composite
- **Scored:** Trend and Stress only. Configured weights trend 0.30, stress 0.25, renormalized over available pillars.
- **Breadth:** tested and **rejected** (Section 9). Not scored. Proxy-pillar code remains in the repo for possible future tests.
- **Sentiment, macro:** not built (Phase 4, gated experiment).
- `composite = Σ weight × pillar score`, clipped to [−1, 1].

---

## 6. Tiers

### 6.1 Mapping

| Tier | Composite | exposure_multiplier |
|---|---|---|
| `FULL` | ≥ 0.35 | 1.00 |
| `NORMAL` | 0.05 to 0.35 | 0.80 |
| `CAUTIOUS` | −0.25 to 0.05 | 0.60 |
| `DEFENSIVE` | −0.50 to −0.25 | 0.40 |
| `RISK_OFF` | < −0.50 | 0.25 |

### 6.2 Order of operations (`stepTierState`)

1. `raw_tier` from the composite.
2. **Hysteresis:** upgrade requires composite above the next tier's bound + 0.05 for 3 days; downgrade requires below the current bound − 0.02 for 2 days; at most one tier per day.
3. **Recovery fast-path (latch):**
   - Trigger: `VIX/VIX3M < 0.90` **and** 20-day change in `BAA10Y` < 0 **and** close > SMA50. Before 2006 (no VIX3M), the VIX condition is replaced by `VIXCLS < its 50-day average` **and** `VIXCLS` 20-day change < 0.
   - While latched: upgrades need 1 day, and the DOWN trend cap is lifted.
   - Stays latched until tier ≥ NORMAL, or invalidated by close < SMA50 or `VIX/VIX3M > 1.0`.
4. **Trend cap:** if `trend_state = DOWN` (and fast-path not latched), tier ≤ `CAUTIOUS`.
5. **200-day floor:** if close > SMA200 × (1 + band) for 3 consecutive days and no veto is active, tier ≥ `NORMAL`.
6. **Stress veto** caps tier at `DEFENSIVE` when either:
   - `VIX/VIX3M > 1.05` for 2 consecutive days, or
   - `BAA10Y` 20-day widening > 45 bp.
   Clears after all conditions have been false for 5 days. **Validated: keep** (disabling it worsened the 2020 drawdown beyond tolerance).

---

## 7. Entry signals (mc-1.4.0)

Inputs: trend state, O1 = RSI(14) (Wilder) on SPY, O2 = `(close − SMA50) / stdev(close − SMA50, 50)` (z-score). First matching rule wins.

| Rule | Condition | Signal | Validation |
|---|---|---|---|
| E-DIP | trend `UP` **and** (RSI14 < 40 **or** O2 ≤ −1.5) | `ADD` | Passed 4/4 markets |
| E-HOT | trend `UP` **and** RSI14 > 75 **and** O2 ≥ 2.0 | `WAIT` (hold, don't add) | Passed 3/4 (IWM fails at 63d) |
| E-DOWN | trend `DOWN` | Shown as `NEUTRAL` with "Downtrend" context | Failed to generalize vs unconditional baseline (passed SPY/QQQ, failed IWM/EFA) |
| E-DEFAULT | otherwise | `NEUTRAL` | No directional claim |

Removed:
- **E-VETO:** stress days had *higher* average forward returns in 4/4 markets, with wider downside tails. Shown in the UI as information only: *"High stress: typical forward returns above average, but downside risk wider than normal."*
- **E-TOP, E-THRUST, E-CAPITULATION:** depended on rejected breadth inputs. Not replaced.

---

## 8. Dashboard (Phase 3)

- **Card:** tier, exposure multiplier, trend state, entry signal with plain-language text, informational stress badge, stale-input warning, as-of date, config version.
- **`/market-conditions`:** Trend and Stress pillar bars (breadth "Tested, not scored"); sub-indicator drill-down (raw, score, stale/excluded); SPY log chart with tier shading and ADD/WAIT markers (1Y / 5Y / Max); live track record from `mc_signal_log_live` ("accumulating" until 21 trading days of forward data); Validation panel with the frozen backtest, cross-market, and entry-rule results, labeled in-sample vs out-of-sample.

---

## 9. Validation standards

Every new component must pass a **pre-registered** keep-or-drop test before it is scored:
- Improves full-period SPY Calmar and does not worsen either sub-period (1996–2008, 2009+).
- Does not worsen max drawdown in any major bear episode (2000–02, 2007–09, 2020, 2022) by more than 2 points.
- Does not worsen Calmar on 2+ of QQQ, IWM, EFA (unchanged config).
- Entry rules: `ADD` must beat its conditional baseline on 21d and 63d mean forward return; `WAIT` must underperform. Fewer than 10 episodes = inconclusive.
- No re-tuning after a failed test on the same history.

### Reference results (mc-1.3.0 tier logic, SPY 1996-02-23 → 2026-09, in-sample)

| Portfolio | CAGR | Vol | Sharpe | Max DD | Calmar | Turnover/yr |
|---|---|---|---|---|---|---|
| Overlay | 9.51% | 12.51% | 0.76 | −22.65% | 0.42 | 2.18 |
| 200-day rule | 9.02% | 12.88% | 0.70 | −26.97% | 0.33 | 4.91 |
| Vol-matched static (66/34) | 7.82% | 12.51% | 0.63 | −39.75% | 0.20 | 0.53 |
| Buy-and-hold | 10.25% | 19.20% | 0.53 | −55.19% | 0.19 | 0 |

Cross-market (out-of-sample) vs 200-day rule, Calmar: QQQ win (0.22 vs 0.15), IWM tie (0.21), EFA narrow loss (0.22 vs 0.23). Known weakness: slow-grind bears without credit stress (2022).

---

## 10. Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: trend, stress, tiers, vetoes, jobs | Done (revised through mc-1.3.0) |
| 2 | Breadth | Tested and rejected; not scored |
| — | Entry-signal validation + oscillators | Done (mc-1.4.0) |
| 3 | Dashboard | Built; on preview branch pending review |
| 4 | Sentiment + macro (reuse regime-engine output for macro) | Not started; gated experiment |
| 5 | Backtest + robustness | Largely done during Phases 1–2; walk-forward not possible (history already seen) |
| 6 | Risk-parity solver integration (`use_market_overlay`, opt-in) | Not started; open decision on where freed weight goes |

## 11. Open decisions
1. Where freed weight goes when `exposure_multiplier < 1`: T-bills, bond sleeve, or pro-rata to non-equity sleeves (Phase 6).
2. Point-in-time constituent data source, only if breadth is ever revisited.
3. Macro pillar: reuse regime-engine output vs compute independently (Phase 4).

## 12. Out of scope (v1)
Individual stock or sector timing · intraday data · automated execution · non-U.S. scoring (cross-market use is validation only).
