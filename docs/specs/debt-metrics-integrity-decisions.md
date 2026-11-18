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

## v2 (2026-11-17)

New follow-up spec, `docs/specs/debt-metrics-integrity-v2.md` — a post-
deploy review found 9 problems in what v1 shipped. Phase 0 only
(reconnaissance, no behavior changes) per the same two-step gate as v1.

### Phase 0, task 1: fixture

`tests/fixtures/debt-metrics-v2-2026-11-17.json`, pulled live. Headline
numbers:

| | Value |
|---|---|
| Indirect bidder — card | 57.55% (status watch) |
| Indirect bidder — classifier (`indirectBidderShareAvg6`) | 57.55%, gate `< 57.5` → **not weak** (0.05pts of margin) |
| Indirect bidder — trip-wire | **armed**, `sinceDate: 2024-08-08`, `trailingAvg: 55.67` |
| Net interest / receipts | 19.821% (`debtServiceStrained` gate `> 20` → **false**, 0.179pts of margin) |
| CPI (YoY) | 3.717%, `last_fetched_at` **2026-10-29** |
| Core CPI (YoY) | 2.566%, `last_fetched_at` **2026-10-29** |
| Real Fed Funds Rate | 0.033%, `last_fetched_at` **2026-10-29**, status still the OLD healthy/watch/danger family (v1 Phase 3b's stance code has never successfully re-run on this card) |
| Convergence gap (`10Y − r_eff`) | 1.774 (spec text cites 1.72 — normal day-to-day drift, not a discrepancy) |
| Redfin home-price/income card | 5.14x, `last_updated` **2026-10-27** (HTTP 403, confirmed in v1 Phase 4) |

### Phase 0, task 2: consumers, re-grepped fresh (not assumed from v1)

**`auction_demand_deterioration`** — 5 hits, all in code already known from
v1's own trip-wire renaming work (confirming nothing new appeared):
1. `generate-debt-cycle-brief/index.ts:214` — `TRIP_WIRE_LABELS` map.
2. `update-big-cycle-metrics/index.ts:810` — `TRIP_WIRE_LABELS` map.
3. `update-big-cycle-metrics/index.ts:932` — the evaluator call site itself.
4. `components/DebtCyclePositionCheck.jsx:36` — `TRIP_WIRE_LABELS` map.
5. `components/DebtCyclePositionCheck.jsx:49` — `TRIP_WIRE_DEFINITIONS`
   (the plain-language description a reader actually sees).

Notification `dedup_key`s are derived at runtime from the label text
(`name.toLowerCase().replace(...)`), not a separate hardcoded occurrence
of this literal key — so there's no 6th hit hiding there, just a
generated string that happens to produce the same text.

**`debtServiceStrained`** — 4 production hits (plus test-file
assertions, not counted as consumers): `_shared/debtCycleClassifier.ts`
(the definition, the `strainedCount` sum, and the result object),
`generate-debt-cycle-brief/index.ts` (interface + prompt text), and
`components/DebtCyclePositionCheck.jsx` (the condition row). Matches
v1's own list — nothing new.

**Re-confirmed the non-goals section's portfolio claim, fresh:** grepped
`update-regime-portfolio-targets` and `update-regime-shadow-targets` for
`DEBT_CYCLE_ID` / `big_cycle_stages` / `classifyDebtCycleStageV2` — zero
hits in either. Still true: nothing downstream of the debt-cycle stage
feeds portfolio targets.

**A genuine v1 miss, found and confirmed while re-grepping (not assumed
from the spec's own claim):** item #2's "stale r−g wording" is real.
`update-big-cycle-metrics/index.ts` lines 554-556 still reads:

```
status_label: ... "r > g — unsustainable trajectory" ... "r < g — sustainable"
note_suffix: "10Y Treasury yield minus real GDP growth (r−g) — ..."
```

My own v1 Phase 1 decisions log explicitly claimed *"No literal
'unsustainable trajectory' string exists anywhere in the repo
(grepped)"* — that claim was wrong; the string is right here, in the
same function (`computeMacroCrossRefUpdates`) I was actively editing
that same phase for the net-interest wiring and the convenience-yield
label fix, just a few hundred lines away. The spec's "real" in "minus
real GDP growth" is plain ASCII, so the miss here specifically wasn't a
U+2212-vs-ASCII-hyphen encoding issue — more likely I grepped for the
*exact spec-quoted phrase* (which embeds an em dash, `—`) as a single
literal pattern at some point, and a shell/tool-level mangling of that
non-ASCII character silently zeroed out the match. Either way: logged
as a real, confirmed miss, not re-litigated further here — this is
exactly what Phase 2's `grep -rnF` sweep (rule 8) is for; not expanding
into that phase's work now.

### Phase 0, task 3: indirect-bidder distribution — the load-bearing number for Phase 1

Pulled the full `treasury_auction_results` history (10Y/30Y, back to
2010-01-11 — 180 raw auctions) and ran v1's own `computeIndirectBidderSnapshot`
logic at every offset where a full consolidated reading exists (101
consolidated readings, offsets 0-100, spanning 2010 through today).

**Full history (n=101, ~16 years):**

| Stat | Value |
|---|---|
| Mean | 49.34 |
| Std dev (population) | 7.05 |
| P10 | 38.46 |
| P25 | 43.54 |
| P50 (median) | 50.70 |
| Min / Max | 31.98 / 62.76 |

**Trailing 2-year window (n=12 consolidated readings, `asof >= 2024-08-13`):**

| Stat | Value |
|---|---|
| Mean | 56.83 |
| Std dev (population) | 2.02 |

**Today's reading (offset 0, asof 2026-08-13): 57.55** — avg10=57.61,
avg30=57.48.

**This is the number that determines whether Phase 1's "expected:
disarmed" prediction holds, and it does, decisively:** today's 57.55 is
**above** both the full-history mean (z = (57.55−49.34)/7.05 = **+1.16**)
and the 2-year mean (z = (57.55−56.83)/2.02 = **+0.36**) — not below
either one. Under Phase 1's planned trip-wire rule ("arms when the
consolidated reading is below its own trailing 2-year mean by more than
1 std dev for 3 consecutive auction rounds"), the relevant boundary is
`mean2yr − 1·sd2yr` = `56.83 − 2.02` = **54.81**. Checking the 3 most
recent rounds against that boundary: offset 0 = 57.55 (above), offset 1
= 55.63 (above), offset 2 = 57.00 (above) — none of the 3 most recent
rounds are below 54.81, let alone all 3 consecutively. **The new
trip-wire would NOT arm under today's data.** This directly confirms why
the current "permanently armed" state (problem #1) is a pure artifact of
the stale fixed 65% threshold: indirect-bidder participation has
structurally risen from the ~30s-40s (2010-2014) to the ~50s-60s
(2015-present) — a `< 65` test that made sense against the OLD regime's
history is now comparing the metric to a level it was never typically at
during the *current* regime, meaning the test can't tell "normal for
today" apart from "actually deteriorating."

### Phase 0, task 4: "core CPI 2.6%" in the Daily Macro Summary

`daily-brief/index.ts:347`: `const coreCpi = get("Core CPI (YoY)")`,
where `get()` (line 342) reads `macro_indicators.current_value` by exact
name match — the same frozen row the fixture captured: **2.566%** (rounds
to "2.6%"), `last_fetched_at` **2026-10-29**. Confirmed this is the exact
same stale value every other CPI-dependent card shares, sourced from the
same `yoyPair` gap — not a separate bug, not a different computation,
just another reader of the one frozen row. Once Phase 4's inflation-gap
fix lands and this card refreshes, the Daily Summary will automatically
pick up the corrected value with no change needed in `daily-brief` itself
(it just reads whatever `macro_indicators` currently holds).

### Acceptance

Fixture committed (`tests/fixtures/debt-metrics-v2-2026-11-17.json`);
both consumer lists given above, re-derived fresh; indirect-bidder
distribution (full-history and 2-year) is in this log, with the
boundary check that validates Phase 1's "expected: disarmed" prediction
against real numbers rather than assumption.

**Nothing structurally blocking found.** All four Phase 0 tasks
completed; the one surprise (the confirmed v1 grep miss) is logged, not
a blocker — Phase 2 will fix it along with the rest of the wording
sweep. Stopping here per the gate; not touching Phase 1.

### Phase 1: one threshold source, calibration vs. own history, sinceDate fix, notification hygiene

**1a. One threshold source.** `INDIRECT_BIDDER_THRESHOLDS` added to
`_shared/statusThresholds.ts`. Card status (`indirectBidderCardStatus`)
and the classifier's weak gate (`indirectBidderIsWeak`) both import it;
the trip-wire (`evalAuctionDemandDeterioration` in `_shared/indirectBidder.ts`)
takes the threshold object as a parameter and
`update-big-cycle-metrics/index.ts` passes `INDIRECT_BIDDER_THRESHOLDS.tripWire`
at the one call site. Grep for the retired raw values, both ASCII and
unicode variants (rule 8), after all code changes:

```
grep -rnF "57.5" supabase/functions components/*.jsx | grep -v _shared/statusThresholds.ts | grep -v tests/
grep -rn "< *65\|<65\b" supabase/functions components
```

Zero live hits — every remaining match is an explanatory comment citing
the retired number for context, not executable logic. One genuine find
along the way: `_shared/debtCycleTripWires.ts` still carried a **dead
duplicate** of `evalAuctionDemandDeterioration` (the pre-Phase-4a
original, pooled-auctions-with-fixed-`<65`), left behind when the real
implementation moved to `_shared/indirectBidder.ts` in v1 Phase 4a but
never deleted. Confirmed via grep that nothing imported it from that
file (both `update-big-cycle-metrics/index.ts` and the tests only ever
imported the `indirectBidder.ts` version) — removed it rather than
leaving an unused alternate implementation sitting there with a stale
threshold baked in, since finding exactly this kind of stale leftover is
what rule 8's grep is for.

**1b. Calibration.** Using the Phase 0 distribution (full-history mean
49.34/stdev 7.05, n=101; trailing-2yr mean 56.83/stdev 2.02, n=12):

- Card: `z > -1` healthy, `-2 < z <= -1` watch, `z <= -2` danger — vs.
  full history.
- Classifier `mp3AuctionDemandWeak`: `z <= -1.5` — vs. full history,
  one boundary (stronger than the card's watch line, since it's
  MP3-adjacent evidence per the spec).
- Trip-wire: arms on 3 consecutive rounds below `mean2yr - 1*sd2yr`,
  disarms on 2 consecutive rounds above `mean2yr - 0.5*sd2yr` —
  computed once per call, anchored to the latest reading, walked across
  the full available history as a state machine (not recomputed per
  historical point — same simplification `isSustainedRising`/
  `isSustainedPositive` already make).

All of these are logged as **uncalibrated starting points** per rule 6
— directionally reasonable given the real distribution, not statistically
fit.

**Judgment call: is n=12 (trailing 2 years) enough for a stable stdev?**
No — 12 points is below the general comfort floor (~20-30+) for a
stable stdev estimate; a single additional extreme auction could swing
`sd2yr` meaningfully. Decided to proceed with the literal "trailing 2
years" the spec specifies anyway, rather than unilaterally widening the
window, for three reasons: (1) the spec explicitly asks "fewer than
~24" as the fallback trigger for the percentile-rank path, and 12 is
below that — but the fallback path is for cases with too little data to
compute *any* meaningful spread at all (the near-term-signal-confidence
style guard), not a general "more data is always better" rule, and 12
genuine auction rounds is a real, if thin, empirical window, not a data
desert; (2) this is explicitly flagged elsewhere in this same phase as
an "uncalibrated starting point" like every other threshold here —
adding a second, undocumented deviation (silently widening the window)
on top of an already-provisional threshold compounds uncertainty rather
than reducing it; (3) the alternative (recomputing a true rolling
window) is the explicitly-rejected larger investment noted in
`indirectBidder.ts`'s own doc comment. **What was done about it:** logged
here as a known caveat rather than silently accepted — if `sd2yr` is
later observed to swing wildly auction-to-auction in production, that's
the empirical signal to revisit the window length, not a priori
reasoning now.

**1c. sinceDate fix.** The old implementation (both the v1
`indirectBidder.ts` version and the now-removed dead duplicate in
`debtCycleTripWires.ts`) reported `window[window.length-1].auction_date`
— the oldest point in whatever fixed lookback window was passed in, not
when the condition actually started. This is exactly the
2024-08-08 bug the Phase 0 fixture captured (`sinceDate` pinned to the
window edge regardless of true onset). The rewrite walks the full
history chronologically as a state machine and only updates
`sinceDate` on the false→true arm transition, to the date of the first
round in that specific streak — verified directly (see 1d) with a
synthetic test where the streak start is deliberately not the oldest
row available, and the assertion confirms `sinceDate` is neither. No
`windowOldestDate` field was carried forward — confirmed via grep it
had no other reader anywhere in the codebase.

**1d. Live projected state, confirmed against the real new code (not
just Phase 0's hand-calc).** Ran `evalAuctionDemandDeterioration` from
the actual rewritten `_shared/indirectBidder.ts`, with
`INDIRECT_BIDDER_THRESHOLDS.tripWire`, against the real 185-row Treasury
auction history pulled in Phase 0 (now committed as
`tests/fixtures/indirect-bidder-auction-history-2026-11-17.json`, and
used directly as the test suite's live-numbers regression anchor):

```
{
  armed: false,
  sinceDate: null,
  values: {
    latest: 57.55,
    mean2y: 56.83,
    sd2y: 2.02,
    armThreshold: 54.81,
    disarmThreshold: 55.82,
    windowReadingCount: 12
  }
}
```

**Disarmed**, exactly matching Phase 0's manual projection (54.81 arm
boundary, none of the last 3 rounds below it) — but now produced by the
real code path end to end, not a hand calculation standing in for it.
The full-history z-score for the same latest reading is **+1.16**
(`indirectBidderCardStatus` → `"healthy"`, `indirectBidderIsWeak` →
`false`), also matching Phase 0.

**1e. Notification hygiene.** Checked the existing notification pipeline
in `update-big-cycle-metrics/index.ts`'s `Deno.serve` handler before
building anything new: it compares today's trip-wires against
yesterday's (from `big_cycle_stage_audit_log`) and only fires a
"Trip-wire fired" notification on a `!prior.armed && current.armed`
transition, deduped via `dedup_key: debt_cycle_tw_${key}:${sinceDate}`.
**There is no "cleared" notification type anywhere in this codebase** —
only "fired." Given today's projected transition is armed→disarmed
(or, if the live data differs from this projection by deploy day,
possibly no transition at all), the existing pipeline would not fire
anything regardless — the `!prior.armed && current.armed` guard is
false either way. Built an explicit suppression guard anyway, as a
defensive measure for the edge case where live deploy-day numbers
differ from this projection and the trip-wire unexpectedly computes
`armed: true`: a query against `big_cycle_stage_notes` for a
recalibration note created *today* (matching `"Auction-demand trip-wire
recalibrated%"`), reusing the same table and the same note 1e separately
asks for rather than inventing a second mechanism — if found, the
`auction_demand_deterioration` key is filtered out of today's
notification batch. The note text itself (`"Auction-demand trip-wire
recalibrated 2026-11-17: now relative to its own history; prior armed
state reflected a threshold mismatch, not new deterioration."`) is
drafted and ready but **not yet inserted** — per the same live-DB-write
gate used in every prior phase (v1 Phase 1's r-g note, Phase 4b's
recalibration note), it goes in only at deploy time, not during
build/commit/report.

### Tests

`tests/indirectBidder.test.ts` rewritten: kept the existing
`computeIndirectBidderSnapshot` coverage unchanged (that calculation
didn't change in Phase 1), removed the now-stale "57.5 boundary, pinned"
block (that threshold is retired), and added coverage for
`meanAndStdev`/`zScoreOf` and the rewritten
`evalAuctionDemandDeterioration`: an armed case, a disarm case (same
armed fixture with 5 recovery rounds prepended — proves the gate
actually flips off, not just that it sometimes doesn't arm), two
hysteresis cases (a too-short dip that never arms; a single recovery
round that fails to disarm an already-armed wire), a dedicated
sinceDate-streak-start assertion, and the live 185-row regression anchor
described in 1d. The old trip-wire tests that lived in
`tests/debtCycleTripWires.test.ts` (pre-dating the v1 Phase 4a move)
were deleted from that file with a pointer comment, since they tested
the now-removed dead duplicate under the old `(rows, n)` signature.

`tests/debtCycleClassifier.test.ts`: every existing `ClassifierInput`
fixture gained `indirectBidderShareZ` (now a required field); the stale
"57.5 boundary" describe block was replaced with a `z <= -1.5` boundary
block (z = -1.4/-1.5/-1.6, plus a null-z case confirming the bidToCover
gate still works independently).

Full suite: `npx vitest run tests/` → 722 passed (40 files). `npx next
build` → compiles clean, all 27 routes prerender.

### Acceptance

One threshold source (confirmed by grep, and by deleting the dead
duplicate that grep surfaced); trip-wire proven to both arm AND disarm
on realistic synthetic data, not just today's single live snapshot;
`sinceDate` now means streak start, verified against a case where that
differs from both the window edge and the oldest available row; live
state (disarmed, real numbers) reported above before any deploy.
**Nothing deployed yet** — code, tests, and this log entry are
committed; the recalibration note is drafted but not inserted; awaiting
deploy approval.

### Phase 2: wording, labels, source lines — the v1 grep miss, fixed

**2a. The exact old string, read directly at the literal file location**
(not re-run from v1's grep pattern, per the coordinator's explicit ask —
v1's grep evidently missed this). `update-big-cycle-metrics/index.ts`,
the `rate_growth_spread` block (was lines 555–557, shifted slightly by
v2 Phase 1's unrelated edits earlier in the file — now ~562–564):

```
status, status_label: status === "bad" ? "r > g — unsustainable trajectory" : status === "warn" ? "r ≈ g — borderline" : "r < g — sustainable",
note_suffix: "10Y Treasury yield minus real GDP growth (r−g) — the classic debt-sustainability test. Cross-referenced from Macro.",
```

Replaced with the spec's exact new copy:

```
status, status_label: status === "bad" ? "r > g — new debt compounding faster than the economy" : status === "warn" ? "r ≈ g — borderline" : "r < g — growth outpacing rates",
note_suffix: "10Y Treasury yield minus nominal GDP growth (r−g) — the marginal cost of new federal borrowing vs. growth of the nominal tax base. Cross-referenced from Macro. r < g alone doesn't stabilize debt/GDP while a primary deficit persists.",
```

Confirmed live (pre-fix) in `big_cycle_metrics`: `note` = "10Y Treasury
yield minus real GDP growth (r−g) — the classic debt-sustainability
test. Cross-referenced from Macro.", `status_label` = "r < g —
sustainable" — this table's `note`/`status_label` columns are written
by `note_suffix`/`status_label` on every function run (see line ~1061's
`noteAppend`), so no separate migration is needed for this card's live
`note`/`status_label` — the fix lands on the next deploy's run.
`source_name` is a **different, separately-seeded column never touched
by the function** — handled in 2b below.

Spot-checked the fix's own byte encoding before committing (per the
coordinator's warning that a prior grep miss may be an encoding issue):
the new `status_label` line uses U+2014 (em dash) as the clause
separator and U+2248 (≈) for the warn case — both byte-identical to
what the original line already used, so no regression there. The new
`note_suffix`'s "(r−g)" uses U+2212 (minus sign), matching
`macro_indicators.description`'s own "(r−g)" from v1 Phase 1. No
encoding drift introduced.

**2b. Source lines.** `big_cycle_metrics.source_name` is a plain
editorial text column — confirmed via the same grep-vs-reality check
that nothing in `update-big-cycle-metrics/index.ts` ever writes it (the
function only writes `value_numeric`/`value_display`/`status`/
`status_label`/`note` per run); it carries whatever was seeded at
migration/creation time. Live values confirmed stale on 2026-11-17:

| key | live source_name (stale) |
|---|---|
| `rate_growth_spread` | "Macro dashboard, Long-Term Debt Cycle layer (FRED DGS10/GDPC1)" |
| `interest_expense_revenue_pct` | "Macro dashboard, Long-Term Debt Cycle layer (FRED A091RC1Q027SBEA / FYFR)" |
| `deficit_pct_gdp` | "FRED" |

Migration `supabase/migrations/20261117_v2_phase2_source_line_fixes.sql`
updates all three to the spec's exact text (no FK involved — a plain
`UPDATE`, unlike the `macro_indicators.name` rename pattern from v1's
`20261117_rename_cb_gold_reserves_to_gold_price_yoy.sql`, which needed
the insert-repoint-delete workaround only because of that table's
non-deferrable FK). **Not yet applied** — held for deploy, per the
same-gate instruction for this phase.

Checked the equivalent `/macro` descriptions (`macro_indicators.description`)
for all three: `Rate vs. GDP Growth Spread` and `Interest Expense % of
Federal Revenue` are **already correct** (both already say "nominal
GDP growth" / MTS-basis, confirmed fixed by v1 Phase 1/2 — this is a
genuinely different text column from `big_cycle_metrics.source_name`
and v1's fix never touched the latter). `Federal Deficit % GDP` has no
`macro_indicators` row at all (it's a `big_cycle_metrics`-only card,
computed directly in `update-big-cycle-metrics`, no `/macro` drawer
counterpart to check).

**2c. The sweep.** `grep -rnF` for all seven terms across
`supabase/functions`, `components`, `app`, `lib`, plus the three live DB
text columns named in the spec (`big_cycle_metrics.note`/`status_label`/
`source_name` — the function's `note_suffix` input maps to the `note`
column; `big_cycle_determinants.reading_text`; `macro_indicators.description`).

- **"real GDP growth"** — 5 code hits, all in genuinely different,
  real-GDP-based features unrelated to the r−g card: a CBO potential-
  growth comment (`fetch-macro-data/index.ts:1854`, `lib/simulatorKeys.js:216`),
  the Dalio quadrant chart (`ThreeForcesChart.jsx:284`), and the
  Growth-Inflation Risk gauge (`DalioGauges.jsx:620,624`). **Intentional,
  logged, not fixed** — these cards are supposed to use real GDP.
- **"GDPC1"** — many hits, all the FRED series ID for other genuinely
  real-GDP-based cards (Real GDP Growth, Output Gap, GDP 2Q/4Q Avg
  crossover, M2 − GDP, Growth-Inflation Risk gauge, three backtests,
  `get-gdp-crossover-history`). Confirmed the r−g card itself does
  **not** use GDPC1 (`fetch-macro-data/index.ts`'s own INDICATORS entry:
  `series: "DGS10", series2: "GDP"` — nominal, since v1 Phase 1).
  **Intentional, logged, not fixed.**
- **"A091RC1Q027SBEA"** (NIPA interest series) — 3 hits: the Interest-vs-
  Defense card (`update-big-cycle-metrics/index.ts:129`, intentionally
  NIPA-basis per 2d — both sides of that comparison are supposed to be
  NIPA) and two `fetch-macro-data/index.ts` call sites inside the
  `interest_net_gdp_pct`/`interest_net_revenue_pct` cases — read directly:
  both only populate `metadata.nipa_pct_gdp`/`nipa_note` ("shown in the
  drawer"), the headline `current`/`previous` values come from MTS. This
  is exactly the spec's own "NIPA lines kept as secondary context"
  example. **Intentional, logged, not fixed.**
- **"sustainable"** — 6 hits: this phase's own new explanatory comment
  (intentional — it's explaining the retirement, not live text), a
  retirement-planning "4% rule" card (`financial-plan/index.ts`,
  `app/planning/page.jsx` — unrelated feature, not the r−g card), and
  three Dalio-gauge narrative paragraphs (`DalioGauges.jsx:259,838,843`)
  describing *other* gauges' own debt-growth-rate framing, not r−g's
  retired status_label. **Intentional, logged, not fixed.** Confirmed
  zero hits against the actual retired r−g wording itself
  (`grep -rnF "unsustainable trajectory"` / `"r < g — sustainable"` →
  clean after the 2a fix).
- **"Subsidy inverted" / "Privilege intact"** — **zero exact-case hits**,
  anywhere, code or DB. But per the coordinator's warning about a prior
  grep miss, re-ran case-insensitively on the bare words "privilege"/
  "subsidy" rather than trusting the exact-phrase miss, and found the
  real (paraphrased, different case) source: `app/macro/page.jsx`'s
  Treasury Convenience Yield drawer — "exorbitant privilege intact" /
  "the subsidy has inverted" — plus a matching code comment in
  `ingest-convenience-yield/index.ts`. Read both in context: these are
  **definitional sign-convention copy** ("positive value means X,
  negative means Y"), not a live status label — the actual
  `status_label` for this card was already retired from this exact
  level-based framing in v1 Phase 3c (confirmed via that code's own
  comment: "'Subsidy inverted' was a level-based label that could read
  as deteriorating even while the level was recovering off a low").
  The drawer text answers a different question ("what does the sign
  mean") than the trend-based status does ("is it improving") — both
  can be true simultaneously, so this is **intentional, logged, not
  fixed**, not a second instance of the same bug.
- **"fiscal_dominance_confirmed"** — several hits, all current: this is
  the live key for the NEW 4-condition trip-wire from v1 Phase 4b (the
  OLD trip-wire that used to hold this name was renamed to
  `stock_bond_corr_positive`; the name was then reused for the actual
  fiscal-dominance test). **Intentional, logged, not fixed.**

**Live DB text columns** (`big_cycle_metrics.note`/`status_label`/
`source_name`, `big_cycle_determinants.reading_text`,
`macro_indicators.description`): queried all three tables for all seven
terms (case-insensitive, broader than exact-phrase to catch any
encoding/case drift). Zero hits in `big_cycle_determinants.reading_text`
and `macro_indicators.description`. `big_cycle_metrics` hits were
exactly the 2a (`note`/`status_label`, fixed by code, lands next run)
and 2b (`source_name`, fixed by migration, held for deploy) items
already covered above — no additional unexplained hits.

**Zero unexplained remaining hits.** Every hit above is either fixed
(2a in code, 2b in a migration) or explicitly logged as intentional
with a stated reason.

**2d. Interest vs. Defense card.** Added to its `note_suffix`: "NIPA
basis on both sides (includes imputed pension interest); budget-basis
net interest (Treasury MTS, trailing 12 months) is $X." `$X` is filled
in live via `fetchMtsNetInterestTrailing12()` (already imported
elsewhere in this file; added to this call site's `Promise.all`) rather
than hardcoded. Verified live: trailing-12 net interest (window
2025-11-30 → 2026-10-31) = **$1,063.96B → "$1.06T"** — matches the
spec's own reference figure exactly. No calculation change to the
card's own NIPA-vs-NIPA ratio.

### Tests / build

No `_shared/` module touched this phase (all edits are in
`update-big-cycle-metrics/index.ts`'s plain Deno.serve body plus one new
plain-text migration), so no new test coverage is applicable — existing
suite re-run as a regression check: `npx vitest run tests/` → 722 passed
(40 files), `npx next build` → compiles clean.

### Acceptance

Sweep log above shows the required zero unintended hits (everything is
either fixed or explicitly logged as intentional with a stated reason).
**Nothing deployed and the migration is not yet applied** — code,
migration file, and this log entry are committed; the live page will
show the new wording only after deploy, which is reported separately
per the standing gate.

### Phase 3: hysteresis on the 20% debt-service gate

**Investigation: insufficient history for the 2-month persistence rule
(the primary finding, per the coordinator's explicit ask).** Queried
`macro_snapshots` for "Interest Expense % of Federal Revenue" across its
full history. Confirmed a hard basis break: ~23.8-24.6 (NIPA basis)
every day from 2026-08-21 through 2026-11-15, then **19.821** (MTS
basis, v1 Phase 2b) starting **2026-11-16** — one day earlier than an
existing code comment claimed ("...from 2026-11-17 onward"); fixed that
comment too while rewiring this code, since I was touching it anyway and
the live data is the ground truth. Filtering to the MTS-basis era only
(`>= 2026-11-16`) leaves exactly two snapshot rows — 2026-11-16 and
2026-11-17, both 19.821 — which `dedupeConsecutive` correctly collapses
to **one** distinct reading. `persistMonths = 2` can never be evaluated
from one reading; this is not a corner case, it is the live state today.

**Decision: yes, this needs an explicit bootstrap/insufficient-history
state, distinct from "off."** Reasoning:
- Mixing the pre-cutover NIPA values into the gate's series was ruled
  out immediately — those values (23.8-24.6) are a different metric,
  not a real multi-month strained reading, and would have armed the
  gate on stale-basis data on day one. The caller (`updateDebtCycleStage`)
  filters the query to `>= MTS_NET_INTEREST_BASIS_CUTOVER` so the gate
  itself never sees mixed-basis data.
- A silent "not enough data yet, so off" would be indistinguishable from
  a real, confirmed "off" read — exactly the ambiguity rule 7's
  disarm-path requirement exists to prevent on the arm side too: a
  caller (or a reader of the Position Check) can't tell "confirmed
  not-strained" apart from "we don't actually know yet." Both the
  classifier's `rawInputs` and the Position Check detail text must
  surface `insufficientHistory` explicitly (3b/3d below).
- The fallback itself compares the single latest reading against the
  STRICTER `on` bound only (never the looser `off` bound) — a thin
  series shouldn't be able to arm on a single noisy print, but it also
  shouldn't take two readings' worth of confirmation just to report
  "not strained" when the one reading we have is nowhere near the line.
  `hysteresisGate.test.ts` pins this directly: a single 19.821 reading
  (today's live value — above `off`=19.5, below `on`=20.5, i.e. in the
  dead band) reads `armed: false` under the bootstrap fallback, and a
  single 20.7 reading (above `on`) reads `armed: true`.
- This is logged as the kind of judgment call rule 6 asks for rather
  than silently decided: Phase 5 (backfill) will eventually make this
  moot by giving the gate years of real MTS-basis history, but Phase 3
  ships before Phase 5 per the spec's own rollout order, so the
  bootstrap path is live, real behavior for some unknown stretch of
  time, not a short-lived theoretical edge case.

**3a.** `_shared/hysteresisGate.ts` (new file): `hysteresisGate(series,
{ on, off, persistMonths })`. Dedupes via the existing `dedupeConsecutive`
(reused, not reinvented, per the spec), then walks the distinct readings
oldest-first as a state machine — arms on `persistMonths` consecutive
readings `> on`, disarms on `persistMonths` consecutive readings `< off`,
holds otherwise. Returns `{ armed, insufficientHistory, monthsAvailable,
latest }`. Pure, no Deno/Supabase dependency — same `_shared/` pattern as
every other module this session.

**3b.** `DEBT_SERVICE_STRAINED_GATE = { on: 20.5, off: 19.5,
persistMonths: 2 }` added to `_shared/statusThresholds.ts` (logged as
uncalibrated, rule 6 — a symmetric 1-point dead band around Dalio's 20%
checkpoint, not statistically fit). `ClassifierInput` gains
`debtServiceStrainedGate: HysteresisGateResult`, computed by the caller
(`updateDebtCycleStage`, via a new `macro_snapshots` query filtered to
the MTS cutover date); `debtServiceStrained` now reads
`input.debtServiceStrainedGate.armed` instead of a fresh
`interestExpenseRevenuePct > 20` check. `rawInputs` carries both the raw
value (`interestExpenseRevenuePct`, unchanged) and the gate state
(`debtServiceStrainedGateInsufficientHistory`,
`debtServiceStrainedGateMonthsAvailable`).

**3c.** `evalFiscalDominanceConfirmed`'s condition 1 no longer re-derives
anything from `netInterestPctReceipts` daily history (that field and its
whole per-day check are removed from `FiscalDominanceDailyRow`/the
streak loop). It now takes `debtServiceStrainedNow: boolean` as a new
parameter — the exact same `stageResult.conditions.debtServiceStrained`
value the classifier already computed via 3b — applied as a current-only
AND term (`armed = streakHolds && condition3Now && debtServiceStrainedNow`),
the same way condition 3 already worked before this phase. Wired at the
single call site: `evaluateTripWires(sb, fedPrintingRisingNow,
somaAbsorbingNow, stageResult?.conditions.debtServiceStrained ?? false)`
— mirrors the existing precedent where `fedPrintingRising`/
`mp3SomaAbsorbing` already flow from `stageResult` into
`evaluateTripWires` rather than being independently recomputed. The
`interestRevSnaps` query inside `evaluateTripWires` is now dead (nothing
reads day-level net-interest history there any more) and has been
deleted, along with `netInterestByDate`/its slot in the date-join union
— confirmed via grep that `netInterestPctReceipts` has zero remaining
references anywhere in the codebase after this change.

As a side effect, this also un-sticks a real limitation the v1 Phase 4
decisions log had already flagged but not fixed: with condition 1 now
current-only instead of day-by-day, the 60-day persistence streak for
this trip-wire depends only on conditions 2/4's history (real fed funds,
CPI YoY — both long-running series), not on net-interest/receipts' own
thin 1-2-day MTS-basis history. The trip-wire was previously structurally
incapable of ever reaching a 60-day streak regardless of real fiscal
conditions; it no longer is.

**Current live gate state, confirmed with real data (not projected):**
ran `hysteresisGate` from the actual new code against the real
MTS-basis-only `macro_snapshots` rows (2026-11-16 and 2026-11-17, both
19.821):

```
{ armed: false, insufficientHistory: true, monthsAvailable: 1, latest: 19.821 }
```

**`debtServiceStrained` reads not-armed**, via the bootstrap fallback
(19.821 is in the dead band — above `off`=19.5 but below `on`=20.5 — so
even the single-reading fallback, which only arms on clearing the
stricter `on` bound, reads false). This matches Phase 0's finding that
the OLD raw `>20` check also read false, by 0.179pts — both the old
check and the new gate agree on today's answer, for different reasons
(old: literally below 20; new: below the stricter 20.5 bootstrap bound).
`fiscal_dominance_confirmed`'s condition 1 therefore also reads false
today (confirmed: it receives this exact boolean, not a re-derived one —
see 3c above), so that trip-wire stays unarmed regardless of conditions
2/3/4.

**3d.** `components/DebtCyclePositionCheck.jsx`'s `debtServiceStrained`
row detail, with today's live numbers substituted:

> Debt service strained — 19.8% of revenue — threshold 20% (on above
> 20.5% for 2 months, off below 19.5%) — insufficient history yet, using
> single-reading fallback

(The renderer joins `{label}` and `{detail}` with " — ", the same
convention every other condition row already uses — not the ": "
literally shown in the spec's own illustrative example. Flagging this
explicitly since it's a cosmetic deviation from the spec's exact
wording, not a functional one: the same information is present, just
joined with this codebase's existing separator rather than a one-off
colon for this single row. Did not change the separator globally, since
that would affect every other row's established rendering for a case
that wasn't asked for.) The mirrored thresholds (20.5/19.5/2 months) are
hardcoded in the JSX with a pointer comment to
`DEBT_SERVICE_STRAINED_GATE`, matching this codebase's established
pattern of components mirroring `_shared/` constants rather than
cross-importing Deno-targeted edge-function code into Next.js.

### Tests

`tests/hysteresisGate.test.ts` (new): threshold crossing without
persistence (no flip), a persistent crossing (flip), a dead-band dip on
an already-armed gate (no flip back), a disarm path (rule 7 — arms then
disarms on the same series), five insufficient-history cases (zero
readings, one reading above `on`, one in the dead band — the live case
today — one below `off`, and exactly `persistMonths` readings no longer
being insufficient), and a dedicated dedup test (45 identical daily
snapshot values collapsing to 1 distinct reading, not 45). Caught my own
test-authoring bug while writing these: three early drafts used two
*identical* adjacent values to represent two different months (e.g.
`[21, 21]`), which `dedupeConsecutive` correctly collapses to one
reading — silently degrading "2 consecutive months above on" into "1
reading, insufficient history" and making the assertion pass for the
wrong reason in one case (the disarm test). Fixed by giving every
adjacent month a slightly different value (e.g. `21.0`/`21.1`) wherever
the test's intent requires dedup to treat them as distinct.

`tests/debtCycleClassifier.test.ts`: every fixture gained
`debtServiceStrainedGate` (via a small `gate()` helper); added a
dedicated describe block proving `debtServiceStrained` reads the gate's
`armed` state directly rather than re-deriving from the raw value (a
raw value above 20 with the gate still off reads false; a raw value
below 20 with the gate already on reads true), plus a `rawInputs`
round-trip test for the new `insufficientHistory`/`monthsAvailable`
fields.

`tests/debtCycleTripWires.test.ts`: `evalFiscalDominanceConfirmed`'s
fixtures drop `netInterestPctReceipts`; all call sites gain the new
`debtServiceStrainedNow` parameter; added a dedicated case proving
condition 1 actually gates the result (gate off + everything else
qualifying → not armed, with `values.condition1DebtServiceStrained`
pinned to 0) rather than silently always passing now that it is no
longer a per-day check.

Full suite: `npx vitest run tests/` → 737 passed (41 files). `npx next
build` → compiles clean, all 27 routes prerender.

### Acceptance

A single month crossing 20% cannot flip the stage (`hysteresisGate.test.ts`'s
"threshold crossing WITHOUT persistence" case, plus the live state
itself: today's 19.821 reading sits in the dead band and reads
not-armed). The Position Check explains the gate state, including the
insufficient-history caveat, not just the boolean. **Nothing deployed**
— code, tests, and this log entry are committed; the live gate's
`insufficientHistory: true` bootstrap state is real and will resolve
naturally as more MTS-basis months accumulate (and more thoroughly once
Phase 5 backfills history), not something this phase works around.

### Phase 4: inflation gap handling, unified

**Discrepancy investigation (the primary finding, resolved before building
anything).** The spec's item 5 claimed fiscal-dominance conditions 2/4
"currently read null" because of the CPI freeze. My own Phase 3
live-verification showed non-null values (`realFedFundsLatest: 0.033`,
`cpiYoyLatest: 3.717`) — a real discrepancy worth resolving before
scoping Phase 4.

**Resolved: the spec's framing was imprecise. These conditions were
never null — they were STALE, which is a different and more dangerous
failure mode.** Traced the actual mechanism:

- `fetch-macro-data`'s `processIndicator()` returns `null` outright when
  `yoyPair(obs)` fails (the `if (!yoy) return null;` guard in every
  `yoy_monthly`/`yoy_monthly_with_3m`/`level_minus_yoy_monthly` case).
- A `null` return gets filtered out of `rows` entirely before BOTH the
  `macro_indicators` upsert AND the `macro_snapshots` upsert at the end
  of `Deno.serve` — so a frozen indicator doesn't just stop updating its
  card, it stops getting ANY new row in `macro_snapshots` from that day
  forward. The table doesn't accumulate null placeholder rows; it simply
  stops accumulating rows for that indicator at all.
- Queried `macro_snapshots` directly: "CPI (YoY)" and "Real Fed Funds
  Rate" both have their last real row at **2026-10-29** (value 3.717 and
  0.033 respectively — exactly my Phase 3 numbers), with nothing newer.
  "Core CPI (YoY)" is frozen at the same date too (2.566).
- `evaluateTripWires`'s date-join builds `fiscalDominanceDailyRows` from
  whatever rows actually exist, then reads `dailyRows[0]` as "today's"
  value. Since no new rows have been written since 2026-10-29, `dailyRows[0]`
  IS the 2026-10-29 row — 20 days stale as of today (2026-11-18), but a
  perfectly normal-looking non-null number, not a null. Nothing bypasses
  the frozen cards; there's only one pipeline, and "frozen" here means
  "stopped writing new rows," not "started writing nulls."

This is actually a worse failure mode than the spec assumed: a null
would at least be visibly "unknown" to any consumer; a stale non-null
value silently presents 20-day-old data as if it were today's reading,
with no signal anywhere that it's stale — the exact same category of
problem v2 Phase 3's `insufficientHistory` flag was built to prevent for
the debt-service gate, just not yet addressed for this one. Confirmed
this doesn't change Phase 4's scope (the spec's underlying problem —
"these conditions aren't using live data" — is correct even though its
mechanism description was wrong), but it DOES mean Phase 4's fix (once
`yoyPair` can pair the newest print again) should make `macro_snapshots`
start accumulating fresh rows again too, which `evaluateTripWires`
should then pick up automatically on its next run — confirmed live after
deploy, not assumed (see the live-verification report).

**4a.** `_shared/yoyMath.ts` gains:
- `addMonths(monthKey, n)` — promoted from `inflationRegime.ts`'s local
  copy (still re-exported there so `get-regime-analysis/index.ts`'s
  existing `import { addMonths } from "../_shared/inflationRegime.ts"`
  keeps working unchanged).
- `monthlyGapFill(series, gapMonth)` — the general rule: a month missing
  from a `Map<"YYYY-MM-01", number>`, bracketed by real values in the
  immediately preceding and following calendar months, gets a one-off
  geometric-mean fill. Returns `null` (never fills) for a month that
  isn't actually missing, one missing at a series edge (no neighbor on
  one side), or part of a 2+ consecutive-month gap. Never mutates its
  input.
- `yoyPair` upgraded internally (via a new `findYearAgoWithGapFill`) to
  use this rule when the exact year-ago month is missing; returns
  `usedInterpolatedMonth` (the filled month, or `null`) alongside
  `current`/`previous`.
- `yoyPairWithFallback` (4c) — walks backward through `obs` for the most
  recent position that CAN be paired (with gap-fill already applied at
  each position tried), returning `usedObsDate` and `staleReason`
  (non-null whenever the returned pairing isn't the newest observation).

Confirmed the fill path is inert for quarterly series by construction,
not by a special case: the neighbor check looks for the immediately
preceding/following CALENDAR MONTH in the same `obs` array, and a
quarterly series' real observations are always 3 calendar months apart
— there is structurally never a monthly-adjacent neighbor to find, so
`monthlyGapFill` always returns null for quarterly data regardless of
what gap exists. Verified with a dedicated test
(`tests/yoyMath.test.ts`'s "quarterly-cadence data never spuriously
triggers the fill").

**4b.** `inflationRegime.ts`'s hardcoded `GAP_MONTH = "2025-10-01"` block
replaced with a sweep: for every month between the CPI series' own
first and last observed month, check `monthlyGapFill` and patch the
result into the (already-local, never-mutates-the-caller) `cpi` map if
it applies. This preserves the ORIGINAL architecture exactly — patch a
local working copy up front so every downstream reader (`yoyAt`,
`cpiP75At`'s windowed lookups, `accelAt`'s direct level reads) sees the
filled value transparently — just generalized from one hardcoded date
to any single bracketed gap found anywhere in the series' range.

**Full-history bit-identical diff, confirmed (not spot-checked):** ran
the OLD (`git show HEAD:`) and NEW `classifyInflationRegime` against the
real `tests/fixtures/inflation-regime-fred-snapshot.json` fixture — 1293
rows each. **Zero rows differ** (compared every field via `JSON.stringify`
equality, not just the paper-replication test's broad transition
windows). This confirms the ONLY gap that actually exists anywhere in
real CPIAUCSL history is still the one 2025-10-01 month the old code
hardcoded — the generalization found no OTHER gaps to newly fill, so
production output is genuinely unchanged, not just "unchanged in the
cases I happened to check."

One existing unit test (`tests/inflationRegime.test.ts`, "skips a
missing month's own YoY...") broke as an expected, correct consequence
of generalizing the rule: its synthetic fixture dropped an ARBITRARY
month (not 2025-10-01) from an otherwise-continuous series, which the
OLD hardcoded-to-one-date code correctly left null — but which the NEW
general rule now correctly fills, since it's a legitimately bracketed
single-month gap. Rewrote it into two tests matching Phase 4's own test
checklist: a single bracketed gap now fills (updated expectations,
including the 12-months-later cascade and confirmation-streak count),
and a genuine two-month gap still doesn't fill (new test, both months
stay null). The three existing D-0-specific tests (fills 2025-10
specifically; a sparse fixture with no real adjacent months stays
unfilled; a real print always wins over interpolation) all still pass
unchanged.

**4c.** `yoyPair` callers in `fetch-macro-data` upgraded to
`yoyPairWithFallback`, scoped to the genuinely monthly cases: `yoy_monthly`
(Core CPI, Industrial Production, Retail Sales, M2 Growth, Real
Disposable Income), `yoy_monthly_with_3m` (CPI, PPI), `yoy_monthly_agg`,
and `level_minus_yoy_monthly` (Real Fed Funds — explicitly named in 4d).
Each surfaces `metadata.used_interpolated_month`/`metadata.stale_reason`
when set. `yoy_monthly_with_3m`'s `reference_period` now uses
`yoy.usedObsDate` (the observation actually paired) instead of always
`obs[0].date`, since under the stale-fallback path those differ; its
3-month-momentum (`change3m_pp`) calculation is skipped entirely under
the stale-fallback path rather than computed against a now-mismatched
baseline (`obs[3]` is "3 months before `obs[0]`," a different reference
point than the fallback's actual current reading) — a deliberate,
conservative choice: omitting a metadata field under a known-stale
fallback is safer than quietly computing a momentum figure against the
wrong anchor.

**Deliberately left unchanged (out of scope, logged per rule 6):** the
GDP/quarterly-cadence `yoyPair` call sites (`yoy_quarterly`,
`level_minus_yoy_quarterly`, `level_minus_nominal_yoy_quarterly`,
`effective_rate_minus_nominal_yoy`, `m2_minus_gdp`'s GDP half, and the
regime-history GDP YoY at the bottom of the file) stay on plain `yoyPair`,
not `yoyPairWithFallback`. The gap-fill itself is safe there (inert for
quarterly data, confirmed above), but the STALE-FALLBACK WALK is a
different, untested behavior for quarterly series — unlike the monthly
cases, I haven't verified whether `yoyPairWithFallback`'s backward walk
could ever actually activate for GDP (e.g. around a revision/timing
lag) or what that would mean for those cards. The spec's explicit scope
is "monthly price indexes" and names CPI/Core CPI/Real Fed Funds
specifically; extending the stale-fallback behavior to quarterly GDP
cards wasn't asked for and isn't covered by any diff/test here, so it's
left alone rather than silently widened.

**4e.** `app/macro/page.jsx`'s generic indicator-card component gains
two small note lines, in the same "metadata-driven per-card note" block
that already handles NIPA/r_eff/zscore notes: `used_interpolated_month`
→ "incl. interpolated {Mon YYYY} base"; `stale_reason` → "stale — newest
print not yet pairable" (full reason in the title tooltip).

### Tests

`tests/yoyMath.test.ts` (new): `addMonths` (same-year, year-rollover
both directions); `monthlyGapFill` (single gap filled; two-month gap not
filled; not-actually-missing returns null; never mutates input; edge gap
with no neighbor on one side not filled); `yoyPair` (normal pairing;
single-month gap filled with `usedInterpolatedMonth` tagged — caught my
own mistake writing this one, see below; 2+ month gap returns null;
quarterly cadence never spuriously fills); `yoyPairWithFallback` (direct
case matches plain `yoyPair`; fallback case walks back one position with
`staleReason`/`usedObsDate` set correctly; fully-unpairable series
returns null).

Caught while writing the "fills a single-month gap" test: I initially
asserted the fill showed up in `yoy.current`, but in that fixture
`obs[0]`'s year-ago month (2025-11) was actually present — the gap I'd
built (2025-10) was only the year-ago match for `obs[1]`, meaning it
surfaces in `yoy.previous`, not `yoy.current`. Fixed by checking which
field the fixture's gap actually lands on rather than assuming
position 0 always exercises it.

`tests/inflationRegime.test.ts`: rewrote the broken synthetic-gap test
into "fills a single missing month... via the general gap rule" (updated
expectations) and "does NOT fill a two-month gap" (new), per Phase 4's
own checklist; left the three D-0-specific tests and the sparse/no-real-
neighbors test as-is (still pass; see comment update on the latter for
why it's still valid under the generalized rule).

Full suite: `npx vitest run tests/` → 754 passed (42 files). `npx next
build` → compiles clean, all 27 routes prerender.

### Acceptance (pending live confirmation — not yet deployed)

One gap rule now spans both subsystems (`inflationRegime.ts` and
`fetch-macro-data`'s `yoyPair`), confirmed via the same shared
`_shared/yoyMath.ts` implementation rather than two independent copies.
`inflationRegime`'s output is confirmed bit-identical across its full
real history (1293/1293 rows, zero diffs). **Not yet deployed** — code,
tests, and this log entry are committed; the actual new CPI/Core
CPI/Real Fed Funds values, whether Real Fed Funds' stance label changes,
whether fiscal-dominance conditions 2/4 update to different live numbers
than Phase 3's report, and whether the Daily Summary's core CPI now
matches the corrected card are all reported separately after deploy —
confirmed live, not assumed, per the standing gate.

### Phase 5: backfill net interest / receipts history

**Found two more MTS/FRED "latest-N-unconditionally" bugs while building
this, exactly the kind of sharp edge the standing rules warned about.**
Before writing the backfill itself, tested `_shared/mtsFiscalData.ts`'s
existing helpers against a genuinely historical `asOf` (2023-06-15) — both
of these threw or would have silently misbehaved:

- `fetchMtsNetInterestTrailing12`: fetched MTS Table 9 via
  `sort=-record_date&page[size]=24` — unconditionally "the latest 24
  rows," with NO date filter on the fetch itself. Correct for `asOf=now`
  (the 12 needed month-ends are always within the newest 24), but for any
  `asOf` more than ~1-1.5 years in the past, the needed historical
  month-ends simply aren't in "the latest 24 as of today" — confirmed
  live: calling it with `asOf = 2023-06-15` threw `"no net-interest row
  found for 2022-06-30"`. **Fixed** by filtering the fetch itself via
  `record_date:in:(<the 12 needed month-ends>)` — the same explicit-date
  approach `fetchMtsTable1Trailing12` already used (that one was never
  broken). Confirmed **bit-identical** for `asOf=now` against the old
  implementation (ran both live, identical JSON), and confirmed it now
  succeeds for the 2023-06-15 case that used to throw.
- `fetchTrailingNominalGdp4Q`: same pattern — fetched FRED's `GDP` series
  via `sort_order=desc&limit=6` with no date bound on the fetch, then
  filtered post-hoc by `asOf`. For an old `asOf`, "the latest 6 quarters
  from today" contains zero quarters `<= asOf`, so the post-hoc filter
  would leave fewer than 4 usable quarters and throw. **Fixed** by adding
  `observation_end=<asOf>` to the FRED request itself — the exact pattern
  `fetch-macro-data`'s own `output_gap` case already uses for the same
  reason. **Could not verify this one locally against live FRED data**
  (the FRED API key is a Supabase secret, not available to this
  sandbox's local network — confirmed via `supabase secrets list`, which
  only returns hashed values, by design). High confidence by direct
  analogy to the already-proven `output_gap` pattern, but genuinely
  unverified until deployed — flagging this honestly rather than
  claiming a confirmation I don't have.

**5a implementation.** New one-off function
`supabase/functions/backfill-interest-expense-history/index.ts`
(matching this codebase's existing one-off-backfill convention, e.g.
`backfill-asset-price-history`): for each of the last `months` (default
48 — one year beyond the spec's 3-year minimum) trailing-12 windows
ending each month back from the live card's own current `windowEnd`,
computes net interest ÷ receipts (`REVENUE_PCT_INDICATOR`) and net
interest ÷ nominal-GDP-4Q (`GDP_PCT_INDICATOR`) via the now-fixed shared
helpers, and upserts both into `macro_snapshots` on
`(indicator_name, snapshot_date)` — the table's actual unique
constraint, confirmed via schema read — which **replaces** any existing
NIPA-basis row for that date outright (rule 2.2), rather than adding a
second row. Supports `?dryRun=true` (compute and report without
writing) and `?months=N` for testing a smaller range first.

**Vintage logic — logged as a real limitation, not a silent
simplification (per the explicit instruction).** Checked whether the
Fiscal Data API exposes any as-of/vintage parameter for `mts_table_1`/
`mts_table_9`: it does not — both endpoints return exactly one value per
historical `record_date`, with no way to ask "what did this report say
about June 2023 as originally published, before any later revision."
This backfill therefore uses the **latest revised figures** for every
historical month, not true point-in-time vintages. In practice Treasury
rarely revises MTS figures materially after publication, but this is a
real data-source limitation, not a design choice, and is logged here
explicitly per the spec's instruction.

**`macro_snapshots` has no `metadata` column** (confirmed via
`information_schema.columns`) — so 5a's "keep NIPA values in
`metadata.nipa_pct_*` where they exist" can only ever apply to the LIVE
`macro_indicators` card row (already true since v1 Phase 2, untouched by
this backfill), never to a historical snapshot row — there's structurally
nowhere to put it there. Not a gap introduced by this phase; the
snapshot table was never going to carry per-row metadata.

**Not yet deployed or run.** The backfill function is written and
committed; running it (even in `dryRun=true` mode, since that still
requires live network/secret access this sandbox doesn't have) requires
deploying it first, per the standing gate. Plan once approved: deploy,
run `?dryRun=true&months=48` first and review the full per-month report
for sanity (row count, date range, any `gdpError`/mismatch entries)
before running the real write; then re-evaluate `debtServiceStrained`
and the fiscal-dominance trip-wire against the real backfilled history
(5b) and report the actual numbers — not a projection — along with the
backfill row-count/definition-check assertion (5c's "60-day data floor"
caveat removal is explicitly held until 5b's result is confirmed, per
the spec's own ordering).

### Tests

No new Vitest file — `_shared/mtsFiscalData.ts` has never had one (every
function in it makes live HTTP calls to Treasury/FRED; there's no local
fixture-replay harness for it in this codebase, unlike the pure
`_shared/` modules this session built elsewhere). The two bug fixes were
verified via live `tsx` scripts against the real Treasury API instead
(Table 9's fix: bit-identical for `asOf=now`, and a successful historical
call where the old code threw). The GDP fix is unverified pending deploy
(no local FRED access) — flagged above. Phase 5's own required "backfill
row-count and definition check" will be run as a direct SQL assertion
against `macro_snapshots` after the real backfill write, not a Vitest
file (no local DB to test against) — reported as an explicit pass/fail
result in the post-deploy report, not eyeballed.

Full suite re-run after these edits (confirms nothing else regressed):
`npx vitest run tests/` → 754 passed (42 files, unchanged — this phase
touched no `_shared/` module any existing test imports). `npx next
build` → compiles clean.
