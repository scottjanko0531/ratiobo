# RatioBo — Regime Shadow Targets Log: Build Spec

**Status:** v1 (Oct 30, 2026), ready to build
**Owner:** Scott
**Builder:** Claude Code
**Suggested location in repo:** `docs/specs/regime-shadow-targets.md`
**Parent spec:** `docs/specs/regime-tilt-recalibration.md` (v1.1). This log is how each phase of that spec gets validated.

---

## 0. Purpose

Scott won't change live portfolio targets until each phase of the recalibration has been seen working on real signals. Both regime-driven portfolios stay held (`regime_auto_shift = false`).

Today's logs only capture shift events (`portfolio_regime_shifts`), not the targets each rule set would produce day to day. So there's nothing to compare phases against.

This spec adds a daily **shadow** computation. For each regime-driven portfolio, it runs every rule set ("lane") side by side. Each lane keeps its own simulated state and records the targets it would hold. **It never writes to `portfolios`.**

The questions it has to answer:

1. How often does each lane shift, and how much turnover does it generate?
2. On a given day, how far apart are the lanes, and why (carry rule, minimum hold, blend, variant)?
3. When a real event happens, does each lane react the way its phase intended? The expected events are:
   - the Nov 11 minimum-hold expiry
   - the October CPI print around Nov 12
   - the November CPI print around Dec 10, which could confirm the Overheating candidate

---

## 1. Prerequisite (do first, separate commit)

**Restore All Weather Alpha's baseline.** The old-rules run at 2026-10-30 06:55 UTC shifted Alpha to full Reflation (`portfolio_regime_shifts` row with `applied = true`) before its hold was set.

- Restore:
  - `current_regime_key = 'fg_ri'`
  - `regime_confirmed_since = '2026-10-21'`
  - `target_allocations` = the `fg_ri` set
  - `regime_blend` populated the way Phase 2 would have written it
- Mark the 10/30 shift row reverted. Add `reverted_at timestamptz` and `revert_note text` to `portfolio_regime_shifts`; don't delete the row.
- **Acceptance:** both portfolios show identical regime state and targets.

The shadow lanes seed from this baseline (§4.3), so this has to land first.

---

## 2. Lanes

The lanes are defined in one registry, `supabase/functions/_shared/shadowLanes.ts`. Each lane is a pure function:

```ts
type LaneFn = (inputs: ShadowInputs, prev: LaneState, ctx: LaneContext) => LaneResult
```

| Lane id | What it computes | Source of logic |
|---|---|---|
| `live` | Records what's actually stored on the portfolio today. No simulation. | `portfolios.target_allocations` / `current_regime_key` |
| `legacy` | The rules as they stood before Phase 2: full swap to the confirmed near-term key if the override is active, otherwise to the structural key (carry readings included). No blend, cap or hold. | The pre-Phase-2 `update-regime-portfolio-targets` at commit **`e5896c7`**. Extract its decision logic into a pure function, `legacyResolve()`, unchanged. Don't re-derive it from memory. |
| `phase2` | Carry rule, blended near-term override, turnover cap, minimum hold. `variant` is always `base`. | Existing `_shared/regimeShiftRules.ts` + `regimeWeights.ts` |
| `phase3` | `phase2` plus the high-inflation variants and acceleration modifiers, **computed regardless of the `regime_variants_enabled` flag.** | Added when Phase 3 is built. The registry must accept it without schema changes. |

**Rule for every lane:** a lane function must call the **same** shared functions production uses (`getWeightSet`, `blendWeights`, `capTurnover`, etc.). The `phase2` lane must not copy them. If production logic changes, the lane changes with it, and `rules_version` (§3) records when.

---

## 3. Schema

### 3.1 `regime_shadow_targets`: one row per day × portfolio × lane

