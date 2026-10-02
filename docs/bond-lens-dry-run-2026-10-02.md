# Bond Lens Dry Run -- 2026-09-30

This is a **read-only dry run**. It uses the live `duration_score`/`duration_stance`/`duration_multiplier` from `bond_lens_signal` as of **2026-09-30** (stance **Extend**, multiplier **1.3x**, duration_score 1.34), computed with the real `lib/bondLensPortfolio.js` solver -- the exact same code the app itself would run, not a reimplementation. Nothing here was applied to any portfolio: no database writes happened as part of producing this report, and no portfolio currently has `use_bond_lens_overlay` enabled. This is purely "what would happen if it were turned on today."

**Update (§6.3 substitutes):** this report now also shows what changes once the solver is allowed to introduce eligible-but-not-held substitute instruments (`DEFAULT_ELIGIBLE_INSTRUMENTS`: nb = BIL/SHY/IEF/TLT, tip = VTIP/SCHP) when the held-only solve can't reach the target. A fix has since landed in `solveDurationShiftWithSubstitutes`: "already held" for substitute-eligibility purposes is now based on POSITIVE weight, not merely the existence of a holding row -- a $0 row no longer blocks its own symbol from being proposed as a substitute. Of the 3 portfolios previously confirmed unreachable (All Weather Alpha, All Weather With Equity Tilting, Dalio All Weather), **0 of 3** are now fully (portfolio-level) reachable with substitutes, and **3 of 3** remain unreachable (All Weather Alpha, All Weather With Equity Tilting, Dalio All Weather) -- see each portfolio's bucket-level before/after table below for why (per-bucket improvement can still occur even when the portfolio-level flag stays false, since one bucket can fix while another stays stuck).

---

## AG ST Shocks Play

No in-scope bond-sleeve (nb/tip bucket) holdings at all -- nothing for Bond Lens to act on in this portfolio.

---

## All Weather Alpha

**In-scope holdings**

| symbol | bond_type | effective_duration | current $ value | current % of bucket |
|---|---|---|---|---|
| TLT (nb) | treasury_nominal | 14.63y | $32,929 | 100.00% |
| VTIP (tip) | tips | 2.40y | $9,143 | 100.00% |

**Excluded holdings**

None.

Current sleeve weighted duration: 11.97y

Benchmark duration: 11.97y (= current duration, no `benchmark_duration` override setting exists for this portfolio)

Target sleeve duration: 15.56y (benchmark × multiplier -- stance **Extend**, multiplier **1.3x**)

**Reachability: before vs after §6.3 substitutes**

| bucket | before (held-only) | after (with substitutes) |
|---|---|---|
| nb | unreachable -- Only one in-scope holding (TLT) in this bucket -- can't shift duration without an eligible substitute instrument. | still unreachable -- Only one in-scope holding (TLT) in this bucket -- can't shift duration without an eligible substitute instrument. |
| tip | unreachable -- Only one in-scope holding (VTIP) in this bucket -- can't shift duration without an eligible substitute instrument. | reachable -- introduces **SCHP** (not previously held) |

_Note (nb): the held instrument is already the most extreme default option in the needed direction (longest duration among `BIL/SHY/IEF/TLT`) -- no default substitute is more extreme, so the bucket stays unreachable even after trying substitutes._

**Weight change if Bond Lens were applied today (with substitutes)**

| symbol | current $ value | target $ value | delta $ value | delta as % of own bucket |
|---|---|---|---|---|
| TLT | $32,929 | $32,929 | +$0 | +0.00% |
| VTIP | $9,143 | $7,497 | $-1,646 | -18.00% |
| SCHP -- proposed, not held | $0 | $1,646 | +$1,646 | +18.00% |

---

## All Weather With Equity Tilting

**In-scope holdings**

| symbol | bond_type | effective_duration | current $ value | current % of bucket |
|---|---|---|---|---|
| TLT (nb) | treasury_nominal | 14.63y | $15,651 | 100.00% |
| VTIP (tip) | tips | 2.40y | $4,402 | 100.00% |

**Excluded holdings**

None.

Current sleeve weighted duration: 11.95y

Benchmark duration: 11.95y (= current duration, no `benchmark_duration` override setting exists for this portfolio)

Target sleeve duration: 15.53y (benchmark × multiplier -- stance **Extend**, multiplier **1.3x**)

**Reachability: before vs after §6.3 substitutes**

| bucket | before (held-only) | after (with substitutes) |
|---|---|---|
| nb | unreachable -- Only one in-scope holding (TLT) in this bucket -- can't shift duration without an eligible substitute instrument. | still unreachable -- Only one in-scope holding (TLT) in this bucket -- can't shift duration without an eligible substitute instrument. |
| tip | unreachable -- Only one in-scope holding (VTIP) in this bucket -- can't shift duration without an eligible substitute instrument. | reachable -- introduces **SCHP** (not previously held) |

_Note (nb): the held instrument is already the most extreme default option in the needed direction (longest duration among `BIL/SHY/IEF/TLT`) -- no default substitute is more extreme, so the bucket stays unreachable even after trying substitutes._

**Weight change if Bond Lens were applied today (with substitutes)**

| symbol | current $ value | target $ value | delta $ value | delta as % of own bucket |
|---|---|---|---|---|
| TLT | $15,651 | $15,651 | +$0 | +0.00% |
| VTIP | $4,402 | $3,610 | $-792 | -18.00% |
| SCHP -- proposed, not held | $0 | $792 | +$792 | +18.00% |

---

## BW AI-Mercantilism

