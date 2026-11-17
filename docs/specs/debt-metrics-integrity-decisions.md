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

## Phase 2 (2026-11-16)

Built and committed per §3 Phase 2. Nothing deployed yet — same two-step
gate as Phase 1. The two interest cards ("Interest Expense % GDP" and
"Interest Expense % of Federal Revenue") can move the debt-cycle stage a
second time (on top of Phase 1's rGreaterG flip), since `debtServiceStrained`
reads straight off the revenue card's `current_value` — see the before/after
table below.

### A near-miss, caught before it shipped: MTS Table 1's duplicate-group trap

Building the shared trailing-12 helper (`_shared/mtsFiscalData.ts`), my
first-pass script summed MTS Table 1 by `classification_desc` alone
(e.g. "November") and got a trailing-12 receipts figure of **$10,680B** —
almost exactly double a plausible number. Root cause: every MTS Table 1
report carries TWO groups under the same report `record_date` — the
current fiscal year's actual months (`sequence_number_cd` starting
`"2."`) AND the *prior* fiscal year's same-named calendar months, shown
for year-over-year comparison (`sequence_number_cd` starting `"1."`).
Both groups can be labeled with the identical `classification_desc`
("November," "February," ...) for a given report, with completely
different dollar values. A naive "match this month's own name" filter
sums both groups.

