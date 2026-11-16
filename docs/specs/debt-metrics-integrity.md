# RatioBo — Debt-Cycle Metrics Integrity Fixes (Macro + Big Cycle)

**Status:** v1.0 (Nov 16, 2026). Not started.
**Owner:** Scott
**Builder:** Claude Code
**Suggested location in repo:** `docs/specs/debt-metrics-integrity.md`
**Decisions log:** `docs/specs/debt-metrics-integrity-decisions.md` (create in Phase 0)
**Trigger:** On Nov 16, 2026 a review of `/macro` and `/big-cycle` found that several Long-Term Debt Cycle readings were mislabeled, stale, inconsistent with each other, or calculated in a way that overstates the risk. The most important problem is r − g, which feeds the MP-stage classifier.

---

## 0. Why this exists

The Long-Term Debt Cycle layer is now driving a headline call: **"MP1 (strained)"**. It also drives a trip-wire labeled **"Fiscal-dominance regime confirmed."** Both are only as good as their inputs. The review found 10 problems. Ranked by how much each one changes conclusions:

| # | Problem | Where | Effect |
|---|---|---|---|
| 1 | r − g subtracts **real** GDP growth from a **nominal** 10Y yield | `fetch-macro-data` → "Rate vs. GDP Growth Spread" (`DGS10` − `GDPC1` YoY, type `level_minus_yoy_quarterly`) | Overstates r − g by roughly the GDP deflator (~3 pts). Shows +3.03 today; the like-for-like figure is near zero. This flips `rGreaterG` in `classifyDebtCycleStageV2`. |
| 2 | Deficit % GDP is last year's number | `update-big-cycle-metrics` → `FYFSGDA188S` (annual) | Shows 5.8% (FY2025). CBO's final FY2026 figure is **6.2%**. |
| 3 | The "Fiscal-dominance regime confirmed" trip-wire only measures a positive stock-bond correlation | `_shared/debtCycleTripWires.ts` → `evalFiscalDominanceConfirmed` (90 days of `corr_90d > 0`) | Inflation-dominated correlation is not fiscal dominance. It reads "confirmed since 2026-02-20" while the Fed is hiking and Paradigm A says "Not Confirmed (0.42)". |
| 4 | "CB Gold Reserves (YoY)" is actually the **gold price** YoY | `fetch-macro-data` → type `cb_gold_imf`. The IMF call fails in the runtime and falls back to Yahoo GC=F every time. | Mislabeled. Central-bank buying data already exists in `wgc_gold_purchases` (Gauge 5). |
| 5 | Gold Price (3M Avg) status is based on the price **level** | `statusFn: v < 2000 healthy / < 3000 watch / else danger` | Shows DANGER while gold is falling (spot $3,845 vs 3M avg $4,233). Above $3,000 it will never leave danger. |
| 6 | Indirect bidder share differs between the card and the classifier | Card: per-term-then-averaged = 57.5%. Classifier: pooled 10Y+30Y, last 6 rows = 59.3%. Trip-wire is a third read. | Same concept, three numbers. The card sits exactly at the classifier's 57.5 threshold. |
| 7 | Real Fed Funds of 0.03% is labeled "HEALTHY" | `statusFn: −1..2 healthy` | A ~0% real policy rate with 3.7% CPI is accommodative. "Healthy" is the wrong concept for a stance indicator. |
| 8 | Fiscal Policy Paradigm rows all render "stale —" | `components/FiscalParadigmSection.jsx` | The DB has **13/13 metrics `available = true`** for 2026-11-16, and RLS allows public read. This is a client-side fetch/join bug, not stale data. |
| 9 | Convenience yield labeled "Subsidy inverted" on its **level** (−45.9bp) | `fetch-macro-data` status `< −25 danger`; Big Cycle label | 10Y swap spreads have been negative for ~a decade, mostly from dealer balance-sheet costs. The level alone overstates the signal; the change is what matters. |
| 10 | Stale or contradictory numbers in National Power Determinants and Debt Added | `big_cycle_determinants`: "Debt Burden" (manual: 254.5%, 5.8%) and "Gaps" (31.6%, 7.1×). `debt_added_period` uses a 22-business-day window. | Determinants disagree with the live cards (32.5%, 5.14×, 256.5%). The 30-day debt figure ($265B ≈ $3.2T annualized) is seasonal noise near fiscal-year start. |

