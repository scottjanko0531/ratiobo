# Debt-Cycle Metrics Integrity — Decisions Log

Append-as-you-go record of judgment calls, data-source choices, and
findings for `docs/specs/debt-metrics-integrity.md`.

## Phase 0 (2026-11-16)

### Fixture vs. snapshot cross-check

Pulled live from `macro_indicators`/`big_cycle_metrics`/`big_cycle_stages`
(see `tests/fixtures/debt-metrics-2026-11-16.json`). Every value matched
the spec's own snapshot list to 2-3 decimal places except the three items
noted in the fixture's own `discrepancies_vs_spec_snapshot` array (indirect
bidder's classifier-pooled 59.3% figure, gross debt's actual source table,
and the trip-wire's "armed since" persistence location) — none of these
are data *disagreements*, just places where Phase 0's recon didn't fully
trace the exact origin within its time budget. `tot_pub_debt_out_amt` from
Treasury's `debt_to_penny` API = $40,608,506,856,903.25 as of 2026-11-12,
an exact match to the spec's "$40.61T."

### FRED pulls (live, via `fredgraph.csv`)

| Series | Latest value | Date |
|---|---|---|
| `GDP` (nominal GDP, SAAR, $B) | 33,010.036 | 2026-07-01 |
| `GDP` (year-ago, same quarter) | 31,180.493 | 2025-07-01 |
| **Nominal GDP YoY (computed)** | **5.8676%** | Q3 2026 vintage |
| `GDPDEF` (GDP deflator index) | 134.127 | 2026-07-01 |
| `GDPDEF` (year-ago) | 129.310 | 2025-07-01 |
| GDP deflator YoY (computed) | 3.724% | — |
| `FYGFDPUN` (debt held by public, $M) | 31,705,538.35 | 2026-04-01 (latest available; quarterly, lags) |
| `FYOINT` (federal net interest outlays, annual, $M) | 1,359,953.25 | FY2026 (ending 2026-09-30) |
| `DGS10` (10Y Treasury, daily) | 5.10% | 2026-11-12 (11-11 missing — Veterans Day) |

**Cross-check:** real GDP YoY (2.066%, from `macro_indicators`) + GDP
deflator YoY (3.724%) ≈ 5.79%, close to the directly-computed nominal GDP
YoY (5.87%) — consistent (small gap from additive-vs-compounding
approximation and `GDPC1` vs `GDP` vintage differences). No contradiction.

**Important finding, log for Phase 1b/2b:** `FYOINT` ($1.36T FY2026) is
**not** the right "net interest" figure for `r_eff` or the Dalio 20%
checkpoint — see the MTS finding below. `FYOINT` runs well above the
MTS budget-function "Net Interest" figure computed below ($1.064T), the
same NIPA-vs-budget-function gap the spec's own §0 secondary point
flags for the interest-expense card (NIPA `A091RC1Q027SBEA` running above
CBO/Treasury net interest). Use MTS, not FRED's `FYOINT`, for Phase 1b.

### Treasury Fiscal Data: exact MTS table/line items used (judgment call, per spec rule 6)

- **Net interest**: `api.fiscaldata.treasury.gov/.../v1/accounting/mts/mts_table_9`,
  filtered `classification_desc = 'Net Interest'` (budget function,
  `line_code_nbr = 320`). This is Table 9 ("Summary of Receipts by Source
  and Outlays by Function of the U.S. Government"). Chose this over
  Table 3 (outlays by *agency*, no "Net Interest" line at all) and over
  FRED's `FYOINT` (a different, broader NIPA-adjacent concept — see
  above). Trailing-12-month sum (Nov 2025 – Oct 2026, 12 individual
  monthly rows, **not** the FYTD column, since FYTD resets every
  October): **$1,063.96B**. This lands almost exactly inside the spec's
  own expected range ("~$1.0–1.1T for FY2026").
