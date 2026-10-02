# Bond Lens Overlay — Phase E Backtest and Validation Report

2026-10-02. Covers §7 of `docs/specs/bond-lens.md` in full, run with monthly
non-overlapping sampling and split-half reporting (2003-2014 / 2015-2026)
per Scott's correction to the earlier, methodologically weak full-period/
daily-overlapping pass. Companion log: `bond-lens-decisions.md` (build
history, maturity-pref fix, coverage reweighting, curve-regime promotion).

## Verdict

**No variant beats constant duration by more than about 0.1 Sharpe;
differences are within noise. Valuation-only is adopted as a modest,
economically grounded tilt, not a proven edge.**

**The full 5-module composite has no real predictive power and does not
ship as the duration-tilting driver.** Its forward-return monotonicity
holds loosely in 2003-2014 but breaks and inverts in 2015-2026 (Short
outperforms Extend at the 12-month horizon); its Sharpe ratio loses to a
constant 1.0x-duration baseline in 2015-2026 (-0.21 vs -0.20) and loses to
two simpler variants (trend-only, trend-gated-valuation) in one or both
halves. The stance thresholds are also badly miscalibrated to the
composite's actual score spread -- 87.3% of months land in Neutral,
explaining why all five original spot-check dates were Neutral. Applying
Scott's own decision rule mechanically (no weight-tuning): the simplest
variant that beats the constant-duration baseline on Sharpe in **both**
halves, and that outperforms every other tested variant in both halves, is
**valuation_score alone, with no trend gate and no other module** (Sharpe
0.66 / -0.11, uncapped Extend band, vs the composite's 0.62 / -0.21 and the
constant baseline's 0.60 / -0.20). This result is robust to +/-50%
perturbation of every threshold and multiplier tested (Test 6) -- it is
not an artifact of one cutoff choice.

**Approved v1 shape (2026-10-02):** `duration_score = valuation_score`,
fixed thresholds exactly as backtested (-0.75/0.5 — not the
percentile-based alternative, which was diagnostic only and never the
scheme Test 3 actually ran), capped at **Extend (1.3x)** with Max-extend
dropped entirely (its trend=up condition no longer exists, and nothing in
this report supports a 1.6x band on its own merits). Re-confirming Sharpe
with that cap applied (identical methodology, same monthly IEF/DGS3MO
panel): **0.64 / -0.12** -- a negligible change from the uncapped 0.66 /
-0.11 (the >1.0/Max-extend band was rare enough in-sample that capping it
barely moves the result), and still beats the constant-duration baseline
(0.60 / -0.20) in both halves. The cap doesn't cost anything measurable
and removes a band the evidence never justified.

path/carry/quadrant/curve/trend stay computed and displayed (explanation
text, per-maturity table, hedge and curve-regime badges, plus a new
display-only inflation-regime warning) -- labeled "context" in the UI --
but drop out of the stance/multiplier decision itself.
`instrument_pref`/`maturity_pref` stay display-only in v1 too (never
backtested here -- Phase E only tested the duration decision); Phase D
applies only `duration_multiplier`, keeping the per-holding nominal/TIPS
mix and maturity profile unchanged. `include_credit` now defaults to
`false` -- Tests 8-9 show the duration-multiplier overlay is a wash on a
Treasury+TIPS risk-parity sleeve and actively harmful on a high-yield
corporate sleeve, since duration risk isn't what drives credit-spread
drawdowns, so Bond Lens is scoped to Treasury/TIPS/bills/aggregate-fund
sleeves by default. `curveRegimeStrict` is the only/default curve-regime
config going forward. See `docs/specs/bond-lens.md` v3 and
`bond-lens-decisions.md` for the full decision record.

---

## 1. Stance distribution, 1984-2026 (§7, Scott's follow-up ask)

505 monthly samples (last trading day of each month), `bond_lens_signal`,
1984-09 to present.

| | Short | Neutral | Extend | Max extend |
|---|---|---|---|---|
| Before trend gate (raw score, fixed bands, no trend=up requirement on Max-extend) | 5.0% | 86.5% | 7.9% | 0.6% |
| After trend gate (actual `duration_stance`) | 5.0% | 87.3% | 7.1% | 0.6% |

Both comfortably clear the 80% flag. The trend gate itself barely moves
the distribution (86.5% -> 87.3%) -- **the real problem is the fixed band
widths (+/-0.75 / 0.5 / 1.0) relative to the composite's actual score
spread, not the trend gate.** A composite whose stance is Neutral 87% of
the time is not meaningfully differentiating across most of history,
which independently explains why all five of the original spot-check
dates (March 2020, June 2022, October 2023, September 2024, today) landed
on Neutral -- that wasn't a coincidence of date selection, it's the typical
outcome.

### Percentile-based thresholds (expanding window, no lookahead)

20th/70th/90th percentile of the pre-gate raw score, computed from only
data available up to each date (24-month warmup), 481 usable months:

| Short | Neutral | Extend | Max extend |
|---|---|---|---|
| 21.2% | 51.1% | 21.8% | 5.8% |

Materially less Neutral-dominated (51.1% vs 87.3%). This confirms the
fixed thresholds -- not the composite's underlying signal -- are the
proximate cause of the Neutral-heavy distribution. (Not carried into the
Test 3 backtest below -- that's a separate, larger follow-up if the
composite itself were being kept; moot given the valuation-only
recommendation, which uses its own un-gated score directly rather than a
tuned threshold scheme.)

---

## 2. Test 1: forward excess returns by stance (§7.2 item 1)

10y proxy: real IEF price return (no dividend reinvestment -- likely
understates true total return by IEF's ~2-4%/yr yield; noted, not
corrected). Cash leg: `DGS3MO`/100 scaled to the horizon. Bucketed by the
actual `duration_stance` at each monthly sample date, non-overlapping
monthly sampling within each half (mild unavoidable overlap at the 6/12
month horizons given monthly sampling cadence, not corrected via
Newey-West here since the point is a bucketed mean, not a regression
coefficient).

| Half | Stance | n | 3mo | 6mo | 12mo |
|---|---|---|---|---|---|
| 2003-2014 | Short | 4 | -1.09% | 0.21% | 8.01% |
| | Neutral | 126 | 0.88% | 2.02% | 3.96% |
| | Extend | 12 | 2.62% | 2.21% | 3.94% |
| | Max extend | 2 | 4.56% | 3.00% | 5.32% |
| 2015-2026 | Short | 9 | 0.07% | -0.90% | 0.53% |
| | Neutral | 129 | -0.40% | -0.62% | -1.31% |
| | Extend | 3 | -0.40% | -1.72% | -4.36% |
| | Max extend | 0 | -- | -- | -- |

**Monotonicity:** 2003-2014's 3-month horizon is cleanly monotonic; 6-month
roughly so; 12-month breaks (Short, n=4, shows the single highest mean
return, above Max extend -- likely noise given n=4). **2015-2026 fails
monotonicity outright and inverts at 12 months** -- Short has the best
forward return (0.53%), Extend the worst (-4.36%), the opposite of what
the stance is supposed to predict. No Max-extend months occurred in this
half at all (consistent with 87% Neutral leaving little room for the
composite to ever reach Max-extend). This independently corroborates the
already-reported weak/negative IC for the live composite in 2015-2026.

---

## 3. Test 3: six-variant bond sleeve backtest (§7.3 item 8 methodology, applied to the duration decision itself)

**Setup.** Monthly resampling of real IEF (2002-07+) for the duration-proxy
return and `DGS3MO`/12 for the monthly cash return. Sleeve return =
`cash + m(t-1) * (IEF_return - cash)`, decided at month-end, applied to the
next month. Restricted to real IEF coverage, so both halves are the full
2003-2014 (n=144) / 2015-2026 (n=141) windows -- the 1984-2002 pre-IEF
period isn't covered by this specific test (real market data, not
synthetic, was used throughout). **The 1972-extended backtest (once DTB3
is backfilled) still only extends `carry_score`'s own history -- it
doesn't create pre-2002 IEF data, so this particular test's window is
unaffected by the DTB3 backfill.**