**One secondary point to fix along the way:** interest expense uses NIPA `A091RC1Q027SBEA` ($1.33T SAAR). That series includes imputed interest on federal pension liabilities, so it runs above CBO/Treasury **net interest** (~$1.0–1.1T for FY2026). Dalio's ~20% threshold is usually quoted on net interest. Show the basis explicitly (Phase 2).

### Current values to replicate in Phase 0 (snapshot Nov 16, 2026, ~10:15 PT)

- Total Debt/GDP 256.5% · Federal Debt/Tax Revenue 7.30x · Interest % GDP 4.03% · Interest % Revenue 24.59%
- r − g (current definition) +3.03 · 10Y ≈ 5.10% (implied) · real GDP YoY 2.07% (Jul 2026 vintage)
- Real Fed Funds 0.03% · Fed BS % GDP 20.48% · USD FX reserve share 56.7%
- Indirect bidder: card 57.5%, Position Check 59.3% · bid-to-cover 2.53
- Convenience yield −45.9bp · custody 52w −$221B · TIC official share −2.13 pts
- Deficit % GDP 5.8% · Debt added (30d) +$265B · gross debt $40.61T
- Stage: **MP1 (strained)** (debtServiceStrained ✓, rGreaterG ✓, everything else ✗)
- Trip-wire: fiscal_dominance_confirmed armed since 2026-02-20

---

## 1. Goals / non-goals

**Goals**
- Every Long-Term Debt Cycle reading is internally consistent: nominal compared with nominal, the same fiscal period on both sides of a ratio, and one source of truth per concept.
- Every card's label describes what is actually calculated.
- Every status uses the right semantics for its indicator: risk level, trend, or stance.
- The MP-stage call and trip-wires rest on correctly defined inputs. Any stage change caused by these fixes is **logged and explained, never silent**.

**Non-goals**
- No change to `classifyDebtCycleStageV2`'s stage logic beyond swapping in the corrected r − g input and recording the new informational inputs.
- No new data vendors. Use FRED, Treasury Fiscal Data, Yahoo and the existing Supabase tables only.
- No portfolio changes. If the debt-cycle stage feeds any portfolio logic (Phase 0 checks), the new values run in **shadow** until Scott confirms them, consistent with the regime-tilt recalibration rule.

---

## 2. Standing rules for the builder

1. **Indicator `name` strings are keys.** `macro_snapshots`, `macro_indicators`, `update-big-cycle-metrics` (`.in("name", [...])`) and `app/macro/page.jsx` (lines ~7999–8100) all match on the exact name. Every rename must come with:
   - a migration that renames the existing rows in **both** `macro_indicators` and `macro_snapshots`;
   - a repo-wide grep showing zero remaining references to the old name.
2. **When a definition changes, snapshot history changes too.** If a calculation changes, either backfill `macro_snapshots` history under the new definition (preferred, from FRED/Treasury history) or start a new indicator name. Never let one series mix two definitions.
3. **Align by date, never by row position.** This is the same rule as the regime-tilt spec §3.1, because FRED series have gaps (e.g. the Oct 2025 CPI shutdown gap). Every ratio pairs observations by matching period.
4. **Vintage labels.** Every card with a ratio shows the period of each side (e.g. "Interest Q3 2026 SAAR / Receipts FY2026").
5. Pure calculation logic goes in `supabase/functions/_shared/` so Vitest can import it (same pattern as `debtCycleClassifier.ts`). Every new calc gets a test under `tests/`.
6. Record every judgment call in the decisions log, with the date and the reason.

---

## 3. Phases

### Phase 0 — Reconnaissance and baseline (no behavior changes)

1. Create the decisions log.
2. Write a fixture `tests/fixtures/debt-metrics-2026-11-16.json` with today's live inputs (the list in §0) as pulled from `macro_indicators` / `big_cycle_metrics` / `treasury_auction_results`.
3. Pull and record from FRED (by date): latest **nominal** GDP YoY (`GDP`), the GDP deflator YoY (`GDPDEF`), debt held by the public (`FYGFDPUN`), and `FYOINT` (federal net interest outlays, annual).
4. Pull from Treasury Fiscal Data:
   - trailing-12-month **net interest**, receipts and deficit from the Monthly Treasury Statement (confirm the exact MTS table and line items and record them in the decisions log);
   - `debt_held_public_amt` from `debt_to_penny`.
