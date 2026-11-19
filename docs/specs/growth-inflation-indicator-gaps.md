# RatioBo — Growth & Inflation Indicator Gaps

**Status:** v1.0 (Nov 18, 2026). Not started.
**Owner:** Scott
**Builder:** Claude Code
**Suggested location in repo:** `docs/specs/growth-inflation-indicator-gaps.md`
**Decisions log:** `docs/specs/growth-inflation-indicator-gaps-decisions.md` (create in Phase 0)
**Reference:** Scott's "Growth & Inflation Drivers — Leading & Lagging Indicators" Sheet (Nov 18, 2026). It maps 76 indicators across 14 driver groups; this spec covers the ones RatioBo doesn't have.

---

## 0. Why this exists

RatioBo's regime engine scores growth and inflation from about 30 indicators across three lenses: near-term (2–3 mo), medium-term (6–18 mo) and structural. A driver-by-driver map found gaps in three places:

1. **Supply-side growth is nearly invisible.** There's nothing on capital investment, productivity or labor supply, which are the drivers of potential growth and of the "AI productivity" question.
2. **Inflation's early-warning layer is thin.** There's no ISM Prices Paid, supply-chain index, import prices or 5y5y. That leaves PPI and oil to carry the near-term inflation read.
3. **The Fed's own measures are missing.** There's no Core PCE (the 2% target series), supercore services, shelter or sticky-price CPI. RatioBo can't say whether inflation is the kind the Fed reacts to.

There's also a known bias in an existing signal: **Retail Sales (YoY) is nominal**, and the near-term growth vote uses a ≥2% threshold. With CPI near 4%, that vote is almost guaranteed to be "up" while inflation is high.

### Inventory

**Already in RatioBo, displayed but not scored.** No new data needed; candidates only for Phase 4: Industrial Production (YoY), Personal Savings Rate, Real Disposable Income (YoY), Housing Starts, 30Y Mortgage Rate, Financial Conditions Index (NFCI), Consumer Debt Service Ratio, Credit Card Delinquency Rate, Gasoline Retail Price.

**Already computed elsewhere in RatioBo, but not a Macro indicator.** Cross-reference them, don't fetch again (Phase 3): Corporate Profits / GDI, S&P 500 / GDP, Trade / GDP (all in `big_cycle_paradigm_raw_series`); R&D % GDP (`big_cycle_determinants`, manual).

**Missing. Tier A: add, and evaluate for the score (Phase 4).**

| Indicator | Axis | Type / lead | Proposed source (verify in Phase 0) | Freq |
|---|---|---|---|---|
| Core capital goods orders (nondefense ex-aircraft), 3M annualized | Growth | Leading 3–6 mo | FRED `NEWORDER` | M |
| Real retail sales (YoY) | Growth | Coincident | FRED `RRSFS` | M |
| ISM Manufacturing Prices Paid | Inflation | Leading 1–3 mo | extend `scrape-ism` | M |
| ISM Services Prices Paid | Inflation | Leading 1–3 mo | extend `scrape-ism-services` | M |
| NY Fed Global Supply Chain Pressure Index | Inflation | Leading 3–6 mo | NY Fed download (not on FRED) | M |
| Core PCE (YoY, plus 3M annualized) | Inflation | Lagging (Fed target) | FRED `PCEPILFE` | M |
| Supercore CPI (services less rent of shelter), 3M annualized | Inflation | Coincident | FRED `CUSR0000SASL2RS` | M |
| 5-year, 5-year forward inflation expectation | Inflation | Leading (years) | FRED `T5YIFR` | D |
| Job openings per unemployed worker | Inflation (labor tightness) | Leading 6–12 mo | FRED `JTSJOL` ÷ `UNEMPLOY` | M |
| Case-Shiller national home prices (YoY) | Inflation (shelter lead) | Leading 12–18 mo | FRED `CSUSHPINSA` | M |

**Missing. Tier B: display only (context, not scored).**

| Indicator | Axis | Type | Proposed source | Freq |
|---|---|---|---|---|
| Labor force participation rate | Growth (supply) | Coincident | FRED `CIVPART` | M |
| Labor force growth (YoY) | Growth / Inflation (supply) | Leading (years) | FRED `CLF16OV` | M |
| Nonfarm labor productivity (YoY) | Growth (supply) | Lagging | FRED `OPHNFB` | Q |
| Real nonresidential fixed investment (YoY) | Growth (supply) | Coincident | FRED `PNFIC1` | Q |
| Real PCE (YoY) | Growth | Coincident | FRED `PCEC96` | M |
| Unemployment gap (UNRATE − NAIRU) | Inflation | Leading 6–12 mo | FRED `UNRATE` − `NROU` | Q |
| Employment Cost Index (YoY) | Inflation | Lagging | FRED `ECIALLCIV` | Q |
| Atlanta Fed Wage Growth Tracker | Inflation | Coincident | Atlanta Fed (check FRED first) | M |
| Import price index (YoY) | Inflation | Leading 1–3 mo | FRED `IR` | M |
| Shelter CPI (YoY) | Inflation | Lagging 12–18 mo | FRED `CUSR0000SAH1` | M |
| Sticky-price core CPI | Inflation | Lagging | FRED `CORESTICKM159SFRBATL` | M |

