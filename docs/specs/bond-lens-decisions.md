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

## Pre-Phase-C fixes (2026-10-02)

**Module output range.** §4's "Conventions for every module" requires
every module score in `[-2, +2]`. A direct query across the full
`bond_signals` history found `valuation_score` reaching `3.0` (1981) and
`carry_score` ranging `-2.76` to `+2.28` -- both are pure z-score
averages, clipped only to `+/-cfg.clipZ` (3) by `normalize.ts`, never
re-clipped to the module's own `+/-2` contract. The other four
(`path_score`, `quadrant_score`, `trend_score`, `curve_score`) were
confirmed already inside `+/-2` by the same query.

Fixed by rescaling (`moduleOutputScale`, `z * (2 / clipZ)`) rather than a
second hard clamp at `+/-2`: carry/valuation's output is a simple
average of z-scores with a KNOWN exact range of `+/-clipZ`, so a linear
scale maps that range onto `+/-2` losslessly. A hard clamp would instead
flatten every reading between 2 and 3 onto the identical value 2,
destroying exactly the magnitude information ("how cheap") that's the
whole stated reason this module family uses z-scores over percentile
rank in the first place. Applied once, at the `bond_signals` row-output
boundary in `scoring.ts` -- not inside `carry.ts`/`valuation.ts`
themselves, so any other caller that wants the raw z-score (Phase E,
say) still gets it unscaled.

**growth_mom in the first ~10 trading days of a quarter.** Confirmed by
reading the code and re-querying live data: the scaled-change fallback
(`(value_now - value_at_first_release) / days_elapsed * 56`) was already
scaling to an 8-week equivalent exactly as intended -- that part worked.
The gap: it would scale off as little as a 1-day gap, meaning an early
noisy GDPNow revision could get multiplied by up to ~56x. Fixed by
requiring at least 10 TRADING days elapsed (`t - firstIdx`, both
indices into the same gap-free trading calendar, so this is an exact
trading-day count, not an approximation) before trusting the scaled
estimate; below that, carries the prior day's own growth_mom reading
forward, flagged degraded -- the same mechanism already used for the
`firstIdx === t` case, which this new check subsumes (0 trading days
elapsed is always below any positive minimum).

Verified live after recompute, 2025's four quarter boundaries
(`bond_signals`, `growth_mom_degraded` flag reasons):

| Date | Trading days since Q start | Behavior |
|---|---|---|
| 2025-01-29 to 01-30 | (prior quarter, not yet boundary) | plain 8-week diff, not degraded |
| 2025-01-31 | 0 | carried forward, degraded |
| 2025-02-03 to ~02-13 | 1-9 | carried forward, degraded |
| 2025-02-14 onward (~10td) | >=10 | scaled 8-week-equivalent, degraded |
| 2025-04-30, 07-31, 10-31 | 0 | same pattern at each boundary |

**path_score formula, final.**

```
data_momentum_z = avg(z(growth_mom), z(infl_trend))   // whichever of the two is available; both missing -> excluded
path_score = clip(-data_momentum_z * abs(z(priced_hikes)), -2, +2)
```

Sign comes from `data_momentum_z` ALONE -- cooling data (`data_momentum_z
< 0`) is bond-bullish (positive), heating data (`> 0`) is bond-bearish
(negative). `priced_hikes`' own sign never flips the result; only its
MAGNITUDE scales how much a given data trend matters (a bigger priced
repricing means the market is actively engaged on this axis, so new data
confirming or denying it carries more weight for duration).

Scott's first draft of the formula was the plain product
`z(priced_hikes) * -z(data_momentum)` -- algebraically that's positive
whenever the two z's have opposite signs REGARDLESS of which one is
which, so it couldn't distinguish "hikes priced + cooling" (bullish)
from "cuts priced + heating" (bearish): both landed on the same sign.
Caught via AskUserQuestion before shipping; Scott confirmed the
sign-from-data-momentum version above.

Four-case truth table (illustrative `|z|` = 1.5 for priced_hikes, 1.0
for data_momentum in every cell, to isolate the sign logic -- actual
magnitude always scales with the real `|z|`s, independent of which
case applies):

| priced_hikes | data_momentum | sign | path_score | reading |
|---|---|---|---|---|
| Hikes priced (z=+1.5) | Cooling (z=-1.0) | + | +1.5 | Bond-bullish: hawkish pricing, data not supporting it |
| Hikes priced (z=+1.5) | Heating (z=+1.0) | - | -1.5 | Bond-bearish: data confirms the hawkish pricing, more to go |
| Cuts priced (z=-1.5) | Cooling (z=-1.0) | + | +1.5 | Bond-bullish: data confirms the dovish pricing, more to go |
| Cuts priced (z=-1.5) | Heating (z=+1.0) | - | -1.5 | Bond-bearish: dovish pricing, data not supporting it |

Note rows 1&3 and 2&4 share a sign -- `priced_hikes`' sign genuinely
doesn't determine direction, only its magnitude does (visible here since
all four cells use the same `|z|`s).

## Phase C: global composite (2026-10-02)

Implements §5 exactly as written: `duration_score = 0.30*valuation +
0.25*path + 0.20*carry + 0.15*quadrant + 0.10*curve`, trend-gated (down
-> cap 0, mixed -> cap +0.75), mapped to stance/multiplier (§5.2),
instrument preference evaluated in order (§5.3), maturity preference
from the per-maturity EFF table with a Max-extend override to 10y
(§5.4), and an explanation paragraph with structured drivers (§5.5).
Wired into `bond-lens-compute` itself (not a separate function) --
reuses the already-computed `bond_signals` history in memory rather
than re-fetching it, only adding the handful of O(n) pieces (r-star
lag, term premium z, per-maturity EFF) that pass wasn't already
carrying.

**`instrument_pref` values are snake_case** (`bills_short_tips`,
`tips_tilted`, `nominal_tilted`) -- matches `bond_lens_signal`'s own
check constraint from the Phase A migration exactly. Found this the
hard way: the first live upsert after deploying Phase C failed on it
(I'd used the human-readable form from spec's own prose). The
human-readable form lives in the explanation text only.

**Composite coverage starts 2006-04-11**, confirmed by directly
querying which column was null right up to that date: NOT carry_score
(already non-null since well before 2006, consistent with DGS3MO's own
1981-09 start + 756-day warmup -> ~1984) -- it's `quadrant_score`,
specifically its inflation axis, which needs T5YIE (5y breakeven,
FRED start ~2003) plus the same 756-day minimum -> 2006. Spec's own
§7.1 table says "full composite: from 2003"; the extra ~3 years here is
the z-score warmup spec's own coverage table doesn't account for, not a
discrepancy with spec's data-availability claim.