5. Answer in the decisions log:
   - Does `big_cycle_stages.is_current` (or any debt-cycle stage or trip-wire) feed portfolio targets, Clio prompts, the Daily Macro Summary, or the Position Check brief? List every consumer.
   - Paradigm "stale" bug: reproduce locally and identify the cause (see Phase 4c). **Known so far:** DB rows exist, `available = true` for all 13 on 2026-11-16, `recorded_at` is `date` on both tables, and public-read RLS exists on both.
6. Compute, but **don't write**, what the stage classifier would return with the corrected r − g from Phase 1. Report the expected stage change before shipping Phase 1.

**Acceptance:** fixture committed; decisions log lists all consumers; projected stage under the new definition reported to Scott.

---

### Phase 1 — r − g correctness (highest priority)

**1a. Fix "Rate vs. GDP Growth Spread" (marginal r − g).**
- Redefine it as `DGS10 (latest) − nominal GDP YoY` (FRED `GDP`, date-matched YoY: the quarter vs the same quarter a year earlier).
- Add a new type `level_minus_nominal_yoy_quarterly`, or parameterize the existing one. Don't silently change `level_minus_yoy_quarterly`, because other indicators may use it (grep first).
- Description: "10Y Treasury yield minus nominal GDP growth (r−g) — the marginal cost of new federal borrowing vs. the growth of the nominal tax base. Positive means newly issued debt compounds faster than the economy."
- Status: `< 0 healthy · 0 to +1.0 watch · > +1.0 danger`. Log the thresholds as a decision; they're a starting point, not calibrated.
- **Backfill** this indicator's `macro_snapshots` history under the new definition (rule 2.2).

**1b. Add "Effective Rate vs. Nominal Growth (r_eff − g)."**
- `r_eff` = trailing-12-month net interest (MTS) ÷ average debt held by the public over the same 12 months (`debt_to_penny.debt_held_public_amt`, monthly average).
- `g` = nominal GDP YoY (same as 1a).
- Layer 1, sort right after 1a. Description: "Average interest rate the government actually pays on its debt, minus nominal GDP growth — the *current* debt-dynamics test. As maturing debt refinances at market rates, r_eff converges toward the 10Y; the gap between this card and r−g (marginal) shows how much refinancing pressure is still ahead."
- Status: same thresholds as 1a.
- Show `r_eff` in the card metadata/drawer, and the **convergence gap** (`DGS10 − r_eff`).
- Expected now: r_eff ≈ 3.3–3.5% vs nominal g ≈ 5% → negative (healthy). That's the main analytical fact the current dashboard hides.