Fixed by requiring `sequence_number_cd.startsWith("2.")` in addition to
the month-name match — confirmed by hand against the live API (see the
raw November 2025 example: line_code 170/seq "2.2" = $336.0B is the real
November 2025 actual; line_code 30/seq "1.2" = $301.8B turned out to be
November **2024**, the prior-FY comparison row, shown under the same
`classification_desc`). Re-ran with the fix: trailing-12 receipts
**$5,367.776B**, deficit **$2,112.242B** — both within ~$0.1B of Phase
0's original figures (confirming Phase 0's hand-pull, done differently,
happened to avoid this trap). Added a regression test
(`tests/debtMetrics.test.ts`, "MTS Table 1 trailing-12 deficit —
current-vs-prior-FY duplicate-group trap") with a mocked API response
carrying both groups, asserting only the `"2."` group is summed. MTS
Table 9 (net interest) has no such duplication — confirmed by direct
query — so `fetchMtsNetInterestTrailing12` doesn't need the guard.

### 2a: Deficit % GDP

Primary: trailing-12-month MTS deficit ÷ trailing-4-quarter nominal GDP
(sum of each quarter's SAAR ÷ 4). Fallback: `FYFSGDA188S`, now labeled
`FY<year> (annual)` in `note_suffix` so its vintage is visible whenever
the live calc fails and this fires.

```
Deficit trailing-12 (Nov 2025-Oct 2026, MTS table 1):  $2,112.242B
Nominal GDP trailing-4Q (sum of 4 SAAR quarters ÷ 4):   $32,235.466B
Deficit % GDP = 2,112.242 / 32,235.466 * 100         =  6.553%
```

**Gap vs. CBO's 6.2% (FY2026, MBR Nov 9 2026): 0.353pts.** Re-confirmed
the Phase 0 explanation with the now-properly-deduped numbers: the MTS
trailing-12 window (Nov 2025-Oct 2026) is shifted one month forward of
CBO's FY2026 window (Oct 2025-Sep 2026) — it drops Oct 2025 (deficit
$284.35B, pulled fresh from the Oct 2025 report's own current-year-group
row) and picks up Oct 2026 (deficit $404.06B), a swing of +$119.71B ≈
+0.371pts of GDP. That alone slightly over-explains the observed
0.353pt gap — consistent with (not a new finding beyond) Phase 0's own
"timing shift" explanation, just reconfirmed on corrected data. Not a
data error.

### 2b: Interest basis — the critical before/after number

**`debtServiceStrained` (> 20% checkpoint) flips from TRUE to FALSE.**

```
Net interest trailing-12 (MTS table 9, Nov 2025-Oct 2026):  $1,063.959B
Federal receipts trailing-12 (MTS table 1, SAME window):    $5,367.776B
Net interest / receipts = 1,063.959 / 5,367.776 * 100     =  19.821%
                                                    (was 24.593% NIPA)
```

19.821% is under the 20% line — `debtServiceStrained` goes from `true` to
`false`. Also recomputed net interest / GDP for the "Interest Expense %
GDP" card: `1,063.959 / 32,235.466 * 100 = 3.301%` (was 4.026% NIPA) —
a status downgrade from "danger" to "watch" under that card's unchanged
`<2 healthy / <4 watch / else danger` thresholds (NIPA's 4.026 was just
over the danger line; net interest's 3.301 is comfortably inside watch).

Both cards' headline switched to the net-interest/MTS basis; the old
NIPA-basis calc (`A091RC1Q027SBEA`/GDP or /FYFR) moves to
`metadata.nipa_pct_gdp` / `metadata.nipa_pct_revenue`, rendered as a
second line on the card (`app/macro/page.jsx` `IndicatorCard`) labeled
"NIPA basis ... incl. imputed pension interest," not hidden. Dalio's 20%
checkpoint in `classifyDebtCycleStageV2` needed **no classifier code
change** — `debtServiceStrained` reads `rawInputs.interestExpenseRevenuePct`,
itself sourced from `macro_indicators` "Interest Expense % of Federal
Revenue" `current_value` via `computeMacroCrossRefUpdates`'s existing
name-based lookup, so swapping that card's underlying calculation
basis is sufficient — confirmed by re-reading `updateDebtCycleStage()`'s
wiring, not assumed.

**Period-alignment assertion** (`assertPeriodAligned` in
`_shared/mtsFiscalData.ts`): both `interest_net_revenue_pct`'s current and
previous windows are checked to share the same `[windowStart, windowEnd]`
before the ratio is computed; throws `period mismatch: ...` otherwise.
Tested two ways: (1) `tests/debtMetrics.test.ts` calls it directly with
intentionally misaligned windows and confirms the throw (and the pass
case with aligned windows); (2) the `interest_net_revenue_pct` case in
`fetch-macro-data/index.ts` catches that specific error locally (string-
matched on `"period mismatch"`, so a genuine network/fetch failure isn't
mislabeled) and returns a row with `metadata.period_mismatch = true`
instead of silently skipping the refresh — `app/macro/page.jsx`'s
`IndicatorCard` renders "Period mismatch — numerator/denominator cover
different windows" in place of the number whenever that flag is set, per
the spec's literal "the card shows 'period mismatch'" requirement (a bare
skip-and-log would only have been visible in the function's own JSON
response, not on the dashboard).

### 2c: Federal Debt / Tax Revenue — vintage assertion + drawer

Kept `GFDEBTN / FYFR`. Added an assertion: FYFR's fiscal year (from its
own `observation_date`, which FRED dates at the FY's own Sep 30 close)
must equal or immediately precede GFDEBTN's quarter's fiscal year
(federal FY starts Oct 1). Currently: GFDEBTN latest = **2026-04-01** (Q2
2026, FY2026 — FRED's quarterly federal-debt series is 1-2 quarters
stale relative to today by its own normal publication cadence, a
structural lag, not a new finding); FYFR latest = **2026-09-30** (FY2026).
Same FY — assertion passes. (If GFDEBTN ever advances to a Q4 2026 or
later reading before FYFR catches up, the FYs would differ by one and
the assertion would still pass per the spec's "matches or immediately
precedes" wording; it would only throw on a 2+ FY gap, which would mean
one of the two series has gone genuinely stale.)

Drawer addition: debt held by the public ÷ trailing-12 receipts (MTS) —
the measure that pairs with Phase 1b's r_eff, as the spec asks:

```
Debt held by the public (2026-11-13, debt_to_penny): $32,825.322B
Receipts trailing-12 (MTS table 1):                   $5,367.776B
Ratio = 32,825.322 / 5,367.776                      =  6.115x
```

(For contrast, the existing gross-debt-based headline, GFDEBTN/FYFR, is
**7.303x** — the two numbers measure different things on purpose: gross
debt includes ~$7.8T of intragovernmental holdings the held-by-public
figure excludes.)

### 2d: Debt Added — trailing-12 headline

Headline switched from trailing-30-day to trailing-12-month change; the
30-day figure moved into `note_suffix` as a secondary line tagged
"seasonal." Both now pulled via `fetchDebtAddedTrailing(days)`
(`_shared/mtsFiscalData.ts`), which filters `debt_to_penny` by
`record_date` (`lte`/`gte` the target cutoff), not a fixed row count —
so a run of market holidays can never silently shrink the window the way
the old `page[size]=22` approach could.

**Pending at deploy** (not yet written — live-visible, held for the
gate): `big_cycle_metrics` row `debt_added_period`'s static `label`
column currently reads "Debt Added (Trailing 30 Days)" — needs updating
to "Debt Added (Trailing 12 Months)" to match the new headline. This is
a one-time `UPDATE ... SET label = ...` alongside the refresh_method
change below, not a code change (the update loop only ever touches
`value_numeric`/`value_display`/`status`/`note`/`last_updated`, never
`label`).

### 2e: Debt Burden determinant

Built live from three figures (per spec): total nonfinancial debt/GDP
(existing `debt_to_gdp` cross-ref, all sectors), federal debt **held by
the public** /GDP (new — was gross federal debt/GDP, a materially
different and larger number), and the 2a deficit %GDP figure.

```
Total nonfinancial debt/GDP (unchanged, all-sector):        256.5%
Federal debt HELD BY THE PUBLIC / trailing-4Q nominal GDP:
  32,825.322 / 32,235.466 * 100                         =   101.83%
  (old reading_text used GROSS federal debt/GDP: 40,616.678 /
   32,235.466 * 100 = 126.0%, close to the old hardcoded "124.6%" —
   the public/gross distinction is the real, intentional change here)
Deficit % GDP (2a, same run):                                6.553%
```

New `reading_text` (built live in `update-big-cycle-metrics/index.ts`,
not hardcoded): `"256.5% total nonfinancial debt/GDP (101.8% federal
debt held by the public/GDP); 6.6% deficit/GDP"` — replacing the old
manually-typed `"254.5% total nonfinancial debt/GDP (124.6% federal
debt/GDP); 5.8% deficit/GDP"`. Every number in the new string is now
traceable to a live card.

**Pending at deploy** (not yet written — live-visible, held for the
gate): `big_cycle_determinants` row "Debt Burden"'s `refresh_method`
column, currently `'manual'`, needs `UPDATE ... SET refresh_method =
'api_macro_xref'` — a labeling/metadata correctness fix per spec 2e, not
a gate on the write itself (the new code writes `reading_text`
unconditionally once deployed, regardless of this column's value).

### Mandatory before-deploy report (rollout-order rule, §4)

Nothing below has been deployed. All Phase 2 work is committed to code
only; the two pending DB writes above (the `label` rename and the
`refresh_method` change) are also held.

| | Before (live today) | After (once deployed) |
|---|---|---|
| `debtServiceStrained` | **true** (24.593% NIPA, > 20%) | **false** (19.821% net-interest/receipts, < 20%) |
| `rGreaterG` | false (already flipped in Phase 1) | false (unchanged) |
| `fedPrintingRising` / `mp2Gate` / `mp3AuctionDemandWeak` / `mp3SomaAbsorbing` | all false | unchanged |
| `strainedCount` | 1 | **0** |
| **Stage** | `MP1` | `MP1` (no additional flip — Phase 1 already moved it off "MP1 (strained)"; dropping strainedCount from 1 to 0 doesn't cross a threshold a second time) |
| "Interest Expense % of Federal Revenue" card | 24.6% NIPA (danger) | 19.8% net interest (watch) |
| "Interest Expense % GDP" card | 4.0% NIPA (danger) | 3.3% net interest (watch) |
| "Deficit % GDP" (`deficit_pct_gdp`) | 5.8% (FYFSGDA188S annual) | 6.6% (MTS trailing-12/GDP4Q, primary) |
| "Federal Debt / Tax Revenue" card | 7.30x, no vintage label | 7.30x (unchanged headline) + vintage label + 6.12x held-by-public drawer figure |
| "Debt Added" card | $+265B trailing-30-day headline | trailing-12-month headline (new figure, 30-day moves to note as secondary/seasonal) |
| "Debt Burden" determinant | manual, "124.6% federal debt/GDP" (gross) | live, "101.8% federal debt held by the public/GDP" |

Debt Sustainability gauge and all four trip-wires: **unaffected** —
confirmed by code read (same reasoning as Phase 1: gauge is a separate
annual z-score composite; trip-wires don't reference
`interestExpenseRevenuePct`/`rateGrowthSpread`).

Test suite: 684/684 passing (38 files, +6 new in `debtMetrics.test.ts`);
`npx next build` clean.

### Deployed (2026-11-16) — live verification

Scott approved. Deployed `fetch-macro-data` and `update-big-cycle-metrics`
via `supabase functions deploy` (CLI), preserving `verify_jwt` exactly
(confirmed before and after: `fetch-macro-data=true`,
`update-big-cycle-metrics=false`).

**A real schema blocker caught live, not shipped silently**: the "Debt
Burden" `refresh_method` UPDATE (`manual` → `api_macro_xref`) hit
`big_cycle_determinants_refresh_method_check`, which only allowed
`api_fred`/`api_imf`/`api_cofer`/`manual` — `api_macro_xref` was never a
legal value on this table, even though its sibling `big_cycle_metrics`
table already uses it extensively. The whole two-statement batch
(including the unrelated "Debt Added" label rename) rolled back together
on the first error — confirmed via a follow-up `SELECT` that the label
hadn't changed either. Fixed with a small additive migration
(`20261116_allow_api_macro_xref_on_big_cycle_determinants.sql`) widening
the constraint to match `big_cycle_metrics`'s convention, then re-ran
both UPDATEs successfully.

**Live verification, in order:**

1. Ran `fetch-macro-data`: `{"updated":73,"skipped":3,...}` — same 3
   pre-existing stale indicators as Phase 1 (unrelated). Confirmed live:
   "Interest Expense % of Federal Revenue" = **19.821%** (watch, was
   24.6%/danger), metadata `nipa_pct_revenue: 24.6`; "Interest Expense %
   GDP" = **3.301%** (watch, was 4.0%/danger), metadata `nipa_pct_gdp: 4`;
   "Federal Debt / Tax Revenue" = 7.303x (unchanged headline) with
   `metadata.debt_quarter: "2026-04-01"`, `fyfr_fiscal_year_end:
   "2026-09-30"` (same FY — vintage assertion passed), and
   `debt_held_public_vs_trailing12_receipts: 6.115` — all exact matches
   to the hand-calc above. No `errors` key in the response — the
   period-mismatch assertion did not fire on the real data path.
2. Ran `update-big-cycle-metrics`: `debtCycleStage.conditions.
   debtServiceStrained: false` (confirmed flipped), every other
   condition unchanged (`rGreaterG/fedPrintingRising/mp2Gate/
   mp3AuctionDemandWeak/mp3SomaAbsorbing` all `false`) → strainedCount
   0 by inspection. `stage: "MP1"` — unchanged, exactly as predicted.
   `debtBurdenText` in the response: `"256.5% total nonfinancial
   debt/GDP (101.8% federal debt held by the public/GDP); 6.6%
   deficit/GDP"` — exact match to the predicted text. Trip-wires
   unchanged (`fiscal_dominance_confirmed` still armed since
   2026-02-20, a pre-existing unrelated state).
3. `big_cycle_stage_audit_log` latest row confirms the same
   `debtServiceStrained: false` and `interestExpenseRevenuePct: 19.821`
   persisted, not just present in the one-off response.
4. `big_cycle_metrics`: `deficit_pct_gdp` = **6.5525...%** (displayed
   6.6%), note includes the full MTS-window/GDP-window breakdown and the
   CBO-gap explanation — matches the hand-calc exactly.
   `debt_added_period`: label now **"Debt Added (Trailing 12 Months)"**,
   value **$+2,466B** (2025-11-13 → 2026-11-13), note includes the 30-day
   secondary figure (**$+287B**, 2026-10-14 → 2026-11-13) with the
   "seasonal, Oct/Apr swings..." text — exactly per spec.
5. `big_cycle_determinants` "Debt Burden": `reading_text` and
   `refresh_method` ('api_macro_xref') both confirmed live after the
   constraint fix and retry.
6. Period-mismatch assertion: confirmed it did NOT fire on the real
   "Interest Expense % of Federal Revenue" run (metadata carries
   `basis`/`nipa_note`/window fields, no `period_mismatch` key) — the
   intentional-misalignment throw path is already covered by
   `tests/debtMetrics.test.ts`'s dedicated test, run again here only to
   confirm normal operation stays clean, not re-tested against
   intentionally bad dates in production.

All mandatory-gate items and all five of the coordinator's specific
verification asks confirmed live. Nothing outstanding from Phase 2.

## Phase 3 (2026-11-17)

Built and committed per §3 Phase 3. Doesn't touch the classifier or any
trip-wire, but does rename a live indicator (rule 2.1) — same two-step
gate as before; nothing deployed yet.

### 3a: Gold cards

**Rename, repo-wide grep (clean):** "CB Gold Reserves (YoY)" → "Gold
Price (YoY)" in `fetch-macro-data`'s `INDICATORS` array; a migration
(`20261117_rename_cb_gold_reserves_to_gold_price_yoy.sql`, not yet
applied) renames the existing rows in both `macro_indicators` (1 row)
and `macro_snapshots` (115 historical rows). Confirmed before writing
the migration: zero existing rows under the new name in either table
(no collision). Grepped the whole repo for "CB Gold Reserves" after
updating `fetch-macro-data/index.ts` and `app/macro/page.jsx`: **three
hits remain, all expected** — the governing spec document itself
(historical description), the migration file's own `WHERE` clause
(necessarily references the old name as its target), and one
explanatory code comment noting the rename's history. Zero functional
code references anywhere else. Also grepped for the retired type string
`cb_gold_imf` — only the spec doc references it now.

**Dead IMF call removed.** The `cb_gold_imf` case (renamed
`gold_price_yoy`) no longer attempts `dataservices.imf.org` at all —
calls `fetchYahooGold` directly, since every prior path always fell
through to that same Yahoo call anyway.

**New "Central Bank Gold Purchases (4Q, tonnes)" card**, type
`wgc_gold_purchases_card`, z-scored against `wgc_gold_purchases`'s full
history using the *exact same* mean/stdev-of-all-years method
`computeGauge5()` already uses for the same table — reused, not
reimplemented, so the card and Gauge 5 can never silently disagree about
what "above-average buying" means. `current_value` is the latest year's
raw tonnage (unit `tons`, matches `formatValue`'s existing case); the
z-score, `is_actual` flag, and year sit in `metadata`, rendered via the
existing generic z-score badge in `IndicatorCard` (no new UI needed
there — only discovered after checking that block already keys off
`metadata.zscore` for any indicator). Re-pointed the `CbGoldDrawer`
(which already showed this exact WGC tonnage chart, previously attached
to the mislabeled price card) to the new card instead — its header now
shows tonnage + z-score rather than a % that belonged to a different
card's measurement.

**Decision — gold trend status thresholds (uncalibrated, per spec rule
6):** `(3M avg / prior 3M avg − 1)`: `> +5% danger`, `0–5% watch`, `≤ 0
healthy`. Implemented via a new `statusOverride` mechanism (see below) —
`current`/`previous` already *are* the two 3-month averages the case
needed (no new fetch), so the trend calc was one line.

**Decision — CB gold purchases z-score thresholds (uncalibrated, per
spec rule 6):** one-sided — `z > 2 danger`, `z > 1 watch`, else
`healthy`. One-sided because only a buying *surge* is the signal this
card exists to catch; below-average buying isn't itself concerning
under the de-dollarization framing Gauge 5 already uses.

### A new mechanism: `statusOverride`

Phase 3a/3c both need a status computed from something other than the
single `current` value `ind.statusFn(current)` receives (a trend
needing `previous`, a change needing a trailing average `previous`
doesn't carry). Rather than widen `StatusFn`'s signature (would touch
every indicator), added one optional `let statusOverride: Status |
undefined` local in `processIndicator`, settable per-case, checked
first in the final return (`statusOverride ?? ind.statusFn(current)`).
Each affected indicator keeps a real (if now largely unreachable)
`statusFn` as a defensive fallback — never silently crashes if a
future edit removes the override logic from its case.

### 3b: Real Fed Funds — stance family

**Confirmed, not assumed:** already uses `FEDFUNDS` (the *effective*,
not target, fed funds rate) date-matched against CPI YoY via the shared
`yoyPair`/`findYearAgo` helpers (calendar year/month match, not array
position) — extracted to `_shared/yoyMath.ts` in Phase 2 specifically so
this kind of claim can be verified by reading code, not taken on faith.
No change needed to the underlying calculation.

**Status-rendering architecture, checked before deciding (per the
coordinator's explicit ask):** `app/macro/page.jsx`'s `StatusBadge`
looks up `STATUS_STYLE[status] ?? STATUS_STYLE.unknown` and renders
`status.toUpperCase()` as the badge text — so *any* status string the
backend emits displays correctly with neutral/grey styling by falling
through to the existing "unknown" branch, with zero frontend code
changes required. The real blocker was **not** the frontend — it was
`macro_indicators_status_check`, a Postgres CHECK constraint
restricting `status` to exactly `healthy`/`watch`/`danger`/`unknown`.
**Found a second, identical constraint on `macro_snapshots`** before
deploying (not discovered live): had I only widened the
`macro_indicators` one, the very next `fetch-macro-data` run's snapshot
upsert — a single multi-row statement covering *every* indicator, not
just this one — would have aborted entirely the moment it tried to
write Real Fed Funds Rate's new stance value, silently breaking that
day's `macro_snapshots` history for all ~70 other indicators too. Both
constraints widened in one migration
(`20261117_allow_stance_status_on_macro_indicators.sql`, not yet
applied) to add `accommodative`/`neutral`/`restrictive` alongside the
existing four. No `big_cycle_metrics` constraint touch needed — "Real
Fed Funds Rate" was never cross-referenced into Big Cycle (confirmed:
it's absent from `computeMacroCrossRefUpdates`'s name list), so the
stance strings never reach `MACRO_STATUS_MAP` (which would otherwise
silently map them to `null`).

**Decision — stance thresholds (uncalibrated, per spec rule 6):** `< 0
accommodative`, `0 to +1.5 neutral`, `> +1.5 restrictive`. Description
updated to the spec's exact wording.

### 3c: Convenience yield — change-based status

Fetched up to 1100 rows (was 400, ~12mo) so a genuine 3-year trailing
average is possible, not just the existing single-point `change_12m_bp`.
Computed `avg_1y_bp`/`avg_3y_bp` (simple mean over the respective trailing
window) and set `statusOverride` from `current − avg_1y_bp`: `< −15bp
danger`, `−15 to −5bp watch`, else `healthy` (per spec, logged here as
confirmation of the exact values, not a new judgment call — the spec
gave these thresholds directly). Both averages surfaced in the drawer
(a new `IndicatorCard` metadata line, same pattern as Phase 1/2's drawer
additions) and the underlying card description rewritten so it
describes the trend-based calculation instead of the retired
level-based "subsidy intact/inverted" framing.

**Big Cycle labels retired/replaced:** `update-big-cycle-metrics`'s
`convenience_yield_10y` cross-ref `status_label` changed from
`"Subsidy inverted"/"Watch"/"Privilege intact"` to `"Treasuries cheap to
swaps (deteriorating)"/"Stable"/"Improving"` — confirmed via repo-wide
grep that "Subsidy inverted" and "Privilege intact" appear nowhere else
in the codebase (so nothing else needed updating to stay consistent).

**Gauge 7 — confirmed unchanged, not assumed:** read
`supabase/functions/compute-gauge7/index.ts` directly. It queries
`convenience_yield_observations` (the raw table) itself — it does
**not** read `macro_indicators`' `current_value` or `status` for this
card at all, and never has. Two independent reasons the composite
cannot have changed: (1) this phase's edits only changed `status`
derivation and added `metadata` fields — the underlying `current`/
`previous` values written to `macro_indicators` (`convenience_bp`
itself) are byte-for-byte the same calculation as before; (2) even if
they had changed, Gauge 7 wouldn't see it, since it never reads that
table for this input. `components/DalioGauges.jsx`'s Gauge 7 drawer
likewise reads `components.z.z_conv_yield` from the gauge's own
computed output, not from `macro_indicators`. Will still re-run
`compute-gauge7` before/after the actual deploy and diff the output, per
"confirm, don't assume" — expecting bit-identical, will report
immediately if not.

### Mandatory before-deploy report

Nothing deployed. Two migrations staged (gold rename data migration +
stance-status constraint widening on both tables) alongside the function
code; `app/macro/page.jsx` drawer bindings updated for the rename.

| | Before | After (once deployed) |
|---|---|---|
| "CB Gold Reserves (YoY)" | mislabeled gold-price card | renamed "Gold Price (YoY)", same calc |
| "Central Bank Gold Purchases (4Q, tonnes)" | doesn't exist | new card, z-scored vs. own history |
| "Gold Price (3M Avg)" status | level-based (`<2000/<3000/else`) | trend-based (3M-avg-vs-prior-3M-avg %) |
| "Real Fed Funds Rate" status | healthy/watch/danger | accommodative/neutral/restrictive (stance) |
| "Treasury Convenience Yield (10Y)" status | level-based (`>10/≥-25/else`) | change-based (level − trailing-1y avg) |
| Big Cycle convenience-yield labels | "Subsidy inverted"/"Watch"/"Privilege intact" | "Treasuries cheap to swaps (deteriorating)"/"Stable"/"Improving" |
| Gauge 7 composite | — | unchanged (confirmed by code read; live diff pending deploy) |

Test suite: 684/684 passing (unchanged — no new indicator-specific
Vitest coverage this phase, since these three cases are live-data-only
edge-function logic with no pure-function extraction candidate the way
the MTS trailing-12 math was in Phase 2); `npx next build` clean.

### Deployed (2026-11-17) — live verification

Scott approved. Deployed `fetch-macro-data` and `update-big-cycle-metrics`
via `supabase functions deploy` (CLI), `verify_jwt` confirmed unchanged
before and after (`fetch-macro-data=true`, `update-big-cycle-metrics=false`).

**A second migration blocker, found live:** the gold-rename migration's
plain two-statement `UPDATE` approach failed —
`macro_snapshots.indicator_name` carries a **non-deferrable** foreign key
to `macro_indicators.name` (`ON DELETE CASCADE`, no `ON UPDATE CASCADE`;
a natural-key FK, unusual but real). Renaming either table first breaks
the FK against the other. Tried making the constraint deferrable
mid-transaction (`ALTER TABLE ... ALTER CONSTRAINT ... DEFERRABLE`) —
that itself failed live (`cannot ALTER TABLE because it has pending
trigger events`). Worked around by inserting a new `macro_indicators` row
under the new name (copying every other column), repointing all 115
`macro_snapshots` rows at it, then deleting the old row — confirmed first
via `pg_constraint` that `macro_indicators.id` isn't referenced by any
other table, so a new `id` for this row is safe. Updated the committed
migration file to match what actually worked (the original file's
`ALTER CONSTRAINT` plan is not what's live).

**Live verification, in order:**

1. **Gold cards**: ran `fetch-macro-data` — "Gold Price (YoY)" live under
   the new name, real data (−5.4%, healthy). New "Central Bank Gold
   Purchases (4Q, tonnes)" card live: 691t (2026, flagged `is_actual:
   false`), z-score +0.79 vs. full history, status healthy (z ≤ 1).
2. **Gold Price (3M Avg) — the actual bug fix confirmed**: live at 3M
   avg **$4,231.74** vs. prior-3M avg **$4,560.71** (spot $3,873.90 in the
   subtitle) — the level alone (`$4,231`) would have read **DANGER**
   under the old `<2000/<3000/else` thresholds despite gold actively
   *falling* (3M avg down ~7.2% from the prior 3M avg). Under the new
   trend-based thresholds this correctly reads **healthy** (trend ≤ 0%).
   This is the precise failure mode the spec's acceptance criterion
   ("gold no longer reads DANGER while falling") names — confirmed live,
   not just by code read.
3. **Treasury Convenience Yield (10Y)**: live metadata carries
   `avg_1y_bp: -47.84`, `avg_3y_bp: -50.3`; current `-45.48` → delta vs.
   1y avg = `+2.36bp`, correctly "healthy" per the `<-15/-15 to -5/else`
   thresholds. Big Cycle cross-ref (`convenience_yield_10y`) confirmed
   live with the new label: `status_label: "Improving"` (was "Subsidy
   inverted"/"Privilege intact") — the old labels no longer appear
   anywhere (re-grepped after deploy).
4. **Gauge 7 — re-run and diffed, not assumed:** pre-deploy
   `dalio_gauge_readings.gauge7 = 0.3154`. Called `compute-gauge7`
   directly post-deploy: returned `0.3154` — **bit-identical**, and the
   re-write to `dalio_gauge_readings` confirms the same. Matches the
   Phase 3 prediction exactly (compute-gauge7 never reads
   `macro_indicators` for this input).
5. **Classifier/stage unaffected**: ran `update-big-cycle-metrics` —
   `debtCycleStage` identical to the post-Phase-2 state (`MP1`,
   `debtServiceStrained: false`, all `rawInputs` unchanged) — confirms
   Phase 3 touched no classifier input, as designed.
6. **Stance-write success, confirmed directly, not inferred from the
   migration applying cleanly:** inserted a real test row into
   `macro_snapshots` with `status = 'accommodative'` — succeeded (the
   exact failure mode the constraint-widening was meant to prevent).
   Deleted it immediately after (a 1999-01-01 placeholder date, chosen
   so it could never be mistaken for real data; confirmed deleted).

**Real Fed Funds Rate stance — code confirmed correct, but blocked live
by an unrelated, pre-existing bug surfaced during this check (not caused
by Phase 3, not fixed here):** this card has been silently stuck since
**2026-10-29** (`last_fetched_at` unchanged across two `fetch-macro-data`
runs tonight, both otherwise clean). Root cause, confirmed by pulling
FRED's own public `fredgraph.csv` directly (no API key): **`CPIAUCSL` has
a genuine gap at `2025-10-01`** (blank value, confirmed present even via
FRED's unauthenticated endpoint — not a fetch/auth issue on our side).
`findYearAgo`/`yoyPair` (the Phase-2-extracted, Phase-2-unit-tested
date-matching helpers) correctly *refuse* to pair Oct 2026 CPI against a
missing Oct 2025 row rather than silently mismatch — exactly the
behavior the Phase 2 gap test was written to enforce — but `yoyPair`'s
current contract is all-or-nothing (if the newer of the two obs can't be
paired, it returns `null` for both), so the whole card goes stale rather
than at least advancing on the older, still-pairable observation. This
will keep blocking until either FRED backfills the Oct 2025 gap or
November 2026 CPI publishes (pairs against Nov 2025, which exists).
**Hand-verified the stance logic is correct independent of this block:**
the frozen value `0.033` in the DB is itself FEDFUNDS(Sept 2026, 3.75) −
CPI-YoY(Sept 2026 vs Sept 2025, confirmed 3.717% from real FRED data) =
`0.033` — reproducing exactly what's stored, confirming the last
successful run's arithmetic. Under the new stance thresholds (`<0
accommodative / 0–1.5 neutral / >1.5 restrictive`), `0.033` maps to
**neutral** — correct. The card's live `status` column still reads
`"healthy"` only because the row has never successfully re-run under the
new code (not because the new code produced `"healthy"`); it will read
`"neutral"` automatically the next time this card successfully refreshes,
with no further code change needed. Flagging this pre-existing bug for
separate follow-up — not fixing it here, since it's outside Phase 3's
scope and a fix to `yoyPair`'s all-or-nothing contract would affect every
other indicator that depends on it (~15+ cards), which deserves its own
review, not a rushed fix during a deploy-verification pass.

### Mandatory-gate and coordinator-specific items: status

| Item | Status |
|---|---|
| Gold Price (YoY) renders live, new name, real data | ✅ confirmed |
| Central Bank Gold Purchases (4Q, tonnes) live, z-scored | ✅ confirmed |
| Gold Price (3M Avg) trend-based, not stuck on DANGER while falling | ✅ confirmed — the actual bug, live |
| Real Fed Funds stance label live in API/UI | ⚠️ code confirmed correct by hand-calc; card itself blocked live by a newly-surfaced, pre-existing, unrelated FRED CPI gap (not a Phase 3 defect) |
| Convenience yield change-based status; Big Cycle new labels | ✅ confirmed |
| Gauge 7 unchanged, diffed not assumed | ✅ confirmed bit-identical (0.3154 → 0.3154) |
| New stance status writes succeed in `macro_snapshots` | ✅ confirmed via a real insert/delete, not just migration success |

Everything in Phase 3's own scope is deployed and verified. One item
(Real Fed Funds' live display) surfaced a genuine, separate, pre-existing
data-gap bug rather than confirming cleanly — reported rather than
papered over, per the standing "stop and report, don't guess" rule.

## Phase 4 (2026-11-17) — last phase of the spec

Built and committed per §3 Phase 4. 4b rebuilds the fiscal-dominance
trip-wire (changes its armed/unarmed state); 4a/4c/4d don't touch
stage/trip-wire logic. Nothing deployed yet — same two-step gate.

### 4a: one indirect-bidder calculation

Confirmed the card's existing method before consolidating anything (per
spec: "that is the card's method; document why"): per-term trailing-6
averages (10Y and 30Y computed separately), then an equal-weighted mean
of the two. Chose this over the pooled/interleaved method
`classifyDebtCycleStageV2`'s input and the trip-wire used instead,
because pooling a 30Y auction in with a 10Y auction into one "trailing 6"
isn't well-defined when the two terms auction on different, uneven
schedules — confirmed live: 30Y auctions roughly quarterly, 10Y roughly
every 6-10 weeks, so a naive pooled-and-sorted top-6 skews toward
whichever term happened to auction more recently.

New `_shared/indirectBidder.ts`: `computeIndirectBidderSnapshot(rows,
offset)` is the one function now called by the card
(`fetch-macro-data`), `classifyDebtCycleStageV2`'s input (via
`updateDebtCycleStage` in `update-big-cycle-metrics`), and
`evalAuctionDemandDeterioration` (moved into this same file — it's now
built directly on the consolidated snapshot: armed only if the last `n`
CONSOLIDATED readings, not raw pooled auctions, are all below 65%).
`classifyDebtCycleStageV2`'s `ClassifierInput` changed from
`indirectBidderShareSeries: WeeklyPoint[]` (which it averaged itself via
`trailingAverage`) to a precomputed `indirectBidderShareAvg6: number |
null` — the caller now does the one consolidated calculation and hands
the classifier a single number, so there's no second averaging method
left anywhere to drift from the first.

**Confirmed with real numbers, not just "code now calls one function"**
(pulled live `treasury_auction_results` rows, same data all three
consumers read):

```
10Y trailing-6 (desc): 60.98, 58.29, 51.52, 50.1, 66.99, 57.77 -> avg10 = 57.608
30Y trailing-6 (desc): 53.15, 53.69, 77.99, 54.41, 61.29, 44.37 -> avg30 = 57.483
Consolidated = (57.608 + 57.483) / 2 = 57.546 -> rounds to 57.55

OLD pooled method (what the classifier/trip-wire used before):
top 6 by date across both terms: 53.15, 60.98, 58.29, 53.69, 51.52, 77.99
-> pooled avg = 59.27 (confirmed: matches the live rawInputs.
   indirectBidderShareAvg6 value seen in every Phase 1-3 verification
   this session)
```

**Card = 57.55% (unchanged, same method as always). Classifier input and
trip-wire's "latest" value both become 57.55% once deployed (were
59.27%) — all three now read the identical number**, confirmed by
`tests/indirectBidder.test.ts`'s own assertion against this exact data.

**The 57.5 boundary, pinned (per spec: "is 57.5 'weak' or not? Log the
decision"):** 57.55 > 57.5 — **not weak**, by 0.05pts. `strainedCount`'s
`mp3AuctionDemandWeak` OR-condition is unaffected either way
(59.27 >= 57.5 was already false; 57.55 >= 57.5 is also false) — no
stage-level change from this fix alone. The boundary itself (57.5) is
unchanged; the spec asked to determine which side of it the *corrected*
number falls on, not to recalibrate it. Logged here as the explicit
decision, with three dedicated boundary tests
(`debtCycleClassifier.test.ts`'s new "the 57.5 boundary" describe block:
57.55 not weak, 57.45 weak, exactly 57.5 not weak under the existing
strict less-than).

### 4b: fiscal-dominance trip-wire — the stakes item

**Rename** (rule 2.1): `fiscal_dominance_confirmed` →
`stock_bond_corr_positive` ("Positive stock-bond correlation regime"),
logic unchanged (`evalFiscalDominanceConfirmed` renamed to
`evalStockBondCorrPositive` in `_shared/debtCycleTripWires.ts`, same
90-day-positive-correlation test). Grepped the whole repo for the old key
before considering this done: two more live consumers found beyond
`update-big-cycle-metrics` itself — `generate-debt-cycle-brief/index.ts`
and `components/DebtCyclePositionCheck.jsx` (both carry their own
`TRIP_WIRE_LABELS`-style map) — both updated with the new key alongside
the existing one. `DebtCyclePositionCheck.jsx`'s plain-language
`TRIP_WIRE_DEFINITIONS` entry for the old behavior moved under the new
key too, with a one-line pointer explaining the rename so a reader
doesn't wonder where the old description went.

**New `fiscal_dominance_confirmed`** (same file): arms only when
conditions 1 (net interest/receipts > 20%, Phase 2b basis), 2 (real fed
funds <= 0), and 4 (CPI YoY > 3%) have ALL held *simultaneously* for >=
60 consecutive calendar days (date-joined daily `macro_snapshots`
history — a day missing even one of the three series breaks the streak
rather than being silently skipped), AND condition 3 (Fed easing, OR Fed
BS %GDP sustained-rising, OR SOMA sustained-positive) holds *today*.

**Judgment call, logged per rule 6:** condition 3 is evaluated as a
current snapshot, not re-derived at each of the trailing 60 days —
`isSustainedRising`/`isSustainedPositive` are themselves already
multi-week-window trend tests, and no other trip-wire in this codebase
re-runs a trend test at every historical day either (TW1's WALCL check is
also a current-state read, not a persistence check over its own trend
test). Re-deriving it per-day would need a much larger infrastructure
investment (recomputing an 8-print rolling window at 60+ different
historical anchor points) for a condition that's inherently about "is
the posture currently X," not "has the posture test itself held for 60
days" — the spec's "for >= 60 days" reads most naturally as describing
conditions 1/2/4 (simple per-day thresholds on already-daily series),
with condition 3 as the gate.

**A real, structural limitation, found and logged rather than smoothed
over:** condition 1 — net interest/receipts, Phase 2b's basis — only
carries valid history in `macro_snapshots` from **2026-11-17 onward**
(today, the day Phase 2 deployed). Rows before that date are the old
NIPA-basis definition (rule 2.2: never mix definitions in one series), so
the merged daily series has at most 1 day of valid condition-1 history
right now. The new trip-wire's 60-day persistence requirement on
condition 1 **cannot be satisfied until ~2027-01-16 at the earliest**,
regardless of actual fiscal conditions, purely as a consequence of when
Phase 2b's basis-corrected history started accumulating. This doesn't
change today's armed/unarmed outcome (condition 3 already fails
independently — see below) but is worth knowing: if someone checks this
trip-wire in, say, three weeks and finds it still unarmed, the reason
could be this data-floor, not necessarily "fiscal conditions are fine."

**Confirmed live, with real inputs, not assumed from the spec's own
prediction:**

```
Fed easing? DFEDTARU latest (2026-11-17) = 4.00%; ~90 days ago
  (2026-08-19) = 3.75%. 4.00 is NOT less than 3.75 -> Fed is NOT easing
  (confirmed: the Fed hiked 3.75->4.00 on 2026-09-17, mid-window).
fedPrintingRising (WALCL sustained-rising)? false (confirmed live,
  unchanged since Phase 1-3 verification).
mp3SomaAbsorbing (SOMA sustained-positive)? false (same).
condition3Now = false || false || false = FALSE.
```

`fiscal_dominance_confirmed` (new): **NOT ARMED** — both because
condition 3 is false today AND because condition 1's streak can't reach
60 days yet. Two independent reasons, same conclusion — matches the
spec's own "Expected now: not armed (the Fed is hiking)," confirmed here
against real pulled data rather than taken on faith.

`stock_bond_corr_positive` (renamed, logic unchanged): **ARMED since
2026-02-20** — identical to what the old `fiscal_dominance_confirmed` key
showed throughout Phases 1-3's verification; only the key changed.

**Paradigm A cross-check:** latest `big_cycle_paradigm_scores` row for
paradigm `A` (2026-11-17): composite **0.4152**, label **"Not
Confirmed."** Since the new trip-wire is unarmed, there's no disagreement
to flag today (both readings point the same direction) — but the
cross-check code path is live and tested: it writes
`values.paradigmAComposite` and `values.paradigmADisagreement: 1` plus a
`console.error` the moment armed=true while composite<0.5, a reporting
signal, not a gate (the trip-wire can still arm even if A disagrees).

**One-time transition note:** the notification-dedup logic in
`update-big-cycle-metrics`'s `Deno.serve` handler compares today's
`tripWires` against yesterday's `priorTripWires` by key. On the FIRST run
after this deploys, `priorTripWires["fiscal_dominance_confirmed"]` will
still be the OLD (stock-bond-corr) trip-wire's prior-day state, compared
against TODAY's NEW (real fiscal-dominance) trip-wire under the same
key — a harmless one-day artifact that self-corrects the following day
once both sides of the comparison use the new definition. Not worth
special-casing for a single day.

Test coverage (`tests/debtCycleTripWires.test.ts`, rewritten): the
renamed trip-wire's 4 existing test cases pass unchanged under the new
name/function; the new trip-wire has 6 cases covering armed (synthetic —
live data is unarmed right now, as expected), condition-3-false,
streak-one-day-short, a mid-window break in condition 2, a mid-window
missing-data day breaking the streak, and the live "condition 1's
history is only 1 day old" reality check.

### 4c: Paradigm "stale" display bug

**Re-confirmed the Phase 0 baseline still holds, days later, not
assumed:** `max(recorded_at)` in `big_cycle_paradigm_scores` =
2026-11-17; all 13 `big_cycle_paradigm_metric_scores` rows for that date
exist with `available = true`. Not reproducible right now, same as Phase
0 found.

**Fixed the suspected root cause preventively** (per the coordinator's
explicit instruction — not chasing a ghost): `update-big-cycle-
paradigm-metrics/index.ts`'s three chunked/batch upserts
(`big_cycle_paradigm_raw_series`, `big_cycle_paradigm_metric_scores`,
`big_cycle_paradigm_scores`) previously only `console.error`'d on
failure and continued — meaning a `metric_scores` chunk could fail
silently while the composite `paradigm_scores` write proceeded
unconditionally right after, producing exactly the reported symptom (a
`recorded_at` that exists in the composite table with partial-or-zero
matching metric rows). All three now `throw` on error, caught by the
outer handler, which logs `status: "error"` to `rb_job_runs` (the same
generic job-run-status table `update-inflation-regime` and others
already use — confirmed by reading that file's exact pattern before
copying it, not inventing a new convention) and returns a 500 instead of
silently succeeding. A future partial failure is now visible, not silent.

**The two independent improvements** (both implemented regardless of
whether the stale bug is live right now, per the spec): `FiscalParadigm
Section.jsx` now queries the latest date directly
(`order("recorded_at",{ascending:false}).limit(5)` — one row per
paradigm for the single most recent date) instead of loading the *entire*
history table with no `.range()`/`.limit()` at all just to find
`max(recorded_at)` client-side; and the chart's history is now fetched in
its own separate query with an explicit (generous, 50,000-row) limit,
rather than reusing the same unbounded "find latest" fetch for both
purposes.

**Acceptance confirmed:** all 13 metric rows show oriented-z values right
now (re-confirmed above); "stale" in `MetricRow` only ever renders when
`available = false` (unchanged — the display logic itself wasn't the
bug, the write path feeding it was).

### 4d: Gaps determinant

"Gaps in Wealth, Opportunity, Values" had `refresh_method: 'api_fred'`
already (not `'manual'` — so this one wasn't even flagged as hand-typed
by its own metadata) but a hardcoded `reading_text`: "Top 1% holds
31.6%... home price/income 7.1×." **Checked before assuming 7.1× was
just wrong** (per the explicit instruction): grepped the whole repo for
any second, deliberately different affordability measure that might
explain 7.1× — found none. The only live affordability figure anywhere
in this codebase is `home_price_income_ratio` (Redfin-sourced, the same
card the Internal Order section displays), currently ~5.14×. 31.6% is
also stale against the live `top1_wealth_share` card (WFRBST01134,
currently 32.5%). Built `reading_text` live from these two already-
computed cards, same pattern as Phase 2e's "Debt Burden" fix:
`"Top 1% holds 32.5% of household wealth; home price/income 5.14x."`

### Mandatory before-deploy report

Nothing deployed. All of 4a-4d built and committed; the stance-constraint
and gold-rename migrations from Phase 3 are already live (deployed
before this phase started) — no new migrations this phase.

| | Before | After (once deployed) |
|---|---|---|
| Indirect bidder — card | 57.55% | 57.55% (unchanged) |
| Indirect bidder — classifier input (`rawInputs.indirectBidderShareAvg6`) | 59.27% (pooled) | **57.55%** (matches the card) |
| Indirect bidder — trip-wire "latest" | 59.27% (pooled) | **57.55%** (matches the card) |
| `mp3AuctionDemandWeak` | false | false (unchanged — 57.55 and 59.27 are both >= 57.5) |
| `stock_bond_corr_positive` (was `fiscal_dominance_confirmed`) | — | **armed since 2026-02-20** (same state, new key) |
| `fiscal_dominance_confirmed` (new) | doesn't exist | **not armed** (condition 3 false; condition 1's streak also can't reach 60 days yet) |
| Paradigm A cross-check | — | 0.4152, "Not Confirmed" — consistent with the new trip-wire's unarmed state, no disagreement to flag |
| Paradigm stale bug | not reproducible (re-confirmed) | preventive fix shipped; future partial failures now surface via `rb_job_runs` |
| "Gaps in Wealth..." determinant | "31.6%... 7.1×" (stale/unsourced) | `"Top 1% holds 32.5%... home price/income 5.14x."` (live) |

### §5 test checklist — final status

- [x] `debtMetrics.test.ts` — 6/6 passing, unaffected by Phase 4.
- [x] `debtCycleClassifier.test.ts` — 12/12 passing (3 new boundary-pinning
  tests added this phase; `indirectBidderShareSeries` fixtures converted
  to the new precomputed `indirectBidderShareAvg6` field).
- [x] `debtCycleTripWires.test.ts` — 17/17 passing (rewritten: renamed
  trip-wire's existing cases unchanged under the new name; 6 new cases for
  the real fiscal-dominance test; `evalAuctionDemandDeterioration` cases
  rebuilt for its new per-term-consolidated-snapshot signature).
- [x] `indirectBidder.test.ts` (new) — 6/6 passing, built directly against
  the real live auction numbers in this log.
- [x] Gold/fed-funds/convenience-yield status tests — **new this phase**:
  extracted the three Phase 3 threshold decisions (previously inline,
  untestable logic in `fetch-macro-data`, which can't be imported under
  Vitest) into `_shared/statusThresholds.ts`, wired `fetch-macro-data` to
  call them instead of duplicating the thresholds inline, and added
  `statusThresholds.test.ts` — 16/16 passing, including a dedicated
  regression test reproducing the exact "DANGER while falling" bug Phase
  3a fixed, using the real live numbers from that phase's own
  verification.
- [x] Migration check for zero `macro_snapshots` rows under retired names
  — new `scripts/check-rls.sql`-style script,
  `scripts/check-retired-indicator-names.sql`, covers the one true rename
  this spec performed ("CB Gold Reserves (YoY)," already live from Phase
  3) — confirmed zero rows under it right now. Phase 1a's r-g work was a
  redefinition under the same name (rule 2.2), not a rename, so it has no
  entry in this list; the script is written to take more rows as future
  renames happen.

Full suite: 716/716 passing (40 files, +32 since Phase 3's 684 — 16 new
in `statusThresholds.test.ts`, the trip-wire/classifier/indirect-bidder
net additions, and a handful more); `npx next build` clean.

This closes out every numbered phase (0-4) of
`docs/specs/debt-metrics-integrity.md`. Nothing is known to be
outstanding from the spec itself once this phase deploys — the only
standing, explicitly-disclosed items from the whole workstream are (1)
Real Fed Funds Rate's silent staleness since 2026-10-29 due to the
unrelated FRED CPIAUCSL gap (Phase 3, still unresolved, not caused by
this spec and not fixed by it), and (2) condition 1's 60-day data floor
on the new fiscal-dominance trip-wire (Phase 4b, self-resolving by
~2027-01-16, not a bug).

### Deployed (2026-11-17) — live verification, with two real findings

Scott approved. Deployed `fetch-macro-data`, `update-big-cycle-metrics`,
`update-big-cycle-paradigm-metrics`, and `generate-debt-cycle-brief` —
`verify_jwt` confirmed unchanged before and after for all four
(`fetch-macro-data=true`, the other three `=false`).

**Indirect bidder — confirmed identical, live:** card = **57.55%**;
classifier's `rawInputs.indirectBidderShareAvg6` = **57.55%** (was
59.27%); trip-wire's `values.latest` = **57.55%** (was 59.27%). All three
now read the one function's output, live, not just in code.

**A real, material consequence I had not explicitly flagged in advance:
`auction_demand_deterioration` flipped from not-armed to armed**, live,
confirmed by comparing `big_cycle_stage_audit_log` rows immediately
before (`16:23` and `06:30` runs today: `armed: false, latest: 53.15,
trailingAvg: 59.27`) and after (`20:46` run: `armed: true, latest: 57.55,
trailingAvg: 55.67, sinceDate: "2024-08-08"`) this deploy. Root cause,
confirmed by re-deriving the math: the OLD method checked whether *every
individual raw auction* in the trailing pooled window was below 65% — a
single outlier auction (e.g. the 77.99% 30-Year print from Feb 2026)
instantly broke that streak. The NEW method checks whether *the
consolidated (per-term-averaged) reading* at each of the trailing 6
rounds is below 65% — the same outlier, diluted into a 6-auction
average, moves that average by only ~(77.99-55)/6 ≈ 3.8pts, nowhere near
65. This is not a bug: it is the direct, correct consequence of the
spec's own explicit instruction (one consolidated function, no more
separate calculations) applied to a trip-wire that was previously built
on the flawed pooled number. It fired a real, user-facing notification
("Trip-wire fired: Auction demand deterioration," high importance,
`20:46:47`) — flagging this prominently rather than treating "the values
now match" as the only thing worth reporting, since the trip-wire's
*behavior*, not just its displayed number, changed. Not reverting this —
it is the number the card itself has always used — but Scott should know
a real notification fired because of this deploy and why.

**Trip-wire consumers, confirmed with live data, not a stale-key
assumption:**
- `stock_bond_corr_positive` (renamed): live `armed: true, sinceDate:
  "2026-02-20"` — identical state to the old `fiscal_dominance_confirmed`
  key pre-rename, confirming the rename carried no logic change.
- Called `generate-debt-cycle-brief?refresh=true` live: its
  `trip_wires_fired` array returned `[{"label":"Auction demand
  deterioration",...}, {"label":"Positive stock-bond correlation
  regime",...}]` — the exact new label text, proving it reads the new
  key correctly, not a cached/stale one.
- `components/DebtCyclePositionCheck.jsx` is frontend code with no
  separate "deploy" step in this session's flow (no `supabase functions
  deploy` target) — it ships via the Next.js app's own deploy, triggered
  by the git push below. Verified what CAN be verified without that: the
  committed source correctly maps `stock_bond_corr_positive` in both
  `TRIP_WIRE_LABELS` and `TRIP_WIRE_DEFINITIONS`, `npx next build` is
  clean, and the live data it will read
  (`big_cycle_stage_audit_log.trip_wires.stock_bond_corr_positive`) now
  has the new key with `armed: true` — so the component is confirmed
  correct by code + live data, but not confirmed via an actual rendered
  page load, since the frontend isn't live yet at the time of this check.
- New `fiscal_dominance_confirmed`: live `armed: false,
  values.streakDays: 0, values.netInterestPctReceiptsLatest: 19.821,
  values.condition3: 0, values.paradigmAComposite: 0.4152`. **Is the
  reason visible in the trip-wire's own live metadata, not just the
  decisions log (the coordinator's explicit ask)?** Yes, directly:
  `streakDays: 0` next to `netInterestPctReceiptsLatest: 19.821` tells a
  reader the streak broke on day one because 19.821 is not > 20 — the
  live numbers self-explain today's specific reason. (The decisions
  log's separate "60-day data floor" framing describes a different future
  scenario — what happens once net interest/receipts *does* cross 20% —
  not today's actual reason, which is simpler: the condition itself is
  false today.) `realFedFundsLatest`/`cpiYoyLatest` both read `null` for
  today's date in the merged series — confirms the Real Fed Funds Rate
  staleness bug (disclosed in Phase 3) is visible here too, consistently,
  not hidden.

**Paradigm job error-surfacing — confirmed via a dry read of the
deployed function, NOT force-tested with a real failure in prod** (too
risky to deliberately corrupt a live write just to test the catch path):
fetched the deployed `update-big-cycle-paradigm-metrics` source directly
via the Supabase MCP tool and confirmed all three upserts
(`big_cycle_paradigm_raw_series`, `big_cycle_paradigm_metric_scores`,
`big_cycle_paradigm_scores`) genuinely `throw` on error in the live code,
caught by a handler that calls `logJobRun(..., "error", ...)` before
returning a 500 — matches the intended fix exactly, confirmed in what's
actually deployed, not just the local source. Ran the job normally
(no induced failure) to confirm no regression: succeeded, 13/13 metric
rows available, `rb_job_runs` logged `status: "ok"` with
`metricsAvailable: 12, metricsTotal: 12` (12 unique metric *definitions*;
13 is the metric×paradigm *score-row* count, since `trade_gdp` feeds both
B and E — not a discrepancy, two different counting units).

**Gaps determinant — confirmed live only after fixing a second real
problem found in the process:** the first post-deploy run did NOT update
`big_cycle_determinants`'s "Gaps in Wealth, Opportunity, Values" row —
investigated rather than assumed-fine, and found `home_price_income_ratio`
hadn't refreshed since **2026-10-27**. Root cause: Redfin's public S3
data file (`redfin-public-data.s3-us-west-2.amazonaws.com/...`) now
returns **HTTP 403** (confirmed via direct `curl`, not a guess) — a real,
pre-existing, unrelated external outage, not caused by this phase. Since
my original 4d implementation (and the existing Phase 2e "Debt Burden"
implementation) both read from `allUpdates` (this run's results only),
a failed Redfin fetch meant the fix could never fire, retry after retry,
until Redfin's endpoint itself recovers. Fixed by reading the stored
`big_cycle_metrics.value_display` directly instead (last-known-good,
not same-run-only) for both determinants — a real robustness
improvement, not scope creep, since the exact same flakiness could hit
Debt Burden's own inputs on a different day. Redeployed
`update-big-cycle-metrics` (verify_jwt reconfirmed unchanged) and
re-verified: **"Gaps in Wealth, Opportunity, Values" now live-reads
"Top 1% holds 32.5% of household wealth; home price/income 5.14x."** —
confirmed directly against `big_cycle_determinants`, matching the two
live cards exactly. "Debt Burden" reconfirmed unaffected:
`"256.5% total nonfinancial debt/GDP (101.8% federal debt held by the
public/GDP); 6.6% deficit/GDP"`, unchanged.

**Post-deploy regression check:** full suite **716/716** passing (40
files), `npx next build` clean — run again after the determinant fix's
redeploy, not just before it.

### Updated mandatory-gate table (supersedes the pre-deploy one above)

| | Predicted | Actually confirmed live |
|---|---|---|
| Indirect bidder (card/classifier/trip-wire) | all 57.55% | ✅ confirmed, all three |
| `mp3AuctionDemandWeak` (classifier gate) | unchanged (false) | ✅ confirmed unchanged |
| `auction_demand_deterioration` (trip-wire armed state) | *not explicitly predicted* | ⚠️ **flipped false→true** — correct consequence of 4a, disclosed above, real notification fired |
| `stock_bond_corr_positive` | armed since 2026-02-20 | ✅ confirmed |
| `fiscal_dominance_confirmed` (new) | not armed | ✅ confirmed, reason visible in live metadata |
| Paradigm A cross-check | 0.4152, no disagreement | ✅ confirmed |
| Paradigm job error-surfacing | throws + logs | ✅ confirmed via deployed-source read (not force-tested live) |
| Gaps determinant | live reading_text | ⚠️ **blocked by a second, newly-found issue (Redfin 403)** → fixed with a more robust read path → ✅ confirmed live after redeploy |

Two things were found live during this verification that neither the
pre-deploy report nor the spec itself anticipated: the auction-demand
trip-wire's armed-state flip, and the Redfin 403 blocking the Gaps fix.
Both are disclosed above with root cause, not smoothed over. Everything
else confirms exactly as predicted. This closes out every phase (0-4) of
`docs/specs/debt-metrics-integrity.md`.
