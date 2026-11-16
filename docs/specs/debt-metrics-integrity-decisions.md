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
4. **`supabase/functions/apply-macro-event/index.ts`** — explicitly gated
   "always behind an explicit human confirm click" (comment in the file
   itself) — not an automated feed.
   **Correction (Phase 1, 2026-11-16):** this is NOT the only writer of
   `big_cycle_stages.is_current` — that was a Phase 0 recon miss.
   `supabase/functions/update-big-cycle-metrics/index.ts`
   (`updateDebtCycleStage()`, lines ~752-755) **also** writes
   `big_cycle_stages.is_current` automatically, every run, from the
   classifier's own computed `result.stage` — no human gate. This is the
   normal automatic classifier→stage pipeline; `apply-macro-event` is a
   *separate*, additional path for a human-confirmed real-world event to
   override the stage directly. Net effect for Phase 1's rollout: once
   the corrected `fetch-macro-data` is deployed, the next scheduled
   `update-big-cycle-metrics` run will automatically flip the
   live-displayed stage — it does not wait for a manual confirm. This
   doesn't change Phase 1's shadow-gating decision (still not required,
   since no portfolio consumer reads the stage), but it does mean the
   stage change ships on the next cron tick after `fetch-macro-data`
   deploys, not on some separate human action.
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

## Phase 1 (2026-11-16)

### 1a: historical backfill vintage-cutover rule (judgment call, per spec rule 6)

The live cron (`case "level_minus_yoy_quarterly"`, and its new sibling
below) has no explicit vintage-locking — on any given day it just asks
FRED for "the latest available value" of each series. To backfill
`macro_snapshots` under the new definition without fabricating a
different methodology than the live code actually runs, I replicated
that same "latest available as of that day" rule for each of the 124
existing `snapshot_date` rows (2026-06-25 through 2026-11-16, pulled
exactly from the DB — not a synthesized continuous range; the existing
gaps, e.g. no row 2026-10-30 through 2026-11-10, are a separate
pre-existing cron-staleness pattern, not something this backfill should
paper over):

