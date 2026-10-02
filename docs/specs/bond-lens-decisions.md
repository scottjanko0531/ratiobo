# Bond Lens Overlay — decisions log

## Step 0 reconnaissance approved, spec locked to v2.1 (2026-10-01)

Scott approved the Step 0 reconnaissance findings with the decisions
below. Full reconnaissance findings are in the conversation that produced
this log, not reproduced here; this entry records the decisions and
their rationale. Spec updated to v2.1 (`bond-lens.md` §0) with matching
inline edits to §3.5, §4 (normalization), §6.3, §6.4, §7.2, §8.

**1. Settings split.** `portfolios.use_bond_lens_overlay` (boolean,
default `false`) is the sole on/off switch — same mechanism as
`use_market_overlay`/`use_capex_overlay`, not a parallel one.
`bond_lens_portfolio_settings` holds every other knob, with **no
`enabled` column** (avoids two sources of truth for on/off — the exact
duplication risk flagged in reconnaissance). A portfolio with the flag
on and no settings row uses the spec defaults.

**2. Per-sleeve reallocation.** A new function, not an extension of the
existing `combineAllOverlays` multiplier-merge pattern — reconnaissance's
finding stands: every existing overlay is a scalar multiplier against an
external target, never a within-bucket reallocation, so this genuinely
doesn't fit the existing shape. Runs after the full existing overlay
stack; operates on each bond holding's already-resize/capex/market-cut
weight (those cuts are real and respected, not undone). Sleeve = `nb` +
`tip` combined, combined weight fixed, split between them free to move
(the TIPS tilt is the point). **No cash interaction in v1** — the spec's
original "route to cash if no eligible short instrument" fallback is
dropped; that case instead sets `target_reachable = false` with a
`gap_note`, same handling as every other unreachable-target case.
Rationale: keeps Bond Lens's blast radius contained to the bond sleeve
only, with zero chance of interacting with the Market Conditions
overlay's own cash mechanic (which already has a documented history of
subtle bugs in this exact spot — see `docs/market-conditions/DECISIONS.md`'s
two KISS post-mortems). Solved as a small LP (duration/mix constraints
are linear in portfolio weights) minimizing total |Δweight|; library vs.
deterministic-greedy choice to be proposed in the Phase D plan once the
actual constraint shapes are in hand.

**3. Classification.** A worksheet — every holding with `simulator_key`
in (`nb`, `tip`) or `asset_type` in (`bond`, `cd`, `money_market`,
`loan`), proposed `bond_type` + in-scope flag + duration source per
holding — is a first deliverable inside Phase A, reviewed and confirmed
by Scott before anything is written to `bond_instrument_meta`. Default
proposals (BDCs/DBMF/private notes out of scope; CDs in scope only with
a populated `maturity_date`; bond ETF duration entered manually with a
90-day staleness warning; individual-bond duration computed from
coupon/maturity/yield, excluded if any are missing) per `bond-lens.md`
§0.3. Reconnaissance's finding that `simulator_key = "nb"` already mixes
BDCs and a managed-futures fund into "nominal bonds" in the *existing*
simulator (outside Bond Lens entirely) is logged as a **separate cleanup
item, not in scope here**:

> **Follow-up (not Bond Lens):** `lib/simulatorKeys.js`'s `ASSET_TYPE_DEFAULT`/`simulator_key`
> convention currently has no way to express "equity-like income vehicle"
> (ARCC, BXSL) or "managed futures / trend-following fund" (DBMF) as
> anything other than `nb` (nominal bonds), which distorts bucket-level
> stats (resize-overlay freed-weight math, Portfolio Actions duration-free
> summaries, etc.) for any portfolio holding them. Needs its own simulator
> bucket or an `other`-style catch-all, independent of Bond Lens's
> `bond_instrument_meta`. Revisit separately.