**Tier C: deferred (no free machine-readable feed or low value).** Log each and don't build:
- Global manufacturing PMI (S&P Global, proprietary). The OECD Composite Leading Indicators via the OECD SDMX API are a possible proxy; evaluate in Phase 0 only.
- NY Fed Survey of Consumer Expectations (xlsx only; UMich 1-yr already covers households).
- Working-age population / immigration (annual; CBO projections, not a series).
- Conference Board Coincident Index (paid).

---

## 1. Goals / non-goals

**Goals**
- Every Tier A and B indicator is live on `/macro` with history in `macro_snapshots`, a correct description, units, status semantics and source line.
- Supply-side growth gets its own visible group on `/macro`.
- Each Tier A indicator is backtested as a regime-score candidate, and any score change ships only in **shadow** until Scott approves it.

**Non-goals**
- No change to live regime weights, regime keys, or portfolio targets without the Phase 4 approval gate. This follows the regime-tilt rule: no portfolio changes until each phase's signals are confirmed.
- No paid data sources.

---

## 2. Standing rules

Rules 1–9 from the debt-metrics-integrity specs still apply: indicator names are keys; never mix definitions in one series; align by date; vintage labels; pure logic in `_shared/` with tests; log decisions; every gate has a disarm test; grep with exact characters; `sinceDate` means streak start. Plus:

10. **One gap rule.** Every new monthly price index YoY uses `_shared/yoyMath.ts` (the v2 single-month interpolation plus fallback to the latest pairable month). Flag `used_interpolated_month` where it applies. The Oct 2025 gap affects most BLS series.
11. **Status semantics match the indicator.** Use risk-style statuses (`healthy`/`watch`/`danger`) only where "high is bad" or "low is bad" is clear. Use the v1 `stance` family, or neutral styling, for descriptive series (e.g. labor force participation). Log every threshold as uncalibrated.
12. **Three mirrors.** The forward-signal lists exist in `lib/simulatorKeys.js`, `supabase/functions/fetch-macro-data/index.ts` (the `FwdSig` arrays, ~line 2210) and `supabase/functions/get-regime-analysis/index.ts`. Any score change touches all three, and `tests/regimeClassifier.test.ts`'s weight-sum and sync checks must pass.

---

## 3. Phases

### Phase 0 — Verify sources (no behavior changes)

1. For each Tier A/B FRED series: confirm the ID exists, then record its title, units, frequency, seasonal adjustment, first and last observation, and release lag. Record whether it's affected by the Oct 2025 gap. Log a table. Replace any ID that's wrong or discontinued, and log the replacement.
2. **ISM Prices Paid:** confirm that the ISM report pages `scrape-ism` and `scrape-ism-services` already parse publish a Prices index, and where it sits in the HTML. Confirm the history depth available from the existing `ism_history` backfill source.
3. **GSCPI:** find the NY Fed's current downloadable file URL and format. Confirm that the shell/edge runtime can reach it. If it can't, log it and move GSCPI to Tier C.
4. **Atlanta Fed Wage Tracker:** check FRED first. If it isn't there, use the Atlanta Fed download, or move it to Tier C if unreachable.
5. **OECD CLI (Tier C evaluation only):** check whether the OECD SDMX API serves a US/G20 composite leading indicator that the existing SDMX client (used for IMF COFER) can call. Log the answer; don't build.
6. Confirm the three signal-list mirrors and the backtest harnesses Phase 4 will use (`nearterm-signal-backtest`, `growth-axis-backtest`, `run-backtest`, `cpi-core-measures-backtest`). Note what each scores: hit rate vs. what, over which window.
7. Snapshot the current near-term and medium-term growth/inflation scores and votes into `tests/fixtures/indicator-gaps-baseline-2026-11-18.json`.

**Acceptance:** every Tier A/B source verified or re-tiered, with reasons logged.

---

### Phase 1 — Add FRED-sourced indicators (display only)

Add each verified FRED Tier A/B series to `fetch-macro-data` using the existing definition pattern (`name`, `layer`, `layer_name`, `description`, `fred_series_id`, `unit`, `data_source: "fred"`, `sort_order`, `series`, `type`, `statusFn`). Reuse existing processor types where they fit (`level`, `yoy_monthly`, `yoy_quarterly`, `level_with_3m`, `yoy_monthly_with_3m`).

