# RatioBo — Debt-Cycle Metrics Integrity, Follow-Up (v2)

**Status:** v1.0 (Nov 17, 2026). Not started.
**Owner:** Scott
**Builder:** Claude Code
**Suggested location in repo:** `docs/specs/debt-metrics-integrity-v2.md`
**Decisions log:** append to `docs/specs/debt-metrics-integrity-decisions.md` under a new `## v2` heading. Don't start a second log, because v1's findings (data floors, MTS table traps, FK workarounds) are context this work needs.
**Predecessor:** `docs/specs/debt-metrics-integrity.md` (Phases 0–4, completed and deployed Nov 16–17, 2026).

---

## 0. Why this exists

v1 shipped cleanly and the main corrections are live:
- r − g is now nominal (−0.72);
- r_eff − g is new (−2.49);
- interest uses the net-interest basis (19.8%);
- the deficit is current (6.6%);
- the stage is MP1;
- the fiscal-dominance trip-wire was rebuilt.

A post-deploy review of the live `/big-cycle` page and the v1 decisions log found 8 follow-ups. Some came out of v1's own fixes and some predate it. Ranked:

| # | Problem | Where | Effect |
|---|---|---|---|
| 1 | **The auction-demand trip-wire is effectively permanently armed.** v1 Phase 4a moved it to consolidated per-term averages but kept the per-auction `< 65` threshold. The consolidated reading runs ~55–58%, so the trip-wire can't disarm. `sinceDate` returns the oldest auction in the 6×6 window (2024-08-08), not when the condition started. | `_shared/indirectBidder.ts` → `evalAuctionDemandDeterioration` (line ~87–95) | A real notification fired Nov 17 that wasn't a new signal. Three thresholds now exist for one concept: card `55/65`, classifier `57.5`, trip-wire `65`. |
| 2 | **Stale r − g wording on Big Cycle.** The cross-ref still says "minus **real** GDP growth", and the status label says "**r < g — sustainable**". v1 Phase 1d's grep reported that this string didn't exist; it does. | `update-big-cycle-metrics/index.ts` lines ~555–556; `big_cycle_metrics.source_name` rows seeded by `20260821_debt_cycle_three_classic_signals.sql` | Mislabels the definition. "Sustainable" overstates the situation: with a ~3% primary deficit, debt/GDP still rises when r < g. |
| 3 | **Stale source lines.** Interest % Revenue still cites `A091RC1Q027SBEA / FYFR` (now MTS). Deficit % GDP cites "FRED" (now MTS + FRED GDP). r − g cites `DGS10/GDPC1` (now `DGS10/GDP`). | `big_cycle_metrics.source_name` (DB rows) | Misleading provenance. |
| 4 | **The stage will flip-flop at 20%.** Net interest / receipts is 19.82% against a hard `> 20` gate, and rising monthly as refinancing continues. | `debtCycleClassifier.ts` → `debtServiceStrained`; new fiscal-dominance condition 1 | Each monthly MTS release could toggle MP1 ↔ MP1 (strained) and fire notifications. |
| 5 | **CPI, Core CPI and Real Fed Funds frozen since 2026-10-29.** `yoyPair` is all-or-nothing, and `CPIAUCSL` has no 2025-10-01 value. Meanwhile `_shared/inflationRegime.ts` already interpolates that exact month (decision D-0, geometric mean of Sep/Nov 2025), so the two subsystems handle one gap two different ways. | `_shared/yoyMath.ts` → `yoyPair`; `_shared/inflationRegime.ts` lines ~71–80 | Three dashboard cards stale. Fiscal-dominance conditions 2 and 4 read `null`. The Daily Summary's "core CPI 2.6%" is suspect (three straight +0.3% m/m core prints). Self-heals Dec 10 (Nov CPI), but the same gap logic will bite again. |
| 6 | **Fiscal-dominance condition 1 has a 60-day data floor.** Net-interest/receipts history only exists from 2026-11-17, so the trip-wire can't arm before ~2027-01-16. | `macro_snapshots` history for "Interest Expense % of Federal Revenue" | v1 rule 2.2 prefers backfill. MTS monthly data goes back years, so the floor isn't necessary. |
| 7 | **Forward pressure is invisible.** The convergence gap (10Y − r_eff = +1.72 pts) lives only in card metadata. With the stage now MP1 and every condition ✗, the Position Check understates the refinancing pressure ahead. | `components/DebtCyclePositionCheck.jsx`; `macro_indicators.metadata.convergence_gap` | A reader concludes "nothing strained" when the main forward risk is the average rate converging toward the market rate. |
| 8 | **Housing affordability stale since 2026-10-27.** Redfin's public S3 file returns HTTP 403. The underlying sale-price period is also 2026-05-31. | `update-big-cycle-metrics/index.ts` line ~156 | Stale Internal Order card. v1 worked around it for the determinant text only. |
| 9 | **Paradigm rows flash "stale" while loading.** `MetricRow` renders "stale" whenever `score` is `undefined`, including before the metric-scores fetch resolves. (Not a data bug; the Nov 16 review mistook this flash for one.) | `components/FiscalParadigmSection.jsx` line ~48 | Misleading on every page load, and it already caused one false bug report. |