| Column | Type | Notes |
|---|---|---|
| `snapshot_date` | date | |
| `portfolio_id` | uuid fk → portfolios | |
| `lane` | text | `live`, `legacy`, `phase2`, `phase3` |
| `rules_version` | text | Short git SHA of the deployed lane code, read from an env var set at deploy, or a constant bumped manually per release |
| `regime_key` | text | The lane's base or structural key after its rules |
| `near_key` | text null | Near-term key used in a blend, if any |
| `lambda` | numeric null | Blend fraction applied (0 when there's no blend) |
| `variant` | text | `base`, `high`, `high_accel`, `high_decel` (§3.3) |
| `target_allocations` | jsonb | Same bucket keys as `portfolios.target_allocations`, whole percentages, sums to 100 |
| `sector_targets` | jsonb null | Equity Tilting only: `{symbol: pct_of_eq_bucket}` after any sector blend |
| `turnover_vs_prev` | numeric | Σ\|Δw\|/2 against this lane's previous row for this portfolio, in percentage points |
| `turnover_uncapped` | numeric null | What turnover would have been without the cap (phase2/phase3 only) |
| `shifted` | boolean | `regime_key`, `near_key`, `lambda` or `variant` changed from the previous row |
| `event` | text null | One short code (§3.2) |
| `blocked_reason` | text null | Why a move was wanted but not made (§3.2) |
| `inputs` | jsonb | Snapshot of every input used (§4.1), so any row can be re-explained later |
| `created_at` | timestamptz default now() | |

- **Primary key:** `(snapshot_date, portfolio_id, lane)`.
- **Writes are insert-only, with on-conflict-do-nothing.** The first reading of the day is the official one, the same rule `nearterm_signal_history` follows. A rerun the same day is a no-op.
- **Recompute:** `?recompute=true` deletes and rewrites rows for a date range. It's only available to the service role, and logs a note stating the reason (§5.3).
- **Access:** RLS on, service-role write, authenticated read. Match the policies on `nearterm_signal_history`, and check against the 10/28 security-advisor migration.

### 3.2 Codes

**`event`:**
- `seed`
- `shift_full` (legacy full swap)
- `blend_start`, `blend_change`, `blend_end`
- `cap_partial` (a capped move; more to come)
- `cap_complete`
- `variant_change`
- `base_change` (a crossover-sourced structural move)
- `no_change`

**`blocked_reason`:**
- `carry_protected`
- `min_hold:<YYYY-MM-DD clears>`
- `below_conf_floor`
- `not_confirmed:<n>/7`
- `infl_candidate:<n>/3`
- `variants_flag_off` (phase3 only; recorded even though the lane still computes the variant targets)

### 3.3 `variant` derivation (shared helper)

| Inflation state | Acceleration vote | `variant` |
|---|---|---|
| `contained` | any | `base` |
| `overheating` or `stagflation` | `mixed` | `high` |
| `overheating` or `stagflation` | `accelerating` | `high_accel` |
| `overheating` or `stagflation` | `decelerating` | `high_decel` |

Lanes that don't use variants (`legacy`, `phase2`) still record `base` and keep the real inflation state in `inputs`.

### 3.4 `regime_shadow_state`: each lane's carried state

| Column | Type | Notes |
|---|---|---|
| `portfolio_id`, `lane` | pk | |
| `base_key` | text | |
| `base_confirmed_since` | date | Drives the minimum hold |
| `last_shift_date` | date null | |
| `current_targets` | jsonb | Where the lane actually sits, which can lag the desired targets under the cap |
| `desired_targets` | jsonb | Where the lane is converging to |
| `current_sector_targets` | jsonb null | |
| `updated_at` | timestamptz | |

Each lane evolves from **its own** previous state, never from the live portfolio. That's the reason this table exists: the live portfolios are held, so reading their state would freeze every lane.

---

## 4. Computation

### 4.1 Where and when

- **New function `update-regime-shadow-targets`**, scheduled 15 minutes after `update-regime-portfolio-targets` on the same days.
  - It reads today's `dalio_regime_analysis` row and `nearterm_signal_state`. **It never writes** to `nearterm_signal_state`, `portfolios` or `portfolio_regime_shifts`.
  - **Why a separate function** rather than a block inside the live job: a shadow failure can't break or delay the live job, and the shadow job can be re-run alone.
- **If today's `dalio_regime_analysis` row is missing:** write nothing, and send a low-importance notification `shadow_skipped:<date>`. Don't call `get-regime-analysis` from here.
- **Inputs** to snapshot into `inputs`:
  - from `dalio_regime_analysis`: `structural_key`, `structural_key_source`, `nearterm_forward_key`, `nearterm_forward_confidence`, `infl_level_state`, `infl_candidate_state`, `infl_candidate_count`, `infl_accel_vote`
  - the near-term smoothed confidence, recomputed with the same shared helper and window as the live job
  - from `nearterm_signal_state`: `pending_key`, `pending_since`, `confirmed_key`, `active`
  - for each portfolio: `regime_auto_shift`

### 4.2 Per lane, per portfolio

1. Load `prev` from `regime_shadow_state`.
2. Call the lane function to get the desired targets, metadata and codes.
3. For capped lanes, move `current_targets` toward `desired_targets` using the shared `capTurnover`.
4. Write the `regime_shadow_targets` row and update `regime_shadow_state`.
5. For Equity Tilting, run sector targets through the same blend or λ path the live code uses on `/portfolios`. Store the result in `sector_targets`.

### 4.3 Seeding (first run)

- **Seed date:** the first run's date. Every lane for both portfolios is seeded from the restored baseline (§1):
  - `base_key = 'fg_ri'`, `base_confirmed_since = '2026-10-21'`, `last_shift_date = '2026-10-21'`
  - `current_targets = desired_targets` = the `fg_ri` set
  - the current Stagflation sector table
- Write a `seed` row per lane on that date, then **run the normal computation on the same date in the same invocation.** This means the `legacy` lane's first computed row already shows the full Reflation swap the old rules made on 10/30. That's the point of comparison.
- **Exception:** `live` isn't seeded; it just records.
- **When `phase3` is added later,** seed it from the `phase2` lane's state on that date, not from the baseline, and write a `seed` row noting that.

### 4.4 No historical backfill

As established in Phase 2, `structural_key_source` didn't exist before 2026-10-30, and the smoothed near-term confidence only goes back to 2026-10-18. The log starts on its deploy date. Don't fabricate earlier rows.

---

## 5. Reading the log

### 5.1 View `regime_shadow_summary`

One row per portfolio × lane, from the seed date to today:

| Column | Definition |
|---|---|
| Shift count | Rows with `shifted = true`, excluding `seed` |
| Total turnover | Σ `turnover_vs_prev` |
| Max single-day turnover | |
| Current regime | `regime_key`, `near_key`, `lambda`, `variant` |
| Current growth exposure | `eq + intl + em` |
| Current real assets | `com + gld + tip` |
| Current `nb` | |
| Days in each `regime_key` | |
| Days blocked, by reason | `blocked_reason` prefix |
| Days since last shift | |

### 5.2 Divergence view `regime_shadow_divergence`

One row per day × portfolio. For each pair of lanes, the one-way distance Σ|Δw|/2 between their `target_allocations`, plus each lane's `regime_key`.

### 5.3 UI: a minimal panel, not a feature

- **Where:** a collapsible "Shadow lanes" section on `/portfolios` under each regime-driven portfolio.
- **What it shows:**
  - a table with one row per lane: regime label, λ, variant, eq/intl/em, nb, tip, com, gld, cash, and days since last shift
  - the latest `event`, and `blocked_reason` if any
  - a 30-day sparkline of growth exposure per lane, following the existing chart conventions on that page
- **Out of scope:** no editing, and no "apply this lane" button.

### 5.4 Notifications: low importance, deduplicated

- **A lane shifts:** "Shadow (phase2): blend started toward Reflation, λ=0.30. Live portfolio held." One per lane event, with dedup key `shadow:<lane>:<portfolio>:<event>:<date>`.
- **Lanes diverge or converge:** when any two lanes go from under 10 points apart to over 20, or back. This is a single notification across both portfolios when they behave identically.
- **Don't notify on `no_change`.**

---

## 6. Tests

- **`legacyResolve()` matches the old function's decisions.** Using fixtures for 9/18, 10/21 and 10/30, it should produce Disinflationary Boom, Stagflation and Reflation respectively.
- **`phase2` lane under carry:** carry structural plus confirmed near-term during the minimum hold gives `blocked_reason = min_hold:2026-11-11` and targets unchanged.
- **`phase2` lane after the hold clears,** with near-term active at 65% smoothed confidence: λ = 0.30. The one-way move should be about 12–13 points, completed in a single day under the 15-point cap, with event `blend_start`.
- **Cap convergence:** a desired move of 40 points takes 3 days, logs `cap_partial` twice and `cap_complete` once, and `turnover_uncapped` is recorded on the first day.
- **Independence:** changing `portfolios.target_allocations` doesn't change any non-`live` lane's next row.
- **Idempotence:** a second same-day run writes nothing; `?recompute=true` rewrites and logs.
- **Sums:** every `target_allocations` sums to 100, and every `sector_targets` sums to 100.
- **Failure isolation:** a thrown error in one lane still writes the other lanes' rows and sends a `shadow_lane_error` notification.
- **The live job is untouched:** `update-regime-portfolio-targets` tests pass unchanged, and no new writes come from the shadow function to live tables.

---

## 7. Acceptance (after first deploy)

Expected first-run rows. As of 10/30, near-term Reflation is confirmed and active, and structural is a carry Stagflation.

| Lane | Expected for both portfolios |
|---|---|
| `live` | Restored `fg_ri` targets (after §1) |
| `legacy` | `rg_ri` full set, event `shift_full`, turnover 40 |
| `phase2` | `fg_ri` targets, `blocked_reason = min_hold:2026-11-11` |

Report these to Scott with the summary view. If any row differs from this table, explain why before calling it done.

---

## 8. Checkpoints the log should make visible

| Date (approx.) | Event | What to look for |
|---|---|---|
| Nov 11 | Minimum hold clears | `phase2`: `blend_start` toward Reflation if near-term is still active; `legacy` unchanged at full Reflation |
| ~Nov 12 | October CPI release | Inflation candidate goes to 2/3 or breaks; `phase3` (if built) records `infl_candidate` |
| ~Dec 10 | November CPI release | If the Overheating candidate confirms: `phase3` gets `variant_change` to `high*` and `phase2` doesn't. Otherwise, the candidate count resets. |
| Any day | Structural crossover | `base_change` in `phase2`/`phase3`; `legacy` swaps in full |

---

## 9. Out of scope

- Simulated P&L per lane. That would need asset return marks; revisit after Phase 6's backtest.
- Applying a lane's targets to a live portfolio. That stays a manual decision through `regime_auto_shift`.
- Lanes for non-regime-driven portfolios.

---

## 10. Order

1. §1 Alpha restore. Separate commit, stop and confirm.
2. Schema, lane registry, `legacyResolve()` extraction, `live`/`legacy`/`phase2` lanes, function and cron, tests.
3. First deploy, then verify against §7 and report.
4. Views and `/portfolios` panel, then notifications.
5. Commit and push each step. Production edge functions and `main` must match.

When Phase 3 is built, it adds the `phase3` lane to the registry as part of that phase's own acceptance.

---

## Build notes (added during implementation, Oct 30 2026)

- §2's cited commit `e5896c7` is the GRID regime-reconstruction fix,
  unrelated to `update-regime-portfolio-targets`. `legacyResolve()` is
  extracted from `6a2ccc7` instead — the last version of that file
  before Phase 2's rewrite (`377e6a3`).
- `rules_version` is a manually-bumped string constant
  (`shadowLanes.ts`'s `RULES_VERSION`), confirmed with Scott — no
  deploy-time git-SHA injection exists in this repo's Supabase Edge
  Function deploys.
- §4.1's `regime_variants_enabled` flag is renamed `regime_phase3_weights`
  (Phase 3 build) — its real scope covers D-1's whole weight-set
  revision, not just the high-inflation variant tier.
- New standing rule (Phase 3 build, see
  `regime-tilt-recalibration-decisions.md`): when a shared weight
  table a lane reads from changes, that lane reseeds the same day via
  `?reseed=true` rather than logging the definition change as real
  turnover. New `event` code `rules_change`; `regime_shadow_summary`
  excludes it from `shift_count`/`total_turnover` the same way it
  already excludes `seed`.
- `legacy` was found to be calling the shared (mutable) `getWeightSet`
  — fixed to use a new frozen `LEGACY_WEIGHTS` constant instead, so it
  stays a faithful old-rules baseline across future shared-table edits.