**New processor types, as needed** (pure logic in `_shared/` with tests):
- `annualized_3m_monthly`: 3-month annualized change of a monthly index, `((x_t / x_{t−3})^4 − 1) × 100`, date-matched. For core capex orders, Core PCE and supercore.
- `ratio_two_series`: date-matched ratio of two FRED series. For openings ÷ unemployed.
- `diff_two_series`: date-matched difference. For UNRATE − NROU. NROU is quarterly, so carry the latest quarter forward to monthly UNRATE and log that.

**Layers and grouping:**
- Add a **"Growth — Supply Side"** group on `/macro` for labor force participation, labor force growth, productivity, real nonresidential investment and core capex orders. Check how layers render in `app/macro/page.jsx` first, and use an existing layer with a sub-heading if adding a layer would ripple into other code. Log the choice.
- Inflation additions go in "Business Cycle", next to CPI/PPI, ordered: leading (prices paid, GSCPI, import prices) → measured (Core PCE, supercore, shelter, sticky).

**Starting statuses** (log as uncalibrated):

| Indicator | Status |
|---|---|
| Core PCE YoY | ≤2.5 healthy · ≤3.5 watch · >3.5 danger |
| Supercore 3M annualized | ≤3 healthy · ≤4.5 watch · >4.5 danger |
| 5y5y | 2.0–2.6 healthy · 2.6–3.0 watch · >3.0 or <1.7 danger (de-anchoring either way) |
| Openings / unemployed | 0.8–1.2 healthy · >1.2 watch (tight) · <0.8 watch (slack) |
| Import prices YoY | ≤3 healthy · ≤6 watch · >6 danger |
| Real retail sales YoY | >1 healthy · 0–1 watch · <0 danger |
| Core capex 3M annualized | >2 healthy · −2 to 2 watch · <−2 danger |
| Labor force participation, labor force growth, productivity, real nonresidential investment | stance / neutral |

**Backfill:** write `macro_snapshots` history for each new indicator from FRED, at least 10 years where available, for the Phase 4 backtests and the trend charts.

