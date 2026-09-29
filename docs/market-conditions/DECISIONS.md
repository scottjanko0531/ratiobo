# Market Conditions Overlay — decisions log

## Bug: Market Conditions Overlay card ignored the existing resize overlay entirely (2026-09-29)

**Symptom**: KISS's overlay card recommended selling 100% of USFR (cash) and
adding a small amount to VT.

**Wrong first fix (reverted)**: initially diagnosed this as KISS's
`target_allocations` missing an explicit `cash` entry, and added
`cash: 30` (rescaling eq/gld/alt_crypto to 42/21/7 to fit). **This was
wrong** — per `kiss-portfolio-backtest`'s own validated design, cash has
no fixed floor at all; `runRebalanced`'s monthly target starts at
`tUsfr = 0` and is set *purely* by whatever's currently displaced by an
active resize signal (`tUsfr = (0.6-tVt) + (0.3-tGldm) + (0.1-tBtc)`),
draining back toward 0% once every leg's signal clears. Baking in a
permanent 30% floor would have silently redefined KISS's strategy from
"fully invested with a transient cash sink" to "always 30% cash" — a
different, never-backtested allocation. `target_allocations` reverted to
its original `{eq: 60, gld: 30, alt_crypto: 10}`.

**Real root cause**: GLDM's live resize signal is `reduced = true,
exposure_multiplier = 0` (`vol_regime` rule) — correctly explaining why
it's held at $0 and why USFR is sitting at ~30% (GLDM's displaced weight,
exactly as designed). The Market Conditions Overlay card's own
"without overlay" baseline, though, was computed straight from
`pf.target_allocations` with **no exposureMultipliers at all** — it never
looked at the resize overlay's live per-symbol signals (`asset_resize_signals`,
already correctly feeding the pre-existing "Portfolio Actions" block
elsewhere on the same page). So the card's baseline saw `gld: 30%` as
GLDM's unreduced target and `cash` as an implicit 0%, and recommended
liquidating USFR to reach that. With the market tier at FULL (multiplier
1, itself a no-op) and GLDM's cut completely un-modeled, the card treated
a portfolio that's already correctly positioned as one that badly needed
$60k moved out of cash.

**Fix**: `lib/marketOverlayPortfolio.js`
- `applyOverlayToTargets` no longer restricts freed-weight accounting to
  `EQUITY_KEYS` — a resize/capex cut on ANY bucket (gld, alt_crypto, etc.)
  must free weight into cash, not just an equity cut. This was the direct
  bug: KISS's freed weight came entirely from a non-equity (gld) cut, which
  the equity-only version silently ignored.
- New `combineAllOverlays(resizeMultipliers, capexMultipliers,
  marketMultipliers, capexApplied)`: resize always multiplies on top
  (orthogonal, symbol-specific technical rules — same independent-signal
  relationship resize already has with capex via `mergeExposureMultipliers`
  in `lib/capexOverlay.js`), while capex and market still combine via MIN
  where both apply to the same equity symbol (the Phase 6 review decision,
  unchanged), and a capex-only cut on a non-equity symbol still applies on
  its own.
- `app/portfolios/page.jsx`'s card: "without overlay" now uses the SAME
  `exposureMultipliers` (resize × capex product) the existing Portfolio
  Actions block already uses — i.e. today's actual live state — instead of
  raw, unscaled `target_allocations`. "With overlay" layers the market
  overlay on top via `combineAllOverlays`. This is the structurally correct
  fix: the card now shows what the MARKET overlay specifically changes,
  not a comparison against a fictional zero-signal portfolio.

**Verified**: new regression tests in `tests/marketOverlayPortfolio.test.ts`
reconstruct KISS's exact live shape (GLDM reduced, VT/FBTC not reduced,
market tier FULL) and assert USFR comes out to a hold (~30% target vs.
~29.9% actual, delta under 5% of its value) rather than a sell-to-zero.
250/250 tests passing, `next build` clean.

**Lesson for next time**: when diagnosing an allocation-recommendation bug
on a resize-overlay portfolio, check the live `asset_resize_signals` state
for every held symbol BEFORE concluding the target config is wrong — a
"missing" cash target can be entirely correct if a non-equity leg's live
signal is expected to be supplying it.

## Phase 3 + Phase 6 merged to main (2026-09-29)

Both branches merged to `main` as clean fast-forwards (no conflicts, per
the merge-order confirmation below): `market-conditions-phase3-preview`
then `market-conditions-phase6-portfolio-overlay`. Production redeployed
(`dpl_AMQLTNMP2ngTCx3muFJjNdC7uxqv`), zero runtime errors on the new
deployment, `/`, `/market-conditions`, and `/portfolios` all serve 200
with no error content. Full authenticated visual confirmation of the
rendered cards isn't possible from here (no login credential available,
per this whole project's standing constraint) — the JSX was already
verified against real data pre-merge via the temporary dev-preview
technique (see the Phase 6 build/review entries below); production is
running the identical, already-verified code.

**tmp-fred-series-check**: a throwaway diagnostic Edge Function (ad-hoc
FRED series/metadata lookup, created during the mc-1.1.0 BAA10Y-vs-HY-OAS
investigation) with no committed source file and no references anywhere
in the repo — genuinely dead weight, safe to remove. **Not removed**: no
available tool in this session can delete an Edge Function (the Supabase
MCP server has no delete-function operation, and the `supabase` CLI isn't
authenticated in this environment — `supabase functions delete` and
`functions deploy` both 401). Needs manual removal via the Supabase
dashboard, or a future session with `supabase login` completed first.

**Tonight's scheduled runs (2026-09-29, 22:30/22:40 UTC ingest/compute)**:
baseline recorded before they fire — `mc_job_runs`'s latest `ok` rows are
both dated 2026-09-28 (started_at 22:30:01/22:40:02 UTC), and
`mc_signal_log_live`'s latest row is `date = 2026-09-28`. Tomorrow's check
should confirm: two new `mc_job_runs` rows for `market-conditions-ingest`/
`market-conditions-compute`, `status = 'ok'`, `started_at` in the
2026-09-29 22:30-22:41 UTC window; and a new `mc_signal_log_live` row for
`date = 2026-09-29` whose `computed_at` sits in that same window (not
hours/days later, which would indicate the row came from a manual
backfill rather than the cron run itself).

## Phase 6 review, before merge (2026-09-29)

Four items raised in review of the Phase 6 build below.

**1. Overlay stacking with AI Capex Cycle — MIN, not product.** When a
portfolio has both `use_market_overlay` and the capex overlay active
(applied, not shadow-mode), the effective per-symbol multiplier is
`min(market_multiplier, capex_multiplier[symbol])`, not their product (the
convention used elsewhere for resize x capex, `mergeExposureMultipliers`
in `lib/capexOverlay.js`). Reasoning: resize x capex are genuinely
independent signals (a symbol-specific trend/vol rule x a top-down
capex-cycle read) where multiplying is the right combination; market
conditions and capex are instead two different reads of overlapping
broad-drawdown risk, so multiplying would double-count the same risk
twice. MIN says the worse of the two reads governs. New
`combineWithCapexOverlay` in `lib/marketOverlayPortfolio.js` returns both
the combined multiplier map and a `binding` map (`"market"`/`"capex"`/
`"tie"` per symbol), surfaced in the portfolio-page UI as a small note
under any holding where capex is the binding (tighter) constraint, plus a
header line noting the two overlays are stacked. This also exposed a real
gap in the original freed-weight math: `applyMarketOverlayToTargets` used
a single flat multiplier per equity bucket, which is only correct when
every holding in a bucket shares the same multiplier -- true for the
market overlay alone, false once capex can bind for only SOME holdings in
a bucket. Replaced with `applyOverlayToTargets`, which value-weights the
actual per-symbol multiplier map (same convention as the existing
resize-overlay `avgMultFor` in `app/portfolios/page.jsx`), so cash still
absorbs exactly the true cut regardless of how many multipliers are
stacked. New tests in `tests/marketOverlayPortfolio.test.ts` cover both on
(market binds), both on (capex binds), capex off, and a mixed-bucket
value-weighting check end-to-end through `computeAllocationDeltas`.

**2. Equity classification, confirmed.** Every `SIMULATOR_KEYS` bucket,
with its Phase 6 classification:

| Key | Label | Classification |
|---|---|---|
| `eq` | US Equities | **Equity** |
| `intl` | International | **Equity** |
| `em` | EM Equities | **Equity** |
| `nb` | Nominal Bonds | non-equity |
| `tip` | TIPS | non-equity |
| `com` | Commodities | non-equity |
| `gld` | Gold | non-equity |
| `cash` | Cash | non-equity |
| `alt_crypto` | Crypto | non-equity (excluded — different risk profile, overlay never validated against it) |
| `alt_re` | Real Estate | non-equity (excluded — illiquid/private, overlay explicitly untested on concentrated sleeves) |
| `alt_loan` | Notes / Loans | non-equity (debt-like) |
| `alt_pp` | Private Placements | non-equity (excluded — illiquid/private) |
| `alt_other` | Other | non-equity (excluded — unknown composition) |

`EQUITY_KEYS = {eq, intl, em}` unchanged from the original Phase 6
proposal — nothing equity-like escapes it, and nothing non-equity is
caught by it.

**EEM out-of-sample check (em bucket specifically), mc config unchanged,
2003-04-14 to 2026-09-29** — same methodology as the QQQ/IWM/EFA
cross-market test (`supabase/functions/market-conditions-crossmarket`,
now also covers EEM; backfilled via `backfill-asset-price-history`):

| Market | Overlay Calmar | 200-day rule Calmar | Buy & hold Calmar |
|---|---|---|---|
| EEM | **0.19** | 0.15 | 0.15 |

Overlay beats both alternatives on EEM (CAGR 6.5% / maxDD -34.4% vs.
buy-and-hold's 10.0% / -66.4% — a large drawdown cut for a moderate CAGR
give-up, same shape as QQQ/IWM/EFA). **No exclusion proposed** — `em`
stays in `EQUITY_KEYS`. Recorded in `lib/marketConditionsMeta.js`'s
`VALIDATION_SUMMARY.crossMarket`, report only, not a gating criterion.

**3. Rebalance gate, confirmed + tested.** `shouldProposeRebalance` is a
pure state comparison (`currentTier !== lastRebalancedTier`), not "did the
tier change today" — it has no notion of "today" at all, so it keeps
firing on every subsequent day the two remain different, including days
after a missed tier change, until the portfolio is actually marked
rebalanced. New test in `tests/marketOverlayPortfolio.test.ts` simulates a
tier change followed by two skipped days, confirming the gate still fires
on each, and stops only once `last_rebalanced_tier` is actually written.

**4. Merge order, confirmed.** `market-conditions-phase6-portfolio-overlay`
branches from `market-conditions-phase3-preview` (`a50c6d5` is a
confirmed ancestor), which is itself not yet merged to `main`. `origin/main`
is still exactly at the phase3/phase6 common ancestor (`9064c70`), so
merging phase3 then phase6 are both clean fast-forwards — no conflicts
expected. **Merge order: phase3 first, then phase6.** Awaiting approval
before merging.

## Phase 6 build: per-portfolio risk-parity integration (2026-09-29)

Implements the kickoff decision below. Read-before-building turned up an
almost-complete precedent already shipped for the resize/capex overlays
(`app/portfolios/page.jsx`'s "Portfolio Actions" block): the freed-weight
math and the two-stage "bucket target × per-symbol multiplier" allocation
design already exist in `computeAllocationDeltas` (`lib/simulatorKeys.js`).
Phase 6 reuses that machinery rather than adding new allocation math.

**EQUITY_KEYS proposal (no prior equity classification existed in the
repo)**: `EQUITY_KEYS = new Set(["eq", "intl", "em"])` in
`lib/simulatorKeys.js`, same shape/precedent as the existing `ILLIQUID_KEYS`.
Bonds, TIPS, commodities, gold, cash, and the illiquid alts are all left
untouched by the overlay — it only dials the three public-equity buckets,
matching the disclaimer that it's validated on broad equity indexes only.

**`use_market_overlay` is an independent boolean**, not a new
`strategy_framework` value. The existing resize/capex overlay gating
already applies to both `resize_overlay` and `regime_driven` identically
despite UI copy implying mutual exclusivity, so there's no real precedent
for framework-exclusivity here, and the CHECK-constrained enum would need
a migration either way. New columns (`20260930_market_overlay_portfolio_fields.sql`):
`portfolios.use_market_overlay boolean not null default false`,
`portfolios.last_rebalanced_tier text` (nullable, checked against the same
5 tier values as `market_conditions_scores.tier`).

**New pure-function module** `lib/marketOverlayPortfolio.js`:
- `marketOverlayMultipliersBySymbol(holdings, exposureMultiplier, equityKeys)` — symbol→multiplier map, the overlay's single global multiplier applied to every equity-classified holding only.
- `applyMarketOverlayToTargets(rawTargets, exposureMultiplier, equityKeys)` — adds the freed equity weight to the cash bucket target; equity bucket targets themselves are left unscaled since `computeAllocationDeltas` applies the per-symbol multiplier itself when turning bucket targets into holding targets. Proven (and unit-tested) that total weight is exactly preserved once run through `computeAllocationDeltas` — cash absorbs exactly the cut.
- `shouldProposeRebalance(currentTier, lastRebalancedTier)` — the tier-change gate; fires on any tier difference including the first-ever check (`lastRebalancedTier` null).

**"Create a cash sleeve if none exists"** is satisfied by
`computeAllocationDeltas`'s existing `buyRows` mechanism (a bucket with a
target but no linked holding) rather than an actual database insert —
consistent with "recommendation, never an order." Unit-tested explicitly.

**UI** (`app/portfolios/page.jsx`): a new "Market Conditions Overlay" card,
deliberately kept separate from the existing resize/capex "Portfolio
Actions" block rather than merged into it, shown for every portfolio
(regardless of `strategy_framework`) once a `market_conditions_scores` row
exists. Shows tier/multiplier/on-off always; when the flag is on, shows a
current / no-overlay-target / with-overlay-target / estimated-trade /
estimated-realized-gain-loss table, restricted to rows where the bucket is
actually touched by the overlay (equity + cash) rather than duplicating
the full holdings list. Estimated realized gain/loss uses the average-cost
`holdings_valued` view's `cost_basis`/`net_gain`, applied pro-rata to the
sold fraction. "Mark rebalanced to <tier>" is the only write this feature
makes — an explicit acknowledgment, shown only when the current tier
differs from `last_rebalanced_tier`, that resets the gate for the next
proposal. Settings toggle added next to Strategy Framework with copy
clarifying it's independent of that field.

**Verified**: `tests/marketOverlayPortfolio.test.ts` (scaling math sums to
100% and cash absorbs exactly the cut, flag-off byte-matches the
non-overlay `computeAllocationDeltas` output, cash-buyRow-creation case,
rebalance fires only on tier change) — full suite 236/236 passing.
`next build` clean. UI verified visually via a temporary, uncommitted
dev-preview route fed by All Weather Alpha's real holdings (pulled via the
Supabase MCP service-role client) — caught and fixed a real contrast bug
where the "With overlay" column's default text color was nearly
unreadable against the card background; recolored to match the existing
Trade-direction color convention (green/red/dim) instead of plain
uncolored text.

## Phase 6 kickoff: freed-weight destination resolved (2026-09-29)

**Decision #1 (open since the Phase 2 proposal entry) is resolved: freed
weight goes to the portfolio's cash sleeve.** When `use_market_overlay` is
on and `exposure_multiplier < 1`, the risk-parity solver runs unchanged
first, then every holding classified as equity is multiplied by the
latest `exposure_multiplier`; the total dollar cut across all equity
holdings is added to cash. Non-equity holdings (bonds, gold, etc.) are
untouched by the overlay — this is a pure equity-sleeve risk dial, not a
portfolio-wide reallocation. SPEC.md §10-11 updated accordingly. See the
Phase 6 entry below for the full integration design.

## Phase 3 prerequisites: E-DOWN unconditional re-test, mc_signal_log_live view (2026-09-30)

**E-DOWN re-test against the UNCONDITIONAL (all-days) baseline**, same
horizons/markets as the rest of this round, report only, no rule changed:

| Market | Episodes | 21d rule mean | 21d uncond. baseline | 63d rule mean | 63d uncond. baseline | Result |
|---|---|---|---|---|---|---|
| SPY | 10 | 0.06% | 0.94% | 0.19% | 2.79% | **pass** |
| QQQ | 14 | -0.24% | 0.94% | -0.54% | 2.74% | **pass** |
| IWM | 17 | 1.39% | 0.91% | 3.89% | 2.72% | **fail** |
| EFA | 14 | 0.73% | 0.71% | 2.16% | 2.21% | **fail** (21d ties/fails narrowly, 63d passes narrowly, net fail since both horizons must pass) |

Mixed: passes on SPY (primary market) and QQQ, fails on IWM and EFA (both
out-of-sample-only markets). Not a clean pass. **Decision, since the
request required a single UI label**: treated as **failing to generalize**
-- both out-of-sample checks fail, and the instruction's own framing ("if
it fails, show as NEUTRAL") reads most naturally as requiring a clean
pass across the validation set, not a bare majority on markets that
include the market being fit against. E-DOWN displays as NEUTRAL with
"Downtrend" context only in the UI (see `lib/marketConditionsMeta.js`'s
`ENTRY_SIGNAL_TEXT`), not as a validated WAIT recommendation. The full
mixed picture is recorded here rather than silently collapsed to a single
pass/fail bit.

**mc_signal_log_live** (new view, `20260930_mc_signal_log_live.sql`):
`mc_signal_log` was populated by a single backfill-equivalent run covering
the full 1993-10-29-present history in one shot (market-conditions-
compute doubles as both "nightly" and "backfill" by design -- see its own
header comment), so every historical row shares essentially the same
`computed_at` regardless of how far in the past its own `date` is. The
view keeps only rows where `computed_at::date <= date + 4` -- written
within 4 days of their own signal date -- which excludes the backfill and
keeps genuine near-real-time nightly writes. Does not alter or delete any
`mc_signal_log` row (that table's append-only/immutable trigger is
untouched).

**The live out-of-sample record starts at the first genuine nightly cron
run**, not at this migration's own date. Checked directly: right now
(2026-09-30), the view happens to contain 3 rows (2026-09-24, 09-25,
09-28) purely because those dates fall within 4 days of the backfill's own
`computed_at` timestamp -- a coincidental artifact of the backfill having
run recently, NOT independent nightly writes. `market-conditions-compute-
daily` is scheduled weekdays at 22:40 UTC
(`20260928_schedule_market_conditions.sql`); the first row written by that
schedule (not by a manual/backfill invocation) is the true start of the
live record. **All performance tracking (the dashboard's "Live track
record" panel, and any future out-of-sample performance claim) uses
`mc_signal_log_live`, never `mc_signal_log` directly** -- `mc_signal_log`
itself mixes backfill and live rows and must not be used for performance
claims.

## mc-1.4.0 entry-rule round: E-VETO/E-TOP/E-THRUST/E-CAPITULATION removed, E-DIP/E-HOT rewired to oscillators, tier veto KEPT (2026-09-30)

Bumped to **mc-1.4.0** (entry-rule changes; tier logic itself is unchanged
-- the veto ablation below came back KEEP, not remove).

### What changed and why

The original entry-signal validation (full per-horizon tables in Appendix
A below) tested all 8 spec-defined rules against SPY forward returns,
1996-02-23-present. Finding: **5 of 8 rules had zero days** --
E-DIP/E-HOT/E-TOP/E-THRUST/E-CAPITULATION all read fields
(`breadthScore`/`breadthDivergence`/`breadthThrustNew`/`pctOversold`/
`rsi14`/`stretch50d`/VIX-term-structure-recency flags) that
`scoring.ts` never populated -- Phase 1 only ever called
`evaluateEntrySignal({ trendState, vetoActive })`. Of the 3 rules that
COULD fire (E-VETO/E-DOWN/E-DEFAULT), **E-VETO failed its own
pre-registered criterion in all 4 markets tested** (SPY/QQQ/IWM/EFA): a
WAIT signal is supposed to underperform its conditional baseline at 21d
AND 63d, but veto days showed ABOVE-average forward returns everywhere --
e.g. SPY 21d +1.85% vs +0.91% baseline, QQQ 21d +3.20% vs +0.85% (nearly
4x), EFA/IWM the same direction. E-DOWN passed cleanly in SPY/QQQ/IWM.

Changes made, in response:

1. **O1 (RSI14, Wilder) and O2 (stretch50d, z-score vs SMA50)** wired into
   the compute pipeline for the first time (`indicators/oscillators.ts`,
   new). O2 is a documented interpretation call, not confirmed against a
   spec doc (none exists in this repo): the entry-rule thresholds
   (dipStretch=-1.5, hotStretch=2.0) only make sense as standard-deviation
   units, not raw percentages -- flagged rather than guessed silently.
2. **E-DIP rewired**: dropped the `breadthScore>=0` guard and the
   `pctOversold` condition (breadth isn't scored, pctOversold was never
   computed) -- now `trend=UP AND (RSI14 < 40 OR stretch50d <= -1.5)`.
   E-HOT's logic is unchanged, but was structurally unreachable before this
   round (same missing-inputs problem) and is now live.
3. **E-TOP, E-THRUST, E-CAPITULATION removed outright, no replacements** --
   all three depended on the breadth pillar, rejected earlier this same
   round on its own pre-registered criteria (see the breadth-round entry
   above). They were dead code in production regardless (never reachable),
   so this removes unreachable branches, not live behavior.
4. **E-VETO removed** -- failed its own validation in 4/4 markets (above).
   The TIER-level stress veto (a separate mechanism -- caps exposure at
   DEFENSIVE-or-worse in `stepTierState`) is UNCHANGED; only the
   entry-signal LABEL is gone. Veto days now fall through to whichever of
   E-DIP/E-HOT/E-DOWN/E-DEFAULT their trend_state matches.
   `DayScoreRow.vetoActive`/`flags.veto` still report the tier veto's own
   state for the UI, labeled as an INFORMATIONAL "high stress --
   historically above-average but volatile forward returns" note rather
   than a directional rule (median/%positive/p10-at-21d/63d reported per
   market in Appendix B below, e.g. SPY 21d median +2.39% vs +1.42%
   baseline, but p10 -6.79% vs -4.77% baseline -- above-average typical
   return, meaningfully worse tail risk, hence "above-average but
   volatile," not "safe to buy").
5. `EntrySignalInput`/`EntrySignalName` trimmed to match (types.ts) --
   `ADD_SMALL`/`TRIM` types removed (nothing can produce them anymore),
   `vetoActive`/`breadthScore`/`breadthDivergence`/`breadthThrustNew`/
   `pctOversold`/`vixTermStructureRecentlyAbove1`/
   `vixTermStructureNowBelow1` fields removed from the input shape.
   `config.entry`'s `dipOversoldPct`/`topRsi`/`capitulationOversoldPct`/
   `capitulationLookback` removed (their only consumers are gone).

### Re-validation with the new wiring (Appendix B, full tables below)

| Rule | SPY | QQQ | IWM | EFA |
|---|---|---|---|---|
| E-DIP | pass | pass | pass | pass |
| E-HOT | pass | pass | fail (63d only, 18 eps) | pass |
| E-DOWN | fail* | fail* | fail* | fail* |
| E-DEFAULT | — (no criterion) | — | — | — |

**E-DIP passes cleanly in all 4 markets** with strong episode counts
(122-187) -- the clearest win from this round's rewiring. **E-HOT passes
in 3/4**, with a thin IWM exception (18 episodes, only the 63d leg fails).

**E-DOWN's "fail" in all 4 markets is a methodological artifact, not a
real signal degradation** -- flagging explicitly rather than letting it
read as a regression. Removing E-VETO means nothing intercepts a DOWN-
trend veto day anymore, so E-DOWN's own day-set is now EXACTLY the full
population of DOWN-trend days -- identical, to the decimal, to its own
"conditional baseline" (all days with trend_state DOWN), since the
baseline is pooled from the same population E-DOWN itself fires on 100% of
the time. Rule mean == baseline mean by construction in all 4 markets (see
Appendix B); a strict "must underperform" test against your own exact
population can only ever tie, never pass. This is informative about the
TEST, not about E-DOWN's signal quality -- a future round wanting a real
read on E-DOWN would need a baseline that excludes veto days (or some
other genuinely narrower population), not a retest of this one.

### Tier veto ablation (diagnostic, pre-registered rule, KEEP)

Tested whether the TIER-level veto (separate from the removed E-VETO
entry-signal rule) is pulling its weight, via `cfg.veto.disabled` (new,
default false, zero effect on every other caller -- `market-conditions-
veto-ablation`, new function).

| Market | Calmar ON | Calmar OFF | Verdict |
|---|---|---|---|
| SPY (full) | 0.42 | 0.43 | improves (+0.01, marginal) |
| QQQ | 0.22 | 0.20 | **worsens** |
| IWM | 0.21 | 0.22 | improves |
| EFA | 0.22 | 0.22 | ties |

| Bear episode | SPY diff | QQQ diff | IWM diff | EFA diff |
|---|---|---|---|---|
| 2000-02 (dot-com) | -0.61 | -3.17 | 0.00 | 0.00 |
| 2007-09 (GFC) | +0.63 | -1.49 | +0.16 | -0.52 |
| 2020 (COVID) | **-2.98** | **-7.00** | -1.27 | -0.90 |
| 2022 | 0.00 | 0.00 | 0.00 | 0.00 |

(diff = OFF's max DD minus ON's; negative = OFF is worse.)

Pre-registered rule: remove only if disabling improves SPY full-period
Calmar AND 3+ of the other 3 markets' Calmar AND doesn't worsen any bear-
episode max DD by more than 2 points. **Result: KEEP.** Only 1 of the
other 3 markets (IWM) genuinely improves -- QQQ worsens, EFA ties -- short
of the "3+" bar regardless of how generously ties are counted. More
decisively, disabling the veto makes the **2020 COVID drawdown 7 points
worse on QQQ and 3 points worse on SPY**, both blowing through the
2-point tolerance by a wide margin. The marginal +0.01 Calmar improvement
on SPY full-period is not close to worth that COVID-crash cost. Tier logic
(`stepTierState`) is UNCHANGED this round; `cfg.veto.disabled` stays in
the codebase as a diagnostic hook (default false), not wired to anything
live.

### Appendix A -- original validation (mc-1.3.0 wiring, before this round's rewiring)

#### SPY (1996-02-23 → 2026-09-28, 7698 days)

**E-CAPITULATION** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.23% | 58.4% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.94% | 65.1% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.79% | 70.5% |

**E-DEFAULT** — signal: NEUTRAL, days: 6005, episodes: 31, trend_states observed: ['UP', 'MIXED']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 6000 | 0.27% | 0.4% | 59.9% | 6252 | 0.27% | 0.41% | 59.9% | 0.23% | 58.4% |
| 21d | 5984 | 1.1% | 1.49% | 67.8% | 6236 | 1.14% | 1.51% | 67.7% | 0.94% | 65.1% |
| 63d | 5942 | 3.3% | 4.05% | 74.9% | 6194 | 3.4% | 4.05% | 74.9% | 2.79% | 70.5% |

**E-DIP** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.23% | 58.4% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.94% | 65.1% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.79% | 70.5% |

**E-DOWN** — signal: WAIT, days: 1260, episodes: 18, trend_states observed: ['DOWN']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 1260 | -0.06% | 0.08% | 50.7% | 1441 | 0.05% | 0.17% | 51.8% | 0.23% | 58.4% |
| 21d | 1260 | -0.16% | 0.39% | 52.1% | 1441 | 0.06% | 0.71% | 53.9% | 0.94% | 65.1% |
| 63d | 1260 | -0.09% | 0.3% | 51% | 1441 | 0.19% | 0.77% | 52% | 2.79% | 70.5% |

Pass/fail: 21d=pass, 63d=pass, overall=**pass**

**E-HOT** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.23% | 58.4% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.94% | 65.1% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.79% | 70.5% |

**E-THRUST** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.23% | 58.4% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.94% | 65.1% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.79% | 70.5% |

**E-TOP** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.23% | 58.4% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.94% | 65.1% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.79% | 70.5% |

**E-VETO** — signal: WAIT, days: 433, episodes: 32, trend_states observed: ['UP', 'DOWN']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 433 | 0.46% | 0.92% | 59.4% | 7535 | 0.22% | 0.38% | 58.4% | 0.23% | 58.4% |
| 21d | 433 | 1.85% | 2.39% | 66.1% | 7519 | 0.91% | 1.42% | 65.1% | 0.94% | 65.1% |
| 63d | 433 | 4.26% | 4.61% | 67.2% | 7477 | 2.72% | 3.72% | 70.2% | 2.79% | 70.5% |

Pass/fail: 21d=fail, 63d=fail, overall=**fail**

#### QQQ (1999-12-21 → 2026-09-22, 6728 days)

**E-CAPITULATION** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.23% | 57.3% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.94% | 62.5% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.74% | 67.9% |

**E-DEFAULT** — signal: NEUTRAL, days: 5084, episodes: 37, trend_states observed: ['MIXED', 'UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 5079 | 0.28% | 0.48% | 58.2% | 5339 | 0.29% | 0.49% | 58.4% | 0.23% | 57.3% |
| 21d | 5063 | 1.16% | 1.59% | 64.3% | 5323 | 1.24% | 1.61% | 64.4% | 0.94% | 62.5% |
| 63d | 5021 | 3.37% | 4.3% | 70.7% | 5281 | 3.59% | 4.42% | 71.1% | 2.74% | 67.9% |

**E-DIP** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.23% | 57.3% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.94% | 62.5% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.74% | 67.9% |

**E-DOWN** — signal: WAIT, days: 1235, episodes: 21, trend_states observed: ['DOWN']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 1235 | -0.14% | 0.34% | 52.2% | 1384 | -0.02% | 0.45% | 53.2% | 0.23% | 57.3% |
| 21d | 1235 | -0.75% | 0.76% | 54.2% | 1384 | -0.24% | 1.28% | 55.4% | 0.94% | 62.5% |
| 63d | 1235 | -1.5% | 2.4% | 55% | 1384 | -0.54% | 2.64% | 55.5% | 2.74% | 67.9% |

Pass/fail: 21d=pass, 63d=pass, overall=**pass**

**E-HOT** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.23% | 57.3% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.94% | 62.5% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.74% | 67.9% |

**E-THRUST** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.23% | 57.3% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.94% | 62.5% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.74% | 67.9% |

**E-TOP** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.23% | 57.3% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.94% | 62.5% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.74% | 67.9% |

**E-VETO** — signal: WAIT, days: 409, episodes: 31, trend_states observed: ['UP', 'DOWN']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 409 | 0.67% | 1.06% | 61.1% | 6529 | 0.22% | 0.49% | 57.3% | 0.23% | 57.3% |
| 21d | 409 | 3.2% | 3.54% | 65.3% | 6513 | 0.85% | 1.51% | 62.1% | 0.94% | 62.5% |
| 63d | 409 | 7.75% | 7.27% | 72.4% | 6471 | 2.5% | 4.12% | 67.4% | 2.74% | 67.9% |

Pass/fail: 21d=fail, 63d=fail, overall=**fail**

#### IWM (2001-02-28 → 2026-09-28, 6433 days)

**E-CAPITULATION** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.22% | 55.2% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.91% | 60.2% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.72% | 64.7% |

**E-DEFAULT** — signal: NEUTRAL, days: 4619, episodes: 32, trend_states observed: ['MIXED', 'UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 4614 | 0.21% | 0.3% | 54.9% | 4788 | 0.2% | 0.31% | 55% | 0.22% | 55.2% |
| 21d | 4598 | 0.78% | 1.24% | 59.6% | 4772 | 0.75% | 1.22% | 59.5% | 0.91% | 60.2% |
| 63d | 4556 | 2.28% | 3.21% | 65.4% | 4730 | 2.31% | 3.2% | 65.2% | 2.72% | 64.7% |

**E-DIP** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.22% | 55.2% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.91% | 60.2% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.72% | 64.7% |

**E-DOWN** — signal: WAIT, days: 1410, episodes: 29, trend_states observed: ['DOWN']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 1410 | 0.15% | 0.42% | 55% | 1640 | 0.27% | 0.51% | 55.9% | 0.22% | 55.2% |
| 21d | 1410 | 1.16% | 2.01% | 61.7% | 1640 | 1.39% | 2.28% | 62.3% | 0.91% | 60.2% |
| 63d | 1410 | 3.73% | 4.04% | 64% | 1640 | 3.89% | 4.29% | 63.4% | 2.72% | 64.7% |

Pass/fail: 21d=pass, 63d=pass, overall=**pass**

**E-HOT** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.22% | 55.2% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.91% | 60.2% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.72% | 64.7% |

**E-THRUST** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.22% | 55.2% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.91% | 60.2% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.72% | 64.7% |

**E-TOP** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.22% | 55.2% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.91% | 60.2% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.72% | 64.7% |

**E-VETO** — signal: WAIT, days: 404, episodes: 30, trend_states observed: ['DOWN', 'UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 404 | 0.47% | 1.15% | 59.7% | 6098 | 0.21% | 0.36% | 55.3% | 0.22% | 55.2% |
| 21d | 404 | 1.53% | 2.45% | 61.9% | 6082 | 0.93% | 1.45% | 60.7% | 0.91% | 60.2% |
| 63d | 404 | 4.14% | 3.9% | 58.9% | 6040 | 2.82% | 3.42% | 65.2% | 2.72% | 64.7% |

Pass/fail: 21d=fail, 63d=fail, overall=**fail**

#### EFA (2002-05-31 → 2026-09-28, 6121 days)

**E-CAPITULATION** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.17% | 56.3% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.71% | 61.4% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.21% | 66.5% |

**E-DEFAULT** — signal: NEUTRAL, days: 4391, episodes: 28, trend_states observed: ['MIXED', 'UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 4386 | 0.18% | 0.3% | 56.6% | 4558 | 0.16% | 0.3% | 56.7% | 0.17% | 56.3% |
| 21d | 4370 | 0.69% | 1.17% | 62.6% | 4542 | 0.71% | 1.19% | 62.4% | 0.71% | 61.4% |
| 63d | 4328 | 2.15% | 3.1% | 67.8% | 4500 | 2.22% | 3.19% | 68.1% | 2.21% | 66.5% |

**E-DIP** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.17% | 56.3% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.71% | 61.4% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.21% | 66.5% |

**E-DOWN** — signal: WAIT, days: 1347, episodes: 24, trend_states observed: ['DOWN']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 1347 | 0.12% | 0.31% | 54.6% | 1558 | 0.19% | 0.36% | 55.3% | 0.17% | 56.3% |
| 21d | 1347 | 0.72% | 1.33% | 58.4% | 1558 | 0.73% | 1.49% | 58.7% | 0.71% | 61.4% |
| 63d | 1347 | 2.27% | 3.16% | 63.2% | 1558 | 2.16% | 2.92% | 61.9% | 2.21% | 66.5% |

Pass/fail: 21d=pass, 63d=fail, overall=**fail**

**E-HOT** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.17% | 56.3% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.71% | 61.4% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.21% | 66.5% |

**E-THRUST** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.17% | 56.3% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.71% | 61.4% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.21% | 66.5% |

**E-TOP** — signal: n/a, days: 0, episodes: 0 (inconclusive, <10 episodes), trend_states observed: none

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.17% | 56.3% |
| 21d | 0 | —% | —% | —% | 0 | —% | —% | —% | 0.71% | 61.4% |
| 63d | 0 | —% | —% | —% | 0 | —% | —% | —% | 2.21% | 66.5% |

**E-VETO** — signal: WAIT, days: 383, episodes: 29, trend_states observed: ['DOWN', 'UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 383 | 0.26% | 0.81% | 59.3% | 5711 | 0.18% | 0.32% | 56.6% | 0.17% | 56.3% |
| 21d | 383 | 0.91% | 2.2% | 59.5% | 5695 | 0.76% | 1.31% | 62.2% | 0.71% | 61.4% |
| 63d | 383 | 2.67% | 3.98% | 63.2% | 5653 | 2.38% | 3.34% | 67.6% | 2.21% | 66.5% |

Pass/fail: 21d=fail, 63d=fail, overall=**fail**

### Appendix B -- re-validation (mc-1.4.0 wiring, after this round's rewiring)

#### SPY (1996-02-23 → 2026-09-28, 7698 days)

**E-DEFAULT** — signal: NEUTRAL, days: 5589, episodes: 230, trend_states observed: ['UP', 'MIXED']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 5584 | 0.21% | 0.37% | 59.3% | 6252 | 0.27% | 0.41% | 59.9% | 0.23% | 58.4% |
| 21d | 5568 | 1% | 1.44% | 67% | 6236 | 1.14% | 1.51% | 67.7% | 0.94% | 65.1% |
| 63d | 5527 | 3.13% | 3.9% | 74.3% | 6194 | 3.4% | 4.05% | 74.9% | 2.79% | 70.5% |

**E-DIP** — signal: ADD, days: 587, episodes: 187, trend_states observed: ['UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 587 | 0.8% | 0.91% | 65.9% | 6094 | 0.26% | 0.4% | 59.9% | 0.23% | 58.4% |
| 21d | 587 | 2.64% | 3.06% | 75.5% | 6078 | 1.12% | 1.49% | 67.7% | 0.94% | 65.1% |
| 63d | 586 | 6.13% | 6.43% | 80.5% | 6036 | 3.33% | 4% | 74.6% | 2.79% | 70.5% |

Pass/fail: 21d=pass, 63d=pass, overall=**pass**

**E-DOWN** — signal: WAIT, days: 1441, episodes: 10, trend_states observed: ['DOWN']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 1441 | 0.05% | 0.17% | 51.8% | 1441 | 0.05% | 0.17% | 51.8% | 0.23% | 58.4% |
| 21d | 1441 | 0.06% | 0.71% | 53.9% | 1441 | 0.06% | 0.71% | 53.9% | 0.94% | 65.1% |
| 63d | 1441 | 0.19% | 0.77% | 52% | 1441 | 0.19% | 0.77% | 52% | 2.79% | 70.5% |

Pass/fail: 21d=fail, 63d=fail, overall=**fail**

**E-HOT** — signal: WAIT, days: 81, episodes: 38, trend_states observed: ['UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 81 | 0.1% | 0.27% | 56.8% | 6094 | 0.26% | 0.4% | 59.9% | 0.23% | 58.4% |
| 21d | 81 | -0.12% | 0.49% | 56.8% | 6078 | 1.12% | 1.49% | 67.7% | 0.94% | 65.1% |
| 63d | 81 | 2.01% | 2.88% | 74.1% | 6036 | 3.33% | 4% | 74.6% | 2.79% | 70.5% |

Pass/fail: 21d=pass, 63d=pass, overall=**pass**

**Veto-day (informational, tier veto)** — days: 433, trend_states observed: ['UP', 'DOWN']

| Horizon | Veto-day n | Veto median | Veto %pos | Veto p10 | Baseline n | Baseline median | Baseline %pos | Baseline p10 |
|---|---|---|---|---|---|---|---|---|
| 21d | 433 | 2.39% | 66.1% | -6.79% | 7519 | 1.42% | 65.1% | -4.77% |
| 63d | 433 | 4.61% | 67.2% | -12.81% | 7477 | 3.72% | 70.2% | -7.06% |

#### QQQ (1999-12-21 → 2026-09-22, 6728 days)

**E-DEFAULT** — signal: NEUTRAL, days: 4682, episodes: 221, trend_states observed: ['MIXED', 'UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 4677 | 0.24% | 0.49% | 58.3% | 5339 | 0.29% | 0.49% | 58.4% | 0.23% | 57.3% |
| 21d | 4661 | 1.12% | 1.59% | 64.5% | 5323 | 1.24% | 1.61% | 64.4% | 0.94% | 62.5% |
| 63d | 4627 | 3.34% | 4.28% | 70.7% | 5281 | 3.59% | 4.42% | 71.1% | 2.74% | 67.9% |

**E-DIP** — signal: ADD, days: 555, episodes: 174, trend_states observed: ['UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 555 | 0.83% | 0.71% | 61.3% | 5145 | 0.29% | 0.49% | 58.4% | 0.23% | 57.3% |
| 21d | 555 | 2.26% | 2.23% | 62.9% | 5129 | 1.15% | 1.56% | 63.9% | 0.94% | 62.5% |
| 63d | 547 | 6.4% | 7.06% | 76.4% | 5087 | 3.32% | 4.26% | 70.7% | 2.74% | 67.9% |

Pass/fail: 21d=pass, 63d=pass, overall=**pass**

**E-DOWN** — signal: WAIT, days: 1384, episodes: 14, trend_states observed: ['DOWN']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 1384 | -0.02% | 0.45% | 53.2% | 1384 | -0.02% | 0.45% | 53.2% | 0.23% | 57.3% |
| 21d | 1384 | -0.24% | 1.28% | 55.4% | 1384 | -0.24% | 1.28% | 55.4% | 0.94% | 62.5% |
| 63d | 1384 | -0.54% | 2.64% | 55.5% | 1384 | -0.54% | 2.64% | 55.5% | 2.74% | 67.9% |

Pass/fail: 21d=fail, 63d=fail, overall=**fail**

**E-HOT** — signal: WAIT, days: 107, episodes: 41, trend_states observed: ['UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 107 | -0.32% | -0.04% | 47.7% | 5145 | 0.29% | 0.49% | 58.4% | 0.23% | 57.3% |
| 21d | 107 | 1.06% | 1.27% | 64.5% | 5129 | 1.15% | 1.56% | 63.9% | 0.94% | 62.5% |
| 63d | 107 | 0.28% | 1.25% | 61.7% | 5087 | 3.32% | 4.26% | 70.7% | 2.74% | 67.9% |

Pass/fail: 21d=pass, 63d=pass, overall=**pass**

**Veto-day (informational, tier veto)** — days: 409, trend_states observed: ['UP', 'DOWN']

| Horizon | Veto-day n | Veto median | Veto %pos | Veto p10 | Baseline n | Baseline median | Baseline %pos | Baseline p10 |
|---|---|---|---|---|---|---|---|---|
| 21d | 409 | 3.54% | 65.3% | -8.59% | 6513 | 1.51% | 62.1% | -7.21% |
| 63d | 409 | 7.27% | 72.4% | -11.52% | 6471 | 4.12% | 67.4% | -11.57% |

#### IWM (2001-02-28 → 2026-09-28, 6433 days)

**E-DEFAULT** — signal: NEUTRAL, days: 4208, episodes: 174, trend_states observed: ['MIXED', 'UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 4207 | 0.22% | 0.32% | 55.3% | 4788 | 0.2% | 0.31% | 55% | 0.22% | 55.2% |
| 21d | 4201 | 0.73% | 1.15% | 59.2% | 4772 | 0.75% | 1.22% | 59.5% | 0.91% | 60.2% |
| 63d | 4159 | 2.16% | 3.11% | 65.1% | 4730 | 2.31% | 3.2% | 65.2% | 2.72% | 64.7% |

**E-DIP** — signal: ADD, days: 543, episodes: 148, trend_states observed: ['UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 539 | 0.07% | 0.31% | 54.2% | 4458 | 0.19% | 0.31% | 55.1% | 0.22% | 55.2% |
| 21d | 529 | 0.94% | 1.95% | 62% | 4442 | 0.76% | 1.27% | 60.1% | 0.91% | 60.2% |
| 63d | 529 | 3.49% | 4.01% | 65.4% | 4400 | 2.43% | 3.22% | 65.9% | 2.72% | 64.7% |

Pass/fail: 21d=pass, 63d=pass, overall=**pass**

**E-DOWN** — signal: WAIT, days: 1640, episodes: 17, trend_states observed: ['DOWN']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 1640 | 0.27% | 0.51% | 55.9% | 1640 | 0.27% | 0.51% | 55.9% | 0.22% | 55.2% |
| 21d | 1640 | 1.39% | 2.28% | 62.3% | 1640 | 1.39% | 2.28% | 62.3% | 0.91% | 60.2% |
| 63d | 1640 | 3.89% | 4.29% | 63.4% | 1640 | 3.89% | 4.29% | 63.4% | 2.72% | 64.7% |

Pass/fail: 21d=fail, 63d=fail, overall=**fail**

**E-HOT** — signal: WAIT, days: 42, episodes: 18, trend_states observed: ['UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 42 | -0.56% | -0.43% | 33.3% | 4458 | 0.19% | 0.31% | 55.1% | 0.22% | 55.2% |
| 21d | 42 | 0.42% | 0.45% | 54.8% | 4442 | 0.76% | 1.27% | 60.1% | 0.91% | 60.2% |
| 63d | 42 | 2.66% | 3.11% | 69% | 4400 | 2.43% | 3.22% | 65.9% | 2.72% | 64.7% |

Pass/fail: 21d=pass, 63d=fail, overall=**fail**

**Veto-day (informational, tier veto)** — days: 404, trend_states observed: ['DOWN', 'UP']

| Horizon | Veto-day n | Veto median | Veto %pos | Veto p10 | Baseline n | Baseline median | Baseline %pos | Baseline p10 |
|---|---|---|---|---|---|---|---|---|
| 21d | 404 | 2.45% | 61.9% | -10.43% | 6082 | 1.45% | 60.7% | -6.33% |
| 63d | 404 | 3.9% | 58.9% | -14.04% | 6040 | 3.42% | 65.2% | -9.9% |

#### EFA (2002-05-31 → 2026-09-28, 6121 days)

**E-DEFAULT** — signal: NEUTRAL, days: 4062, episodes: 149, trend_states observed: ['MIXED', 'UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 4057 | 0.15% | 0.28% | 56.4% | 4558 | 0.16% | 0.3% | 56.7% | 0.17% | 56.3% |
| 21d | 4042 | 0.65% | 1.15% | 62.4% | 4542 | 0.71% | 1.19% | 62.4% | 0.71% | 61.4% |
| 63d | 4000 | 2.09% | 3.1% | 67.8% | 4500 | 2.22% | 3.19% | 68.1% | 2.21% | 66.5% |

**E-DIP** — signal: ADD, days: 456, episodes: 122, trend_states observed: ['UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 456 | 0.3% | 0.57% | 59.9% | 4153 | 0.17% | 0.32% | 57% | 0.17% | 56.3% |
| 21d | 455 | 1.44% | 1.88% | 64.8% | 4137 | 0.77% | 1.27% | 63.5% | 0.71% | 61.4% |
| 63d | 455 | 3.47% | 3.83% | 71.9% | 4095 | 2.46% | 3.41% | 69.8% | 2.21% | 66.5% |

Pass/fail: 21d=pass, 63d=pass, overall=**pass**

**E-DOWN** — signal: WAIT, days: 1558, episodes: 14, trend_states observed: ['DOWN']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 1558 | 0.19% | 0.36% | 55.3% | 1558 | 0.19% | 0.36% | 55.3% | 0.17% | 56.3% |
| 21d | 1558 | 0.73% | 1.49% | 58.7% | 1558 | 0.73% | 1.49% | 58.7% | 0.71% | 61.4% |
| 63d | 1558 | 2.16% | 2.92% | 61.9% | 1558 | 2.16% | 2.92% | 61.9% | 2.21% | 66.5% |

Pass/fail: 21d=fail, 63d=fail, overall=**fail**

**E-HOT** — signal: WAIT, days: 45, episodes: 18, trend_states observed: ['UP']

| Horizon | Rule n | Rule mean | Rule median | Rule %pos | Cond. baseline n | Cond. mean | Cond. median | Cond. %pos | Uncond. mean | Uncond. %pos |
|---|---|---|---|---|---|---|---|---|---|---|
| 5d | 45 | -0.12% | 0.02% | 51.1% | 4153 | 0.17% | 0.32% | 57% | 0.17% | 56.3% |
| 21d | 45 | -1.6% | -1.39% | 37.8% | 4137 | 0.77% | 1.27% | 63.5% | 0.71% | 61.4% |
| 63d | 45 | 1.3% | 2.93% | 57.8% | 4095 | 2.46% | 3.41% | 69.8% | 2.21% | 66.5% |

Pass/fail: 21d=pass, 63d=pass, overall=**pass**

**Veto-day (informational, tier veto)** — days: 383, trend_states observed: ['DOWN', 'UP']

| Horizon | Veto-day n | Veto median | Veto %pos | Veto p10 | Baseline n | Baseline median | Baseline %pos | Baseline p10 |
|---|---|---|---|---|---|---|---|---|
| 21d | 383 | 2.2% | 59.5% | -9.87% | 5695 | 1.31% | 62.2% | -5.07% |
| 63d | 383 | 3.98% | 63.2% | -14.46% | 5653 | 3.34% | 67.6% | -8.35% |

## Phase 2 breadth round: proxy pillar built and tested, DROPPED from scoring (2026-09-30)

**Decision, made in advance of building anything (2026-09-30)**: the ONLY
breadth pillar ever scored into the composite — live or backtest — is the
PROXY pillar (PB1/PB2/PB3 + divergence, built from the 9 original sector
SPDRs and RSP/SPY, all long-lived enough to backtest without survivorship
bias). Constituent-based B1-B5/thrust/%RSI-oversold (current S&P 500
membership) were approved as LIVE DIAGNOSTICS only — displayed, and
%oversold feeding entry signals — never wired into `breadthScore`, because
they can't be validated on unbiased history (current membership projected
backward is survivorship-biased by construction). This was decided before
the keep-or-drop test below ran, not chosen after seeing an inconvenient
result.

**Proxy pillar build** (`indicators/breadth.ts`, new):
- PB1 = count of the 9 sector SPDRs with close > own SMA200 → `score =
  (count - 4.5) / 4.5`. PB2 = same with SMA50. Both use the exact
  user-specified formula, no configurable bound (4.5 is fixed by the
  9-sector universe size, not a tunable placeholder).
- PB3 = 50-day % change of RSP/SPY → `score = clip(raw / pb3BoundPct, -1,
  1)`, `pb3BoundPct` placeholder ±3% (`config.breadth.pb3BoundPct`).
- Divergence: SPY within 2% of its own 252-day high AND PB1's count < 5 of
  9 AND lower than it was 60 trading days ago → subtracts
  `divergencePenalty` (0.25) from the pillar score.
  `config.breadth.divergenceCountMax`/`divergenceLookbackDays` replace the
  old placeholder `divergenceBreadthMax` (a % threshold that assumed a
  constituent-based pillar, never actually used).
- `scoring.ts`'s `ComputeInputs` gained an OPTIONAL `breadthScore` field.
  `market-conditions-compute` (the live/production caller) never populates
  it — production stays trend+stress only, provably unaffected (verified:
  full test suite 213/213 passing, and the new "breadth" pillar entry is
  `null` whenever `breadthScore` is omitted, identical to breadth simply
  not existing in the pillars array as it did pre-round). Only the new
  `market-conditions-breadth-backtest` edge function passes it.

**PB3 drift check (requested before finalizing)**: mean PB3 score since
2015-01-01 is **-0.117** (mean raw 50-day RSP/SPY change: -0.48%,
reflecting the mega-cap-led market structure of that period) — above the
-0.2 threshold that would have triggered de-meaning or a halved weight, so
no adjustment made. Full-history (2003-07-14+) mean is ~0.006, essentially
unbiased — the 2015+ tilt is a real, known regime effect (large-cap
leadership), not a construction bug.

**Keep-or-drop test result: FAILS on every criterion, on every market.**
mc-1.3.0's config held unchanged except `breadthScore` populated
(`pillarWeights.breadth` was already 0.25 in `MC_CONFIG`, so this is a pure
on/off toggle, cross-pillar redistribution handles the renormalization
automatically):

| Market | Calmar without | Calmar with | 2022 maxDD without | 2022 maxDD with | Whipsaws without | Whipsaws with |
|---|---|---|---|---|---|---|
| SPY (full period) | 0.42 | 0.33 | -19.11% | -19.74% | 20 | 23 |
| SPY (1996-2008) | 0.35 | 0.27 | — | — | — | — |
| SPY (2009+) | 0.55 | 0.53 | — | — | — | — |
| QQQ | 0.22 | 0.17 | — | — | 24 | 29 |
| IWM | 0.21 | 0.20 | — | — | 23 | 41 |
| EFA | 0.22 | 0.20 | — | — | 25 | 36 |

Against the stated rule: (a) full-period SPY Calmar — **worse** (0.42→0.33);
(b) both sub-periods — **both worse**; (c) 2022 max DD — **worse**
(-19.11%→-19.74%); (d) other 3 markets — **worse on all 3, not just failing
to improve on 2+**. Every criterion fails, and not marginally — full-period
SPY Calmar drops ~21% relatively, and whipsaw counts rise sharply on IWM
(23→41) and EFA (25→36) in particular. The proxy pillar (SPY breadth read)
appears to inject noise into markets whose OWN internal breadth genuinely
differs from the US mega-cap sector rotation the SPDR/RSP proxy is built
from — most visible on IWM/EFA where the whipsaw increase is largest.

**Outcome, final**: the continuous breadth proxy pillar is **REJECTED** on
its own pre-registered criteria (2026-09-30) — not "deferred," not
"needs retuning." `market-conditions-compute` is unaffected (never called
with `breadthScore`) — no config version bump, stays `mc-1.3.0`. **No
further tuning of breadth against this same history** — reweighting
PB1/PB2/PB3, dropping PB3, or otherwise iterating on the proxy pillar until
it happens to pass would be the exact curve-fitting-on-the-test-set failure
mode the pre-registered keep-or-drop rule existed to prevent. The proxy
pillar code (`indicators/breadth.ts`) and the backtest harness
(`market-conditions-breadth-backtest`) stay in the repo as reference, not
as a live candidate.

One possible future direction, explicitly NOT started now: divergence and
thrust as discrete EVENT FLAGS (feeding entry-signal rules only, e.g.
E-CAPITULATION/E-TOP) rather than a continuous scored pillar — a
fundamentally different hypothesis (rare-event risk markers, not a
day-to-day exposure input) that would need its own single pre-registered
test against fresh criteria, not a retry of this one. Constituent-based
breadth diagnostics (B1-B5/thrust/%oversold, live display-only) are
deprioritized given the scored version's rejection — the GitHub constituent
list fallback noted below remains the source to use whenever that work
picks back up.

**Constituent-source finding, relevant to any future constituent-based
breadth work**: iShares' IVV holdings CSV endpoint (the source approved for
this round) is not currently fetchable headlessly — every attempt (direct,
with cookies, with a referer, after visiting the product page first)
returned the exact same 2,251,704-byte HTML product page under a
`content-type: text/csv` header and `content-disposition: attachment`,
regardless of session state; response headers showed `x-upstream-cache:
HIT` alongside `content-length: 1`, suggesting a live CDN/cache
misconfiguration on iShares' end, not a bot-detection wall worth working
around. Not otherwise needed for this round (the proxy pillar doesn't touch
constituents), so left unresolved — whoever builds the live constituent
diagnostics (B1-B5/thrust/%oversold, approved as display-only in the
decision above) will need either a retry, or the fallback already
confirmed working: `raw.githubusercontent.com/datasets/s-and-p-500-
companies/main/data/constituents.csv` (503 rows when checked, within the
490-510 sanity band; same `.`-for-dual-class notation as IVV, e.g. `BRK.B`,
`BF.B`, confirmed present).

## mc-1.3.0 robustness round (2026-09-29 / 2026-09-30): baseline frozen, parameters not curve-fit, cross-market holds up

mc-1.3.0 is now the frozen baseline — no further parameter tuning against
SPX/SPY history. Two infrastructure bugs were fixed to make the sensitivity
sweep below possible at all (both verified behavior-preserving for the
default config via 3 new regression tests, 213/213 passing):

- `tierForComposite` (`config.ts`) previously read the module-level
  `MC_CONFIG.tiers` unconditionally, silently ignoring any `cfg` passed to
  `stepTierState` — invisible in production (`cfg` is always `MC_CONFIG`
  there) but wrong for testing config variants. Now takes an optional
  `tiers` parameter defaulting to `MC_CONFIG.tiers`; `stepTierState` passes
  `cfg.tiers` explicitly.
- `T1_BOUND` was a hardcoded local constant (`0.05`) in `trend.ts`, not part
  of `MC_CONFIG`, so it couldn't be varied. Moved to
  `MC_CONFIG.trend.t1BoundPct`; `scoreT1` now takes it as a parameter.

Four robustness checks, all IN-SAMPLE except cross-market (see below):

1. **Vol-matched static benchmark**: a static SPX/T-bill mix, monthly
   rebalanced, equity weight found by bisection (30 iterations) to match
   mc-1.3.0's own realized full-period vol (12.51%) — landed at **66%
   equity**. mc-1.3.0 beats this vol-matched mix decisively on Calmar in the
   full period (0.42 vs the vol-matched mix's own figure — see the
   conversation's own report table for the full side-by-side, not
   duplicated here) and in both sub-periods. Bear-episode drawdowns: the
   overlay has the shallowest max drawdown in 3 of 4 episodes (2000-02,
   2007-09, 2020) but is *worse* than both the vol-matched mix and the
   200-day rule specifically in 2022 — consistent with the whipsaw cost
   already flagged in the mc-1.3.0 entry above (the floor/latch mechanism's
   trade-off).

2. **Sub-periods** (1996-02-23→2008-12-31, 2009-01-01→present): overlay
   Calmar advantage over buy-and-hold/200-day/vol-matched-static holds in
   both halves, not just driven by one regime.

3. **Parameter sensitivity** (`market-conditions-sensitivity`, new edge
   function): trendBand, T1 scale (t1BoundPct), upgradeDays, downgradeDays,
   tier thresholds, and creditWideningBp each varied ±25% one at a time
   (day-count params rounded via floor/-25%, ceil/+25%; tier thresholds
   shifted ±0.05 absolute per instruction), all others held at baseline.
   Result: a **plateau, not a spike** — Calmar ranged 0.36–0.43 across all
   12 variants (baseline 0.42), CAGR 9.15–9.68% (baseline 9.51%). No single
   parameter's ±25% perturbation collapses performance. The sweep initially
   hit `WORKER_RESOURCE_LIMIT` running all 13 variants naively (each variant
   recomputing stress-pillar percentile ranking from scratch — O(window) per
   day per sub-indicator, window up to 2520 days — even though none of the
   six swept parameters affect stress scoring); fixed by precomputing
   trend/stress raw series and the stress pillar score once and reusing
   them across variants, since only genuinely cfg-dependent O(1)-per-day
   steps need to re-run per variant.

4. **Cross-market test** (`market-conditions-crossmarket`, new edge
   function), mc-1.3.0's config held **completely unchanged** from its
   SPX-tuned baseline — only the Trend pillar's price series is swapped to
   each market's own close/SMA200/SMA50/momentum; the Stress pillar keeps
   the same US VIX/VIX3M/BAA10Y series throughout. This is the one part of
   the robustness round that is **genuinely out-of-sample** — nothing about
   mc-1.3.0's thresholds/weights/state machine was fit to QQQ/IWM/EFA.
   IWM and EFA price history were backfilled via the existing
   `backfill-asset-price-history` function (Yahoo v8 chart endpoint, same
   mechanism already used for SPY/QQQ). Result, Calmar (overlay vs 200-day
   vs buy-and-hold):
   - **QQQ** (1999-03-10+): 0.22 vs 0.15 vs 0.13 — overlay wins both.
   - **IWM** (2000-05-26+): 0.21 vs 0.21 vs 0.15 — overlay ties the 200-day
     rule, beats buy-and-hold.
   - **EFA** (2001-08-27+): 0.22 vs 0.23 vs 0.11 — overlay narrowly *loses*
     to the 200-day rule (though clearly beats buy-and-hold); overlay CAGR
     (5.81%) also trails the 200-day rule's (6.59%) here.
   Against the 200-day rule specifically, this is **1 win (QQQ), 1 tie
   (IWM), 1 narrow loss (EFA)** — not 2 wins; corrected here after an
   initial miscount in the conversation's own report. Overlay beats
   buy-and-hold in all 3 regardless. **Conclusion**: mc-1.3.0 clearly beats
   buy-and-hold and the vol-matched static mix everywhere tested; its edge
   over the 200-day rule specifically is concentrated in severe bears
   (§1/§2 above) and is marginal-to-absent outside them — consistent with
   EFA's result here and with the 2009+ sub-period Calmar gap (0.55 vs
   0.54) being thin. Known weakness: the 2022 slow-grind bear, where the
   200-day rule (and even the vol-matched static mix) beat the overlay on
   drawdown (§2) — not a severe, fast bear, the exact regime this overlay
   is weakest in.
   One data-quality note, not a Yahoo gap: all three symbols show a single
   flagged gap 2001-09-10→2001-09-17 (7 calendar days) — the post-9/11 NYSE
   closure, a real market closure, not missing vendor data.

**Gating criteria from the request, evaluated**: beats vol-matched static on
Calmar — yes. No cliff in sensitivity — yes, plateau confirmed. Cross-market:
1 win, 1 tie, 1 narrow loss vs the 200-day rule (beats buy-and-hold in all
3) — the overlay's edge is real but concentrated in severe bears, not
uniform. Per the original instruction, Phase 2 proceeds next with an
explicit with/without-breadth comparison against mc-1.3.0, using absolute
mappings for breadth indicators.

**The forward `mc_signal_log` is the true out-of-sample record.** Every
number in this entry and in mc-1.2.0/mc-1.3.0's own entries below is
in-sample (fit against, or at minimum evaluated against, history already
known when the config was chosen) — the cross-market test is the only
exception, and even that reuses SPX-fit thresholds rather than being a live
forward test. `mc_signal_log` is append-only and immutable (DB-trigger
enforced) specifically so that every day's live score becomes a permanent,
un-revisable record from this point forward — that log, not any backtest in
this file, is what eventually answers whether mc-1.3.0 (or whatever
supersedes it) actually works.

## mc-1.3.0: closing the recovery-lag gap (2026-09-29)

Four changes, all applied and verified live:

1. **200-day floor** (`stepTierState`): once close has closed above the band
   for 3 consecutive days AND veto is inactive, tier cannot be worse than
   NORMAL (`config.recovery.tierFloor`), independent of hysteresis's own
   day-count. Applied after hysteresis + trend cap, before the veto's cap —
   veto's own activation state has to be computed earlier than its
   tier-capping EFFECT to let the floor check `!vetoActive`, but the
   ordering of effects on `finalTierIndex` matches the instruction exactly.

2. **Absolute T1/T3 scoring** (`indicators/trend.ts`): T1 now a linear
   +/-5%-from-SMA200 mapping; T3 now `momentum / 252d-annualized-vol`
   clipped to [-1,1] (a risk-adjusted momentum ratio, not a percentile
   rank). Both drop `minHistory` entirely — **not explicitly requested**,
   but the logical consequence of dropping percentile ranking (an absolute
   formula has no trailing population to need a minimum size for); flagging
   this interpretation rather than silently making it. Live dates moved
   from 1996-11-06 (T1) / 1997-01-23 (T3) to ~1994 (as soon as SMA200 /
   momentum+252d-vol exist) — meaningfully more early-history usable.

3. **Recovery fast-path latch** (`config.recovery`, `stepTierState`): once
   triggered, stays active — shortened upgrade window + suspended trend cap
   — until tier reaches NORMAL (checked same-day, not one day late) or
   invalidated (`close < SMA50` or `VIX/VIX3M > vixTermStructureInvalidate`,
   a new 1.0 threshold distinct from the 0.90 trigger). Pre-2006 fallback
   trigger (no VIX3M): VIXCLS below its own 50d average AND falling over 20
   days. **No invalidation-side fallback was specified for the pre-2006
   case** — a pre-2006 latch can only be invalidated via the SMA50 break,
   not a VIX3M-based one, since none exists to fall back to. Not invented
   here; flagged as a gap if it matters in practice.

4. **Stress pillar S6 + reweighting** (`indicators/stress.ts`): added S6
   (VIXCLS 20-day change, inverted percentile) and moved from equal weight
   to an explicit split — S3+S6 ("is it moving") total 50%, S1+S2+S4+S5
   ("where does it sit") share the other 50%, renormalized proportionally
   when any are excluded (same redistribution mechanic as the cross-pillar
   weighting, not a special case).

**Result** (recomputed and re-diagnosed against the same anchors): the
recovery-lag gap closed substantially. All 4 bottoms improved vs mc-1.2.0
(2002: 148->133 trading days; 2009: 111->60; 2020: 81->47; 2022: 127->35),
and mc-1.3.0 now lands within 1-3 trading days of the plain 200-day rule
for 2009/2020/2022 — only 2002 still lags meaningfully (133 vs 112 days),
structurally limited by the fast-path being unavailable pre-2006. Full
comparison table, whipsaw analysis, and a preliminary backtest are in the
2026-09-29 report below this entry (not duplicated here — see the
conversation's own report for the numbers; this file records decisions and
findings, not full report output).

**Real cost, not free**: whipsaws (upgrade to NORMAL+ reverting to
CAUTIOUS- within 30 trading days) increased under mc-1.3.0 relative to
mc-1.1.0/1.2.0 in the 2000-02/2008/2022 windows checked (5 vs 2), and
turnover rose accordingly (1.8-1.9/yr under mc-1.1.0/1.2.0 to 2.2/yr under
mc-1.3.0 in the preliminary backtest). The faster 2022-12-01 "recovery"
specifically reverted within 4 trading days. This is the direct trade-off
of the floor/latch mechanisms: they make the system more willing to commit
early, which by construction increases false starts. The preliminary,
in-sample backtest (1996-02-23-present) still shows mc-1.3.0 with the best
Calmar ratio (0.42) and shallowest max drawdown (-22.65%) of every
portfolio tested including buy-and-hold and the 200-day rule, so the
trade-off nets out favorably in this sample — but "in this sample" is
doing real work in that sentence; this has not been validated
out-of-sample per spec Section 10's own walk-forward requirement.

**Infrastructure note**: `market_conditions_scores` is a full-rebuild
table, so before this recompute a one-off snapshot
(`mc_scores_snapshot_mc120`, plain `CREATE TABLE AS SELECT`, not a tracked
migration) was taken to preserve mc-1.2.0's per-day series for the
side-by-side report — mc-1.1.0 was already safe in `mc_signal_log`. A new
standalone edge function, `market-conditions-backtest-preliminary`, was
built for the backtest itself (same curl-invoked, not-wired-into-production
pattern as this repo's other `*-backtest` functions) since it needed a new
data source (DTB3, now also ingested by `market-conditions-ingest`) and
return-series mechanics not needed anywhere else in the module.

## Phase 2 proposal: absolute mappings for breadth indicators with a natural fixed reference point (item 6)

The mc-1.2.0->mc-1.3.0 arc's central lesson: percentile ranking is the
right tool for an indicator whose only meaningful question is "is this
unusual relative to its own history" (credit spread level, realized vol),
but the wrong tool for one that has a genuine fixed reference point where
the RAW level itself is directly interpretable (VIX term structure ratio
vs. 1.0; price vs. its own moving average). Several of the spec's Phase 2
breadth indicators (Section 6.2) are the latter, not the former, and should
be built as absolute mappings from the start rather than repeating this
same diagnose-and-fix cycle a third time:

- **B1 (% above 200-day) / B2 (% above 50-day)**: both are already a
  percentage with a genuine fixed reference point — 50% is the natural
  neutral level (half the index above its average, half below), not
  "unusual relative to trailing history." Proposed: linear mapping
  centered at 50%, e.g. `score = clip((pct - 50) / 30, -1, 1)` (20%
  breadth -> -1, 50% -> 0, 80% -> +1) — bounds are placeholders, same
  spirit as `recovery`'s placeholders, flagged for Phase 5 calibration.
- **B3 (net new highs)**: `(NH52-NL52)/n` is already a bounded ratio in
  [-1,1] by construction (net highs/lows as a fraction of the universe) —
  propose using it AS the score directly, no normalization step needed at
  all, percentile or otherwise.
- **B4 (McClellan Summation) / B5 (equal-vs-cap-weight ratio change)**:
  genuinely don't have an obvious fixed reference point (a Summation Index
  reading's "meaning" really is relative to its own historical range) —
  propose keeping percentile rank for these two, unlike B1-B3.

This is a proposal for Phase 2 to accept, adjust, or reject before that
phase's breadth pillar is built — not committed to yet, since Phase 2
hasn't started.

## mc-1.2.0: recovery-lag diagnosis and fix (2026-09-29)

**Diagnosis** (queried directly against the live mc-1.1.0 data before
changing anything): for each of 6 RISK_OFF episodes (2002-10-09,
2009-03-09, 2011-09-27, 2020-03-23/24, 2022-10-12 bottoms/starts), compared
the date each gating condition stopped binding. Trend-cap lift and
trend-state-leaving-DOWN are the same date by construction (the cap
re-reads `trend_state` fresh every day, no independent hysteresis of its
own) — confirmed empirically, not assumed. Veto was essentially never the
bottleneck: cleared within 0-7 days in every episode, often same-day. The
real bottleneck in 4 of 6 episodes was **trend-state stickiness**: SPX
closed back above its 200d SMA 7-17 weeks before `trend_state` ever left
DOWN.

| Anchor | SPX > SMA200 | trend left DOWN | Gap |
|---|---|---|---|
| 2002-10-09 bottom | 2003-03-21 | 2003-05-09 | 7 weeks |
| 2009-03-09 bottom | 2009-05-29 | 2009-08-12 | 11 weeks |
| 2011-09-27 RISK_OFF start | 2011-10-27 | 2012-01-25 | 13 weeks |
| 2020-03-23/24 bottom | 2020-05-26 | 2020-05-29 | 3 days |
| 2022-10-12 bottom | 2022-11-30 | 2023-03-31 | 17 weeks |

2020's V-shaped recovery barely showed the problem (3 days); the other four
— all slower, choppier recoveries — got stuck for months. Root cause: the
old rule required `aboveBand AND slopeUp` together to leave DOWN, and a
choppy recovery spends weeks oscillating inside the ±2% dead band (neither
`aboveBand` nor `belowBand`), which reads as raw MIXED — and the old
stickiness rule held the PRIOR state (DOWN) through any MIXED reading,
so the state sat frozen in DOWN through the entire chop even once SPX was
solidly back above its 200d SMA.

**Fix 1 — trend-state transitions** (`indicators/trend.ts`,
`resolveTrendState`): DOWN now exits to MIXED after 3 consecutive days
above the band, regardless of slope. The slope requirement is kept only
for MIXED -> UP (DOWN can never jump straight to UP — always passes
through MIXED first). UP's own exit (belowBand + slopeDown, same day) is
unchanged. This is now an explicit stateful transition function (needs
yesterday's state + a running above-band streak), replacing the old
"compute raw state, apply generic stickiness" approach — the generic
version couldn't express "hold DOWN, but only for up to 3 days" as
distinct from "hold DOWN indefinitely."

**Fix 2 — recovery fast-path** (`config.recovery`, `stepTierState`): when
VIX/VIX3M < 0.90 AND BAA10Y's 20-day change < 0bp AND close > SMA50 all
hold the same day, the hysteresis upgrade window drops to 1 day (from the
normal 3) and the DOWN trend cap is suspended for that day. **Every value
in `recovery` is an explicit placeholder** — none backtested, flagged for
Phase 5 calibration alongside `veto.creditWideningBp`. Not gated on
`trend_state` explicitly since the trend-cap suspension is a no-op unless
`trend_state` is actually DOWN.

**Fix 3 — S1 (VIX/VIX3M) scoring** (`indicators/stress.ts`): switched from
percentile rank to an absolute linear mapping (ratio <= 0.85 -> +1, >= 1.05
-> -1, linear between), with no `minHistory` gate — live from VIX3M's own
2006-07-17 start instead of +756 trading days after that (previously S1
wasn't live until 2009-07-16). Percentile-ranking a ratio that has a real
fixed reference point (1.0 = flat term structure) answers "is this unusual
for the ratio's own history," not "is the term structure actually inverted
right now" — the wrong question for this specific indicator, unlike S2-S5
where percentile rank is the right normalization.

Config bumped to **`mc-1.2.0`**.

**Post-fix result, and a new finding that limits how much it actually
helped**: recomputed and re-ran the same recovery-lag diagnostic. The
trend-state fix worked exactly as designed in isolation —
`trend_state` now leaves DOWN 2.5-10 weeks earlier in 3 of 4 episodes
(2002, 2009, 2022; 2020 barely changed, it wasn't broken to begin with).
But the overlay's actual recovery-to-NORMAL date only improved
meaningfully for **2020** (81 -> 51 trading days, the fast-path's
conditions aligned early and stayed aligned). **2009** didn't move at all
(111 trading days, identical) and **2022** moved only 4 days despite
its trend-state label moving 9 weeks earlier. **2002** didn't move at all,
and can't be helped by the recovery fast-path regardless of tuning — VIX3M
doesn't exist until 2006, so `recoveryFastPathActive` is structurally
`false` for the entire 2002-2003 episode.

Diagnosed why: once the trend cap stops binding, the **composite score
itself** — specifically `score_trend`'s T1/T3 components, which are
percentile-ranked against 10 years of trailing history — becomes the
dominant constraint, and that's slow by a different mechanism than
stickiness. A price that's just barely crossed back above its 200d SMA
ranks LOW in percentile terms even though the raw signal is technically
positive, because a bare crossing is unremarkable relative to a full bull
market's typical readings. Neither of this round's two fixes touches that
— they fixed the trend-state LABEL and the CAP's binding condition, not
the underlying score magnitude that (it turns out) was the real gate in 3
of 4 cases. Also observed: the recovery fast-path is evaluated fresh every
day, not "unlocked" once triggered — it activated early in 2009 and 2022
(first active day well before the eventual recovery date in both) but
wasn't simultaneously active on the specific day composite finally cleared
its margin, so it didn't shorten the wait in either case. Flagging this as
a real, unresolved gap for Phase 5 — not claiming this round's fix solved
the acceptance-bar problem, only the specific stickiness mechanism it
targeted.

## Post-Phase-1 changes (2026-09-29, before Phase 2)

Five changes requested by the user after reviewing Phase 1, all applied and
verified live (real ingest + full recompute run, not just unit tests):

1. **`mc_signal_log`** (new migration `20260929_mc_signal_log.sql`): append-only
   record of the overlay's real-time output, one row per date. Enforced at
   the DB level, not just application discipline — `UPDATE`/`DELETE` triggers
   raise an exception for every role, confirmed by hand (both blocked with
   `mc_signal_log is append-only`). `market-conditions-compute` writes to it
   with `ON CONFLICT (date) DO NOTHING` alongside its normal
   `market_conditions_scores` full-rebuild upsert — a date logged once is
   never touched again by a later config change or bug-fix recompute, by
   construction (the trigger would reject it even if the code tried).

2. **Credit spread source swap, S2/S3 + the credit-widening veto: BAMLH0A0HYM2 -> BAA10Y.**
   Confirmed via FRED directly: `BAA10Y` (Moody's Baa corporate yield less
   10y Treasury) has clean daily history from **1986-01-02** — full depth
   well before SPY's own 1993 start, unlike HY OAS's now-3-year window (see
   the finding above). `BAMLH0A0HYM2` is still ingested (for reference/future
   comparison) but no longer feeds S2/S3 or the veto. Bumped
   `config.version` to **`mc-1.1.0`**. Set `veto.creditWideningBp` to **45**
   as an explicit placeholder — BAA10Y is an investment-grade spread and
   moves in much smaller increments than HY OAS did, so the old 100bp
   threshold would almost never fire; 45bp is unbacktested and flagged for
   Phase 5 recalibration, not a considered choice.

3. **Forward-fill for daily series**: `alignWithForwardFill()`
   (`_shared/marketConditions/normalize.ts`) carries the last published
   value forward up to **3 trading-day positions** (not calendar days),
   respecting `published_at` for causality — built generically now so Phase
   4's weekly series (whose `published_at` genuinely lags their as-of date)
   reuse the same mechanism rather than a second one later. Beyond 3 days,
   the input is excluded and the day's `flags.stale_inputs` records which
   series were forward-filled (and how many days) — observed live on the
   first real run: BAA10Y was 2 trading days behind SPY's latest date
   (ordinary FRED publish lag) and got forward-filled + flagged; VIXCLS was
   4 days behind, exceeded the cap, and was correctly excluded rather than
   filled. This is the fix for the staleness gap flagged in Phase 1's own
   write-up above.

4. **Ingest delete confirmation**: every write in `market-conditions-ingest`
   is an upsert (`onConflict`, never `.delete(`) — confirmed by grep, not
   just recollection, and documented in the file's own header comment now
   so it stays true.

5. Full recompute run after all of the above:
   `config_version` now `mc-1.1.0` across all 8,283 rows;
   `mc_signal_log` populated 1:1 with `market_conditions_scores` (8,283 rows,
   1993-10-29 to today) and confirmed immutable by direct test.

## Phase 2 constituent-source decision (resolves part of Decision #2)

**Live breadth uses current S&P 500 constituents.** Backtest breadth must be
labeled survivorship-biased until a historical point-in-time constituent
source is chosen (still open, before Phase 5) — reinforced by a concrete
finding: `asset_price_history` is fed **exclusively by Yahoo Finance's v8
chart API** (confirmed by grep — every writer, `backfill-asset-price-history`,
`sync-asset-price-history`, `compute-capex-cycle`, and now
`market-conditions-ingest`, uses the same endpoint; no other provider
touches this table), and that endpoint **does not serve delisted tickers** —
confirmed directly, not assumed: both `ENE` (Enron, delisted 2001) and `BSC`
(Bear Stearns, delisted 2008) return `"No data found, symbol may be
delisted"`. A historical constituent backtest built on this same price
source would silently drop every company that left the index, which is
exactly the survivorship bias the spec's Decision #2 was warning about —
concrete confirmation that a dedicated point-in-time constituent + price
history source is required before Phase 5's breadth backtest, not just a
theoretical concern.


Records where the build spec's proposed design was mapped onto existing
ratiobo infrastructure instead of building a parallel/duplicate path, per
spec Section 0.1 ("reuse existing tables, clients, and conventions"), and
resolves the spec's Section 13 open decisions that block Phase 1
(Section 12.6: "raise before the phase that depends on them, not guessed").

## Architecture: Supabase edge functions + pg_cron, not Next.js API routes

The spec's proposed layout (`lib/market-conditions/`, `app/api/cron/...`,
Vercel cron + `CRON_SECRET`) doesn't match this repo. Checked directly:

- Every compute/ingest job in this repo (`sync-asset-price-history`,
  `compute-asset-resize-signals`, `update-big-cycle-metrics`, `ingest-liquidity-data`,
  etc.) is a self-contained Supabase edge function under `supabase/functions/`,
  scheduled via `pg_cron` + `net.http_post` migrations (e.g.
  `20260908_schedule_asset_resize_overlay_jobs.sql`) — never a Next.js API
  route or Vercel cron. No `vercel.json` cron config exists. No `CRON_SECRET`
  usage exists anywhere in the repo.
- Every dashboard page queries Supabase tables **directly from the client**
  (`supabase.from("holdings_valued").select(...)` in `app/dashboard/page.jsx`,
  same pattern everywhere else). No `app/api/*` routes exist at all.
- Shared, Deno-API-free scoring/classification logic lives in
  `supabase/functions/_shared/*.ts`, imported both by edge functions
  (`../_shared/x.ts`) and by Vitest under Node (confirmed by the doc-comments
  in `debtCycleClassifier.ts` / `paradigmScoring.ts` explaining exactly this
  split, and by `vitest.config.ts`'s `include: ["tests/**/*.test.{js,ts}"]`
  importing straight from `_shared/`).

**Decision:** follow this repo's established pattern, not the spec's literal
file layout:
- `supabase/functions/_shared/marketConditions/` — config, normalize,
  indicators, scoring, entry-signal logic (pure, no Deno APIs, unit-testable
  under Vitest exactly like `paradigmScoring.ts`).
