# Market Conditions Overlay — decisions log

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