**Retail sales note:** keep "Retail Sales (YoY)" as is (it's scored). Add "Real Retail Sales (YoY)" beside it with a description noting that the nominal series overstates real growth when inflation is high. Any swap in the score happens only in Phase 4.

**Tests:** one per new processor type (date matching across a gap, quarterly carry-forward, annualization math); a definition-sanity test (every new indicator has a unit, status function and source).

**Acceptance:** all verified FRED Tier A/B indicators are live with history; `/macro` shows the supply-side group; nothing in the regime scores changed (assert the Phase 0 baseline fixture still matches).

---

### Phase 2 — Non-FRED sources

**2a. ISM Prices Paid.**
- Migration: add a `prices` column to `ism_history` and `ism_services_history`.
- Extend `scrape-ism` and `scrape-ism-services` to parse it, and backfill history from the same source the existing backfill used.
- Stamp `prices_paid` onto the ISM PMI indicators' metadata, the same way `new_orders` is stamped. Don't create a standalone indicator.
- Show it on the ISM cards as a secondary line.
- Note: the stale "ISM New Orders" row (layer "Quadrant Positioning", last fetched 2026-06-19) looks like an orphan. Check for consumers. If there are none, propose retiring it in the log; don't delete without Scott's yes.

**2b. GSCPI** (if Phase 0 kept it):
- New edge function `ingest-gscpi` that downloads the NY Fed file, parses the monthly series, upserts into a new `gscpi_history` table, and logs to `rb_job_runs`.
- Raise an error if the newest month is more than 60 days old.
- Monthly cron after the NY Fed's release. Indicator type `supabase_gscpi`.
- Status: < 0 healthy · 0–1 watch · > 1 danger (standard deviations above the historical average).

**2c. Atlanta Fed Wage Tracker** (only if not on FRED and Phase 0 found a reachable file): same pattern as 2b.

**Acceptance:** Prices Paid visible on both ISM cards with history; GSCPI live (or logged as Tier C); ingest failures surface in `rb_job_runs`.

---

### Phase 3 — Cross-reference existing data

Expose Corporate Profits / GDI, S&P 500 / GDP and Trade / GDP as Macro indicators that **read from** `big_cycle_paradigm_raw_series` (latest value, plus a YoY or 3M change where meaningful). Same pattern as the Big Cycle cross-references: no second fetch, and the description says "Cross-referenced from Fiscal Policy Paradigm." Put Corporate Profits / GDI in the business-activity area and Trade / GDP in the structural/supply area.

**Acceptance:** the three show on `/macro` and match the Paradigm values exactly.

---

### Phase 4 — Score candidates: backtest, shadow, approve

**Nothing in this phase changes live weights without Scott's approval.**

**4a. Candidate changes** (each tested on its own and in the combined set):

| Lens | Change | Rationale |
|---|---|---|
| Near-term growth | Replace nominal Retail Sales with **Real Retail Sales** (same 10% weight, threshold ≥1% real) | Removes the inflation bias |
| Near-term growth | Add **Core capex orders (3M annualized)** at 10%; take 5 pts each from GDPNow (20→15) and Payrolls (15→10) | Adds a business-investment leading signal; GDPNow and payrolls are partly coincident |
| Near-term inflation | Add **ISM Prices Paid (mfg/services blend)** at 10%; take 5 pts each from CPI Momentum (20→15) and PPI Trend (20→15) | Earlier pipeline read than PPI, less noisy than CPI |
| Near-term inflation | Add **GSCPI** at 5%, from Copper (10→5) | Supply-chain cost pressure, which copper partly proxies today |
| Medium-term inflation | Add **5y5y** at 10%, from 10Y Breakeven (26→16) | Long-run anchoring; correlated with breakevens, so this replaces part of that weight rather than adding a separate vote |
| Medium-term inflation | Add **Openings / unemployed** at 10%, from Capacity Utilization (16→11) and M2 (10→5) | Labor tightness is the main path to wage-driven inflation |
| Medium-term inflation | Add **Case-Shiller YoY** at 5%, from Tariff Impact structural (11→6) | 12–18 month lead into shelter, ~35% of CPI |

Every basket must still sum to 1.00. Propose vote thresholds per signal, log them, and keep the sign conventions of the neighbouring signals.

**4b. Backtest.** Run each candidate through the existing harnesses (`nearterm-signal-backtest` for near-term, `growth-axis-backtest` / `run-backtest` for medium-term) over the longest window every input covers. Report, versus the Phase 0 baseline:
- directional hit rate on the realized axis (growth: real GDP / GDPNow direction over the horizon; inflation: core PCE or CPI direction over the horizon; use whatever the harness already defines and log it);
- number of quadrant flips per year (whipsaw);
- regime agreement with the current live engine.

A candidate goes forward only if it improves hit rate without increasing flips by more than ~20%, or is neutral on hit rate while cutting flips. Log every result, including rejected ones.

**4c. Shadow.** Write approved-by-backtest candidates to a shadow lane. Reuse `regime_shadow_targets` and the "Shadow lanes" UI already on the portfolio page if they fit; otherwise add a `forward_signal_shadow` record next to the live forward signal. Run for **at least 4 weeks**, showing live vs. shadow scores, quadrant and confidence side by side on `/macro`.

**4d. Approval gate.** After the shadow period, report the live vs. shadow differences (quadrant, confidence, which portfolios' tilts would have changed and by how much). Promote to live in all three mirrors (rule 12) **only with Scott's explicit yes**, and log the date.

**Tests:**
- weight-sum and three-mirror sync (extend `tests/regimeClassifier.test.ts`);
- each new vote function at its boundaries;
- the shadow lane writes without touching live `current_regime_key` / `regime_blend`.

**Acceptance:** backtest results logged; approved candidates running in shadow; no live change without approval.

---

## 4. Rollout

Order: **0 → 1 → 2 → 3 → 4.** Phases 1–3 are display-only and can deploy as they finish, once the baseline fixture still matches. Phase 4 has two gates: the backtest report, then Scott's approval after at least 4 weeks of shadow.

**Expected visible changes:**
- `/macro` gains a supply-side growth group and about 20 new indicator cards (Tier A + B, depending on Phase 0).
- The ISM cards show Prices Paid.
- Corporate profits, S&P/GDP and trade/GDP appear as cross-references.
- A shadow forward-signal panel appears for candidate score changes.
- **No change** to live regime reads or portfolio targets until Phase 4d approval.

**After deploy:** list the indicators added so the Growth & Inflation Sheet's "In RatioBo model" column can be updated.

---

## 5. Test checklist

- [ ] Processor types: `annualized_3m_monthly`, `ratio_two_series`, `diff_two_series` (date matching, gaps, quarterly carry-forward)
- [ ] Definition sanity: every new indicator has a unit, status function, source line and description
- [ ] Gap rule applied to every new BLS price series (`used_interpolated_month` flagged)
- [ ] ISM scraper: prices parsed; backfill row counts
- [ ] `ingest-gscpi`: parse, upsert, 60-day staleness guard
- [ ] Cross-references equal the Paradigm raw values
- [ ] Baseline fixture unchanged after Phases 1–3 (scores untouched)
- [ ] Phase 4: weight sums = 1.00, three-mirror sync, vote boundaries, shadow isolation
