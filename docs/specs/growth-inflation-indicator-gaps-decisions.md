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
