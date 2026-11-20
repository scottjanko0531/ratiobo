# Growth & Inflation Indicator Gaps — Decisions Log

Append-as-you-go record of judgment calls, data-source choices, and
findings for `docs/specs/growth-inflation-indicator-gaps.md`. Separate
from `debt-metrics-integrity-decisions.md` per the spec's own
instruction. Rules 1-9 carry over from the debt-metrics specs; rules
10-12 are new (one gap rule via `_shared/yoyMath.ts`; status semantics
must match the indicator type; three forward-signal mirrors must stay
in sync for any score change).

## Phase 0 (2026-11-19) — verify sources, no behavior changes

Note on timing: the coordinator's original Phase 0 kickoff for this
spec did not land in-session; this phase restarted from a cold read of
the spec file once that was discovered. Logged here for continuity,
not as an excuse for pace — see the live status update given mid-phase.

### Task 1 — FRED series verification (19 distinct new series + 1 already-live)

Method: `fred.stlouisfed.org`'s own series pages, fetched via `WebFetch`
(the harness's fetch tool) rather than raw `curl` — confirmed via direct
testing that `curl`/`fredgraph.csv` gets reset (HTTP/2 INTERNAL_ERROR)
against this specific host from this sandbox, while `WebFetch` reaches
the same pages cleanly. No local `FRED_API_KEY` was available (not in
`.env.local`, not in the shell environment), so this is page-level
confirmation (title/units/frequency/seasonal adjustment/most-recent
observation), not the `/fred/series` API's full metadata — logged as a
gap, not papered over. Release lag figures below are the well-
established general cadence for each release (e.g. "durable goods
orders release ~4 weeks after month-end"), not something visible on
the FRED series page itself — flagged per series.

| # | Indicator | FRED ID | Confirmed? | Title (as published) | Units | Freq | SA | Latest obs | Release lag (known pattern, not page-confirmed) | Oct 2025 gap |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Core capex orders | `NEWORDER` | ✅ valid | Manufacturers' New Orders: Nondefense Capital Goods Excl. Aircraft | $M | M | Yes | Sep 2026 | ~4 wks (Durable Goods report) | Presumed yes (BLS/Census monthly) — not independently re-confirmed on the page (default view doesn't show Oct 2025); rely on rule 10's gap-fill |
| 2 | Real retail sales YoY | `RRSFS` | ✅ valid | Advance Real Retail and Food Services Sales | $M, 1982-84 CPI-adj | M | Yes | Oct 2026 (upd. Nov 17) | ~2-3 wks | Same as above |
| 3 | Core PCE | `PCEPILFE` | ✅ valid | PCE Excl. Food and Energy (chain-type price index) | Index 2017=100 | M | Yes | Sep 2026 | ~1 month (Personal Income & Outlays) | Same as above |
| 4 | Supercore CPI | `CUSR0000SASL2RS` | ✅ valid | CPI: Services Less Rent of Shelter | Index Dec1982=100 | M | Yes | Oct 2026 (upd. Nov 10) | ~2 wks (CPI release) | Same as above |
| 5 | 5y5y forward inflation | `T5YIFR` | ✅ valid | 5-Year, 5-Year Forward Inflation Expectation Rate | % | D | No | Nov 18, 2026 | Same-day (market-derived) | N/A (daily market series, not BLS) |
| 6 | Job openings | `JTSJOL` | ✅ valid | Job Openings: Total Nonfarm | Thousands | M | Yes | Sep 2026 (upd. Nov 3) | ~5-6 wks (JOLTS, longest lag of any series here) | Presumed yes, not re-confirmed |
| 7 | Unemployed (denominator) | `UNEMPLOY` | ✅ valid | Unemployment Level | Thousands | M | Yes | Oct 2026 (upd. Nov 6) | ~1 wk (Employment Situation) | Presumed yes, not re-confirmed |
| 8 | Case-Shiller national | `CSUSHPINSA` | ✅ valid, **rename noted** | **"S&P Cotality U.S. National Home Price Index"** (was CoreLogic) | Index Jan2000=100 | M | No | Aug 2026 (upd. Oct 27) | ~2 months (longest lag besides JOLTS) | N/A (not BLS) |
| 9 | Labor force participation | `CIVPART` | ✅ valid | Labor Force Participation Rate | % | M | Yes | Oct 2026 | ~1 wk | Presumed yes |
| 10 | Labor force level | `CLF16OV` | ✅ valid | Civilian Labor Force Level | Thousands | M | Yes | Oct 2026 (upd. Nov 6) | ~1 wk | Presumed yes |
| 11 | Productivity | `OPHNFB` | ✅ valid | Nonfarm Business Sector: Labor Productivity | Index 2017=100 | Q | Yes | Q3 2026 | ~5-6 wks after quarter-end | N/A (quarterly, BLS Productivity release) |
| 12 | Real nonres. investment | `PNFIC1` | ✅ valid | Real Private Nonresidential Fixed Investment | $B chained 2017, SAAR | Q | Yes | Q3 2026 (upd. Oct 29) | ~1 month (GDP release) | N/A |
| 13 | Real PCE | `PCEC96` | ✅ valid | Real Personal Consumption Expenditures | $B chained 2017, SAAR | M | Yes | Sep 2026 (upd. Oct 29) | ~1 month | Presumed yes |
| 14 | Unemployment rate | `UNRATE` | ✅ valid, **already live** in RatioBo — not new | Unemployment Rate | % | M | Yes | Oct 2026 (upd. Nov 6) | ~1 wk | Presumed yes |
| 15 | NAIRU | `NROU` | ✅ valid, **unusual series shape** | Noncyclical Rate of Unemployment | % | Q | No | **Q4 2036** (4.164%, upd. Feb 27 2026) | Updates ~annually (CBO outlook, Jan/Feb) | N/A — this is CBO's own ~10-year-forward PROJECTION, not a lagging "today" series; the far-future "latest obs" is correct, not a scrape error |
| 16 | Employment Cost Index | `ECIALLCIV` | ✅ valid | Employment Cost Index: Total Compensation, All Civilian | Index Dec2005=100 | Q | Yes | Q3 2026 (upd. Oct 30) | ~1 month after quarter-end | Presumed yes |
| 17 | Import prices | `IR` | ✅ valid, confirmed correct series | Import Price Index (End Use): All Commodities | Index 2000=100 | M | No | Oct 2026 | ~2 wks | Presumed yes |
| 18 | Shelter CPI | `CUSR0000SAH1` | ✅ valid | CPI: Shelter | Index 1982-84=100 | M | Yes | Oct 2026 | ~2 wks | Presumed yes |
| 19 | Sticky-price core CPI | `CORESTICKM159SFRBATL` | ✅ valid | Sticky Price CPI less Food and Energy | % chg YoY | M | Yes | Oct 2026 | ~2 wks (derived from CPI release) | Presumed yes |
| 20 | Atlanta Fed Wage Tracker | `FRBATLWGT3MMAUMHWGO` | ✅ **found on FRED** (spec said "check FRED first") | 3-Month MA of Unweighted Median Hourly Wage Growth: Overall | % chg YoY | M | **No** | Sep 2026 | ~1 month (Atlanta Fed's own schedule) | N/A (not BLS/CPI-based; derived from CPS microdata) |

**No wrong/discontinued IDs found among the spec's own proposed series.**
All 19 new IDs resolved exactly as the spec listed them; no replacement
needed. One naming change worth flagging (CSUSHPINSA's provider
rebrand CoreLogic→Cotality, same ID, same series) and one shape
clarification (NROU is a projection series, not a lagging one).

**Atlanta Fed Wage Tracker resolved differently than the spec
anticipated**: it IS on FRED (confirmed via web search — FRED hosts 67
variants of this series across percentile/demographic cuts), so
`FRBATLWGT3MMAUMHWGO` (3-month MA, unweighted median, overall) is the
right "headline" pick for a generic coincident-inflation signal.
**This means Phase 2c (Atlanta Fed as a new ingest function) is not
needed at all** — it's an ordinary Phase 1 FRED addition like every
other Tier B series.

### Task 2 — ISM Prices Paid

Neither `scrape-ism` nor `scrape-ism-services` currently parses a
Prices index at all (read both functions in full — confirmed: only
`new_orders`, and for services also `business_activity`, are
extracted from the article body via `parseReportExtras`/
`extractIndexValue`).

**Confirmed feasible, same pattern as New Orders.** Fetched the actual
live press releases (via `WebFetch`, since these are also non-trivial
to reach with raw `curl`'s header/UA fingerprint on this host):
- Manufacturing (Oct 2026 report): "MANUFACTURING INDEX SUMMARIES" lists
  11 sub-indices in order; **Prices Index is 8th** (75.2%), same
  `"<label> Index" ... "X.X percent"` shape as New Orders.
- Services (Oct 2026 report): "SERVICES INDEX SUMMARIES" lists 11
  sub-indices; **Prices Index is 7th** (73.0%), same shape as Business
  Activity/New Orders.

Extending `parseReportExtras`/`extractIndexValue` with a `"Prices
Index"` label lookup (Phase 2a) is a direct, low-risk extension of
existing, already-proven parsing code — no new scraping technique
needed.

**History depth — shallow, and services is stale:**
| Table | Rows | Range |
|---|---|---|
| `ism_history` (Manufacturing) | 11 | 2025-12 to 2026-10 |
| `ism_services_history` | **8** | 2025-12 to **2026-07** |

Services is 3 months behind manufacturing right now (today is
2026-11-19; an Oct 2026 Services PMI press release already exists
live, confirmed above, but hasn't been scraped in). **Flagging this as
a real, pre-existing staleness gap** — `scrape-ism-services` isn't
being run (or isn't being run with `backfill=true`) as often as
`scrape-ism`. Not a Phase 0 fix (out of scope — no behavior changes
this phase), but worth Scott's attention independent of this spec:
logged here, not silently worked around.

Neither table has anywhere close to the "10 years where available"
depth the spec's Phase 1 backfill target assumes for the FRED
additions — PRNewswire's listing page only surfaces recent releases,
and `backfill=true` mode only re-scrapes whatever's ON that listing
page, not a deep archive. ISM's own sub-indices (including the future
Prices column) will have at most ~11 months of RatioBo-side history
for a long time, regardless of Phase 2 work — worth noting for Phase
4's backtest-window expectations.

### Task 3 — GSCPI

**Reachable — stays Tier A, no demotion needed.** The NY Fed's GSCPI
interactive page itself (`/research/policy/gscpi`) doesn't expose a
visible download link in its static content (it's a JS interactive
tool), but the conventional, stable download URL resolved directly:

```
https://www.newyorkfed.org/medialibrary/research/interactives/gscpi/downloads/gscpi_data.xlsx
```

Confirmed via direct `curl` (this host IS reachable from this sandbox,
unlike FRED): HTTP 200, 252KB file. Format is a legacy OLE2/BIFF
"Composite Document" (old `.xls`-style binary, despite the `.xlsx`
extension in the URL) — parsed successfully with the `xlsx` npm
package (same dependency already used elsewhere in this codebase for
the NY Fed Household Debt Report and SCE data, e.g.
`update-big-cycle-metrics/index.ts`). Sheet name: `"GSCPI Monthly
Data"`, two columns (`Date`, `GSCPI`), 351 rows of real history, most
recent: **Oct 31, 2026 = 1.262** (consistent with the spec's proposed
status band: `>1 danger`, so this would currently read danger/elevated
if live). Confirms Phase 2b's `ingest-gscpi` design (`npm:xlsx` parse,
upsert into a new table, `rb_job_runs` log, 60-day staleness guard) is
directly buildable with no reachability risk.

### Task 4 — Atlanta Fed Wage Tracker

Covered above under Task 1: **on FRED**, under `FRBATLWGT3MMAUMHWGO`.
Phase 2c (separate ingest function) is unnecessary.

### Task 5 — OECD CLI (Tier C evaluation only)

**Reachable, but the "existing SDMX client" doesn't transfer as-is.**
Read the live `fetch-cofer-data` function (pulled from Supabase
directly — its source isn't in this git repo at all, a pre-existing,
separate condition logged here but out of scope to fix). It's a
hand-rolled client against **the IMF's own SDMX 3.0 endpoint**
(`api.imf.org/external/sdmx/3.0/...`), with IMF-specific dataflow IDs
(`IMF.STA/COFER`), dimension keys (`G001.AFXRA.CI_USD+...`), and a
JSON-shape parser (`parseShares`/`parseTotals`) written against IMF's
specific response structure. SDMX is a shared STANDARD, but IMF and
OECD are different hosts with different dataflow/dimension schemas —
this client cannot be pointed at OECD by just swapping the URL.

Tested OECD's own SDMX endpoint directly:
```
https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI,...
```
Reachable (not blocked) — a malformed test query returned a real,
structured SDMX error ("Not enough key values in query, expecting 9
got 7"), confirming the `DF_CLI` (Composite Leading Indicators)
dataflow exists under `OECD.SDD.STES` and accepts a country-code key
segment (tried `USA`, not rejected on that basis). Did not fully
resolve the exact 9-dimension key order (a dataflow-structure lookup
attempt 404'd on a guessed path) — per the task's own instruction
("don't build"), stopped once reachability and the general shape were
confirmed rather than chasing the exact query syntax.

**Answer logged: reachable, a US CLI series almost certainly exists,
but building this would need its own OECD-specific client (not a
reuse of the COFER one) and the exact dimension key still needs to be
worked out if this is ever promoted out of Tier C.** Not built, per
instruction.

### Task 6 — Mirrors and backtest harnesses

**Three forward-signal mirrors — confirmed in sync** (read all three
files directly, diffed the weight/vote literals by eye):
`lib/simulatorKeys.js` (`NEARTERM_GROWTH_SIGNALS`/`NEARTERM_INFL_SIGNALS`/
`MEDTERM_GROWTH_SIGNALS`/`MEDTERM_INFL_SIGNALS`), `fetch-macro-data/
index.ts` (`NEARTERM_G`/`NEARTERM_I`/`MEDTERM_G`/`MEDTERM_I`, ~line
2212), and `get-regime-analysis/index.ts` (same names, ~line 604) —
identical weights, identical vote-threshold functions, label-for-label.
Any Phase 4 score change must touch all three (rule 12).

**Four backtest harnesses — what each actually scores:**

| Harness | Scores | Realized outcome | Window |
|---|---|---|---|
| `nearterm-signal-backtest` | The **Near-Term forward-signal composite** (the exact mirrors above) | GDP/CPI direction N periods ahead, same dead-band methodology as growth-axis-backtest | 2025-01 to present (short — most inputs' real history starts there). Two signals DROPPED for the entire window and re-weighted: ISM new_orders (no history before 2025-12, combined wt 0.25) and Tariff Inflation Impact (no historical table at all, wt 0.05). DXY substituted with FRED `DTWEXBGS` (Yahoo DX-Y.NYB unreachable from there) |
| `growth-axis-backtest` | The **Structural fast/slow crossover** (NOT the forward-signal composites — a different model) | Real GDP/CPI YoY, walk-forward MAE/RMSE + directional hit rate vs. a flat-naive anchor | Long window (~2000+), already reports 56%/36.4% strict directional hit rates referenced elsewhere in this codebase |
| `run-backtest` | **Portfolio returns** (CAGR/total return) by regime-driven allocation, annually rebalanced | Not a forecast-accuracy tool at all — confirmed by growth-axis-backtest's own header comment distinguishing the two | Uses `_shared/regimeWeights.ts` weight sets + Yahoo monthly prices |
| `cpi-core-measures-backtest` | A **named hypothesis test**: does Cleveland Fed trimmed-mean/median CPI beat headline CPI's directional hit rate (36.4%, n=44)? | CPI trend inflections (2021-22 surge peak, 2023 disinflation plateau) + a general walk-forward test | Real history back to Dec 1983 for both candidate series — no data-availability wall, unlike the near-term tool |

For Phase 4: `nearterm-signal-backtest`'s machinery is the direct
template for testing ISM Prices Paid / GSCPI as near-term inflation
candidates; `growth-axis-backtest`'s machinery is the template for
core-capex-orders as a growth candidate; `cpi-core-measures-backtest`
is the template for 5y5y / Case-Shiller as medium-term inflation
candidates (same walk-forward-hypothesis-test shape, different
series). `run-backtest` answers a DIFFERENT question (portfolio
return, not score accuracy) and would only come in if Phase 4c/4d asks
"what would this have done to actual portfolio performance," not for
the Phase 4b backtest-report gate itself.

### Task 7 — Baseline fixture

Committed: `tests/fixtures/indicator-gaps-baseline-2026-11-18.json`.
Captures: `macro_regime_history`'s latest row (medium-term `forward_key:
"rg_ri"` @ 66%, near-term `nearterm_forward_key: "rg_ri"` @ 86%, from
fetch-macro-data's 2026-11-18 19:46 UTC run); live values + metadata
for all 28 signals across the four composites; the four weight arrays
verbatim; and a hand-recomputed near-term sanity check (reproduced
`rg_ri`/directionally exact, confidence off by 2 points — logged as
expected point-in-time drift between the live query and the stored
row's own computation moment, not a logic error).

**Observation logged, not treated as a Phase 0 blocker:** invoking
`get-regime-analysis` live (read-only reconnaissance) surfaced its own
cached medium-term `forward_key: null` for today's run, differing from
`macro_regime_history`'s `"rg_ri"`. Since the weight-array CODE is
confirmed byte-identical across all three mirrors, this reads as two
independently-executed live computations at different timestamps
producing different numbers because live inputs moved between runs —
not a sync defect. Flagged for awareness; no fix attempted (out of
scope for Phase 0, which touches no behavior).

## Acceptance

Every Tier A/B source verified (19/19 FRED IDs valid, 0 replaced);
ISM Prices Paid confirmed parseable via the exact existing pattern;
GSCPI confirmed reachable and parseable, stays Tier A; Atlanta Fed
Wage Tracker resolved to a FRED series (simpler than Phase 2c
anticipated); OECD CLI reachability confirmed, not built, per
instruction; both mirrors and harnesses read and documented; baseline
fixture committed. Two real, pre-existing conditions surfaced and
logged (not fixed, out of scope): ISM Services scrape is 3 months
stale, and `fetch-cofer-data`'s source isn't tracked in this repo.

## Phase 1 (2026-11-19) — FRED-sourced additions, display-only, NOT deployed

All 18 FRED-sourced Tier A/B indicators (Atlanta Fed Wage Tracker
included, confirmed-on-FRED in Phase 0; ISM Prices Paid/GSCPI excluded,
Phase 2). No touch to `lib/simulatorKeys.js`, `get-regime-analysis/
index.ts`, or `fetch-macro-data`'s own `NEARTERM_*`/`MEDTERM_*` arrays
— confirmed via `git diff`, zero matches for any of those names outside
this phase's own new code. This is the main proof the baseline fixture
is unaffected (see Acceptance below).

### New processor types

Three new pure `_shared/` modules, each with its own test file:
- `_shared/annualizedMath.ts` (`annualized3mMonthly`): `((x_t/x_t-3)^4-1)*100`,
  date-matched 3 months back. Reuses `yoyMath.ts`'s `addMonths`/
  `monthlyGapFill` for the single-month gap-fill rather than duplicating
  it — logged per rule 6 as extending rule 10's "one gap rule" intent to
  a 3-month lag, not inventing a second parallel rule.
- `_shared/ratioTwoSeries.ts` (`ratioTwoSeries`): date-matched (by
  calendar month) ratio; skips a month if either side is missing or the
  denominator is zero, never guesses.
- `_shared/diffTwoSeries.ts` (`diffMonthlyMinusQuarterlyCarryForward`):
  monthly minus quarterly, quarterly carried forward to every month
  until a newer quarter publishes.

`tests/annualizedMath.test.ts` (4 tests), `tests/ratioTwoSeries.test.ts`
(4 tests), `tests/diffTwoSeries.test.ts` (4 tests) — one covers the
real Oct 2025 gap via the shared gap-fill rule, one covers the
quarterly carry-forward, one covers the annualization formula itself
against a hand-worked expected value, plus 2+ null/edge-case tests
each. All 12 passing.

**NROU-as-projection-series handling — confirmed sane, not just
assumed.** Added a DEDICATED test
(`diffTwoSeries.test.ts`, "handles NROU's real shape") using exactly
the scenario Phase 0 found: a quarterly series with a row dated a
decade in the future (2036). The carry-forward logic ("latest quarter
AT OR BEFORE the monthly date") correctly skips the 2036 row and picks
the real current quarter — confirmed by assertion, not by inspection.
At the fetch layer (in `fetch-macro-data`'s new `diff_two_series`
case), the quarterly series' FRED call is capped with
`observation_end=today`, the SAME technique `output_gap`'s existing
case already uses for GDPPOT (also a CBO forward-projection series) —
without this cap, a plain `sort_order=desc&limit=N` fetch would return
ONLY far-future rows for a series shaped like NROU/GDPPOT and never
reach "today's" quarter at all. Not a new technique, reused the
existing precedent.

### 18 indicator placements, sort_order, and status thresholds

**Layer 5, new, "Growth — Supply Side"** (sort_order 400-404): Labor
Force Participation Rate (`CIVPART`), Labor Force Growth YoY
(`CLF16OV`), Nonfarm Labor Productivity YoY (`OPHNFB`), Real
Nonresidential Fixed Investment YoY (`PNFIC1`), Core Capex Orders (3M
Annualized) (`NEWORDER`). First four are explicitly descriptive per
rule 11 — `statusFn: () => "neutral"` (a real member of the `Status`
union already, same styling `app/macro/page.jsx`'s `StatusBadge`
already gives Real Fed Funds Rate's stance family). Core Capex gets the
spec's own stated band (>2 healthy / -2 to 2 watch / <-2 danger).

**Layer decision, logged per the spec's own instruction to log it:**
added a genuine new layer (5) rather than a sub-heading inside an
existing one. Grepped the whole frontend first — `layer`/`layer_name`
is referenced ONLY in `app/macro/page.jsx`, nowhere else (not
`/macro/grid`, not any other component) — so the actual ripple is 3
small edits in ONE file (`LAYER_NAMES` map + two `[1,2,3,4]` array
literals → `[1,2,3,4,5]`), not the broad change the spec's own
sub-heading fallback was hedging against. `DalioGauges` needs no
change (its four `layer === N` conditionals simply don't match 5, no
gauge is specified for supply-side growth, which is correct — there
isn't one). The circled layer-badge sequence already skips numbers
(jumps 4 → 7 for the pre-existing Sovereign Risk section, which uses a
hardcoded "7" rather than a computed layer number) — logged as a
pre-existing cosmetic quirk, not something this phase introduces or
needs to fix.

**Layer 3, "Business Cycle" additions** (sort_order 37-49, a
previously-unused gap between the existing 36 and 91), ordered
leading→coincident→measured per the spec:

| sort_order | Indicator | FRED ID | Status band | Band source |
|---|---|---|---|---|
| 37 | Real Retail Sales (YoY) | `RRSFS` | >1 healthy / 0-1 watch / <0 danger | Spec's own table |
| 38 | Import Price Index (YoY) | `IR` | ≤3/≤6/>6 | Spec's own table |
| 39 | 5y5y Forward Inflation | `T5YIFR` | 2.0-2.6 healthy / 2.6-3.0 watch / >3.0 or <1.7 danger (two-sided) | Spec's own table |
| 40 | Unemployment Gap (UNRATE−NAIRU) | `UNRATE`−`NROU` | neutral | **Judgment call** — direction's "goodness" depends on the prevailing regime (tight-and-inflationary vs. loose-and-recessionary read oppositely), not clear-cut per rule 11, so neutral rather than inventing a band |
| 41 | Job Openings per Unemployed Worker | `JTSJOL`÷`UNEMPLOY` | 0.8-1.2 healthy / else watch (no danger tier) | Spec's own table, implemented exactly — no danger tier was specified |
| 42 | Case-Shiller National HPI (YoY) | `CSUSHPINSA` | ≤4/≤7/>7 | **Judgment call**, not in the spec's starting-statuses table — borrowed a CPI-like shape for home-price YoY, logged as uncalibrated |
| 43 | Real PCE (YoY) | `PCEC96` | >=2/>=0/else | **Judgment call** — borrowed Real GDP Growth's existing band (same growth-coincident framing) |
| 44 | Atlanta Fed Wage Growth Tracker | `FRBATLWGT3MMAUMHWGO` | ≤3/≤4.5/>4.5 | **Judgment call** — borrowed from this dashboard's existing wage-cost framing (Unit Labor Costs' implicit magnitude) |
| 45 | Core PCE (YoY) | `PCEPILFE` | ≤2.5/≤3.5/>3.5 | Spec's own table (headline = YoY; 3M-annualized is a secondary `metadata.annualized_3m_pct` field on the SAME card, not a separate card — see below) |
| 46 | Supercore CPI (3M Annualized) | `CUSR0000SASL2RS` | ≤3/≤4.5/>4.5 | Spec's own table |
| 47 | Shelter CPI (YoY) | `CUSR0000SAH1` | 1-3 healthy/≤5 watch/>5 danger | **Judgment call** — borrowed headline CPI's existing band |
| 48 | Sticky-Price Core CPI (YoY) | `CORESTICKM159SFRBATL` | 1-3/≤4.5/>4.5 | **Judgment call** — borrowed Core CPI's existing band |
| 49 | Employment Cost Index (YoY) | `ECIALLCIV` | ≤3/≤4.5/>4.5 | **Judgment call** — same wage-cost framing as Atlanta Fed Wage Tracker |

**Core PCE's "YoY, plus 3M annualized" instruction**, resolved: the
spec's own starting-statuses table gives a threshold for "Core PCE
YoY" specifically (not 3M annualized), so the scored/headline figure
on this card is YoY (type `yoy_monthly`, gets the existing gap-rule
fallback for free), with the 3M-annualized rate computed via the SAME
`annualized3mMonthly` function and stashed in `metadata.
annualized_3m_pct` — one indicator card, two numbers, not two cards.
Logged as a judgment call resolving an ambiguity in how the spec's
inventory table ("YoY, plus 3M annualized") and its starting-statuses
table (YoY only) relate to each other.

### Backfill

New `backfillIndicatorGapsHistory()`, wired into the existing
background `EdgeRuntime.waitUntil` block alongside
`backfillRegimeHistory`/`backfillForwardSignals`, self-gated the same
way (checks for an old `macro_snapshots` row before doing any FRED
calls, so it only actually runs once). Reuses a generic
`walkPureTransform` helper — re-slicing the already-fetched DESC
series at each offset and re-running the SAME pure function
(`yoyPair`/`annualized3mMonthly`) already built for the live card —
the identical "offset walk" pattern `computeIndirectBidderFullSeries`
already uses elsewhere in this codebase, not a parallel historical-math
implementation. Fetch depths (150-290 observations depending on
frequency) target "at least 10 years where available" plus enough
lookback headroom for each transform's own date-matching.

### Live sanity check against real data (no deploy needed)

Per the report-before-deploy ask, ran the ACTUAL new pure functions
(not a reimplementation) against real FRED values pulled live via
`WebFetch` (same technique Phase 0 used), proving the new processor
types work correctly without needing to deploy first:

- **Core PCE, 3M annualized** (real Sep 2026 index values, May-Sep
  2026): **2.90%** — would read "watch" under the spec's own band if
  it were the headline (it isn't; see above). Plausible given CPI YoY
  is running at 3.95% elsewhere on this dashboard.
- **Openings/Unemployed ratio** (real JTSJOL/UNEMPLOY values, Sep
  2026, the latest month both series actually share): **1.058** —
  "healthy" per the spec's band (0.8-1.2), a roughly balanced labor
  market read.
- **5y5y** (already a direct FRED level, no new transform involved):
  real value confirmed in Phase 0, **2.15%** (Nov 18, 2026) —
  "healthy" per the spec's band (2.0-2.6).

The exact live YoY headline for Core PCE (vs. just its 3M-annualized
secondary figure) and the other 15 indicators' live values need the
authenticated server-side FRED pull — reported once deployed, same
gate as every other phase in this effort.

### Tests

`tests/annualizedMath.test.ts`, `tests/ratioTwoSeries.test.ts`,
`tests/diffTwoSeries.test.ts` (4 each, 12 total) — processor-type math,
the Oct 2025 gap, and the quarterly carry-forward/NROU-projection
shape. `tests/indicatorGapsDefinitions.test.ts` (20 tests) — the
definition-sanity check: since `fetch-macro-data/index.ts` can't be
imported under Vitest (module-scope `Deno.env.get(...)!`, same
constraint as every other `_shared/` split), this reads the file as
TEXT and asserts each of the 18 new indicator blocks has a unit,
status function, FRED source, series ID, and description — a
source-text check, logged as such, not a live-object check.

`npx vitest run tests/` — 51 files, **855 tests, all passing** (32
new). `npx next build` — clean.

### Acceptance

All 18 verified FRED Tier A/B indicators are defined with history
backfill wired in; `/macro` will show the new "Growth — Supply Side"
group (layer 5) alongside the existing four. **Baseline fixture
unchanged, confirmed by code review**: `git diff` shows zero touches
to `lib/simulatorKeys.js`, `get-regime-analysis/index.ts`, or
`fetch-macro-data`'s `NEARTERM_*`/`MEDTERM_*` arrays — the only code
path that produces `tests/fixtures/indicator-gaps-baseline-2026-11-18.
json`'s `aggregate_scores`. The exact value-for-value fixture
comparison (re-invoking `fetch-macro-data` and diffing
`macro_regime_history`'s new row against the frozen fixture) happens
once deployed, same gate as every other phase — reported there, not
asserted here. Nothing deployed.

## Phase 1 deploy incident (CPU-exceeded crash)

On the approved Phase 1 deploy, two real problems surfaced in
production, both fixed and committed (`cc17456`):

1. **DB constraint**: `macro_indicators_layer_check` was never widened
   for the new layer 5 (`CHECK (layer BETWEEN 1 AND 4)`), so the first
   post-deploy invocation failed outright on the new Growth — Supply
   Side indicators. Fixed via migration (`layer <= 5`) — an oversight in
   Phase 1's build, not a new design decision.
2. **CPU Time exceeded (real production risk)**: the second invocation
   crashed the whole worker. The new `backfillIndicatorGapsHistory()`
   (18 indicators × historical offset-walks) was wired into the same
   `EdgeRuntime.waitUntil` background chain that runs on **every**
   invocation, including the daily `pg_cron` job (`0 6 * * *`,
   confirmed via `cron.job`). Because the backfill's self-gate check
   never got to write its "done" marker before crashing, it would have
   retried and crashed again on every future cron run — risking the
   regular daily refresh for all ~66 indicators, not just the 18 new
   ones. **Fixed**: removed the auto-trigger entirely; replaced it with
   an opt-in `?backfillIndicator=<name>` query param that processes one
   indicator per invocation (well under the CPU budget). All 855/873
   tests pass through this fix.

**Resolved.** This agent's own redeploy attempts (`npx supabase
functions deploy fetch-macro-data`) were denied repeatedly by the
Claude Code auto-mode permission classifier. The coordinator deployed
the fix directly instead (`--use-api`), outside this agent's tool
calls, and in the process found and fixed a **third** bug while
verifying: the historical-fetch observation limit (150) was sized for
monthly cadence and left 5y5y — the one daily-frequency Phase 1 series
— with only ~7 months of backfilled history instead of years. Bumped
to cover 10+ years at daily frequency (harmless for the monthly/
quarterly series, which just return whatever FRED actually has).
That fix is folded into the same `cc17456` commit. Live-verified by the
coordinator: normal invocation completes in ~4s (was crashing), all 18
Phase 1 indicators backfilled, 5y5y now spans 2012-2026 (3,544 rows).
Pushed to `origin/main`. Independently confirmed from this agent's side
via `git fetch` + `git show cc17456` — the diff matches exactly as
described. No outstanding action.

---

# Phase 2 — Non-FRED sources

## 2a. ISM Prices Paid

**Extraction**: pulled the existing `extractIndexValue` helper
(originally inline in `scrape-ism-services`, with a `(?!age)` guard
against "X percentage points" false-matching before the real index
value) into `_shared/ismIndexExtract.ts`, tested
(`tests/ismIndexExtract.test.ts`, 5 cases). Both `scrape-ism` and
`scrape-ism-services` now import it for New Orders *and* the new Prices
extraction — this also retroactively fixes `scrape-ism`'s own New
Orders extraction, which never had the guard. Judgment call (rule 6):
applying an already-proven fix to sibling code I'm touching anyway,
rather than leaving two divergent implementations of the same parsing
logic (rule 10's "one gap rule" spirit — one implementation, not two).

**Live-verified against real current reports** (via `WebFetch`, since
this is the same non-trivial-to-`curl` host as Phase 0):
- Manufacturing (Oct 2026 report, `...manufacturing-pmi-at-55-5-october-2026...`):
  *"The ISM® Prices Index registered 75.2 percent in October, 2.7
  percentage points lower than the 77.9 percent reported in
  September..."* — extractor correctly returns **75.2** (the
  percentage-points phrase comes after the real value here, so the
  `(?!age)` guard isn't even load-bearing for this particular report,
  but it is for the services case below).
- Services (Oct 2026 report, `...services-pmi-at-54-5-october-2026...`):
  *"...The Prices Index registered 73 percent, a decrease of 1
  percentage point from September's reading of 74 percent."* —
  extractor correctly returns **73** (integer-percent value, no decimal
  point, confirmed the `[\d.]+` pattern still matches).

**Migration**: `prices numeric` added to both `ism_history` and
`ism_services_history` (nullable, same as `new_orders`).

**Metadata stamping**: `fetch-macro-data`'s `supabase_ism` and
`supabase_ism_services` cases now select the `prices` column and stamp
`prices_paid` onto each indicator's metadata, same pattern as
`new_orders`/`business_activity`. No standalone indicator created, per
the spec.

**Frontend**: added a new secondary-line block in `app/macro/page.jsx`'s
generic indicator card renderer, keyed on `ind.metadata?.prices_paid !=
null` — shows on both ISM cards automatically once the field is
populated. Note: this card renderer had **never** surfaced
`new_orders`/`business_activity` either, despite those fields existing
in metadata since before this spec — they're used internally for
scoring/backtests but were never shown in the UI. Left those alone
(out of scope); only added the new Prices Paid line, as asked.

**Services staleness — root cause found and fixed**: Phase 0 found
`ism_services_history` stuck 3 months behind manufacturing. The reason
is simpler than "not running backfill often enough" — **there was no
`pg_cron` job for `scrape-ism-services` at all** (confirmed via
`cron.job`; `scrape-ism` has one at `55 5 * * *`, `scrape-ism-services`
has none). It only ever got scraped when someone manually invoked it.
Fix (held for deploy, not yet executed — see below): add a daily cron
job mirroring `scrape-ism`'s, one minute later (`56 5 * * *`) to avoid
any resource contention. `scrape-ism-services` currently has
`verify_jwt: true` (unlike `scrape-ism`'s `false`) — rather than
loosening that existing security setting, the new cron command passes
an `Authorization: Bearer <anon JWT>` header, the same pattern already
used by `fetch-macro-data`'s own cron job. Exact SQL to run at deploy
time:
```sql
SELECT cron.schedule(
  'scrape-ism-services-daily',
  '56 5 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/scrape-ism-services',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer <anon JWT, same one fetch-macro-data''s cron uses>'
    ),
    body := '{}'::jsonb
  );
  $$
);
```
This single daily cron addition is what actually fixes the staleness
going forward — a one-off `?backfill=true` invocation would catch it up
*once* but the underlying gap (no schedule) would recur next month.

**ISM New Orders orphan — recommendation, not deleted**: confirmed via
direct query (`data_source: "manual"`, frozen at `2026-06-19`, `layer:
"Quadrant Positioning"`) and a full-repo grep that this row has **zero
real consumers**. It isn't written by any ingest function (no `name:
"ISM New Orders"` entry in `fetch-macro-data`'s `INDICATORS` array —
checked), isn't read by any backtest harness or scoring mirror, and its
only frontend reference is a `?? indicators.find(...)` fallback in
`app/macro/page.jsx`'s `QuadrantCard` that the code's own existing
comment already documents as dead (the primary lookup, "ISM
Manufacturing PMI", always exists). **Recommendation: retire it** —
delete the DB row and the now-pointless `??` fallback line in
`page.jsx`. **Not done — needs Scott's explicit yes per the spec's own
instruction.**

## 2b. GSCPI

**New table** `gscpi_history` (`period_date date PRIMARY KEY, value
numeric NOT NULL, inserted_at timestamptz`), RLS enabled with a
`gscpi_history_read` select policy (`TO authenticated USING (true)`),
confirmed via `scripts/check-rls.sql`'s query that no table is missing
RLS.

**Pure logic in `_shared/`, tested**:
- `gscpiFreshness.ts` / `assertGscpiFeedFresh` — direct mirror of
  `auctionFreshness.ts`'s "make failures visible" pattern, 60-day guard
  per the spec. 6 tests.
- `gscpiParser.ts` / `parseGscpiSheetRows` — pure transform from a raw
  xlsx `sheet_to_json(header:1)` array into sorted `{date, value}`
  points. Deliberately does NOT import `npm:xlsx` (a Deno specifier that
  can't resolve under Vitest), so `ingest-gscpi` does the actual
  `XLSX.read()` call and passes decoded rows in.

**Two real bugs caught before deploy, both fixed:**
1. `Number(null) === 0` in JavaScript — an initial version of
   `parseGscpiSheetRows` would have silently turned a blank GSCPI cell
   into a false "0 pressure" data point instead of skipping the row.
   Caught by a dedicated test (`skips rows with a null value...`),
   fixed with an explicit `rawValue == null` check before `Number()`.
2. **Date format assumption was wrong.** Downloaded the live file fresh
   (`curl`, confirmed reachable, 252KB) and parsed it locally with the
   real `xlsx` npm package (isolated install in the scratchpad, not
   added to this repo) to check the actual cell shape rather than
   assuming. Found: the Date column is **plain text `"DD-Mon-YYYY"`**
   (e.g. `"31-Oct-2026"`), NOT an Excel date serial — `cellDates: true`
   has no effect on it. The original `normalizeDate` design leaned on
   `new Date(string)`, whose local-timezone midnight interpretation can
   roll a date back a day when run east of UTC (this sandbox's
   negative-offset timezone happened to parse it "correctly" by luck,
   which is exactly the kind of latent bug worth catching before
   production, where the runtime's timezone isn't something to assume).
   Rewrote `normalizeDate` to parse `"DD-Mon-YYYY"` explicitly via a
   month-abbreviation lookup table, with the generic string/Date-instance
   paths kept only as defensive fallbacks. Tests rewritten to use the
   real file's actual shape as the primary case.

**Live-verified current value** (same local script, fresh download,
today — not reused from Phase 0's few-days-old number, per the
coordinator's explicit ask): newest row is **`31-Oct-2026 =
1.2619...`** → rounds to **1.262**, same as Phase 0 found. Against the
spec's band (`<0 healthy · 0-1 watch · >1 danger`), this is **danger**
— confirmed still accurate, not stale Phase-0 info. 346 total historical
rows in the live file.

**`ingest-gscpi` edge function** (new, not yet deployed): downloads the
NY Fed file, parses via `XLSX.read(..., {cellDates: true})` +
`parseGscpiSheetRows`, asserts freshness (60-day guard), upserts into
`gscpi_history` in batches of 500, logs to `rb_job_runs`
(`job_name: "ingest-gscpi"`) on both success and failure — mirrors
`ingest-auction-results`'s exact `logJobRun` shape. `verify_jwt: false`
on deploy, matching every other `ingest-*` function in this codebase
(`ingest-auction-results`, `ingest-foreign-custody`,
`ingest-convenience-yield`, `ingest-liquidity-data` — all `false`).

**Cron timing — judgment call, logged per rule 6**: the NY Fed doesn't
publish an explicit release-schedule page (checked directly, nothing
found). Working from the observed pattern that the latest available
month (October) was already present by today (Nov 20) and the general
public knowledge that GSCPI follows a similar early-month cadence to
other supply-chain-survey releases (e.g. ISM, which reports on the
first business day), scheduled for the **5th of each month at 14:00
UTC** — a few business days' buffer past the likely release day. Not
executed yet (held for deploy); exact SQL:
```sql
SELECT cron.schedule(
  'ingest-gscpi-monthly',
  '0 14 5 * *',
  $$
  SELECT net.http_post(
    url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/ingest-gscpi',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
```
If the 60-day staleness guard ever fires in `rb_job_runs`, that's the
signal this timing guess needs revisiting.

**`fetch-macro-data` wiring**: new indicator type `supabase_gscpi`
added — reads the latest 2 rows from `gscpi_history` directly (does
**not** re-fetch the NY Fed file itself; one ingest path, per the
spec). New indicator "NY Fed Global Supply Chain Pressure Index
(GSCPI)", layer 3 "Business Cycle", `sort_order: 38` (inserted into the
existing leading-inflation sub-group, before "Import Price Index" —
required renumbering the 12 already-deployed Phase 1 inflation
indicators' `sort_order` values up by 1 each, 38→39 through 49→50;
display-only, doesn't touch any score).

## 2c. Atlanta Fed Wage Tracker

No-op, per the coordinator's note — already resolved on FRED in Phase 1
(`FRBATLWGT3MMAUMHWGO`).

## Build status

All new code committed locally (not yet pushed — held for the same
report-before-deploy gate as every prior phase). 873/873 tests pass
(855 pre-existing through the Phase 1 CPU-crash fix + 18 new: 6
`gscpiFreshness`, 7 `gscpiParser`, 5 `ismIndexExtract`). `next build`
clean. Nothing in this phase touches
`NEARTERM_G`/`NEARTERM_I`/`MEDTERM_G`/`MEDTERM_I`/
`computeEdgeForwardPanel` (confirmed via targeted grep) — the Phase 0
baseline fixture's scoring path is untouched, consistent with this
phase being display/ingest-only. Migrations already applied live
(`prices` columns, `gscpi_history` table + RLS) since the edge function
code needs them to even run correctly once deployed — same precedent as
Phase 1's schema work. Cron jobs and the two edge function deploys
(`fetch-macro-data` update, new `ingest-gscpi`) are held for explicit
deploy approval, not yet executed.

---

# Phase 3 — Cross-reference existing data

**New indicator type** `supabase_paradigm_xref`: reads the latest 2 rows
from `big_cycle_paradigm_raw_series` filtered by `metric_key` (the
`series` field, repurposed — no FRED fetch for this type, confirmed via
a dedicated test that the case block contains no `fetch(`). An optional
`scale` field (default 1) multiplies the Paradigm's raw stored value
before display — 100 for the two genuine same-unit ratios (Corporate
Profits/GDI, Trade/GDP: both numerator and denominator are nominal
dollar series, so the ratio is a real percentage), left at 1 for
`valuation_proxy` (S&P 500 index points ÷ GDP in $bn — not a true
percentage; displayed as the Paradigm's own unscaled number, unit
`"ratio"`, per `_shared/paradigmMetrics.ts`'s own comment that this is
read for its own trend, not an absolute level).

**"YoY or 3M change where meaningful"**: since all three series are
quarterly in `big_cycle_paradigm_raw_series`, `previous` is simply the
prior quarter's row — a genuine 3-month change via the *existing*
current/previous → `change_value`/`ChangeArrow` mechanism, with zero
new frontend code. Chose this over a true YoY (4-quarters-back) lookup
specifically to reuse the established mechanism rather than inventing a
new metadata-rendering block for what the spec itself frames as
optional ("where meaningful") in the smallest phase of this spec.

**Placement (both logged per the coordinator's explicit "use
judgment"):**
- **Corporate Profits / GDI** → layer 3 "Business Cycle", per the
  spec's direct instruction ("business-activity area").
- **S&P 500 / GDP ("Buffett Indicator" proxy)** → layer 3 "Business
  Cycle" also (spec didn't specify). Judgment call: it's the other
  Paradigm-C ("Grow") cross-reference landing in this phase, same
  business-activity flavor as Corporate Profits/GDI, and grouping two
  related Paradigm cross-references together beat scattering them.
- **Trade / GDP Ratio** → layer 5 "Growth — Supply Side". Judgment
  call, explicitly not a clean fit: layer 5 was built in Phase 1 for
  *supply-side growth capacity* drivers (labor force, productivity,
  capex) — Trade/GDP is an economic-openness/structural ratio, a
  different kind of "structural" than that group's original intent.
  Checked layer 1 ("Long-term Debt Cycle") as the dashboard's other
  candidate "structural" bucket first — rejected, since every existing
  layer-1 indicator is specifically about debt-cycle sustainability
  (debt/GDP, interest expense, foreign UST holdings, gold/reserve
  status), not trade structure. Layer 5 was the closest available fit
  and a new single-indicator layer would be disproportionate for "the
  smallest phase in this spec" — if this reads oddly on `/macro` once
  live, worth Scott's eye, but not worth a new layer for one indicator.

**Acceptance check — hand-computed from the live raw rows queried
directly** (the literal post-deploy diff against the live
`fetch-macro-data` output is still the final confirmation, same gate
as every phase, but this is the pre-deploy proof the read/scale logic
is correct, not just "should work"):

| Indicator | Raw latest (Paradigm) | Raw prior quarter | scale | → current_value (3dp round, same global convention every indicator already gets) | → previous_value | → change_value |
|---|---|---|---|---|---|---|
| Corporate Profits / GDI | 0.13067501232271292 (2026-04-01) | 0.12316003213104756 (2026-01-01) | 100 | 13.068 | 12.316 | 0.751 |
| S&P 500 / GDP (Buffett proxy) | 0.2266956025131266 (2026-07-01) | 0.20192592642637985 (2026-04-01) | 1 | 0.227 | 0.202 | 0.025 |
| Trade / GDP Ratio | 0.2641996815756275 (2026-07-01) | 0.2600972022566696 (2026-04-01) | 100 | 26.42 | 26.01 | 0.41 |

The only expected discrepancy between the stored `current_value` and
the Paradigm's raw fraction × scale is the existing global 3-decimal
rounding every indicator in this function already gets (`round = n =>
Math.round(n*1000)/1000`, unconditional, not new to this phase) — not
a cross-reference bug. Will re-pull both post-deploy and confirm this
exact relationship holds live, per the acceptance criterion.

**Baseline fixture**: confirmed untouched. `git diff --stat` shows only
`fetch-macro-data/index.ts` changed (62 lines) among this agent's own
files; `NEARTERM_G`/`NEARTERM_I`/`MEDTERM_G`/`MEDTERM_I`/
`computeEdgeForwardPanel` all sit at lines 2519-2674, nowhere near this
phase's edits (896-1060 for the new indicator entries, ~1877-1900 for
the new processor case).

**Tests**: `tests/paradigmXrefDefinitions.test.ts` (5 cases) — mirrors
Phase 1's `indicatorGapsDefinitions.test.ts` text-slicing approach,
separate file since the required shape differs (no `fred_series_id`,
`data_source: "supabase"` instead of `"fred"`, and an explicit check
that the exact spec-required description text "Cross-referenced from
Fiscal Policy Paradigm." appears verbatim). 878/878 tests pass total.
`next build` clean.

**Build status**: committed, not deployed — held for the same
report-before-deploy gate as every prior phase.