No in-scope bond-sleeve (nb/tip bucket) holdings at all -- nothing for Bond Lens to act on in this portfolio.

**Excluded holdings**

| symbol | reason |
|---|---|
| DBMF | managed_futures |

---

## Dalio All Weather

**In-scope holdings**

| symbol | bond_type | effective_duration | current $ value | current % of bucket |
|---|---|---|---|---|
| TLT (nb) | treasury_nominal | 14.63y | $206,174 | 100.00% |
| SCHP (tip) | tips | 6.40y | $0 | 0.00% |
| VTIP (tip) | tips | 2.40y | $226,830 | 100.00% |

**Excluded holdings**

| symbol | reason |
|---|---|
| ARCC | equity_like_bdc |
| BXSL | equity_like_bdc |

Current sleeve weighted duration: 8.22y

Benchmark duration: 8.22y (= current duration, no `benchmark_duration` override setting exists for this portfolio)

Target sleeve duration: 10.69y (benchmark × multiplier -- stance **Extend**, multiplier **1.3x**)

**Reachability: before vs after §6.3 substitutes**

| bucket | before (held-only) | after (with substitutes) |
|---|---|---|
| nb | unreachable -- Only one in-scope holding (TLT) in this bucket -- can't shift duration without an eligible substitute instrument. | still unreachable -- Only one in-scope holding (TLT) in this bucket -- can't shift duration without an eligible substitute instrument. |
| tip | unreachable -- Only one in-scope holding (VTIP) in this bucket -- can't shift duration without an eligible substitute instrument. | reachable -- introduces **SCHP** (not previously held) |

_Note (nb): the held instrument is already the most extreme default option in the needed direction (longest duration among `BIL/SHY/IEF/TLT`) -- no default substitute is more extreme, so the bucket stays unreachable even after trying substitutes._

**Weight change if Bond Lens were applied today (with substitutes)**

| symbol | current $ value | target $ value | delta $ value | delta as % of own bucket |
|---|---|---|---|---|
| TLT | $206,174 | $206,174 | +$0 | +0.00% |
| SCHP | $0 | $40,829 | +$40,829 | +18.00% |
| VTIP | $226,830 | $186,001 | $-40,829 | -18.00% |

---

## Golden Butterfly Hedged

**In-scope holdings**

| symbol | bond_type | effective_duration | current $ value | current % of bucket |
|---|---|---|---|---|
| SHY (nb) | treasury_nominal | 1.84y | $47,171 | 51.73% |
| TLT (nb) | treasury_nominal | 14.63y | $44,009 | 48.27% |

**Excluded holdings**

| symbol | reason |
|---|---|
| DBMF | managed_futures |

Current sleeve weighted duration: 8.01y

Benchmark duration: 8.01y (= current duration, no `benchmark_duration` override setting exists for this portfolio)

Target sleeve duration: 10.42y (benchmark × multiplier -- stance **Extend**, multiplier **1.3x**)

**Reachability: before vs after §6.3 substitutes**

| bucket | before (held-only) | after (with substitutes) |
|---|---|---|
| nb | reachable | reachable (no substitute needed) |

**Weight change if Bond Lens were applied today (with substitutes)**

| symbol | current $ value | target $ value | delta $ value | delta as % of own bucket |
|---|---|---|---|---|
| SHY | $47,171 | $30,033 | $-17,138 | -18.80% |
| TLT | $44,009 | $61,146 | +$17,138 | +18.80% |

---

## KISS

No in-scope bond-sleeve (nb/tip bucket) holdings at all -- nothing for Bond Lens to act on in this portfolio.

---

## Note Portfolio

**In-scope holdings**

| symbol | bond_type | effective_duration | current $ value | current % of bucket |
|---|---|---|---|---|
| TLT (nb) | treasury_nominal | 14.63y | $0 | n/a (bucket total $0) |

**Excluded holdings**

| symbol | reason |
|---|---|
| CAD1 2026-6 | no_market_duration |
| CAL1 2026-4 | no_market_duration |
| CCIX_ULTRA_ST | no_market_duration |
| CCXI_ST_NOTE | no_market_duration |
| ESP PAYROLL ADVANCES SR. 2026-3 | no_market_duration |
| ESP1 2026-4 | no_market_duration |
| FDA1 2026-1 | no_market_duration |
| HIGH-YIELD ST NOTE | no_market_duration |
| KIK1 2026-3 | no_market_duration |
| PBN11 2026-1 | no_market_duration |
| PBN12 2026-1 | no_market_duration |
| RAP1 2026-6 | no_market_duration |
| SFC2 2026-2 | no_market_duration |
| SHORT TERM NOTE | no_market_duration |
| SHORT TERM NOTE | no_market_duration |
| SHORT TERM NOTE ULTRA | no_market_duration |
| WSF2 2026-2 | no_market_duration |

Current sleeve weighted duration: n/a

Benchmark duration: n/a (= current duration, no `benchmark_duration` override setting exists for this portfolio)

Target sleeve duration: n/a (benchmark × multiplier -- stance **Extend**, multiplier **1.3x**)

**Reachability: before vs after §6.3 substitutes**

| bucket | before (held-only) | after (with substitutes) |
|---|---|---|
| nb | reachable | reachable (no substitute needed) |

All in-scope holdings in this sleeve currently carry $0 value -- there is no dollar weight to reallocate, so no trades would result regardless of the targets above.

---

## Rule Breakers

No in-scope bond-sleeve (nb/tip bucket) holdings at all -- nothing for Bond Lens to act on in this portfolio.

---