- **Receipts and deficit**: `mts_table_1` ("Summary of Receipts, Outlays,
  and the Deficit/Surplus of the US Government, by Month"), individual
  monthly rows identified by `line_code_nbr` (20=Oct, 30=Nov, … 130=Sep,
  160=the *new* fiscal year's Oct, since each MTS publication carries a
  fresh line-code namespace for the just-started fiscal year's first
  month alongside the just-closed year's 12 rows — confirmed by hand:
  line 20's October figures ≠ line 160's October figures). Trailing-12
  (Nov 2025 – Oct 2026): receipts **$5,367.88B**, deficit **$2,112.32B**
  (outlays − receipts cross-checked and matches exactly).
- **Debt held by the public**: `v2/accounting/od/debt_to_penny`,
  `debt_held_public_amt` (daily). Latest (2026-11-12): $32,824,386,143,424.80
  (≈$32.82T). Daily granularity is more precise than FRED's quarterly
  `FYGFDPUN` ($31.71T, one quarter stale) — **recommend Phase 1b use the
  daily `debt_to_penny` series for the trailing-12-month average
  denominator, not FRED's `FYGFDPUN`.**

**Deficit % GDP cross-check against CBO:** trailing-12 deficit ($2,112.32B)
÷ trailing-4-quarter actual nominal GDP (computed from the 4 latest `GDP`
SAAR quarters ÷ 4 each, summed: ≈$32,235.47B) = **6.55%**. This is >0.3pts
away from CBO's quoted 6.2% for FY2026 (spec's own threshold for needing
an explanation, §Phase 2a). **Explanation:** the MTS trailing-12 window
(Nov 2025–Oct 2026) is shifted one month forward of CBO's FY2026 window
(Oct 2025–Sep 2026) — it drops Oct 2025 (deficit $284.3B) and picks up
Oct 2026 (deficit $404.1B), a swing of ~+$120B, which alone accounts for
roughly +0.37pts of the ~0.35pt gap observed. Not a data error — a
real, explainable timing-window effect, exactly the kind the spec
anticipated.

### Consumers of `big_cycle_stages.is_current` / debt-cycle stage / trip-wires

Grepped the whole repo (not assumed from naming). Real consumers:

1. **`components/DebtCyclePositionCheck.jsx`** — display only (the
   "Position Check brief" Scott named).
2. **`supabase/functions/generate-debt-cycle-brief/index.ts`** — builds a
   full Claude (haiku) prompt with the stage, its conditions, and armed
   trip-wires as a "hard constraint" (the LLM is told not to contradict
   the computed classification), generates a narrative brief, and runs a
   *second* Claude call as a fact-checker pass against that narrative.
   Reads from `big_cycle_stage_audit_log`. **This is a real
   "Clio-adjacent" prompt consumer** Scott didn't name explicitly by this
   function's name — flagging it since the instruction was "list every
   consumer, don't assume from naming."
3. **`supabase/functions/detect-macro-events/index.ts`** — reads the
   current stage's `label`/`description` and includes it as context in
   its own separate Claude prompt (scanning for new macro events). A
   **second, distinct LLM-prompt consumer**, also not one of the four
   things Scott named by name.
4. **`supabase/functions/apply-macro-event/index.ts`** — the only writer
   of `big_cycle_stages.is_current` found; explicitly gated "always
   behind an explicit human confirm click" (comment in the file itself)
   — not an automated feed.
5. **`app/big-cycle/page.jsx`** — renders the stage list, display only.

**Confirmed NOT a consumer, despite surface-level grep hits:**
- `supabase/functions/_shared/marketConditions/types.ts` and
  `supabase/functions/_shared/paradigmScoring.ts` both matched an earlier
  broad grep for `debtCycleClassifier`/`classifyDebtCycleStageV2`, but in
  both cases the only match is a **comment** citing `debtCycleClassifier.ts`
  as a *coding-convention* reference (both files are written in the same
  Deno-API-free, Vitest-importable pattern) — neither file actually
  imports or reads anything from the debt-cycle classifier or trip-wires.
