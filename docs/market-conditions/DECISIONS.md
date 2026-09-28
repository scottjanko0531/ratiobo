# Market Conditions Overlay — decisions log

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

**Outcome**: breadth is **NOT scored**. `market-conditions-compute` is
unaffected (never called with `breadthScore`) — no config version bump,
stays `mc-1.3.0`. The proxy pillar code (`indicators/breadth.ts`) and the
backtest harness (`market-conditions-breadth-backtest`) are kept in the
repo as-is — reusable if a different breadth construction is tried later
(e.g. reweighting PB1/PB2/PB3, dropping PB3, or trying the constituent-
based pillar once unbiased history exists), but nothing here should be
wired into production scoring without a fresh keep-or-drop pass.

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