---

## 1. Goals / non-goals

**Goals**
- One threshold per concept, and every trip-wire can both arm **and** disarm under realistic data.
- Every label, description and source line on `/big-cycle` and `/macro` matches the live calculation.
- Threshold gates near their boundary don't toggle on noise.
- Inflation gap handling is identical across subsystems.
- The forward-looking debt signal is visible where the stage is shown.

**Non-goals**
- No change to stage logic beyond adding hysteresis (item 4).
- No new data vendors. If Redfin can't be restored, use an existing source (FRED/Census/FHFA) and record the switch in the log.
- No portfolio impact. Phase 0 of v1 confirmed nothing downstream of the debt-cycle stage feeds portfolio targets; re-confirm with a grep in Phase 0 here.

---

## 2. Standing rules (carry over from v1, plus three new)

v1's rules 1–6 still apply. That includes indicator names as keys with rename migrations, backfilling under a new definition, date alignment, vintage labels, pure logic in `_shared/` with tests, and logging decisions.

7. **Every gate needs a disarm test.** For each trip-wire or classifier threshold you touch, add a test proving it can turn *off* on realistic data. An armed-forever trip-wire is a bug.
8. **Grep with the actual characters.** Search for exact UI strings with the fixed-string flag (`grep -rnF`), and search both `−` (U+2212) and `-`, `≈` and `~`. The v1 miss in item 2 was almost certainly a character mismatch.
9. **`sinceDate` means when the condition started.** It never means the oldest data point in a lookback window.

---

## 3. Phases

### Phase 0 — Baseline (no behavior changes)

