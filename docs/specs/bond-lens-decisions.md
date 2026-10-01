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