- `supabase/functions/update-regime-portfolio-targets/index.ts` matched a
  grep for "Clio" — but this is "Clio" in the sense of the *inflation/
  regime* analysis assistant (structural_key/nearterm_forward_key, the
  subject of this session's earlier regime-tilt-recalibration work), a
  completely separate subsystem with no reference to the debt cycle at
  all.
- **Daily Macro Summary** (`supabase/functions/daily-brief/index.ts`): zero
  references to `big_cycle_stages`, debt cycle, or fiscal dominance
  anywhere in the file.
- **Portfolio targets**: no file under `supabase/functions/` whose name or
  content suggests portfolio-target computation references
  `big_cycle_stages` or `DEBT_CYCLE_ID` anywhere in the repo.

**Bottom line for Scott's question:** the debt-cycle stage/trip-wires do
**not** feed portfolio targets, the inflation-regime Clio prompts, or the
Daily Macro Summary. They DO feed two LLM-prompt consumers beyond the
named Position Check brief (`generate-debt-cycle-brief`'s narrative +
fact-check pass, and `detect-macro-events`'s event-scanning prompt) — both
will need their generated text/behavior re-validated once Phase 1 changes
the stage definition, since both currently treat the computed stage as
ground truth to never contradict.

### Paradigm "stale" display bug — traced, not currently reproducible against live data

Checked every candidate in the spec:

1. **No `.range()` on `big_cycle_paradigm_scores`**: confirmed present
   (320 rows today) — a real future risk (~4 years out at 5 rows/day) but
   not today's bug. **Not the cause.**
2. **`recorded_at` string-format mismatch**: both tables are genuinely
   `date` type in Postgres (confirmed via `information_schema`), and I
   replicated the component's exact two-query sequence directly against
   the live REST API (anon key, same table names, same filter,
   `recorded_at=eq.2026-11-16`) — it returns the correct 13 rows, all
   `available: true`. **Ruled out as today's cause.**
3. **`/big-cycle` rendering a different component**: confirmed by grep —
   `app/big-cycle/page.jsx` imports and renders `FiscalParadigmSection`
   directly, nothing else. **Ruled out.**
4. **A race between the two client-side fetches**: checked the *actual*
   write order in `update-big-cycle-paradigm-metrics/index.ts`: it writes
   `big_cycle_paradigm_metric_scores` **first**, then
   `big_cycle_paradigm_scores` **second**, in the same function run. This
   ordering structurally prevents the client-side race in the happy
   path — by the time a `recorded_at` shows up in `paradigm_scores`,
   `metric_scores` for that same date was already committed moments
   earlier. **Ruled out as the steady-state cause.**

**Most likely actual cause, given the evidence:** the metric-scores
upsert is chunked (`.slice(i, i+500)`) and any chunk's error is only
`console.error`'d — never thrown, never surfacing anywhere a human would
see it (no `rb_job_runs`/equivalent logging in this function). If any
chunk silently failed on some past day, `big_cycle_paradigm_scores` for
that date would still get written (it's a separate, unconditional write
right after), producing exactly the reported symptom: a `latestDate` that
exists in the composite table but has partial-or-zero matching rows in
`big_cycle_paradigm_metric_scores` — every `MetricRow` then renders
"stale" because `score` is `undefined`, not because the data is actually
stale. **This is not reproducible against today's data** (today's upsert
evidently succeeded cleanly, confirmed live) — it's a **latent,
intermittent failure mode**, not a standing bug. Recommend for Phase 4c:
(a) make `update-big-cycle-paradigm-metrics` log its own run to a
job-runs-style table matching this codebase's established convention, so
a partial failure is actually visible, and (b) have the component
distinguish "no row returned for a metric this date" from
`available=false` — today it silently renders the same "stale" label for
both, which is exactly what made this bug hard to pin down after the
fact.

### Phase 1 projection — computed, NOT written anywhere

Corrected r−g (Phase 1a definition: `DGS10 (latest) − nominal GDP YoY`,
date-matched):

```
DGS10 (2026-11-12)        5.10%
Nominal GDP YoY (Q3 2026) 5.8676%   (computed live from FRED GDP, above)
r − g (corrected)         5.10 − 5.8676 = −0.7676
```

This is **negative** (slightly beyond the spec's own rough guess of "−0.5
to +0.5," but same side of zero, well within plausible vintage/rounding
variance of a rough guess made without pulling live data). Under
`classifyDebtCycleStageV2`:

- `rGreaterG = rateGrowthSpread > 0` → **flips from `true` to `false`**.
- All other conditions are unaffected by this change: `debtServiceStrained`
  stays `true` (24.593% > 20, Phase 1 doesn't touch this input yet),
  `fedPrintingRising`/`mp2Gate`/`mp3AuctionDemandWeak`/`mp3SomaAbsorbing`
  all stay `false` (unchanged live reads, confirmed above).
- `strainedCount` (the OR of `debtServiceStrained`, `rGreaterG`,
  `fedPrintingRising`) drops from **2 → 1**.
- Since `strainedCount >= 2` is the only test separating `"MP1 (strained)"`
  from `"MP1"`, and it's no longer met:

**Projected stage: `MP1 (strained)` → `MP1`.**

Exactly matches the spec's own "likely outcome" (§4). As a secondary,
informational-only computation (per Phase 1b, not a classifier gate):
`r_eff` (MTS trailing-12 net interest $1,063.96B ÷ trailing ~12-month
average debt held by public, computed from 3 available `FYGFDPUN`
quarters ≈$31.34T — flagged above that Phase 1b should use the daily
`debt_to_penny` series instead for full 12-month precision) ≈ **3.39%**,
so `r_eff − g` ≈ 3.39 − 5.8676 ≈ **−2.48**, in the same ballpark as the
spec's own "−1.5 to −2" guess (somewhat more negative, same conclusion:
healthy).

**This is a correction, not an improvement in fundamentals** — exactly
the framing the spec asks Phase 1c's Position Check note to carry.