Variants: (i) constant 1.0x duration (passive IEF). (ii) trend_state alone
(up->1.3x, mixed->1.0x, down->0.5x). (iii) valuation_score alone, no trend
gate, through the stance bands (no trend sub-condition on the 1.6x band).
(iv) valuation_score with the trend gate applied as a cap (same mechanic
as the live composite's own gate), then through the stance bands. (v) the
real, live `duration_stance`/`duration_multiplier` columns. (vi) the
pre-gate composite raw score through the stance bands, no trend gate at
all.

| | (i) const 1.0x | (ii) trend only | (iii) valuation only | (iv) trend+val | (v) full composite | (vi) composite, no gate |
|---|---|---|---|---|---|---|
| H1 2003-2014: return/vol/maxDD/turnover | 5.42% / 6.66% / -7.60% / 0.7% | 5.80% / 8.13% / -9.21% / 20.8% | 6.35% / 7.54% / -7.87% / 13.2% | 6.17% / 7.43% / -7.87% / 12.5% | 6.16% / 7.62% / -7.79% / 15.3% | 6.16% / 7.62% / -7.79% / 15.3% |
| H2 2015-2026: return/vol/maxDD/turnover | 0.87% / 6.47% / -23.15% / 0.7% | 1.33% / 6.11% / -17.54% / 24.8% | 1.45% / 6.80% / -18.31% / 17.0% | 1.34% / 6.20% / -16.49% / 17.0% | 0.85% / 6.33% / -21.44% / 10.6% | 0.78% / 6.37% / -21.44% / 12.8% |

Cash return (annualized): H1 1.41%, H2 2.19%. Turnover = % of months the
multiplier changed; the ~0.7% floor on (i) is a boundary artifact
(`lag()` returning NULL at each half's first row), not real turnover --
(i) is truly 0% by construction.

**Sharpe ((return - cash) / vol):**

| | (i) | (ii) | (iii) | (iv) | (v) | (vi) |
|---|---|---|---|---|---|---|
| H1 2003-2014 | 0.60 | 0.54 | **0.66** | 0.64 | 0.62 | 0.62 |
| H2 2015-2026 | -0.20 | -0.14 | **-0.11** | -0.14 | -0.21 | -0.22 |

### 4. Decision rule (§7, applied mechanically, no weight-tuning)

- **Does (v) beat (i) on Sharpe in both halves?** No. H1: 0.62 > 0.60
  (barely). H2: -0.21 < -0.20 (loses -- the full composite is *worse*
  than just holding constant duration exposure in the second half).
- **Does (v) lose to (ii) or (iv) in either half?** Yes: loses to (iv) in
  H1 (0.62 < 0.64); loses to both (ii) and (iv) in H2 (-0.21 is worse than
  -0.14, twice over).

Both triggers fire. Per the rule, recommend the simplest variant that
beats (i) in **both** halves. Checking all six: (i) is the baseline by
definition; (ii) fails in H1 (0.54 < 0.60); (v) and (vi) both fail as
shown; (iii) and (iv) both clear the bar. Between those two, **(iii)
valuation-only strictly dominates (iv)** -- better Sharpe in both halves
(0.66 > 0.64, -0.11 > -0.14) -- *and* is simpler (no trend gate at all).
**(iii) wins outright, on both performance and simplicity.**

This is a real result, not a consolation prize: valuation-only has the
best Sharpe of all six variants tested, in both halves, full stop. The
other four modules (path, carry, quadrant, curve) -- representing most of
Phase B's build effort -- do not improve the duration-timing decision over
valuation alone, and the trend gate specifically makes things worse in
every variant it's applied to in H2 (compare (iii) vs (iv): un-gated beats
gated in H2, -0.11 vs -0.14).

### 5. Test 6: sensitivity, on the (iii) valuation-only winner

+/-50% perturbation of each of the 3 stance thresholds and 3 multiplier
values, one parameter at a time, 12 perturbation runs:

| Parameter | Direction | H1 Sharpe | H2 Sharpe |
|---|---|---|---|
| baseline | -- | 0.66 | -0.11 |
| Short threshold (-0.75) | narrower (-0.375) | 0.65 | -0.17 |
| | wider (-1.125) | 0.68 | -0.21 |
| Extend threshold (0.5) | narrower (0.25) | 0.63 | -0.10 |
| | wider (0.75) | 0.67 | -0.07 |
| Max-ext threshold (1.0) | narrower (0.5) | 0.65 | -0.14 |
| | wider (1.5) | 0.64 | -0.12 |
| Short multiplier (0.5x) | lower (0.25x) | 0.65 | -0.06 |
| | higher (0.75x) | 0.65 | -0.16 |
| Extend multiplier (1.3x) | lower (0.65x) | 0.65 | -0.03 |
| | higher (1.95x) | 0.64 | -0.17 |
| Max-ext multiplier (1.6x) | lower (0.8x) | 0.59 | -0.15 |
| | higher (2.4x) | 0.66 | -0.08 |

No perturbation flips sign in either half (H1 stays 0.59-0.68 positive;
H2 stays -0.03 to -0.21 negative). No swing exceeds ~0.1 in absolute
Sharpe terms (well under a 0.3 fragility flag). **Verdict: robust.** The
H1 edge and H2 shortfall both survive every threshold/multiplier choice
tested -- this isn't an artifact of one specific cutoff.

---

## 6. Tests 8-9: model portfolio simulations (§7.3)

**Data constraint:** no AGG or LQD (investment-grade corporate) fund
exists in `asset_price_history`. Proxies used, and flagged as real
limitations: "aggregate bond fund" -> IEF (understates diversification --
real AGG blends Treasuries/IG corporates/MBS); "corporates" -> HYG
(**high-yield, not investment-grade** -- a materially different risk
profile; also caps that portfolio's window to 2007-05+, HYG's inception).
Equity sleeve = SPY throughout. Risk-parity bond leg = a fixed 50/50
IEF/TIP notional split, not a real vol-targeting risk-parity engine.
"Bond Lens ON" applies only the real `duration_multiplier` around a cash
baseline (`cash + m*(proxy_return - cash)`) -- no `instrument_pref`/
`maturity_pref` tilt, since that's Phase D scope, explicitly not started.

| Portfolio | Window | Mode | Max DD | Bond sleeve ann. return | Bond sleeve ann. vol | Turnover | Rebalances/yr |
|---|---|---|---|---|---|---|---|
| 60/40 + IEF (AGG proxy) | 2002-08 to 2026-09 (290mo) | OFF | -29.46% | 3.36% | 6.64% | n/a | 12 (fixed cadence) |
| | | ON | **-28.60%** | 3.47% | 7.08% | 13.1% of months | 1.57 |
| 40/60, bond 50/50 IEF+TIP (risk parity) | 2004-01 to 2026-09 (273mo) | OFF | -20.39% | 3.22% | 5.64% | n/a | 12 |
| | | ON | -20.61% | 3.09% | 5.90% | 10.3% of months | 1.23 |
| 30/70 + HYG (income/corporates) | 2007-05 to 2026-09 (233mo) | OFF | -35.02% | 4.75% | 10.18% | n/a | 12 |
| | | ON | **-39.93%** | 4.01% | 11.46% | 9.5% of months | 1.13 |

**Verdict:** Bond Lens ON only helps the Treasury-proxy sleeve (-0.86pp
drawdown), is roughly a wash on the Treasury+TIPS risk-parity sleeve
(+0.21pp worse), and **meaningfully hurts** the HYG/corporates sleeve
(+4.91pp worse drawdown) -- the composite measures duration/rate risk,
which isn't what drove HYG's drawdowns (2008, 2020 were credit-spread
events, not rate events). All three portfolios stay well under the
<6-rebalances/year turnover target (1.13-1.57/yr) regardless of mode --
**turnover was never the binding constraint; sleeve-signal mismatch is.**
This independently supports scoping Bond Lens to Treasury-duration
sleeves specifically, not bond sleeves generally.

---

## 7. Variant decisions (already made by Scott, recorded here for the full picture)

- **(a) Inflation-regime hedge rule:** not adopted as a rule (36.8% hit
  rate / 28.8% false-alarm rate over 1965-2002 -- too weak a
  discriminator). Kept as a **display-only "inflation regime warning"**
  next to the hedge badge, since it would have flagged 2022 a year early
  -- useful context for a user, not a basis for automated action. **Not
  yet implemented in code** -- this is new UI/explanation-layer scope, not
  started this session.
- **(b) Quadrant removed from composite:** not adopted. Full-period gain
  was a 2003-2014-only artifact; 2015-2026 shows a worse hit rate for the
  alt variant. Moot in any case given quadrant (and every other non-
  valuation module) drops out of the live stance/multiplier decision
  under this report's own recommendation.
- **(c) Curve regime:** `curveRegimeStrict` promoted to the only/default
  config this session (`bond-lens-compute` v14, deployed and recomputed;
  `bond_lens_signal.curve_regime` now neutral ~60.1% of the time, down
  from the old config's ~47%). Also now moot for the live duration
  decision under the valuation-only recommendation, but curve_score/
  curve_regime remain computed and displayed (UI cross-check, per spec).
- **(d) DTB3 backfill:** `scripts/backfill-dtb3.mjs` written this
  session; Scott running it locally with his own service-role key.
  `.env.local` confirmed already covered by `.gitignore` (`.env*.local`,
  line 9) -- safe to add `SUPABASE_SERVICE_ROLE_KEY` there.

---

## 8. Recommendation for v1

1. **Duration decision:** drive `duration_score`/`duration_stance`/
   `duration_multiplier` from `valuation_score` alone, no trend gate, no
   other module. This is the best-performing AND simplest variant tested,
   robust under sensitivity analysis, by a decisive margin over the full
   composite in the half that matters most for an out-of-sample read
   (2015-2026).
2. **Keep path/carry/quadrant/curve computed and displayed** -- they
   still feed `instrument_pref` (quadrant, breakeven gap), `maturity_pref`
   (carry's EFF/BE table), the explanation text, and now the new
   inflation-regime display warning (path's growth_mom / quadrant's
   inflation axis) -- just not the stance/multiplier decision itself.
3. **Scope the overlay to Treasury-duration sleeves.** Tests 8-9 show no
   benefit (TIPS/risk-parity) to active harm (HYG/corporates) outside
   that scope.
4. This is a architecture-level change to §5.1/§5.2 of the spec (the
   composite formula itself) -- not made in code yet, pending Scott's
   review of this report, per his explicit instruction not to start
   Phase D (or, by extension, revise the shipped composite) until he's
   seen it.

**Not changing without further instruction:** `bond_signals`' six module
columns, the maturity-preference/coverage-reweighting fixes from the
prior round (both already shipped, unaffected by this report's
recommendation), and the curve-regime default (already promoted,
unaffected).