1. Snapshot the current live values for every item in §0 into `tests/fixtures/debt-metrics-v2-2026-11-17.json`. Include all three indirect-bidder thresholds, the auction trip-wire's `armed`/`sinceDate`/`trailingAvg`, net interest/receipts, CPI/Core CPI/Real Fed Funds `last_fetched_at`, the convergence gap, and the Redfin card's `last_fetched_at`.
2. Re-grep for consumers of `auction_demand_deterioration` and `debtServiceStrained` (notification paths, LLM prompts, UI) and list them in the log.
3. Pull indirect-bidder history from `treasury_auction_results` and compute the consolidated per-term reading (v1's `computeIndirectBidderSnapshot`) at every historical auction date available. Record its distribution: mean, std dev, P10/P25/P50, and the 2-year rolling mean. Phase 1 calibrates against this.
4. Check what "core CPI 2.6%" in the Daily Macro Summary actually reads from (which indicator, which date) and log it.

**Acceptance:** fixture committed; consumers listed; the indirect-bidder distribution is in the log.

---

### Phase 1 — Auction demand: one threshold, a real trip-wire

**1a. One threshold source.** Create `INDIRECT_BIDDER_THRESHOLDS` in `_shared/statusThresholds.ts`. The card status, the classifier's `mp3AuctionDemandWeak`, and the trip-wire all import it. No inline numbers anywhere.

**1b. Calibrate against the series' own history**, not fixed levels:
- **Card status:** z-score of the consolidated reading against its own full history: `z > −1 healthy`, `−2 < z ≤ −1 watch`, `z ≤ −2 danger`.
- **Classifier `mp3AuctionDemandWeak`:** `z ≤ −1.5`. This is MP3-adjacent evidence, so it needs a stronger signal than the card's watch line.
- **Trip-wire (early warning):** arms when the consolidated reading is **below its own trailing 2-year mean by more than 1 std dev for 3 consecutive auction rounds**. Disarms when it's back above `mean − 0.5 sd` for 2 consecutive rounds (hysteresis).
- If Phase 0's history is too short for a stable z (fewer than ~24 consolidated readings), fall back to percentile ranks over whatever exists and say so in the card metadata. Log the choice.
- All thresholds are starting points. Log them as uncalibrated per rule 6.

**1c. Fix `sinceDate`.** Return the date of the first round in the current consecutive streak (rule 9). Rename the old value to `values.windowOldestDate` if it's still useful.

**1d. Expected outcome.** Project the trip-wire's live state under the new rule before deploying and report it. **Expected: disarmed**, unless Phase 0's history shows today's 57.55% is genuinely low versus its own 2-year mean. If it stays armed, report why with the numbers. Don't force a disarm.

**1e. Notification hygiene.** On the first run after deploy, suppress the "fired/cleared" notification for this one key, because the definition changed. Log one line in `big_cycle_stage_notes`: "Auction-demand trip-wire recalibrated <date>: now relative to its own history; prior armed state reflected a threshold mismatch, not new deterioration."

**Tests:**
- `indirectBidder.test.ts`: armed case, disarm case (rule 7), hysteresis, a `sinceDate` streak-start case, and today's live numbers.
- `debtCycleClassifier.test.ts`: `mp3AuctionDemandWeak` boundary cases at the new z threshold.

**Acceptance:** one threshold source; the trip-wire can arm and disarm on realistic data; `sinceDate` means streak start; live state reported before deploy.

---

### Phase 2 — Wording, labels and source lines

**2a. r − g cross-ref** (`update-big-cycle-metrics/index.ts` ~555–556):
- `note_suffix`: "10Y Treasury yield minus **nominal** GDP growth (r−g) — the marginal cost of new federal borrowing vs. growth of the nominal tax base. Cross-referenced from Macro."
- `status_label`:
  - `bad` → "r > g — new debt compounding faster than the economy"
  - `warn` → "r ≈ g — borderline"
  - `healthy` → "r < g — growth outpacing rates"
- **Retire the word "sustainable" from this card.** Add one line to the note: "r < g alone doesn't stabilize debt/GDP while a primary deficit persists."

**2b. Source lines.** Migration updating `big_cycle_metrics.source_name` (and anything else that renders provenance) for:
- **Rate vs. GDP Growth Spread:** "Macro dashboard, Long-Term Debt Cycle layer (FRED DGS10 / GDP, nominal)"
- **Interest Expense % of Federal Revenue:** "Macro dashboard, Long-Term Debt Cycle layer (Treasury MTS: net interest ÷ receipts, trailing 12 months)"
- **Federal Deficit % GDP:** "Treasury MTS (trailing-12 deficit) ÷ FRED GDP (trailing 4Q)"
- The equivalent `/macro` descriptions, if any still reference the old series.

**2c. Sweep.** Use rule 8: `grep -rnF` for "real GDP growth", "GDPC1", "A091RC1Q027SBEA", "sustainable", "Subsidy inverted", "Privilege intact", "fiscal_dominance_confirmed", across `supabase/functions`, `components`, `app`, `lib`, **and live DB text columns**:
- `big_cycle_metrics.note_suffix` / `status_label` / `source_name`
- `big_cycle_determinants.reading_text`
- `macro_indicators.description`

Every remaining hit is either fixed or logged as intentional (e.g. NIPA lines kept as secondary context).

**2d. Interest vs. Defense card.** It compares NIPA interest ($1.33T) with NIPA defense ($1.23T). That's internally consistent, but it now sits beside a net-interest headline of $1.06T. Add to its note: "NIPA basis on both sides (includes imputed pension interest); budget-basis net interest is $X." Fill in X from the live MTS figure. No calculation change.

**Acceptance:** the sweep log shows zero unintended hits; the live page shows the new wording.

---

### Phase 3 — Hysteresis on the 20% debt-service gate

**3a.** Add a shared `hysteresisGate(series, { on, off, persistMonths })` helper in `_shared/`:
- arms when the value is `> on` for `persistMonths` consecutive monthly readings;
- disarms when it's `< off` for the same count;
- otherwise keeps its prior state.

Monthly granularity matches the MTS cadence. Dedupe daily snapshot repeats first (reuse `dedupeConsecutive`).

**3b.** `debtServiceStrained` uses `on = 20.5`, `off = 19.5`, `persistMonths = 2`. Log the values as uncalibrated. The classifier's `rawInputs` must record both the raw value and the gate state, so the Position Check can show "19.8% (gate: off, needs >20.5% for 2 months)".

**3c.** Fiscal-dominance condition 1 uses the same gate state. Don't apply a separate raw `> 20` check.

**3d.** Position Check condition row: "Debt service strained: 19.8% of revenue — threshold 20% (on above 20.5% for 2 months, off below 19.5%)".

**Tests:** threshold crossing without persistence (no flip); persistent crossing (flip); dip into the dead band (no flip back); disarm path.

**Acceptance:** a single month crossing 20% can't flip the stage; the Position Check explains the gate state.

---

### Phase 4 — Inflation gap handling, unified

**4a.** Promote the D-0 interpolation out of `inflationRegime.ts` into `_shared/yoyMath.ts` as a **general, documented gap rule** for monthly price indexes:
- For a missing month bracketed by two real observations, use the **geometric mean of the neighbors**, only for computing YoY on either side of it.
- Never write the filled value back to any raw-series table.
- Tag every YoY that used a filled value with `metadata.used_interpolated_month = "2025-10-01"`.
- Gaps longer than one month are never filled. Return `null` and keep v1's strict behavior.

**4b.** `inflationRegime.ts` imports the shared rule instead of its hardcoded `GAP_MONTH` block. Its outputs must be **bit-identical** before and after. Diff the classifier output across its full history.

**4c.** `yoyPair` in `fetch-macro-data` uses the shared rule. Also add a fallback for when the newest observation still can't be paired: return the most recent pairable pair, with `metadata.stale_reason`, so the card advances rather than freezing.

**4d.** Run `fetch-macro-data` and confirm:
- CPI, Core CPI and Real Fed Funds refresh with `last_fetched_at` today;
- Oct 2026 YoY values are flagged `used_interpolated_month`;
- Real Fed Funds now shows its **stance** label (v1 Phase 3b's code, blocked until now);
- fiscal-dominance conditions 2 and 4 read non-null;
- the Daily Summary's core CPI matches the corrected Core CPI card (resolves Phase 0 item 4).

**4e.** Card UI: when `used_interpolated_month` is set, show a small "incl. interpolated Oct 2025 base" note.

**Tests:**
- single-month gap filled;
- two-month gap not filled;
- filled value never persisted;
- `inflationRegime` output bit-identical;
- fallback-to-latest-pairable path.

**Acceptance:** no CPI-derived card is stale; one gap rule across both subsystems; the inflation-regime output is unchanged.

---

### Phase 5 — Backfill net interest / receipts history

**5a.** Backfill `macro_snapshots` for "Interest Expense % of Federal Revenue" and "Interest Expense % GDP" under the MTS net-interest basis.
- Use one monthly value per month-end. The trailing-12 window ends that month.
- Go back as far as MTS Table 9 / Table 1 support cleanly (target ≥ 3 years).
- Reuse v1's `_shared/mtsFiscalData.ts`. **Mind the Table 1 duplicate-group trap** (`sequence_number_cd` must start with `"2."`).
- Apply v1's "as of that date" vintage logic: each historical month uses only the data available then. If true vintages aren't available, use the latest revised figures and log that.
- Replace the old NIPA-basis rows for those dates (rule 2.2: never mix definitions). Keep the NIPA values in `metadata.nipa_pct_*` where they exist.

**5b.** Re-evaluate the fiscal-dominance trip-wire against the backfilled history. Report the streak length and armed state. **Expected:** still unarmed (condition 1 is under 20% today; condition 3 is false).

**5c.** Remove the "60-day data floor" caveat from the log and code comments once it's resolved.

**Tests:** a backfill row-count and definition check (no NIPA-basis headline values remain in the backfilled range).

**Acceptance:** at least 3 years of consistent-basis history; the trip-wire evaluates on real history.

---

### Phase 6 — Make forward pressure visible

**6a.** Add a **"Refinancing pressure ahead"** row to the Position Check, shown as informational (like the r_eff row, not a stage gate):
- `convergence_gap = DGS10 − r_eff` (from metadata), with r_eff and the 10Y shown;
- the 12-month change in r_eff (from the Phase 5 backfill) as the trend arrow.

Copy: "The average rate on outstanding debt (3.38%) sits 1.72 pts below the 10Y; as maturing debt refinances, it converges upward."

**6b.** Add a Big Cycle card "Effective Rate on Federal Debt (r_eff)" as a cross-ref of the existing Macro indicator: value r_eff, subtitle with the convergence gap. Status bands, based on the gap: `< 0.5 healthy · 0.5–1.5 watch · > 1.5 danger`. A large gap means more repricing is still ahead. Log as uncalibrated.

**6c.** Position Check brief prompt (`generate-debt-cycle-brief`): add the convergence gap and r_eff trend as inputs. Instruct it that an MP1 stage with a large convergence gap means **"no current strain, rising pressure,"** not "healthy." Update the fact-check pass to verify that sentence's numbers.

**Acceptance:** the Position Check shows the forward signal next to the stage; the brief mentions it.

---

### Phase 7 — Small fixes

**7a. Redfin 403.** Find out whether the S3 path moved (check Redfin's Data Center for the current URL). If it's restorable, update the URL and log it. If not:
- switch the numerator to FRED `MSPUS` (median sales price of houses sold, quarterly) and the denominator to FRED `MEHOINUSA646N`;
- rename the card's source line;
- backfill per rule 2.2 or start a new indicator name.

Either way, the card shows its **data period** (currently 2026-05-31) prominently, not just in the note.

**7b. Paradigm loading state.** In `FiscalParadigmSection.jsx`, track `metricScoresLoaded`. While it's false, `MetricRow` shows a neutral "…", not "stale". Show "stale" only when loaded **and** (`score` missing **or** `available = false`). Distinguish the two in the tooltip: "no row for this date" vs. "source unavailable".

**Acceptance:** the Redfin card is current or explicitly re-sourced; no "stale" flash on load.

---

## 4. Rollout order and expected visible changes

Ship order: **0 → 1 → 2 → 3 → 4 → 5 → 6 → 7.** Phases 1, 3, 4 and 5 can change a trip-wire or stage, so each needs the v1-style before-deploy report and Scott's approval.

**Expected live changes:**
- **Auction-demand trip-wire:** likely disarmed (Phase 1), with a recalibration note.
- **Big Cycle r − g card:** reads "r < g — growth outpacing rates," nominal wording and correct sources (Phase 2).
- **Stage:** stays MP1 (19.8% is inside the dead band). Future toggles need 2 consecutive months beyond 20.5% / 19.5% (Phase 3).
- **CPI cards:** CPI, Core CPI and Real Fed Funds refresh. Real Fed Funds shows **Neutral** (or whatever the refreshed data gives). Core CPI likely reads well above 2.6% (Phase 4).
- **Fiscal-dominance trip-wire:** evaluated on years of history; still unarmed (Phase 5).
- **Position Check:** gains the "Refinancing pressure ahead" row (Phase 6).

---

## 5. Test checklist

- [ ] `indirectBidder.test.ts`: one threshold source; z-based arm/disarm; hysteresis; `sinceDate` = streak start
- [ ] `debtCycleClassifier.test.ts`: `mp3AuctionDemandWeak` at the new z boundary; `debtServiceStrained` hysteresis
- [ ] `hysteresisGate.test.ts` (new): crossing without persistence, persistent crossing, dead band, disarm
- [ ] `yoyMath.test.ts` (new or extended): single-month gap filled, multi-month not filled, never persisted, fallback-to-latest-pairable
- [ ] `inflationRegime` output bit-identical across full history after the gap-rule refactor
- [ ] Backfill check: no NIPA-basis headline values in the backfilled interest range
- [ ] Wording sweep log: zero unintended hits for the rule-8 search list (code **and** DB text columns)
- [ ] `FiscalParadigmSection`: no "stale" before the metric fetch resolves