**1c. Classifier wiring.**
- `rateGrowthSpread` in `ClassifierInput` takes the corrected 1a value. Keep `rGreaterG = rateGrowthSpread > 0` (Dalio's own test).
- Add `effectiveRateGrowthSpread` to `rawInputs` (informational, **not** a gate). Show it as a row in the Position Check (✓/✗ display only).
- Update `tests/debtCycleClassifier.test.ts`:
  - existing fixtures still pass under their old inputs;
  - a new test with the 2026-11-16 fixture asserts the new expected stage.
- If the stage changes, the Position Check shows a one-time note: "Stage recalculated after r−g methodology fix on <date>; previous definition compared nominal yield to real growth." Store the note in `big_cycle_metrics` (or a notes table) so it isn't hardcoded.

**1d. Downstream text.** Update the Big Cycle card copy ("r > g — unsustainable trajectory") and any Clio/summary prompt text that references r − g, so the wording follows the new value and sign. No hardcoded "unsustainable."

**Acceptance:**
- The 1a value equals `DGS10 − GDP YoY` to 2 decimals against a hand calculation from FRED.
- The 1b value reconciles to MTS and Debt-to-the-Penny inputs.
- Snapshot history contains no mixed-definition rows.
- Classifier tests are green; the stage change (if any) is logged with before/after inputs.

---

### Phase 2 — Fiscal data freshness and basis

**2a. Deficit % GDP.**
- Primary: trailing-12-month deficit (MTS) ÷ trailing-4-quarter nominal GDP (FRED `GDP`, SAAR → annual sum ÷ 4 as appropriate; document the method).
- Fallback: `FYFSGDA188S`, labeled "FY<year> (annual)" so its age is visible.
- Expected: about 6.2% for FY2026 (CBO MBR, Nov 9, 2026). If the trailing-12 figure differs from CBO by more than 0.3 pts, log why (timing shifts).

**2b. Interest basis.**
- Add **net interest** (MTS trailing-12) next to the NIPA series.
- "Interest Expense % of Federal Revenue" and "Interest Expense % GDP" use **net interest / trailing-12 receipts** as the headline. NIPA moves into the drawer as "NIPA basis (incl. imputed pension interest)."
- The Dalio 20% checkpoint compares against the net-interest figure.
- Log the expected drop (roughly from 24.6% to ~20%). Report whether `debtServiceStrained` (> 20) flips, because that is the other strained condition.
- Period alignment: numerator and denominator cover the same trailing 12 months. Assert this in code: the calc throws, and the card shows "period mismatch", if the two sides don't match.

**2c. Federal Debt / Tax Revenue.** Keep `GFDEBTN / FYFR`, but:
- assert that FYFR is the fiscal year matching or immediately preceding the debt quarter;
- add a vintage label;
- also show debt **held by the public** / trailing-12 receipts in the drawer. That is the measure that pairs with r_eff.

**2d. Debt Added.** Make the trailing-12-month change the headline. Keep the 30-day figure as a secondary line with the note "Seasonal — Oct/Apr swings are tax- and fiscal-year-timing driven." Pull enough Debt-to-the-Penny rows for 12 months, filtering by date rather than row count.

**2e. Debt Burden determinant.** Change `refresh_method` from `manual` to `api_macro_xref`. Build `reading_text` from the live values: total debt/GDP, federal debt held by the public/GDP, and deficit % GDP (2a).

**Acceptance:** deficit card reads FY2026-current; interest cards state their basis; no ratio mixes periods; the Debt Burden determinant matches the live cards.

---

### Phase 3 — Labels and status semantics

**3a. Gold cards.**
- Rename "CB Gold Reserves (YoY)" → **"Gold Price (YoY)"** (rule 2.1 migration).
- Remove the dead IMF IFS call. That endpoint (`dataservices.imf.org` IFS) is retired and the code always falls back to Yahoo.
- Add a real **"Central Bank Gold Purchases (4Q, tonnes)"** card from `wgc_gold_purchases`, z-scored against its own history, so the name now matches the data.
- "Gold Price (3M Avg)": status follows **trend**, not level. Use `(3M avg / prior 3M avg − 1)`: `> +5% danger` (fiat-distrust bid), `+0–5% watch`, `≤ 0 healthy`. Keep the spot price in the subtitle. Thresholds go in the decisions log.
- Update the `app/macro/page.jsx` drawer bindings for the renamed name.

**3b. Real Fed Funds.**
- Replace healthy/watch/danger with **stance** labels: `< 0 Accommodative`, `0 to +1.5 Neutral`, `> +1.5 Restrictive`. Use neutral styling.
- If the status system only supports healthy/watch/danger, add a `stance` status family rather than forcing it.
- Description: "Positive = restrictive; ≤ 0 with inflation above target = policy accommodating the debt load."
- Use the **effective** fed funds rate on a date-matched month vs CPI YoY (it already does via `FEDFUNDS`; confirm).

**3c. Convenience yield.**
- Status follows the **change**: the current level minus its trailing 1-year average, in bp. `< −15bp danger`, `−15 to −5 watch`, else healthy.
- Show the level and the 1y/3y averages in the drawer.
- Big Cycle labels: "Treasuries cheap to swaps (deteriorating)" / "Stable" / "Improving". Retire "Subsidy inverted" as a level-based label.
- Gauge 7 uses whatever this card exposes. Confirm the composite still computes and log any change.

**Acceptance:** no card description contradicts its calculation; gold no longer reads DANGER while falling; Real Fed Funds displays a stance.

---

### Phase 4 — Consistency and bugs

**4a. One indirect-bidder calculation.**
- Create `_shared/indirectBidder.ts` with one function: per-term trailing-6 averages (10Y and 30Y), then the equal-weighted mean. That is the card's method; document why.
- The card, `classifyDebtCycleStageV2` input, and `evalAuctionDemandDeterioration` all call it.
- The Position Check line and the card must show the same number.
- Pin the threshold boundary in tests: is 57.5 "weak" or not? Log the decision.

**4b. Fiscal-dominance trip-wire.**
- Rename the current trip-wire `fiscal_dominance_confirmed` → `stock_bond_corr_positive` ("Positive stock-bond correlation regime"). Keep its logic.
- Add a new `fiscal_dominance_confirmed` that arms only when **all** of these hold for ≥ 60 days:
  1. net interest / receipts > 20% (Phase 2b basis);
  2. real fed funds ≤ 0;
  3. the Fed is easing **or** Fed BS % GDP is sustained-rising (reuse `isSustainedRising`) **or** SOMA long-duration is sustained-positive;
  4. CPI YoY > 3%.
- It should also be consistent with Paradigm A. If A's composite < 0.5 while this arms, show both, and log any disagreement for review instead of hiding it.
- Expected now: **not armed** (the Fed is hiking).
- Update `tests/debtCycleTripWires.test.ts`.

**4c. Paradigm "stale" display bug.**
- Reproduce. Candidates to check in `FiscalParadigmSection.jsx` (lines ~123–145):
  - `big_cycle_paradigm_scores` select with no `.range()` (320 rows today, fine, but it hits the 1000-row default within ~4 years at 5 rows/day);
  - a race between the two fetches;
  - a `recorded_at` string format mismatch between the two queries;
  - whether `/big-cycle` renders this component or a separate one with its own query.
- Fix the bug. Also query the latest date directly (`order desc, limit`) instead of loading the full history to find it, and fetch history separately for the chart with an explicit range.
- **Acceptance:** all 13 metric rows show oriented-z values; "stale" appears only when `available = false`.

**4d. Gaps determinant.**
- Build `reading_text` from the same sources as the Internal Order cards: top 1% share from `WFRBST01134` (the latest value, which the card shows as 32.5%) and home price/income from the Redfin card (5.14×).
- Remove the hardcoded 7.1× (it appears to come from a different affordability measure). If it is deliberately a different measure, name the source.

**Acceptance:** no number on `/big-cycle` disagrees with the same concept on `/macro` or elsewhere on `/big-cycle`.

---

## 4. Rollout order and expected visible changes

Ship in order: Phase 0 → 1 → 2 → 3 → 4. Phase 1 and Phase 2b can each change the debt-cycle stage, so before deploying each:

1. Report the before → after for: stage, each classifier condition, the Debt Sustainability gauge, and any trip-wire.
2. If Phase 0 found a portfolio consumer, write the new stage to shadow only until Scott confirms.

**Likely outcome (check in Phase 0, don't assume):**
- r − g (marginal, nominal) goes from +3.03 to roughly −0.5 to +0.5.
- r_eff − g lands around −1.5 to −2.
- Net interest / receipts lands near the 20% line.
- So the stage may move **MP1 (strained) → MP1**.

That is a correction, not an improvement in fundamentals. The Position Check note (1c) should say so, and the convergence gap (10Y − r_eff ≈ +1.6 pts) should be the headline replacement signal for "pressure still ahead."

---

## 5. Test checklist

- [ ] `debtMetrics.test.ts` (new): nominal r − g; r_eff − g; deficit trailing-12; period-mismatch assertion; date-matched YoY across a gap.
- [ ] `debtCycleClassifier.test.ts`: the 2026-11-16 fixture under the new definitions.
- [ ] `debtCycleTripWires.test.ts`: renamed correlation trip-wire unchanged; new fiscal-dominance trip-wire armed and unarmed cases.
- [ ] `indirectBidder.test.ts` (new): the card and the classifier get the same value; boundary case at 57.5.
- [ ] Gold trend status; real fed funds stance mapping; convenience-yield change status.
- [ ] Migration test or check: zero `macro_snapshots` rows under retired names.