**Maturity preference lands on 2y almost every time** (confirmed across
all 5 spot-check dates below) -- checked this isn't a bug: `EFF_n =
CR_n / D_mod(n)` structurally favors short maturities almost regardless
of curve shape, since `D_mod` grows with `n` faster than `CR_n` does
for anything resembling a normal-to-flat curve. This is a property of
the spec's own literal EFF formula, not an implementation error -- worth
a look in Phase E if a maturity-preference signal that actually
responds to curve shape is wanted.

### Spot-checks (`bond_lens_signal`, nearest trading day on/before each date)

| Date | duration_score | stance | instrument_pref | maturity_pref | hedge_reliable | curve_regime | quadrant |
|---|---|---|---|---|---|---|---|
| 2020-03-20 | -0.20 | Neutral | nominal_tilted | 2y | true | bull_steepening | Q1 |
| 2022-06-17 | 0.00 (trend-capped) | Neutral | tips_tilted | 2y | true | bear_flattening | Q3 |
| 2023-10-20 | 0.00 (trend-capped) | Neutral | bills_short_tips | 2y | false | bear_steepening | Q1 |
| 2024-09-20 | 0.23 | Neutral | nominal_tilted | 2y | true | bull_steepening | Q4 |
| 2026-09-30 (latest) | 0.00 (trend-capped) | Neutral | bills_short_tips | 2y | false | bear_flattening | Q4 |

All five read as directionally sane against the real macro backdrop for
each date (e.g. 2022-06-17 lands in Q3/stagflation with a TIPS tilt
during the Fed's hiking cycle; 2023-10-20's bear_steepening during the
late-2023 long-end selloff triggers the hedge-unreliable bills tilt).
None hit Extend/Max extend/Short in this particular five-date sample --
not surprising given the trend gate caps most of them at 0 and the
underlying composite rarely swings past +-0.75 in practice; worth
widening the spot-check set in Phase E if the stance bands themselves
need stress-testing.

## Phase E test variants (2026-10-02, NOT wired into production)

Four variants, per Scott's explicit request to test before Phase E
proper, kept entirely separate from the live config/compute:

**(a) Inflation-regime hedge rule.** `hedge_reliable_alt = false` when
core PCE 12mo > 3.0% AND not decelerating (3mo annualized >= 12mo rate),
regardless of realized correlation; otherwise the existing correlation
rule. Computed directly in Postgres (PCEPILFE's own LAG(3)/LAG(12) on
its monthly rows, forward-joined onto each Friday) rather than pulled
into a script -- kept the result to a handful of summary numbers:

- **Late 2021:** flags 17 of 26 weeks (65%) in H2 2021, first flagging
  on **2021-04-02** -- over 15 months before the real correlation rule
  flipped (2022-07-22). Directly confirms Scott's own framing: the
  realized-correlation rule only caught the hedge breakdown "after the
  damage was done."
- **False alarms, 2003-2019 (859 weeks):** **zero.** The alt rule never
  once said "unreliable" while the real correlation-based rule still
  said "reliable" across this entire 16-year stretch.

A genuinely clean result on both ends -- catches the 2021 setup far
earlier, with no false-alarm cost over the preceding 16 "normal" years
in this specific data. Doesn't by itself say whether 3.0%/accelerating
is the RIGHT threshold (only that it's not obviously too loose over
2003-2019) -- Phase E's own sensitivity test (§7.2 test 6) is the place
to vary it.

**(b) Path/quadrant overlap.** Variant: quadrant_score leaves the
duration composite (still feeds instrument_pref and hedge_reliable's
own Q2/Q3 rule, unchanged); its 0.15 weight splits as +0.10 to
valuation (0.30->0.40) and +0.05 to carry (0.20->0.25) -- the only
split that keeps the remaining four weights summing to 1.00. Tested
against forward 12-month IEF excess returns (IEF total return minus the
prevailing DGS1 yield, both computed directly in Postgres), over the
4,598 trading days where both the composite and a forward 12-month
window exist (2006-04 through ~1yr before the latest date):

| | live (with quadrant) | alt (quadrant removed) |
|---|---|---|
| IC (corr with fwd 12m excess) | 0.093 | **0.169** |
| Hit rate | 48.65% (below chance) | **52.44%** |

The alt variant's IC is nearly double live's, and its hit rate clears
50% where live's doesn't. `corr(live, alt) = 0.94` -- they move together
almost identically day to day (expected, sharing 4 of 5 inputs), so this
is a real but modest effect, not two different signals. Caveat: this is
overlapping daily data (heavy autocorrelation in both the composite and
12-month forward returns), so the effective independent sample size is
far smaller than 4,598 -- a real IC/hit-rate test with properly spaced,
non-overlapping windows belongs in Phase E proper. Directionally,
though, this supports pulling quadrant out of the duration composite.

**(c) Curve regime.** Already computed in the pre-Phase-C review
(2026-10-02, item 6 above): live config (10bp/5bp/2wk) averages **6.0
regime changes/year**, neutral 47.3% of weeks; `curveRegimeStrict`
(15bp/8bp/4wk) averages **2.5/year**, neutral 63.5% of weeks, over
1999-2026. Both configs already live side by side in
`BOND_LENS_CONFIG` for Phase E to pick from directly.

**(d) Carry history via DTB3.** Confirmed via direct queries against
`bond_raw_series`: `DGS3MO` starts 1981-09-01 (the actual binding
constraint on today's `carry_score`, consistent with Scott's own
framing); `DTB3` (3-month T-bill, secondary market) starts 1954-01-04;
`DGS7` starts 1969-07-01; `DGS10` starts 1962-01-02. `carry_score`'s
true dependencies are only the bill leg and the 10y/9y-interpolated
leg (needs `DGS7` and `DGS10` specifically, not `DGS1`/`DGS2`/`DGS3`/
`DGS5` -- those only feed the OTHER maturities' EFF table, not
`carry_score` itself).

Using `DGS3MO ?? DTB3` as the bill fallback would therefore push
`carry_score`'s real binding constraint from `DGS3MO` (1981-09) back to
**`DGS7` (1969-07-01)** -- `DTB3` itself is no longer the limiter once
it's available from 1954. Extended start: 1969-07-01 + 756 trading days
-> **~1972-73**, not all the way back to DTB3's own 1954 start.

**Not backfilled.** `DTB3` itself (1954-2026, ~18k rows) and the
subsequent recompute both ran into a hard interface wall this session:
every write path available here (`execute_sql`/`apply_migration`) takes
the full SQL text as a literal parameter, and a dataset this size
either exceeds the tool's own return-size limit (on read) or costs an
enormous amount of context to push through in one block (on write) --
there's no service-role key or direct Postgres connection available
from this session to route around it (by design -- service-role keys
shouldn't be handled by the assistant per this project's own security
posture, same reasoning as the ACM GitHub Actions refresh). The 1969-73
start-date math above is the real, verified answer (built from actual
queried FRED start dates, not guessed) -- the backfill itself is a
cheap follow-up (one Python script, FRED's public `fredgraph.csv`
endpoint, same shape as the Shiller/ACM backfills already in this repo)
whenever there's budget for a session with direct DB write access, or
Scott wants to run it himself.

Resolved this session (see below): a reusable Node script,
`scripts/backfill-dtb3.mjs`, run by Scott locally with his own
service-role key -- same "assistant never handles the key" boundary,
just solved with a script Scott runs instead of a session with direct
DB access.

---

## Phase C fix: maturity preference ("my spec error") -- 2026-10-02

Scott's own correction, verbatim: *"EFF_n = CR_n / D_mod(n) is the same
formula as BE_n, and it structurally favors the shortest maturity."*
Confirmed independently before the fix: on every one of the 5 spot-
check dates, the OLD `maturityPref` picked **2y** every single time --
not because 2y was genuinely the best risk/reward point on the curve,
but because `D_mod(n)` grows roughly monotonically with `n` while `CR_n`
does not grow nearly as fast, so `CR_n/D_mod(n)` is biased toward small
`n` on essentially any realistic curve shape. The metric was
structurally incapable of ever preferring 10y except via the separate
Max-extend override.

**Fix.** `EFF_n` is now a genuine Sharpe-style ratio:

```
EFF_n = (CR_n - y_3m) / (D_mod(n) * sigma_n)
```

`sigma_n` = trailing 1-year (252-trading-day) stdev of **daily changes**
in `y_n`, annualized (`stdev(Δy_n) * sqrt(252)`). `y_3m` = the 3-month
bill yield (`DGS3MO`, falling back to `DTB3`). The OLD formula
(`CR_n/D_mod(n)`) didn't go away -- it's exactly what `BE_n` ("breakeven
yield rise") already was, so removing the redundant `EFF` field from
`carryAndRolldown`'s return type *was* the rename; `BE_n` is unchanged
and still surfaces in the per-maturity UI table (`maturityTable` in the
explanation drivers).

**Implementation notes:**

- All four maturities {2, 5, 7, 10} are EXACT knots in the curve table
  (`DGS2`/`DGS5`/`DGS7`/`DGS10` directly) -- no interpolation needed to
  get `y_n(t)` itself for the sigma calculation, only `CR_n`/`D_mod(n)`
  (via the existing `carryAndRolldown`, for the `n-1` rolldown leg)
  needs the full curve.
- `sigma_n` is computed O(n) per maturity via two new `normalize.ts`
  primitives (`dailyDiff`, `rollingStdevSeries`) using the same
  incremental running-sum/sum-of-squares technique as
  `rollingZScoreSeries` -- deliberately, given this module's own
  prior history of CPU-time bugs from naive per-day window rescans.
  `rollingStdevSeries` has NO `minHistory` grace period (unlike the
  z-score version) -- "trailing 1-year stdev" means a full 252-value
  window, not whatever history happens to exist yet.
- **New `maturity_pref` value: `"bills"`.** When every available
  `EFF_n` is <= 0 (the curve isn't compensating for duration risk
  anywhere on it -- the inverted-curve case) OR when `EFF_n` can't be
  computed for any maturity at all, `maturityPref` returns `"bills"`
  rather than `null`. Judgment call: `bond_lens_signal.maturity_pref`
  is `NOT NULL`, and "can't tell, so stay in cash" was picked over
  silently skipping the row for one missing/non-positive piece. Added
  via migration `bond_lens_signal_bills_and_nullable_hedge`
  (`maturity_pref` check constraint now allows `'bills'`).
- `docs/specs/bond-lens.md` §4.1 and §5.4 edited directly to describe
  the new formula and the `"bills"` semantics -- the first time this
  session edited the spec file itself rather than only this decisions
  log.

**Maturity-pref distribution, before vs. after** (full `bond_lens_signal`
history; "before" captured by direct query immediately before the
redeploy, "after" immediately after):

| | before (n=4,861, 2006-04-11 to 2026-09-30) | after (n=10,516, 1984-09-11 to 2026-09-30) |
|---|---|---|
| 2y | 3,096 (63.7%) | 6,645 (63.2%) |
| 5y | 906 (18.6%) | 1,124 (10.7%) |
| 7y | 662 (13.6%) | 1,063 (10.1%) |
| 10y | 197 (4.1%) | 816 (7.8%) |
| bills | n/a (value didn't exist) | 868 (8.3%) |

2y is still the single largest bucket (barely moved, 63.7% -> 63.2%),
but that's no longer definitionally guaranteed the way it was under the
old `CR_n/D_mod(n)` formula -- it's now a real empirical outcome (2y's
own yield vol has often been low enough, relative to its carry, to
still win on a genuine risk-adjusted basis in many periods) rather than
a structural artifact that could never produce anything else. The real
evidence the fix worked: 10y's share nearly doubled (4.1% -> 7.8%),
5y/7y's shares dropped by roughly half each, and `"bills"` now exists
as a real outcome in 8.3% of days -- days where the Sharpe-style ratio
says no maturity on the curve is worth the duration risk, which the old
formula could never express at all. Row count more than doubled
(4,861 -> 10,516) purely from the separate coverage-gating fix below,
not from this fix itself.

Also note the coverage-gating fix (below) means "before" and "after"
aren't drawing from identical date ranges -- "before" only covers
2006-2026 (the old seven-way gate's binding window), "after" covers
1984-2026. This table is reported as-is rather than re-run on a matched
date range, since the whole point of both fixes landing together was
to get both a correct formula AND a longer history at the same time.

---

## Composite coverage reweighting -- 2026-10-02

Per §4's "missing inputs are reweighted" convention (previously applied
only within individual modules, e.g. valuation's real-yield-gap vs.
term-premium legs), now applied to the composite itself for the first
time. Old gate: `computeBondLensSignalHistory` required ALL of
`valuation_score`, `path_score`, `carry_score`, `quadrant_score`,
`curve_score`, `trend_state`, AND `hedge_reliable` to be non-null before
emitting a `bond_lens_signal` row at all -- an all-or-nothing gate.

**New gate:** a row is attempted once `valuation_score`, `carry_score`,
and `trend_state` are ALL present. `path_score`/`quadrant_score`/
`curve_score` are each optional -- whichever of the three are present
get their §5.1 weights (0.25/0.15/0.10 respectively) renormalized to
sum back to 1.00 over just that subset, rather than treating a missing
module as a silent zero (which would mechanically bias the composite
toward "duration-unfavorable" purely from missing data, not a real
market read). The result is flagged `degraded` (with the specific
`missingModules` list) in `explanation.drivers.duration` whenever any
of the three optional modules is absent.

`hedge_reliable` was deliberately left OUT of this gate -- it's a
separate concern (`instrumentPref` already degrades gracefully on a
null hedge reading, falling through to the breakeven/quadrant rule) and
in practice is non-null from ~1966 onward (36 months after the
Shiller/synthetic hedge fallback's own warmup), well before
`carry_score`'s own ~1984/~1972 start -- so by the time the new gate's
three required fields are ever satisfiable, `hedge_reliable` is already
populated. Confirmed this reasoning holds rather than just assumed it;
also dropped the `NOT NULL` constraint on `bond_lens_signal.hedge_reliable`
in the same migration as a defensive belt-and-suspenders measure, in
case that reasoning is ever wrong for a data reason not anticipated here.

**Expected effect:** the composite's own start moves from wherever the
slowest-starting module among the ORIGINAL seven-way gate used to bind,
back to roughly `carry_score`'s own start -- ~1984 on `DGS3MO` alone,
or ~1972 once `DTB3` is backfilled and recomputed (§7.1's reduced
backtest window depends on this).

`durationScore`'s signature changed to accept `path`/`quadrant`/`curve`
as `number | null` (previously all five were required `number`) and now
returns `degraded`/`missingModules` alongside the existing `raw`/
`score`/`stance`/`multiplier` fields. `raw` is now the RENORMALIZED
pre-trend-gate score (not a plain 5-weight sum) -- when all five modules
are present, renormalizing over weights summing to 1.00 is a no-op, so
every pre-existing `durationScore` test continued to pass unchanged.

---

## Spot-check table (post-fix), 2026-10-02

| Date | valuation | path | carry | quadrant | curve | raw composite | gated composite | stance | instrument | maturity | why gated≠raw |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2020-03-23 | -0.98 | 0.09 | -0.74 | 0.75 | 0.50 | -0.26 | -0.26 | Neutral | nominal_tilted | 2y | trend up, no cap |
| 2022-06-14 | 0.26 | 0.46 | -0.44 | -0.16 | -0.50 | 0.03 | 0.00 | Neutral | 2y | nominal_tilted | trend down -> cap 0 |
| 2023-10-19 | 1.30 | 0.62 | -1.02 | 0.35 | -1.00 | 0.29 | 0.00 | Neutral | bills_short_tips | bills | trend down -> cap 0 |
| 2024-09-18 | 0.58 | 0.43 | -0.91 | 0.47 | 0.50 | 0.22 | 0.22 | Neutral | nominal_tilted | bills | trend up, no cap |
| 2026-09-30 (today) | 1.34 | 1.58 | 0.37 | 0.44 | -0.50 | 0.89 | 0.00 | Neutral | bills_short_tips | 2y | trend down -> cap 0 |

Explanation text, verbatim, for each:

- **2020-03-23:** "Duration: Neutral (score -0.26). Valuation unfavorable (real 10y -0.0% vs r-star 1.3%; term premium z -1.7). Curve regime: bull steepening. Best carry per unit risk: 2y (risk-adjusted carry 0.23)."
- **2022-06-14:** "Duration: Neutral (score 0.00). Valuation unfavorable (real 10y 0.9% vs r-star 1.5%; term premium z -0.1). Trend is down, capping the score at 0. Curve regime: bear flattening. Best carry per unit risk: 2y (risk-adjusted carry 1.10)."
- **2023-10-19:** "Duration: Neutral (score 0.00). Valuation favorable (real 10y 2.5% vs r-star 1.0%; term premium z +1.1). Trend is down, capping the score at 0. Curve regime: bear steepening. Bonds not a reliable hedge for equities right now — tilt toward bills/short TIPS. No maturity on the curve compensates for duration risk right now — prefer bills."
- **2024-09-18:** "Duration: Neutral (score 0.22). Valuation favorable (real 10y 1.6% vs r-star 0.9%; term premium z +0.4). Curve regime: bull steepening. No maturity on the curve compensates for duration risk right now — prefer bills."
- **2026-09-30:** "Duration: Neutral (score 0.00). Valuation favorable (real 10y 2.9% vs r-star 1.0%; term premium z +2.1). Trend is down, capping the score at 0. Curve regime: bear flattening. Bonds not a reliable hedge for equities right now — tilt toward bills/short TIPS. Best carry per unit risk: 2y (risk-adjusted carry 0.73)."

Two of five dates (2023-10-19, 2024-09-18) land on `maturity_pref =
"bills"` -- real confirmation the new sentinel fires on live data, not
just in synthetic tests. All five land in "Neutral" stance; three of
five show the trend gate actually binding (raw != gated), which is the
gate doing real work, not a decorative cap that never triggers.

---

## Phase E, re-run with corrected methodology -- 2026-10-02

Per Scott's correction: monthly, non-overlapping sampling (not daily
overlapping), 2003-2014 vs. 2015-2026 reported separately, judged on
whether an improvement holds in BOTH halves, not the full-period
aggregate.

**(a) Inflation-regime hedge rule, re-tested on 1965-2002 (not
2003-2019 -- core PCE never exceeded 3% there).** Ground truth: the
pre-1993 Shiller/synthetic realized SPY-vs-synthetic-10y-bond monthly
correlation, same construction already live in `scoring.ts`.

- 317 months with usable joined data (of ~456 possible in the window).
- Hit rate: 35/95 actual-bad-hedge months correctly flagged = **36.8%**.
- False-alarm rate: 61/212 actual-good-hedge months incorrectly flagged
  = **28.8%**.
- H2 2021 sanity check, with 2-week hysteresis added: **18 of 26**
  weeks flagged (vs. 17/26 without hysteresis -- barely changes, since
  the underlying PCE signal here is monthly and persistent).

**Verdict: do not adopt.** A 36.8% hit rate against a 28.8%
false-alarm rate is a weak discriminator -- not much better than
noise -- over the one 34-year window (1965-2002) that actually stress-
tests it. It does correctly catch 2021-22 early, which is the
headline case it was designed for, but the false-alarm rate elsewhere
in history is too high to justify overriding the realized-correlation
rule with it by default. Keep the existing correlation-based rule as
the only live rule; this stays a documented comparison variant, not
promoted.

**(b) Quadrant removed from the composite, re-tested properly
(monthly, split-half).** Alt: quadrant_score dropped, its weight moved
to valuation (0.40 total; path 0.25, carry 0.20, curve 0.10 unchanged
-- note this sums to 0.95, not 1.00, matching my own literal reading of
Scott's "(0.40)" figure from the original ask rather than a renormalized
0.45; flagged here rather than silently corrected).

| Half | metric | live | alt |
|---|---|---|---|
| 2003-2014 (n=97 months) | IC | 0.025 | 0.176 |
| 2003-2014 | hit rate | 52.6% | 55.7% |
| 2015-2026 (n=128 months) | IC | -0.043 | -0.038 |
| 2015-2026 | hit rate | 48.4% | 46.9% |

**Verdict: do not adopt.** The full-period-only result from the prior
(uncorrected) run -- IC 0.093->0.169, hit rate 48.65%->52.44% -- is
confirmed to be an artifact of pooling. The entire apparent gain lives
in 2003-2014; in 2015-2026 neither variant has real predictive power
(both ICs are noise-level negative) and the alt variant's hit rate is
outright worse than live's. This fails "holds in both halves" --
keep quadrant_score in the live composite, weights unchanged.

(The original ask also offered a second sub-variant -- quadrant's
weight going to carry (0.25) instead of valuation -- which wasn't
separately tested, since the valuation-targeted sub-variant above
already fails decisively in the recent half; happy to run the
carry-targeted version too if useful, but it's unlikely to change the
"don't adopt" conclusion given the underlying problem (quadrant and
path's own 0.72 correlation) doesn't depend on which module absorbs
the freed-up weight.)

**(c) Curve regime, live vs. strict -- unchanged from the earlier
comparison, reported as-is:** live config (10bp/5bp/2wk) averages 6.0
regime changes/year, 47.3% neutral; `curveRegimeStrict`
(15bp/8bp/4wk) averages 2.5/year, 63.5% neutral, over 1999-2026. No
new backtest run against forward returns this session -- this is a
churn/stability comparison only, not a predictive-power one. Leaning
recommendation: curve_score only carries a 0.10 composite weight (a
cross-check, per spec, not a primary driver), so the live config's
~6x/year flip rate looks more like noise than signal relative to what
a 10%-weighted module should be contributing; `curveRegimeStrict` is
the more defensible default on that reasoning, but this is Scott's
call to make, not a data-driven win either way without a real
forward-return test of the two configs against each other.

**(d) Carry history via DTB3 -- unchanged, reported as-is:** analytically
derived ~1972-73 start once DTB3 is backfilled (see above); backfill
script (`scripts/backfill-dtb3.mjs`) written this session, not yet run
(Scott runs it locally with his own service-role key).

### Final recommendation

**Default weights: unchanged** (0.30 valuation / 0.25 path / 0.20
carry / 0.15 quadrant / 0.10 curve). Neither tested reweighting variant
((a)'s rule change, (b)'s quadrant removal) earns promotion under the
corrected split-half methodology -- (a) is a weak discriminator over
its only real stress-test window, (b)'s apparent edge doesn't survive
out-of-sample.

**Adopt:**
- The maturity-preference fix and composite coverage reweighting
  (both already deployed, bond-lens-compute v13).
- `curveRegimeStrict` as the live curve-regime config, on the
  reasoning above -- Scott's call to confirm.
- Run `scripts/backfill-dtb3.mjs` when convenient, to push carry's
  (and the full composite's) start back from ~1984 to ~1972.

**Don't adopt:**
- Variant (a) (inflation-regime hedge override) -- 36.8%/28.8%
  hit/false-alarm, too weak a discriminator.
- Variant (b) (quadrant out of the composite) -- full-period gain
  doesn't survive the 2015-2026 half.

---

## Phase E, completed -- 2026-10-02

Scott's follow-up after reviewing the above: the full composite's own
IC/hit-rate (0.025/-0.043, 52.6%/48.4%) is "essentially no predictive
power," and §7 wasn't actually finished -- stance distribution, forward-
return-by-stance, the 6-variant bond sleeve backtest, sensitivity, and
model-portfolio tests were all still outstanding. Full results, decision
rule applied mechanically (no weight-tuning), and the final recommendation
are in **`docs/specs/bond-lens-phase-e-report.md`** -- not duplicated here.

Headline: the full 5-module composite doesn't beat a constant-1.0x-
duration baseline on Sharpe in 2015-2026, and loses to simpler variants in
one or both halves. The simplest variant that beats the baseline in BOTH
halves, and beats every other variant tested in both halves, is
**valuation_score alone, no trend gate, no other module** -- confirmed
robust under +/-50% threshold/multiplier sensitivity. Recommendation: v1
drives `duration_score`/`duration_stance`/`duration_multiplier` from
valuation alone; path/carry/quadrant/curve stay computed and displayed
(explanation, maturity table, hedge/curve badges, a new display-only
inflation-regime warning for variant (a)) but drop out of the stance
decision. Not yet implemented in code -- pending Scott's review, per his
explicit instruction not to start Phase D (or revise the shipped
composite) until then.

Also landed this session: `curveRegimeStrict` promoted to the only/default
curve-regime config (`bond-lens-compute` v14, redeployed and recomputed --
see composite.ts's own decision above); `.env.local` confirmed covered by
`.gitignore` ahead of Scott adding `SUPABASE_SERVICE_ROLE_KEY` for the
DTB3 backfill.

---

## Phase E approved; spec promoted to v3 -- 2026-10-02

Scott's decisions on the Phase E report, in full:

1. **Duration stance from valuation only, capped at Extend.**
   `duration_score = valuation_score`, no trend gate, FIXED thresholds
   (-0.75/0.5) -- exactly what the winning Test 3 backtest used, not the
   percentile-based alternative (diagnostic only, never the scheme
   actually backtested). "Max extend" dropped (its trend=up condition no
   longer exists; no evidence supports a 1.6x band regardless). Sharpe
   re-confirmed with the cap applied: **0.64 (2003-2014) / -0.12
   (2015-2026)**, vs. the uncapped 0.66/-0.11 -- negligible difference
   (the >1.0 band was rare in-sample), still beats the constant-duration
   baseline (0.60/-0.20) in both halves. Implemented in `composite.ts`
   (durationScore/maturityPref/instrumentPref/buildExplanation all
   simplified -- `DurationStance` is now `"Short" | "Neutral" | "Extend"`,
   `DurationScoreResult` dropped `raw`/`degraded`/`missingModules` since
   there's only one input now and the composite-level gate (valuation_score
   alone) replaces the old carry+trend+valuation gate). Redeployed as
   `bond-lens-compute` v15.
2. **Honest framing.** The exact line Scott specified is now the lead
   sentence of `bond-lens-phase-e-report.md`'s verdict: *"No variant beats
   constant duration by more than about 0.1 Sharpe; differences are
   within noise. Valuation-only is adopted as a modest, economically
   grounded tilt, not a proven edge."* A short version goes in the Bond
   Lens card's info tooltip (§8 of the spec) -- **not yet implemented in
   UI code**, since no Bond Lens frontend component exists in this repo
   yet (Phase F hasn't started); logged here so the exact tooltip text is
   ready whenever Phase F is built.
3. **Instrument/maturity preference: display-only in v1.** Confirmed --
   `instrument_pref`/`maturity_pref` were never backtested (Phase E only
   tested the duration decision). Phase D (just-started, see below)
   applies ONLY `duration_multiplier`; the per-holding nominal/TIPS mix
   and maturity profile are left unchanged. **Follow-up, logged, not
   blocking:** backtest the TIPS-tilt rule vs. a constant mix, and the
   EFF-based maturity choice vs. a fixed 7-10y bucket, both from 2003.
   Not run this session.
4. **Scope.** `include_credit` now defaults to `false`. In scope by
   default: Treasury, TIPS, bills, aggregate funds. Agency MBS, IG
   corporate, and munis join HY/EM debt as excluded-by-default, reported
   as "excluded holdings." `docs/specs/bond-lens.md` §6.1 updated
   directly (and §5.1-5.4, §6.2-6.3, §7.4, §8, §10 -- see the spec's own
   new "§0b. Changes from Phase E (v2.1 -> v3)" section for the full
   list).
5. **Other modules labeled "context."** path/carry/quadrant/curve/trend
   stay computed and displayed, plus the hedge badge and a new
   display-only inflation-regime warning (variant (a), next to the hedge
   badge) -- but carry no weight in `duration_score`. The UI "context"
   labeling and the inflation-regime warning badge are **spec'd, not yet
   built** (same Phase-F-doesn't-exist-yet reason as item 2).
6. **Annual Phase E re-run.** New §7.4 in the spec. **Not yet scheduled
   as an actual recurring job this session** -- this repo's cron
   mechanism (`pg_cron` + edge functions, per §0 item 8) would need a new
   yearly-cadence job calling a new backtest edge function; that function
   doesn't exist yet. Logged as a near-term follow-up, separate from
   Phase D.

Then Phase D per §6, with v2.1 and v3 changes together -- see the next
entry for what's actually been built.

---

## Phase D built -- 2026-10-02

Scope confirmed by direct query before writing anything: `portfolios.
use_bond_lens_overlay` and `bond_lens_portfolio_settings` already existed
(Phase A), `bond_lens_portfolio_settings` had 0 rows, `bond_instrument_meta`
already had 31 rows with `effective_duration` already populated for every
IN-SCOPE holding (SHY 1.84, TLT 14.63, SCHP 6.4, VTIP 2.4) -- no manual
duration backfill needed. Reconnaissance (a dedicated fork) found
`combineAllOverlays`/`computeAllocationDeltas` (`lib/simulatorKeys.js`,
`lib/marketOverlayPortfolio.js`) already support a `sectorTargets`
override map (per-symbol % of its OWN bucket's target, falling back to
pro-rata) -- the exact mechanism every other overlay already uses to
reshape holding-level weights. Decided to make Bond Lens a sectorTargets
PRODUCER rather than a parallel pipeline, both for consistency and
because it makes the "off == identical" acceptance test close to free
(an empty sectorTargets map is already that function's own no-op
default).

**`lib/bondLensPortfolio.js`** (new, pure, no DB dependency):
- `classifyBondSleeve` -- §6.1's scope table, by `bond_type`: always-in-
  scope (`treasury_nominal`, `tips`, `bills_cash_like`, `aggregate`),
  credit-gated on `include_credit` (`ig_corporate`, `muni`,
  `agency_mbs`), always-excluded (everything else, e.g. `high_yield`,
  `em_debt`). Unclassified/missing-duration holdings excluded and
  flagged, never guessed (§6.7).
- `sleeveStats` -- weight, weighted duration, mix (nominal/tips/bills/credit).
- `solveDurationShiftWithinBucket` -- the actual new machinery. v3
  dropped the mix/maturity-targeting that originally motivated a general
  LP (§6.3's "small optimization"), so this is a closed-form greedy
  two-extreme-point solver instead: to raise a bucket's weighted
  duration, move weight from its shortest-duration holding(s) to its
  longest (reverse to lower) -- provably turnover-minimal for a single
  linear constraint with an L1 objective, no LP library needed. Flags
  `target_reachable = false` with a `gap_note` when a bucket has only one
  holding, or the target is beyond what its own held instruments can
  reach (does NOT reach for `eligible_instruments` substitutes itself in
  v1 -- flagged as a gap, not auto-resolved).
- `computeBondLensSectorTargets` -- ties it together. Each bucket's own
  target duration = that bucket's own CURRENT duration x (sleeve target /
  sleeve current), where sleeve target = `benchmark_duration` (portfolio
  setting, or the sleeve's own current duration if null, per §6.1) x
  `duration_multiplier`. This is why Neutral (multiplier 1.0, no explicit
  benchmark override) is a true no-op: ratio = 1 regardless of starting
  duration. **No TIPS tilt, no maturity targeting anywhere in this module
  -- v3 scope.**
- 22 tests (`tests/bondLensPortfolio.test.ts`), including the literal
  acceptance test from spec §6: `computeAllocationDeltas(holdings,
  targets, { sectorTargets: {} })` (Bond Lens off) produces IDENTICAL
  `actionRows` to the same call with `sectorTargets` omitted entirely
  (no Bond Lens code in the picture at all) -- not a manual check, an
  automated one.

**UI wiring** (`app/portfolios/page.jsx`, two delegated passes): toggle
checkbox mirroring `use_market_overlay`/`use_capex_overlay` exactly;
Bond Lens card (stance/multiplier, instrument/maturity labeled
"(display-only)", hedge badge, sleeve before/after, excluded holdings,
gap notes, explanation text, stale-signal handling per §6.7); merged into
the existing Portfolio Actions `computeAllocationDeltas` call via
`sectorTargets`, strictly gated on `use_bond_lens_overlay` (the function
is never even called when off, not called-then-discarded); `bond_lens_
toggle_log` insert on enable/disable. 404/404 tests pass throughout
(22 new, 382 unchanged), `npm run build` clean.

**Explicitly NOT built this session (logged, not silently skipped):**
- No settings-EDITING UI for `bond_lens_portfolio_settings` -- read-only
  display only. No portfolio has a settings row yet (defaults apply to
  all). Editing UI (benchmark duration override, min-trade-threshold,
  etc.) is a follow-up.
- No "settings change" entries in `bond_lens_toggle_log` (only
  enable/disable) -- there's no settings-editing UI yet to generate one.
- The info tooltip (Phase E's verdict line), the "context" labeling on
  path/carry/quadrant/curve score bars, and the inflation-regime warning
  badge (§8, items 2/5 from the prior entry) -- still not built; no Bond
  Lens market-view/UI work has happened at all beyond the portfolio card
  above. The inflation-regime warning specifically also needs a new
  backend computation (core PCE 3-month-annualized vs. 12-month, not
  currently a queryable column anywhere) that hasn't been built either.
- `eligible_instruments` substitutes (BIL/SHY, IEI, IEF, TIP/SCHP, STIP)
  are not consulted by the solver -- only currently-held instruments are
  ever reallocated among. A bucket with only one holding simply reports
  `target_reachable = false`.
- The TIPS-tilt-vs-constant-mix and EFF-maturity-vs-fixed-bucket backtest
  (logged as a Phase-E follow-up, not blocking) -- still not run.
- Tests 8/9's full model-portfolio simulation already ran in Phase E
  (`bond-lens-phase-e-report.md`) using IEF/TIP/HYG proxies -- Phase D's
  OWN acceptance fixture set (Treasury-only, aggregate-fund-only, mixed
  Treasury/TIPS/corporate, no bonds, HY-only, unknown ticker, per §6
  "Phase D acceptance") was not separately built as fixture portfolios in
  this app's own test data -- the `tests/bondLensPortfolio.test.ts` fixtures
  cover the same cases in isolation (unit-level), not as literal seeded
  portfolio rows.

---

## Phase D, Step 1: eligible_instruments substitutes -- 2026-10-02

Per Scott's instruction, built in order, checkpointing before Step 2.

**Why this was needed:** the dry run (above) found 3 of 9 portfolios
(All Weather Alpha, All Weather With Equity Tilting, Dalio All Weather)
flagged `target_reachable = false` purely because their nb/tip buckets
each hold exactly ONE instrument -- nothing to shift weight between.

**Ingestion:**
- `asset_price_history`: BIL/SHY/IEF/TLT/VTIP already covered; **SCHP was
  missing entirely** (0 rows) -- backfilled via the existing
  `backfill-asset-price-history` edge function (`?symbols=SCHP`, no new
  code needed), 4,065 rows, 2010-08-05 to present.
- `bond_instrument_meta`: SHY/TLT/SCHP/VTIP already had `effective_duration`
  + `duration_as_of` populated (real holdings, Phase A). BIL and IEF are
  held by NO current portfolio, so they had no `holding_id` to attach to
  at all -- required a real schema change, not just new rows: swapped the
  table's PK from `holding_id` to a new surrogate `id`, added a `symbol`
  column, made `holding_id` nullable with a check constraint
  (`(holding_id IS NOT NULL) <> (symbol IS NOT NULL)`, exactly one of the
  two set per row) and a partial unique index on each. Inserted two
  reference rows (`holding_id: null`, `symbol` set instead):
  - **BIL**: 0.10y effective duration, as of 2026-10-01. Source: SSGA/
    State Street's own BIL fact sheet (1-3 month T-bill fund; stable,
    near-zero duration by construction).
  - **IEF**: 6.87y effective duration, as of 2026-10-01. Source:
    iShares' own IEF product page (7-10y Treasury fund).
  Both sourced via live web search against each fund's own published
  page, not estimated from memory -- this directly drives real
  duration math, so it needed a real citation, not a guess.

**Solver** (`lib/bondLensPortfolio.js`):
- `solveDurationShiftWithSubstitutes(entries, targetDuration, eligibleMeta, opts)`:
  tries the held-only solve first (turnover-minimizing -- substitutes are
  a last resort, never a first choice). If unreachable, finds eligible
  candidates (not already held) on the correct side of the gap, and
  introduces the SINGLE MOST EXTREME one (longest when raising past
  every held holding's own max, shortest when lowering past every held
  holding's own min). Proven sufficient on its own: for one linear
  constraint with an L1 objective, no combination of two or more
  less-extreme substitutes could ever reach further than the one most
  extreme instrument already does alone -- so "fewest new instruments
  possible" reduces to "at most one," always.
- `solveDurationShiftWithinBucket` extended to accept synthetic
  zero-weight substitute entries (`isSubstitute: true`) as valid
  RECEIVERS without any other change to its logic -- a substitute
  starting at $0 can never become a donor anyway (the existing
  donor-capacity check already skips any entry with nothing to give
  away), so this fell out of the existing code for free.
- `computeBondLensSectorTargets` takes a new 5th param,
  `bondInstrumentMetaBySymbol` (symbol-keyed, covering both held and
  reference rows), and returns `proposedNewHoldings` for any introduced
  substitutes -- entries not in the original `holdings` array at all,
  so the UI can label them distinctly ("Proposed -- not held") rather
  than conflating them with real holdings.
- **Invariants re-confirmed, same three as the user's pre-enable
  checklist, now covering substitutes too:** bucket totals still fixed
  (a substitute's weight comes out of the SAME bucket's existing total,
  never a different bucket or a new allocation); composition with
  exposureMultiplier unaffected (substitutes flow through the exact same
  `sectorTargets` mechanism); no cash/freedPct interaction (substitutes
  never touch the cash bucket, same as before).
- **Known asymmetry, logged plainly, not fixed:** the default `tip`
  eligible list (`VTIP`, `SCHP`) has nothing shorter than VTIP's own
  2.40y -- a tip-bucket target below that stays unreachable even with
  substitutes, by construction of the chosen defaults (Scott's own
  explicit list, not something this session second-guessed).

**Tests:** 11 new (`tests/bondLensPortfolio.test.ts`, now 36 in that
file / 418 total), covering single-instrument buckets needing a
substitute in both directions, the "most extreme wins" selection logic,
unreachable-even-with-substitutes, the default-vs-custom
`eligible_instruments` list, and a portfolio already exactly at target
(no trade, no substitute).

**UI wiring**: `app/portfolios/page.jsx` -- `bondInstrumentMetaBySymbol`
built client-side from data already fetched in `load()` (no new query:
the existing `bond_instrument_meta` row set already contains both held
and reference rows; held rows keyed by their holding's symbol via the
already-fetched holdings-valued view, reference rows keyed by their own
`symbol` column). Threaded through both `computeBondLensSectorTargets`
call sites. `BondLensSleeveDetail` (shared by the live card and the
enable-preview modal) renders `proposedNewHoldings` as a visually
distinct "Proposed -- not held" block, with explicit copy that Bond Lens
never creates a holding or places a trade. Confirm path re-verified:
still only writes `portfolios` + `bond_lens_toggle_log`.

**A real bug found by the dry run itself, fixed before Checkpoint 1**:
Dalio All Weather has a $0 SCHP row (position fully sold down, row never
deleted) alongside a real VTIP holding. The first substitute-solver pass
treated "a row exists for this symbol" as "already held," which
incorrectly excluded SCHP from ever being proposed there -- even though
a $0 row contributes nothing to the bucket's actual achievable duration
range and should be exactly as eligible as a truly-unheld substitute.
Fixed: `solveDurationShiftWithSubstitutes` now derives held-symbols/
held-durations from POSITIVE-weight entries only. Added a regression
test. Re-ran the dry run after the fix: Dalio's `tip` bucket now
correctly proposes SCHP too, matching the other two portfolios' tip
buckets.

**Checkpoint 1 result** (`docs/bond-lens-dry-run-2026-10-02.md`,
before/after reachability for the 3 portfolios the first dry run flagged
unreachable):

| Portfolio | nb bucket, before | nb bucket, after | tip bucket, before | tip bucket, after |
|---|---|---|---|---|
| All Weather Alpha | unreachable (TLT only) | **still unreachable** (TLT already the longest default nb instrument -- no substitute is more extreme) | unreachable (VTIP only) | **reachable -- SCHP proposed** |
| All Weather With Equity Tilting | unreachable (TLT only) | **still unreachable**, same reason | unreachable (VTIP only) | **reachable -- SCHP proposed** |
| Dalio All Weather | unreachable (TLT only) | **still unreachable**, same reason | unreachable (VTIP only, plus the $0 SCHP row) | **reachable -- SCHP proposed**, after the fix above |

Net: 0 of 3 portfolios are now FULLY reachable (each still has an
unreachable `nb` bucket), but all 3 TIP buckets flip from unreachable to
reachable. The remaining `nb`-bucket gap is structural, not a bug: TLT
(14.63y) is already the longest instrument in the default `nb` eligible
list (BIL/SHY/IEF/TLT) -- Extend's target duration for these particular
portfolios' current allocations sits beyond what even the full default
list can reach. A longer nb substitute (e.g. a 20+ year Treasury ETF)
would need to be added to `eligible_instruments` to close this -- not
done here, since Scott's instruction specified exactly BIL/SHY/IEF/TLT
as the default and didn't ask for a longer option; logging this as a
future option, not a gap to silently patch.

Golden Butterfly Hedged and Note Portfolio: unchanged from the original
dry run (both already had a clean answer -- a real trade and a trivial
no-op respectively).

Tests: 36 in `tests/bondLensPortfolio.test.ts` (419 total), including
the single-instrument-bucket-in-both-directions, fewest-new-instruments,
custom-vs-default-eligible-list, already-at-target, and the $0-holding
regression cases Scott asked for. `npm run build` clean.

**Stopping here for Scott's review, per his explicit instruction**
("Work in order and stop at each checkpoint") -- Step 2 (defensive tier
backtest) not started.

---

## Checkpoint 1 follow-ups, approved by Scott -- 2026-10-02

Confirmed: the `nb`-bucket gap (TLT already the longest default
instrument) is NOT a bug -- deliberately not extending the default list
with strip ETFs (EDV/ZROZ), which change the risk profile too much for a
default.

1. **Gap-note wording.** When `solveDurationShiftWithSubstitutes` finds
   no eligible candidate beyond the currently-held extreme, it no longer
   returns the generic "consider an eligible substitute" note -- it now
   returns, verbatim: *"Already at the long end of eligible instruments;
   no further extension available. Shortening remains available if the
   stance turns defensive."* (symmetric short-end wording for the
   opposite direction). Two new tests confirm the exact strings.
2. **EDV, opt-in only.** Added as a `bond_instrument_meta` reference row
   (23.9y effective duration, Vanguard's own fact sheet, as of
   2026-08-31 -- ~1.6x TLT's 14.63y, matching Scott's own framing almost
   exactly) and backfilled into `asset_price_history` (4,700 rows,
   2008-01-29 to present). Deliberately NOT added to
   `DEFAULT_ELIGIBLE_INSTRUMENTS` -- only reachable if a portfolio's own
   `eligible_instruments` setting explicitly includes it (Step 3's
   settings editor, not built yet -- the data layer already supports it
   today if set directly). New test proves it's unreachable by default
   and reachable once explicitly added to the candidate list. UI warning
   added to `BondLensSleeveDetail` (shared by the live card and the
   preview modal): "Zero-coupon strips: roughly 1.6x TLT's rate
   sensitivity," shown whenever EDV appears with positive weight in
   either `sectorTargets` or `proposedNewHoldings` -- i.e., whenever it's
   actually part of what's being shown, not merely configured.
3. **Short-stance reachability, confirmed.** A test-only forced
   `duration_multiplier = 0.5` (the real signal untouched) shows all
   three previously-nb-unreachable portfolios (All Weather Alpha, All
   Weather With Equity Tilting, Dalio All Weather) become reachable --
   each via **BIL** specifically (0.10y, the single most extreme eligible
   short instrument, not SHY), landing around 7.3y. This confirms the
   "already at the long end... shortening remains available" framing in
   the new gap note is literally true, not just a nice sentence.
   Appended to `docs/bond-lens-dry-run-2026-10-02.md`.

Tests: 421 total (2 new for the gap-note wording, 2 new for EDV
opt-in). `npm run build` clean. Committed, then proceeding directly to
Step 2 per Scott's "then proceed" instruction.

---

## Step 2: defensive tier -- tested and rejected -- 2026-10-02

Trigger tested: `valuation_score < -0.75` AND `trend_state = down` AND
`hedge_reliable = false`, 2-week hysteresis on the combined condition.
Effect tested: 0.1x multiplier (modeled as a direct override on the
same sleeve_return formula Phase E used -- BIL's own duration, ~0.10y,
is close enough to cash that this is a reasonable backtest
simplification for "shift into BIL," stated explicitly rather than
building a separate BIL return series).

**Only 4 episodes ever activate across the full 1965-2026 history**:
1994-12-09 to 1995-01-13, 1996-05-24 to 1996-06-14, 1996-07-19 to
1996-08-02, and 2021-06-18 to 2021-07-16. **2022, 2013 (taper tantrum),
and the 1980s never trigger at all** -- confirmed directly against the
real `valuation_score` series:

- **2022**: valuation_score bottomed near -1.05 in March, while
  `hedge_reliable` was still `true`. By late July, when hedge flipped
  `false`, valuation had already recovered to -0.2/-0.4 -- the two
  conditions never overlap.
- **2013 taper tantrum**: same pattern -- valuation recovers before
  trend/hedge confirm.
- **1980s (Volcker disinflation)**: `valuation_score` actually reads
  strongly FAVORABLE (+1 to +2) through this period, since it measures
  richness relative to r-star/term premium, not absolute yield level --
  despite extreme absolute yields, the model doesn't see bonds as
  "expensive" here at all. Trend/hedge may fire; valuation never does.
  This is the model behaving as designed, not a flaw to patch -- the
  defensive tier's valuation leg is just never satisfied in a regime
  the naive "yields are high" intuition would expect it to be.

**The underlying problem, structural, not a parameter-tuning issue**:
the three conditions are anti-correlated in practice. Valuation tends
to recover (bonds get cheap, i.e. yields rise enough) BEFORE trend and
hedge_reliable both confirm -- by the rare times all three align, the
easy money in avoiding the selloff has usually already been missed.

**False-trigger cost**: the 1994-12-09 episode missed one of the best
bond rallies on record (DGS10 7.79% -> 5.73% over the next 12 months)
while defensively parked. The two 1996 episodes cost little (roughly
flat-to-mild-rally, -9 to -54bp). The one real-IEF-data-era trigger
(2021-06-18) was flat over its own active window and had already
deactivated well before 2022 -- it does NOT get credit for correctly
avoiding 2022, since the rule wasn't active when 2022 actually hit.

**Quantitative result** (monthly, real IEF/DGS3MO, same methodology as
the Phase E report, baseline = live v3):

| Half | Baseline Sharpe/maxDD/turnover | +Defensive tier |
|---|---|---|
| 2003-2014 (0 active months) | 0.64 / -7.87% / 11.1% | identical -- no historical trigger falls in this window |
| 2015-2026 (1 active month) | -0.12 / -17.71% / 11.3% | -0.13 / -18.35% / 12.1% -- WORSE on every metric |

**Decision: tested and rejected**, per the stated adoption bar
("improves max drawdown without lowering Sharpe in either half"). H1
shows zero effect at all. H2 -- the only half it does anything in --
makes Sharpe worse, max drawdown worse, AND turnover higher. Fails even
the weaker "does no harm" bar. Not adopted. Not wired into any live
code or config -- this was backtest-only throughout, as instructed.

**Stopping here for Scott's decision, per his explicit instruction**
("stop at Checkpoint 2") -- Step 3 (settings editor) and Step 4 (market
view) not started.

---

**DTB3 backfill: dropped from the to-do list (Scott, 2026-10-02).** Carry
is context-only now (v3 §5.1) -- it no longer feeds `duration_score`, so
extending its own history from ~1984/~1965 (valuation's own start, which
already governs the composite's real start post-v3) back to ~1972 buys
nothing for the live rule. `scripts/backfill-dtb3.mjs` stays in the repo,
unused, in case a future reason to extend `carry_score`'s own display
history (or a future model that weights carry again) comes up -- not
deleted, just no longer on anyone's critical path.