**4. `solver_override_enabled` removed from v1.** No live per-portfolio
correlation-aware risk-parity solver exists for it to override
(`lib/riskParity.js` is asset-class-level, used only by `/macro`'s
sandbox simulator — confirmed directly, not inferred). Rather than ship
a sub-toggle with nothing to flip, it's cut from v1 entirely; revisit
only if a real per-holding solver is built elsewhere in the app first.
`hedge_reliable` itself stays fully computed and displayed — §5.3's
instrument-preference rule already consumes it directly ("Bills / short
TIPS" when unreliable), so it has a real v1 effect with no solver
involved at all.

**5. `macro_pillar_enabled` deferred.** Market Conditions' macro pillar
doesn't exist yet (`SPEC.md`: Phase 4, gated experiment, `scoreMacro`
always `null`). The column stays on `bond_lens_portfolio_settings`,
default `false`, inert until Phase 4 ships — not removed, since (unlike
the solver) there's a concrete, named future home for it. The curve
regime classifier (§4.6) is unaffected by this and is computed/shown in
the market view regardless; only the tier-notch adjustment is gated.

**Normalization.** Carry, valuation and term-premium modules keep
literal z-scores (`(x − mean) / stdev`), not Market Conditions'
percentile-rank convention — a deliberate divergence, not an oversight:
magnitude ("how cheap, in sigma") is the thing these modules need to
express, where Market Conditions only ever needed relative ranking.
Window matches Market Conditions' (2520 trading days, 756-day minimum)
for consistency in *that* dimension; clip at ±3 before combining into a
module score, to bound the influence of any single extreme print.

**Auction data.** `treasury_auction_results` (`ingest-auction-results`,
Treasury Fiscal Data API, populated since 2010 — found and confirmed
working in reconnaissance) is a display-only cross-check next to term
premium in v1, not a score input. Phase E tests `bid_to_cover_ratio` and
the `high_yield − avg_med_yield` dispersion proxy as candidate inputs
against ACM term premium specifically, and any promotion to an actual
score input requires its own explicit decision logged here — not a
silent addition during Phase E.

**Infrastructure.** Confirmed as found in reconnaissance: FRED via the
existing `FRED_API_KEY`; ETF backfills via the existing Yahoo v8 path
into `asset_price_history`, **with `.range()` pagination** (the exact
1000-row PostgREST cap that broke the Market Conditions chart applies
here too — any unpaginated read of an ETF's history past ~4 years will
silently truncate); `pg_cron` + edge functions, not Vercel cron. The
weekly composite job runs after Friday close, deliberately offset from
Market Conditions' 22:30/22:40 UTC jobs rather than colliding with them.

## Phase A follow-up: ACM term premium daily refresh deferred (2026-10-01)

`bond-lens-ingest?source=acm` reliably hits `WORKER_RESOURCE_LIMIT` in
the edge function, even in isolation. Root cause confirmed by parsing
the live ~10MB NY Fed `ACMTermPremium.xls` locally with the same `xlsx`
library version: the BIFF8 decode alone costs **~363MB of heap**,
regardless of which sheet is selected (`sheets: ["ACM Daily"]`), dense
vs. object cell storage (`dense: true`), or any row-range filter
(`sheetRows`/`range` — verified empirically that neither actually limits
the decode for this binary format; the library fully parses the sheet
before any row filtering is applied, so "just parse the last N days"
is not achievable this way no matter how small N is).

Decision: **defer the daily refresh, backfill-only for now.** The
one-time historical backfill (local parse → direct SQL insert) already
populates `bond_raw_series` with full ACM history through the backfill
date. `bond-lens-ingest-acm-daily`'s cron job is unscheduled
(`20261001_unschedule_bond_lens_acm_daily.sql`); FRED and HLW r-star keep
their daily jobs (r-star's file is ~180KB and parses fine standalone,
confirmed). Revisit only if ACM term premium needs to be current
day-to-day for a specific use — options noted for that revisit: a
lighter data source (NY Fed may expose a smaller feed; not yet checked)
or moving just this parse to a higher-memory runtime (e.g. a Vercel API
route called by pg_cron) rather than the edge function.