- **DGS10**: as-of lookup — the latest FRED daily observation on or
  before the snapshot date (matches `fetchFred`'s own "most recent
  non-null" behavior).
- **Nominal GDP YoY**: FRED's `GDP` series publishes quarterly, with the
  advance estimate for quarter *Q* available roughly a month after *Q*
  closes (BEA's publication calendar: last business day of the month
  following quarter-end). I used fixed cutover dates — Q1 2026
  (2026-01-01) "available" from 2026-04-30; Q2 2026 (2026-04-01) from
  2026-07-30; Q3 2026 (2026-07-01) from 2026-10-30 — to decide which GDP
  print each snapshot date would have seen as "latest," then computed
  YoY against the same quarter one year prior. This is an approximation
  of BEA's real calendar (which varies by a few days year to year), not
  the exact publication dates — logged as a judgment call per rule 6,
  not treated as more precise than it is.
- Computed for all 124 dates with **zero gaps** — no FRED/Treasury data
  missing for any date in range, well short of the "TTM/forward-return
  gap" caliber the coordinator flagged as a stop condition.
- Result: value starts at **−1.348** (2026-06-25) and ends at **−0.7676**
  (2026-11-16) — the 2026-11-16 value exactly matches the Phase 0
  hand-projection above (3 decimal rounding aside). Every one of the 124
  backfilled values is negative → `status = "healthy"` throughout the
  entire history. No sign flips, no mixed-definition rows once written
  (old rows are being overwritten in place under the new definition per
  rule 2.2, not appended alongside old values).

### 1a: new type vs. parameterizing the existing one (judgment call)

Added a new type `level_minus_nominal_yoy_quarterly` rather than
repointing `level_minus_yoy_quarterly`'s `series2`. Grepped first per the
spec's own instruction: `level_minus_yoy_quarterly` is used exactly once
in `fetch-macro-data/index.ts` today (only by "Rate vs. GDP Growth
Spread" itself), so repointing it would have been safe in practice — but
a new type keeps the real-GDP-YoY and nominal-GDP-YoY code paths
textually distinct for any future indicator that wants the real-GDP
version, and keeps the diff self-documenting (new case literally says
"nominal" in its name and comment) rather than relying on a reader
noticing `series2` changed from `GDPC1` to `GDP` on an unrelated-looking
generic type. Status thresholds changed from the old `< 0 / < 2 /
else` to the spec's own `< 0 healthy / 0 to +1.0 watch / > +1.0 danger` —
logged per spec rule 6 as "a starting point, not calibrated."

### 1b: Effective Rate vs. Nominal Growth (r_eff − g)

New type `effective_rate_minus_nominal_yoy` and two new fetch helpers
(`fetchMtsNetInterestMonthly`, `fetchDebtHeldPublicDaily`) added to
`fetch-macro-data/index.ts`, reusing the exact MTS table 9 /
`debt_to_penny` sources validated in Phase 0 (not FRED's `FYOINT`).
Live-computed (not yet deployed) via direct API pulls, cross-checked by
hand in Python against the same math the new TS case runs:

```
Net interest, trailing-12 (Nov 2025-Oct 2026, MTS table 9 line 320): $1,063.96B
  (exact match to the Phase 0 figure)
Avg debt held by public, trailing-12 (debt_to_penny daily, 250 obs):   $31.51T
r_eff = 1,063.96 / 31,511.63 * 100                                   = 3.376%
g (nominal GDP YoY, Q3 2026 vintage, same as 1a)                      = 5.8676%
r_eff - g = 3.376 - 5.8676                                           = -2.491
DGS10 (2026-11-12) - r_eff = 5.10 - 3.376 (convergence gap)          = +1.724
```

Matches the spec's own expectation (`r_eff ≈ 3.3-3.5%`, `r_eff - g ≈
-1.5 to -2`, landing slightly more negative at full daily precision —
consistent with, not contradicting, the rough guess). `r_eff` and the
convergence gap are stored in the indicator's `metadata` column (per
spec: "show r_eff ... in the card metadata/drawer"), not as separate
cards. "Previous" (for `change_value`) shifts both trailing-12 windows
back one month (13 months of net-interest/debt data fetched, 12 used for
"current," months 2-13 for "previous") — a judgment call since the spec
doesn't specify a month-over-month convention for a trailing-12 metric;
chosen to match how every other `change_value` in this file already
works (latest vs. one period back), not a novel convention.

### 1c: wiring, test, and the one-time note

Added `effectiveRateGrowthSpread: number | null` to
`ClassifierInput`/`rawInputs` in `debtCycleClassifier.ts` — informational
only, not read by any `if`/gate in `classifyDebtCycleStageV2`. Wired in
`update-big-cycle-metrics/index.ts`'s `updateDebtCycleStage()` by adding
"Effective Rate vs. Nominal Growth (r_eff − g)" to the existing
`macro_indicators` lookup (one more name in an `.in(...)` list already
there for `rateGrowthSpread`/`debtToTaxRevenueX` — no new query).

**Correction to Phase 0's consumer list** (logged above, under the Phase
0 section, where the original finding lives): `update-big-cycle-metrics`
itself automatically writes `big_cycle_stages.is_current` every run from
the classifier's output — `apply-macro-event` is a separate, additional
human-gated override path, not the only writer. This means the stage
flip ships on the next scheduled classifier run after `fetch-macro-data`
deploys, not on a separate manual action.

**One-time note storage**: created `big_cycle_stage_notes` (migration
`20261116_big_cycle_stage_notes.sql`, RLS-locked per `CLAUDE.md`
convention) rather than reusing a `big_cycle_metrics` row — that table's
rows are rendered as live dashboard metric cards with numeric
value/status, and a note-only row with no numeric value risked an odd
display for a case I hadn't audited; a dedicated table (explicitly
allowed by the spec: "big_cycle_metrics (or a notes table)") avoids that
risk entirely. Wired into `DebtCyclePositionCheck.jsx` (renders the
latest row as a banner above the conditions checklist),
`generate-debt-cycle-brief/index.ts` (passed into the prompt as a
`methodologyNote`, with an instruction not to read it as improved
fundamentals), and `detect-macro-events/index.ts` (same note appended to
its stage-context line, told explicitly not to treat it as a real-world
event). **Not yet inserted into the live table** — holding the actual
`INSERT` until after the mandatory before-deploy report below, since
inserting the note is itself a live-visible change tied to the same
rollout as the stage flip.

Exact note text (drafted, not yet written):

> Stage recalculated after r−g methodology fix on 2026-11-16; previous
> definition compared nominal yield to real growth, overstating the
> strain reading. This is a correction, not a change in underlying
> fundamentals.

Test file (`tests/debtCycleClassifier.test.ts`): added
`effectiveRateGrowthSpread: null` to all 4 existing fixtures (field is
non-optional on `ClassifierInput`, so this was required for the file to
compile; `null` preserves old behavior exactly since the field is
informational-only) and added a new test asserting the 2026-11-16
fixture resolves to `MP1`, not `MP1 (strained)`, under the corrected
`rateGrowthSpread`. All 9 tests in the file pass; full suite (678 tests,
37 files) passes; `npx next build` is clean.

### 1d: copy fixes

Two hardcoded "real GDP growth" strings found and fixed to "nominal GDP
growth" (both describe `rateGrowthSpread`, which 1a changed to be
nominal-GDP-based): `components/DebtCyclePositionCheck.jsx`'s `r > g`
condition-row detail string, and `generate-debt-cycle-brief/index.ts`'s
`conditionLines` prompt text. Checked `app/big-cycle/page.jsx`'s stage
definitions and `lib/dalioBenchmarks.js` for similar hardcoding — the
former already says generically "the interest rate exceeds GDP growth (r
> g)" without specifying real/nominal (no change needed, already
accurate under either definition); the latter has no r-g benchmark at
all. No literal "unsustainable trajectory" string exists anywhere in the
repo (grepped) — the spec's own example was illustrative, not a literal
quote to find.

### Mandatory before-deploy report (rollout-order rule, §4)

Nothing below has been deployed. `fetch-macro-data`,
`update-big-cycle-metrics`, `generate-debt-cycle-brief`, and
`detect-macro-events` are all edited locally only; the `macro_snapshots`
backfill has not been written; the `big_cycle_stage_notes` row has not
been inserted. The only live DB change so far is the new, empty
`big_cycle_stage_notes` table (DDL only, no data, not read by anything
deployed yet — zero behavior change).

| | Before (live today) | After (once deployed) |
|---|---|---|
| **Stage** | `MP1 (strained)` | `MP1` |
| `debtServiceStrained` | true | true (unchanged) |
| `rGreaterG` | true | **false** (flips) |
| `fedPrintingRising` | false | false (unchanged) |
| `mp2Gate` | false | false (unchanged) |
| `mp3AuctionDemandWeak` | false | false (unchanged) |
| `mp3SomaAbsorbing` | false | false (unchanged) |
| `strainedCount` | 2 | 1 |
| "Rate vs. GDP Growth Spread" card | +3.034% (danger) | −0.7676% (healthy) |
| "Effective Rate vs. Nominal Growth" card | does not exist | −2.491% (healthy), new |
| **Debt Sustainability gauge** (`debt_sustainability_gauge_1`, 1.867) | unaffected — confirmed by code read: sourced from a separate annual debt-to-GDP/debt-to-income z-score composite (`computeGauge1`-style block, update-big-cycle-metrics ~line 663), no `rateGrowthSpread` input anywhere in that path | unaffected |
| **Trip-wires** (`mp2_onset_watch`, `auction_demand_deterioration`, `dollar_divergence_widening`, `fiscal_dominance_confirmed`) | unaffected — confirmed by grep: none of the four reference `rateGrowthSpread`/`rGreaterG` in `debtCycleTripWires.ts` | unaffected |
| `macro_snapshots` history (124 rows) | old (flawed) real-GDP-YoY-based values | backfilled under corrected definition, all 124 negative/"healthy" |

Shadow-gating not required (Phase 0 found no portfolio consumer). The
`big_cycle_stage_notes` one-time note is the equivalent safeguard for the
two narrative/prompt consumers, per the coordinator's explicit
instruction — drafted above, not yet live.

### Deployed (2026-11-16) — live verification

Scott approved. Deployed via `supabase functions deploy` (CLI, not the
MCP `deploy_edge_function` tool — avoids reading this repo's largest file,
`fetch-macro-data/index.ts` at 3200 lines, fully into context just to
redeploy it unchanged elsewhere). Preserved `verify_jwt` exactly per the
live settings confirmed before deploying (fetch-macro-data=true,
update-big-cycle-metrics=false, generate-debt-cycle-brief=false,
detect-macro-events=false — the latter two aren't pinned in
`supabase/config.toml` since that file only tracks pg_cron-invoked
functions; confirmed their live setting directly via `list_edge_functions`
first) — all four confirmed unchanged after deploy.

**Caught one real bug before it reached the live cron**: the first
`fetch-macro-data` deploy 500'd — `sort_order: 4.5` on the new r_eff
indicator against a `smallint` column (`"invalid input syntax for type
smallint: \"4.5\""`). Fixed to `sort_order: 4` (ties with "Rate vs. GDP
Growth Spread" — harmless, both Layer-1 cards render adjacent), redeployed,
reran clean.

**Live verification, in order:**

1. Ran `fetch-macro-data` directly (`curl` with an `Authorization: Bearer`
   anon-key header, matching its `verify_jwt=true` pin): `{"updated":73,
   "skipped":3,...}`. The 3 skipped are pre-existing stale indicators
   unrelated to this work (Core CPI, CPI, Real Fed Funds Rate — last
   fetched 2026-10-29, a separate standing issue, not touched here).
   Confirmed live: "Rate vs. GDP Growth Spread" = **-0.768** (healthy,
   was +3.034/danger); "Effective Rate vs. Nominal Growth (r_eff − g)" =
   **-2.491** (healthy, new), with `metadata.r_eff = 3.376` and
   `metadata.convergence_gap = 1.724` — exact matches to the hand-calc
   above.
2. Ran `update-big-cycle-metrics`: response's `debtCycleStage` = exactly
   the predicted before→after — `stage: "MP1"`, `rGreaterG: false`,
   `debtServiceStrained: true`, `fedPrintingRising/mp2Gate/
   mp3AuctionDemandWeak/mp3SomaAbsorbing: false`, `rawInputs.
   effectiveRateGrowthSpread: -2.491` present and wired. Trip-wires:
   3 unarmed, `fiscal_dominance_confirmed` armed since 2026-02-20 — a
   pre-existing state, confirmed unaffected by this change (no
   `rateGrowthSpread` reference in that trip-wire's logic).
3. `select label, is_current from big_cycle_stages ...`: confirms
   `is_current` flipped live — `MP1 (strained)` → `false`, `MP1` →
   `true`. Matches the Phase 0 correction (§1c) that this write happens
   automatically on the classifier run, not behind `apply-macro-event`'s
   human gate.
4. `big_cycle_metrics` `debt_sustainability_gauge` key: **unchanged**,
   still `1.867` / "Elevated Risk" — confirms the code-read finding that
   this gauge has no `rateGrowthSpread` dependency.
5. Called `generate-debt-cycle-brief?refresh=true` live: narrative opens
   with *"Current stage is MP1, reclassified this run from MP1
   (strained) following a methodology correction to r−g measurement on
   2026-11-16. The prior definition compared nominal yield to real
   growth and overstated strain... The stage shift reflects definition
   precision, not improving fundamentals."* — the note surfaced exactly
   as designed, in the LLM's own words, not silently dropped.
6. Called `detect-macro-events` live: found 3 genuinely new real-world
   events (a Fitch sovereign-outlook warning, Fed hike signaling, debt-
   ceiling timeline reporting) — all three with `suggested_stage: null`.
   Confirms the methodology-note safeguard worked: the scanner did not
   mistake the stage's own MP1 (strained)→MP1 recalculation for a
   reportable market event.
7. `DebtCyclePositionCheck.jsx` was not driven through a browser (no UI
   test harness in this pass), but the exact data it reads was verified
   directly: the latest `big_cycle_stage_audit_log` row has `conditions.
   rGreaterG: false` and `raw_inputs.effectiveRateGrowthSpread: -2.491`,
   matching the component's `CONDITION_ROWS` keys and the new
   `effectiveRateGrowthSpread` row's `metFn` exactly; `big_cycle_stage_
   notes` has the inserted note as its only/latest row, matching the
   component's `loadStageNote()` query (`order by created_at desc limit
   1`). The component logic was fully read during implementation and
   matches this data shape with no transformation gaps.
8. Backfill: spot-checked 3 of the 124 `macro_snapshots` rows
   (2026-06-25, 2026-09-01, 2026-11-13) against **freshly re-pulled**
   FRED `DGS10`/`GDP` values (not reusing the earlier `/tmp` files) —
   all three reproduce the stored value exactly by hand. The 2026-11-16
   row shows `-0.768` (not the backfill's `-0.7676`) because step 1's
   live `fetch-macro-data` run overwrote today's row on top of the
   backfill — expected (today's date is always the live cron's own
   write), not a backfill defect; both round to -0.77.
9. Full test suite: 678/678 passing, 37/37 files; `npx next build`
   clean.

All mandatory-gate items confirmed live, not just by code read. Nothing
outstanding from Phase 1.