- `supabase/functions/market-conditions-ingest/index.ts` — fetches
  VIXCLS/BAMLH0A0HYM2 (FRED) + ^VIX3M/SPY/RSP (Yahoo), upserts.
- `supabase/functions/market-conditions-compute/index.ts` — reads ingested
  data, runs `_shared/marketConditions`, upserts `market_conditions_scores`.
- `supabase/migrations/*_schedule_market_conditions.sql` — pg_cron, same
  `net.http_post` pattern as every other scheduled job.
- No `app/api/market-conditions/*` routes. The dashboard card queries
  `market_conditions_scores` directly via the Supabase client, like every
  other card in the app. Section 9.2's two endpoints are dropped as
  unnecessary indirection, not ported.
- `scripts/backtest/` (Phase 5) follows the existing pattern of standalone
  curl-invoked `*-backtest` edge functions (`kiss-portfolio-backtest`,
  `growth-axis-backtest`, `net-liquidity-backtest`) rather than a local
  Node script, since every prior backtest in this repo needs live Supabase
  data and has been built that way.

## Table mapping (Section 4)

| Spec table | Decision |
|---|---|
| `mc_price_daily` | **Not created.** Reuses `asset_price_history` (symbol, date, close, source) — the table `backfill-asset-price-history`/`sync-asset-price-history` already populate via Yahoo Finance adjusted close. Confirmed no Phase 1-4 indicator in this spec needs open/high/low/volume (all trend/stress/breadth math here is close-only), so the spec's OHLCV columns aren't needed. `adj_close` in the spec's schema = `close` here (Yahoo's adjusted close is already what's stored under `close`, per `backfill-asset-price-history`'s own comment). |
| `mc_series_daily` | **New table** (as specified). No existing table stores an arbitrary raw daily macro series with an as-of/published-at split — `fetch-macro-data` computes indicators on demand without persisting history, and `liquidity_monthly` is monthly-resolution WALCL/TGA/RRP only (relevant to Phase 4's Macro pillar, not Phase 1). Holds VIXCLS, ^VIX3M, and BAMLH0A0HYM2 for Phase 1 — VIX3M's source is Yahoo (see below) rather than FRED, but sits in the same table since it's conceptually a Stress-pillar input like the other two. |
| `mc_breadth_daily` | New table, as specified (Phase 2). |
| `market_conditions_scores` | New table, as specified. No `risk_overlay_scores` or equivalent exists (checked `supabase/migrations/` directly). |
| `mc_universe` | New table, as specified (Phase 2). |
| job-run logging | **New `mc_job_runs` table.** No existing generic job-log table exists in the repo (checked); spec explicitly allows this fallback. |

## Resolved open decisions (Section 13)

**#1 — Price data provider (blocks Phase 1).** Reuses the existing Yahoo
Finance v8 chart-endpoint mechanism already proven in
`backfill-asset-price-history`/`sync-asset-price-history` (same headers,
same `period1=0&period2=now` full-history trick, same adjusted-close
handling) — no new provider, no new API key. **S&P 500 proxy is SPY**, not
`^GSPC`: an ETF's Yahoo-adjusted close is exactly what this repo already
sources for VT/QQQ/GLDM, and dividend-adjusted total return is the more
realistic choice for a tactical-exposure signal that's meant to inform real
positioning. Flagging this as a choice, not a certainty — happy to switch to
raw index if preferred, but it changes very little here since none of the
Trend/Stress indicators are sensitive to the ~2%/yr dividend drift over
rolling-percentile/SMA-relative calculations.

**#5 — VIX3M source (blocks Phase 1).** Checked directly: Yahoo Finance
carries `^VIX3M` with daily history back to **2006-07-17**. Same fetch
mechanism as the price data above. Real constraint worth flagging: this is
~6.5 years short of the spec's 2000-01-01 backtest start and short of a full
10-year (2520-day) normalization window until ~2016. Per spec Section 5's
own rule, S1 (VIX term structure) is excluded and the Stress pillar's
remaining sub-indicators renormalized for any date before 2006-07-17 or
before S1 has `minHistory` (756 days) of its own data — same mechanism
already specified for any indicator with insufficient history, not a special
case.

## New finding during Phase 1 build: BAMLH0A0HYM2 (HY OAS) is now a rolling ~3-year FRED series, not full history

Discovered by hand while building the Stress pillar (checked directly against
FRED's own series metadata, not assumed): FRED's own notes on
`BAMLH0A0HYM2` state *"Starting in April 2026, this series will only include
3 years of observations. For more data, go to the source."* Confirmed live —
`observation_start` is `2023-09-29` regardless of the `cosd` param passed,
for both the public `fredgraph.csv` endpoint and the authenticated
`api.stlouisfed.org` series/observations endpoint. This is an ICE Data
Indices licensing change on FRED's end, not a bug in this build.

Consequences, handled by the spec's own existing mechanism (Section 5's
"insufficient history -> exclude and renormalize"), not a special case:
- S2 (HY OAS level) and S3 (HY OAS 20d change) are excluded from the Stress
  pillar for any date before the FRED window's own history is old enough
  (in practice, from Phase 1 launch through roughly mid-2026, S2/S3
  contribute nothing — the pillar runs on S1/S4/S5 only until then).
- More importantly for **Phase 5 backtesting**: since this window is
  *rolling* (~3 years trailing from whenever the backtest is run, not a
  fixed historical range), a full 2000-2026 backtest will **never** have
  credit-spread information for the vast majority of its own history. The
  Stress pillar's backtested behavior before ~2023 is really "VIX term
  structure + realized vol + VIX level" (3 of 5 sub-indicators), not the
  full 5-indicator design the spec describes. Flagging this now, before
  Phase 5, rather than let it surface as a surprise in the backtest report.
- Not fixed here — no immediate action needed for Phase 1 (live scoring
  degrades gracefully exactly as designed). Worth deciding before Phase 5
  whether to accept this limitation, source a longer non-FRED HY OAS history
  for backtesting purposes only, or substitute a different credit-spread
  series with fuller FRED history (e.g. Moody's Baa-Aaa spread, a rougher
  proxy but with_decades of depth).

## Daily-series alignment: no forward-fill in Phase 1, observed consequence

`market-conditions-compute` aligns VIXCLS/VIX3M/HY OAS to SPY's trading-day
calendar by **exact date match only** — no forward-fill, reserving that
mechanism for Phase 4's weekly series (AAII/NAAIM/WALCL/TGA) per spec
Section 3, since daily series were assumed to align cleanly almost always.

In practice (observed on the first real ingest run), FRED's publish cadence
for VIXCLS and BAMLH0A0HYM2 can lag SPY's latest trading day by a few days
(ordinary publish-lag/weekend effects, not a bug) — meaning the **most
recent 1-4 rows** of `market_conditions_scores` at any given time may have
S1/S2/S3/S5 excluded until the next ingest catches up, self-healing on the
following nightly run. Historical rows are unaffected. This is a
conservative default (matches Section 5's general "insufficient data ->
exclude" principle) rather than a bug, but if a tighter "live" reading is
wanted later, a short forward-fill (carry the last known value forward a few
days) would be a small, isolated follow-up to `market-conditions-compute`'s
alignment step — not raised as blocking anything now.

## Deferred (not blocking Phase 1)

- **#2 (S&P 500 historical constituent list, Phase 2)** — needs a real
  decision on data source before breadth/`mc_universe` can be built without
  survivorship bias. Will raise before starting Phase 2.
- **#3 (freed-weight destination, Phase 6)** — will raise before solver
  integration.
- **#4 (macro pillar: reuse regime engine vs. recompute, Phase 4)** —
  `dalio_regime_analysis` doesn't appear to expose a directly-reusable
  numeric liquidity/growth score on first check (grep came back empty), but
  this needs a closer read of `get-regime-analysis/index.ts` before deciding
  — will confirm before Phase 4, not assumed here.