## Phase B follow-up: GDPNow current-quarter coverage (2026-10-02)

GDPNow's Phase A ingestion stopped at 2026-07-28 because `TrackingArchives`
only gets a quarter's block once that quarter's BEA advance estimate
ships and the sequence is "closed out" -- the live, still-open quarter
lives in a different sheet in the same workbook, `CurrentQtrEvolution`,
laid out as repeating (Date, Major Releases, GDP*) column triples that
*wrap into a new triple* every ~12-13 rows rather than growing one
column indefinitely (confirmed by hand against the live file
2026-10-01: block 1 Jul 30-Aug 25, block 2 Aug 26-Sep 25, block 3 Sep
30-Oct 1, all one continuous Q3 2026 sequence). `bond-lens-ingest`
now parses this generically (however many triples exist, not hardcoded
to 3) and tags every row with `target_quarter` (new `bond_raw_series`
column) -- from `CurrentQtrEvolution`'s own "Initial GDPNow 26:Q3
forecast" label for the live quarter, from the archive sheets' own
"Quarter being forecasted" column for closed ones. Re-run confirmed:
2,143 rows total, 2011-08-25 to 2026-10-01, zero gaps; `2026Q3` alone
has 27 rows from 2026-07-30 (initial nowcast) through today.

`growth_mom` (spec §4.2) will use `target_quarter` to detect the
boundary case: Scott's call is the **scaled version** -- in the first
weeks of a new quarter, use the change in that quarter's own nowcast
since its first release, scaled to an 8-week-equivalent rate, rather
than carrying the prior quarter's value forward. Implemented in Phase
B's §4.2 module, not here.

## Phase B follow-up: in-scope ETF durations entered (2026-10-02)

The 10 in-scope `bond_instrument_meta` rows (§0.3) were left with null
`effective_duration` at the end of Phase A deliberately — entering a
number from memory for data that feeds a real valuation score risked
silently wrong duration-weighted math. Sourced from each fund's own
current factsheet instead:

| Symbol | Effective/avg duration | As of |
|---|---|---|
| SHY | 1.84 yrs | 2026-08-31 (iShares) |
| TLT | 14.63 yrs | 2026-09-30 (iShares) |
| SCHP | 6.4 yrs | 2026-08-31 (Schwab) |
| VTIP | 2.4 yrs | 2026-08-31 (Vanguard, reported as "average duration") |

Staleness warning (§0.3, 90 days) is a Phase B/UI concern reading
`duration_as_of`, not re-litigated here.

## Phase B follow-up: ACM refresh moved to GitHub Actions (2026-10-02)

The backfill-only decision above was a stopgap -- ACM is the primary
term premium input for §4.3's valuation score, so a stale ACM means a
stale valuation score every week. Real fix: move the refresh out of the
edge function entirely. `scripts/bond_lens_acm_refresh.py` (pandas +
xlrd, which handle the same ~10MB `.xls` fine on a GitHub Actions
runner's far larger memory budget) upserts into `bond_raw_series` via
the Supabase REST API, authenticated with the service-role key as a
GitHub secret (`SUPABASE_SERVICE_ROLE_KEY` -- **Scott needs to add this
secret himself** in the repo's Settings → Secrets and variables →
Actions; the key is not something this session has access to or should
handle). Tested locally against the live file: 16,289 rows, 1961-06-14
to 2026-09-30, exact match to the earlier JS-parsed backfill.

Scheduled weekly, `.github/workflows/bond-lens-acm-refresh.yml`, 21:00
UTC Friday -- ahead of Bond Lens's own daily cron (22:50/23:10/23:20
UTC) and where the Phase C composite will eventually run. Revisit the
exact time once the composite's own schedule is set.

**Staleness fallback is a compute-time concern, not refresh-time**: "if
ACM's last observation is >10 business days old when the composite
runs, fall back to `THREEFYTP10` (Kim-Wright), z-scored on its own
history, set the valuation module's `degraded` flag, show the
staleness in the market view" is §4.3's own job when it reads
`bond_raw_series` -- implemented there (Phase B), not duplicated into
this refresh script, so there's one place that owns "is ACM usable
right now."

## Phase A follow-up: GDPNow sourced from the Atlanta Fed directly (2026-10-01)

FRED's `GDPNOW` series is quarterly-snapshot only (~61 rows), insufficient
for spec §4.2's "8-week change in GDPNOW" formula, which needs the
intraquarter nowcast revision history. The Atlanta Fed's own model-data
spreadsheet (`GDPTrackingModelDataAndForecasts.xlsx`, found via
atlantafed.org's own GDPNow data page, not FRED) has it: `TrackingArchives`
(2014:Q2 onward) and `TrackingDeepArchives` (2011:Q3-2014:Q1), both with a
"Forecast Date"/"GDP Nowcast" column pair giving one row per nowcast
revision.

Built as a fourth `bond-lens-ingest?source=gdpnow` path, series_id
`GDPNOW_ATL_NOWCAST`. Despite the file being ~11MB (50+ sheets total),
`sheets: [...]`-restricted parsing works here — confirmed only ~23MB to
decode the two needed sheets — unlike ACM's legacy `.xls`, because this
is modern OOXML (zip of per-sheet XML parts, so unneeded sheets are
never decompressed at all). Tested standalone: 2,116 rows, 2011-08-25 to
2026-07-28, zero gaps. Scheduled daily at 23:20 UTC weekdays
(`20261001_schedule_bond_lens_gdpnow.sql`), after FRED/r-star in the same
offset-from-Market-Conditions window.

## Phase B review follow-up: hedge, quadrant, path, GDPNow, valuation, trend, curve regime (2026-10-02)

Scott's Phase B chart review (§7.2 test 5 and five other items) surfaced
real bugs and two scoring-formula changes:

**1. Hedge flag.** Diagnosed by computing the raw 90-day SPY/IEF
correlation directly in Postgres (not re-derived in JS) for Oct 2021-Dec
2022: it is genuinely negative through mid-June 2022 (as low as -0.32)
and only crosses positive and trips the Q2/Q3-and-corr>0 rule on
2022-07-22 -- the hysteresis-confirmed flip already in `bond_signals`
was correct given the real data, not a bug. The REAL bug: `HedgeState`'s
initial value was `hedgeReliable: true`, and `stepHedgeReliable` held
that default forever whenever `corr` was null -- which it was for the
entire pre-IEF (2002) and pre-SPY (1993) history, so hedge_reliable read
`true` for 40 years with no basis. Fixed: `hedgeReliable` is now
`boolean | null`; null means "no reading yet," flagged
`hedge_reliable_degraded`, never defaults to true. Below real-data
coverage, falls back to a monthly construction (`syntheticBond.ts`):
Shiller's monthly S&P total return (real SPY overrides it from 1993)
against a synthetic 10y total return built from DGS10 via
duration-based approximation (`-D_mod*Δy + y/252` per day), 36-month
rolling correlation. The synthetic bond leg was validated against real
IEF before use: corr 0.962, sd 0.00488 vs 0.00428, over the full
2002-2026 overlap, computed directly in Postgres. Shiller's own P column
is a monthly AVERAGE of daily closes (his own CAPE convention, not a
month-end snapshot), so the equity leg only reads ~0.60 correlated with
real SPY returns over the 1993-2004 overlap -- expected, and exactly why
every fallback reading is flagged degraded regardless.

**2. Quadrant churn.** `quadrant_score` is now continuous:
`clip(-(z(growth_mom) + z(infl_axis))/2, -2, 2)`, replacing the fixed
4-point lookup table. The `quadrant` label (Q1-Q4) stays sign-based but
is now display-only with 3-week persistence (`stepQuadrantLabel`, same
walk-forward pattern as `hedge_reliable`/`curve_regime`) --
`cfg.quadrant.labelPersistenceWeeks`. Hedge reliability's own Q2/Q3
check still reads the RAW (unpersisted) label, unchanged, since spec
ties that rule to the actual regime, not the display cadence.

**3. GDPNow quarter-boundary nulls.** Root cause: the scaled-change
fallback (growth_mom's own first fix) returned null on the EXACT day
`target_quarter` flips to a new quarter, because "change since the
quarter's first release" is undefined with zero elapsed days -- that one
day lands at/near each month-end (Jan/Apr/Jul/Oct), matching what Scott
saw. Fixed: on that one day, carry the prior day's own growth_mom value
forward, flagged degraded (Scott's documented fallback for exactly this
case). Confirmed separately: the 2026-07-28 FRED-discontinuation
boundary has no actual data gap (2026Q2's last release 07-28, 2026Q3's
first 07-30), and the latest `GDPNOW_ATL_NOWCAST` row is 2026-10-01
carrying September 2026 nowcasts.

**4. path_score.** Continuous:
`clip(-z(data_momentum) * abs(z(priced_hikes)), -2, 2)`, where
`data_momentum = avg(z(growth_mom), z(infl_trend))`. Scott's first draft
of the formula (`z(priced_hikes) * -z(data_momentum)`, a plain product)
was mathematically direction-blind -- opposite-signed inputs always
multiply to the same sign regardless of which input is which, so
"hikes priced + cooling data" (bullish) and "cuts priced + heating data"
(bearish) collapsed onto one sign. Confirmed with Scott (AskUserQuestion)
and corrected so the sign comes from `data_momentum` alone and
`priced_hikes` only scales the magnitude.

**5. Coverage.** `valuationScore` now falls back to term premium alone,
flagged degraded, whenever `realYieldGap` is excluded (pre-TIPS, i.e.
before DFII10's ~2006 effective start) but `termPremium` isn't --
pulls valuation_score's start back to ~1964 (ACM's own 756-day minimum
after its 1961 start). `trend`'s "IEF or synthetic" now actually has a
synthetic leg: `syntheticBond.ts`'s daily duration-based 10y total-return
index, spliced continuously onto real IEF at its 2002-07-30 inception
(`spliceSyntheticBeforeReal`, rescaled so the join has no jump), flagged
`trend_degraded` until a full 252-day momentum window sits entirely
within real-IEF-covered dates.

**6. Curve regime thresholds.** Lower priority per Scott's own framing --
added `BOND_LENS_CONFIG.curveRegimeStrict` (15bp level / 8bp slope /
4-week persistence) alongside the live `curveRegime` config, unwired
from production. Both configs are mechanically interchangeable with the
same `curveRegimeRaw`/`classifyCurveCandidate`/`stepCurveRegime`
functions, so Phase E can run both over the same history with zero code
changes.

**7. Staleness / operational gap found.** `bond_signals.flags` was empty
on the latest row and `ACMTP10`'s own last observation (2026-09-30) is
fresh relative to the 10-business-day cap, so valuation read live ACM,
not the Kim-Wright fallback. Separately: **no cron job of any kind ever
invoked `bond-lens-compute`** -- every ingest job was scheduled, but
nothing recomputed `bond_signals` on a schedule, so it would have gone
stale even with perfectly fresh inputs. Added `bond-lens-compute-daily`,
23:40 UTC weekdays, after the three ingest jobs
(`20261002_schedule_bond_lens_compute_daily.sql`). The ACM GitHub
Actions workflow's own run history could not be confirmed from this
session (no `gh` CLI available locally) -- Scott should check the repo's
Actions tab, and confirm the `SUPABASE_SERVICE_ROLE_KEY` secret was
actually added, since that step was never verifiable from here.

One-time backfill, not a recurring job (the window it covers is
permanently historical): `SHILLER_SP500_TR_MONTHLY`,
`20261002_backfill_shiller_sp500_monthly_tr.sql`, 1962-01 through
2004-12 (extra headroom past 1993 for validation), sourced from Shiller's
own published `ie_data.xls` (shillerdata.com).
