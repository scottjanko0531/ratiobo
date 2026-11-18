# RatioBo — Debt-Cycle Metrics Integrity, v3 (Auction Ingest + Position Check Brief)

**Status:** v1.0 (Nov 18, 2026). Not started.
**Owner:** Scott
**Builder:** Claude Code
**Suggested location in repo:** `docs/specs/debt-metrics-integrity-v3.md`
**Decisions log:** append to `docs/specs/debt-metrics-integrity-decisions.md` under `## v3`.
**Predecessors:** `debt-metrics-integrity.md` (v1) and `debt-metrics-integrity-v2.md` (v2). Both are complete and deployed. Their standing rules 1–9 still apply.

---

## 0. Why this exists

A review of the live `/big-cycle` page after v2 found three problems. #1 predates v1/v2. #2 comes from an earlier feature (`_shared/portfolioGap.ts`). #3 is a fact-check gap introduced by v2.

| # | Problem | Where | Effect |
|---|---|---|---|
| 1 | **Auction data is about 3 months stale and misses 2/3 of 10Y/30Y auctions.** (a) The ingest makes one call, `page[number]=1&page[size]=10000&sort=auction_date` from 2010, with no pagination. Ascending order means the newest rows are the ones cut off. Nothing has been ingested since **2026-10-22**, though the daily cron reports "succeeded". (b) Consumers match `security_term === "10-Year"` / `"30-Year"` exactly. Treasury labels reopenings `9-Year 10-Month`, `9-Year 11-Month`, `29-Year 10-Month`, `29-Year 11-Month`, so only the quarterly new issues count. | `supabase/functions/ingest-auction-results/index.ts` (line ~60 fetch; line ~100 `latest10y`); `_shared/indirectBidder.ts` (lines ~46, 56–61, 87–89); any other consumer matching on `security_term` | "Indirect Bidder Share 57.5%" and "Bid-to-Cover 2.53" are from the **Aug 12–13** auctions. "Trailing 6 auctions" actually covers about 18 months. v2 Phase 1's history (101 readings, 2-year mean 56.83 / sd 2.02) was calibrated on new issues only. |
| 2 | **The Position Check brief issues household-wide allocation orders.** Prompt item (5) *requires* a "Concrete moves" section built from `computeBucketGaps` over **all** of the user's holdings against BW Modified. The live brief told Scott to cut Notes/Loans from 42% to 0% and Cash from 51% to 3%, and called AETSTOCK ($5.2M) "ultra-safe, ultra-low-yielding collateral" to redeploy. | `generate-debt-cycle-brief/index.ts` (prompt item 5, ~line 141; `portfolioGapLines`, ~lines 134 / 303–316); `_shared/portfolioGap.ts`; "Portfolio Gap vs. BW Modified" panel in `DebtCyclePositionCheck.jsx` | It mischaracterizes illiquid business-related and high-yield note holdings. A macro-stage brief shouldn't be generating trade instructions for the whole balance sheet. It also conflicts with the per-portfolio regime logic (All Weather etc.). |
| 3 | **The brief misreports the auction-demand trip-wire.** It says auction demand "fired on 2026-11-17… reflects deterioration relative to historical behavior" and cites "this week's weakness". That firing was the v1 threshold artifact, the v2 recalibration disarmed it, and no auction data arrived this week (#1). The fact-checker missed this. The "2 FIRED IN LAST 7 DAYS" header also counts the artifact. | `generate-debt-cycle-brief/index.ts` (`tripWiresFiredThisWeek`, fact-check prompt ~line 167); `DebtCyclePositionCheck.jsx` header count | A false "deterioration" claim in the one narrative meant to summarize debt risk. |

---

## 1. Goals / non-goals

**Goals**
- Auction data is complete (all 10Y/30Y auctions, reopenings included) and current to within one business day of Treasury publishing results.
- Ingest failures are visible.
- The debt-cycle brief describes the macro situation. It does **not** issue household allocation orders.
- Trip-wire history in the brief and header excludes firings that a recalibration superseded. The fact-checker verifies trip-wire claims against the current state *and* the recalibration notes.

**Non-goals**
- No change to stage logic or trip-wire thresholds beyond recalibrating against the corrected auction history (Phase 2).
- No change to portfolio-level analysis features (the per-portfolio Daily Analysis, rebalance tables). Only the debt-cycle brief and its panel are in scope.

---

## 2. Phases

### Phase 0 — Baseline (no behavior changes)

1. Confirm root cause 1(a): call the Fiscal Data `auctions_query` endpoint with the current URL and record `meta.total-count`, `meta.total-pages`, and the last `auction_date` on page 1. Expected: total count above 10,000, and page 1 ending around 2026-10-22.
2. List every distinct `security_term` in `treasury_auction_results` that maps to a 10Y or 30Y original maturity. Include the 20Y family (`20-Year`, `19-Year 10/11-Month`) for reference only; 20Y stays out of scope unless Scott asks. Log the term-to-tenor mapping rule.
3. Grep every consumer of `treasury_auction_results` and every `security_term ===` / `.eq("security_term"` match across `supabase/functions`, `components`, `app`, `lib`. List them.
4. Snapshot current values into `tests/fixtures/debt-metrics-v3-2026-11-18.json`:
   - indirect bidder (card / classifier / trip-wire);
   - bid-to-cover and its auction date;
   - trip-wire state;
   - the current brief text;
   - the current "Portfolio Gap vs. BW Modified" panel contents.

**Acceptance:** root cause confirmed with API metadata; term mapping and consumer list logged.

---

### Phase 1 — Auction ingest: complete and current

**1a. Incremental, paginated fetch.**
- Fetch from `max(auction_date) − 30 days` in the table (overlap catches late-published results), `sort=-auction_date`, paginating through `meta.total-pages`.
- Keep a `?full=true` mode that paginates the whole history from 2010 for backfills.
- Upsert on the existing natural key. Confirm what it is (likely `cusip` + `auction_date`) and log it.

**1b. A tenor field instead of string matching.**
- Add a derived `original_tenor` column (`'10Y'`, `'30Y'`, `'20Y'`, …) via migration, populated by one shared mapping function in `_shared/auctionTenor.ts`.
- Rule: a `security_term` of `N-Year` or `(N−1)-Year 1x-Month` maps to `N`Y for notes/bonds. Use the Phase 0 list; include TIPS/FRN only if `security_type` says so, and keep them separate from nominal.
- Backfill the column for all existing rows.

**1c. Switch consumers to the tenor field.**
- `indirectBidder.ts` (`computeIndirectBidderSnapshot`, `evalAuctionDemandDeterioration`), the bid-to-cover `latest10y` selection, and every Phase 0 consumer use `original_tenor IN ('10Y','30Y')` and `security_type = 'Note' | 'Bond'` (nominal only).
- "Trailing 6 auctions" now means the last 6 auctions per tenor, about 6 months.

**1d. Make failures visible.**
- The ingest logs to `rb_job_runs`: rows fetched, rows upserted, newest `auction_date`, and `status`.
- It returns HTTP 500 (and logs `error`) if the newest 10Y/30Y `auction_date` is more than **35 days** old. The 10Y auctions monthly, so a 35-day gap means the feed has stopped.
- Add a `data_as_of` field (the newest auction date used) to the Indirect Bidder and Bid-to-Cover cards' metadata, and show it in the card subtitle.

**1e. Run the full backfill** (`?full=true`) and confirm:
- the 10Y/30Y row counts roughly triple versus new-issue-only;
- the newest 10Y is the Nov 2026 refunding auction (~Nov 10–12);
- the newest 30Y is the Nov refunding (~Nov 12–13);
- `data_as_of` is shown on both cards.

**Tests:**
- `auctionTenor.test.ts`: every Phase 0 term string maps correctly; unknown terms return `null`, never a wrong guess.
- `indirectBidder.test.ts`: reopenings included; trailing-6 per tenor.
- Pagination: a mocked 2-page response yields both pages.
- Staleness guard throws above 35 days.

**Acceptance:** cards show auctions from November 2026; reopenings are included; a stopped feed would show up within 35 days.

---

### Phase 2 — Recalibrate auction-demand thresholds on the corrected history

v2 Phase 1 calibrated z-scores and the trip-wire's 2-year mean/sd on **new issues only**. Reopenings typically show different bidder mixes, so the distribution changes.

**2a.** Recompute the Phase 0-style distribution (full history and trailing 2 years) on the corrected data, with all auctions and per-tenor trailing-6 readings. Log mean, sd, P10/P25/P50, and n. The 2-year n should be about 24 consolidated readings, not 12.

**2b.** No threshold *rules* change (z bands, arm/disarm logic, hysteresis). Only the inputs change. Before deploying, report the live before/after for:
- the card status and z;
- `mp3AuctionDemandWeak`;
- the trip-wire (armed/disarmed, streak, `armThreshold`/`disarmThreshold`);
- bid-to-cover value and date.

**2c.** If the trip-wire **arms** on corrected data, that's a real signal, not an artifact. Report it with the numbers. **Don't** suppress the notification (unlike v2's recalibration note) unless Scott says otherwise. If it changes state, add a `big_cycle_stage_notes` line: "Auction data corrected <date>: reopenings now included and feed current through <date>; readings before this date reflected August data."

**Acceptance:** thresholds evaluated on complete, current data; any state change reported and approved before deploy.

---

### Phase 3 — Position Check brief: macro narrative, not trade orders

**3a. Remove household allocation orders.**
- Delete prompt item (5) "Concrete moves" and the `portfolioGapLines` input from `generate-debt-cycle-brief`.
- Replace it with item (5) **"Implications"**: 2–4 sentences on what the current stage, trip-wires and refinancing pressure mean for **asset classes generally** (e.g. duration, real assets, cash yields). No percentages tied to the user's holdings, and no buy/sell instructions.
- Add an explicit prompt rule: "Do not reference the user's holdings, balances, or allocation percentages. Do not issue rebalancing instructions."

**3b. Remove or rescope the "Portfolio Gap vs. BW Modified" panel** in `DebtCyclePositionCheck.jsx`. Default: **remove it from the Big Cycle page**. If Scott wants it kept, it must:
- exclude holdings flagged illiquid or non-tradeable (add a `holdings.is_liquid` boolean, default `true`; set it `false` for AETSTOCK, the Note Portfolio's notes, `CCXI_ST_NOTE`, and any `alt_loan` / `alt_pp` / `alt_other` keys; log the list for Scott to confirm);
- be labeled "Liquid holdings only — informational, not a recommendation".

Ask Scott which option before building. If no answer, remove it.

**3c. Fact-checker additions.** The fact-check pass must flag:
- any reference to the user's holdings, balances, or allocation percentages;
- any buy/sell/rebalance instruction;
- any claim that a trip-wire "fired" or reflects "deterioration" when (i) it's currently disarmed **and** (ii) a `big_cycle_stage_notes` recalibration note covers that firing date;
- any "this week" auction claim when no 10Y/30Y auction occurred in the past 7 days (use `data_as_of`).

If the fact-checker flags anything, regenerate once. If it still fails, show the brief with a visible "fact-check flagged: …" banner rather than silently publishing it.

**3d. Trip-wire firing history.**
- `tripWiresFiredThisWeek` (brief input) and the "N FIRED IN LAST 7 DAYS" header exclude firings superseded by a recalibration note: same key, note dated on or after the firing, and the trip-wire disarmed since.
- Superseded firings appear in the trip-wire tooltip as "fired <date> — superseded by recalibration <date>", not in the count.

**3e.** Regenerate the brief (`?refresh=true`) and confirm:
- no holdings or percentage references;
- no "Concrete moves";
- no auction-deterioration claim;
- the header count excludes the Nov 17 artifact.

**Tests:**
- prompt-builder unit test: no `portfolioGapLines` and no holdings data reach the prompt;
- fact-check rule tests: holdings reference flagged, rebalance instruction flagged, superseded-firing claim flagged;
- `tripWiresFiredThisWeek` excludes superseded firings.

**Acceptance:** the brief is macro-only, its trip-wire history is accurate, and the fact-checker enforces both.

---

## 3. Rollout

Order: **0 → 1 → 2 → 3.**
- Phase 2 can change a trip-wire or classifier state, so it needs the before-deploy report and Scott's approval.
- Phase 3b needs Scott's choice (remove vs. rescope the panel).
- Phase 1 must deploy before Phase 2. Phase 3 is independent of 1–2 and can ship in parallel if convenient.

**Expected visible changes:**
- **Auction cards:** current through mid-November 2026, with a `data_as_of` subtitle. The numbers may move materially from 57.5% / 2.53.
- **Auction-demand trip-wire / classifier:** re-evaluated on complete data; state reported before deploy.
- **Position Check brief:** no "Concrete moves" and no household percentages; gains an "Implications" paragraph.
- **Big Cycle page:** the Portfolio Gap panel is removed, or relabeled liquid-only per Scott's choice.
- **Trip-wire header:** no longer counts the Nov 17 artifact.

---

## 4. Test checklist

- [ ] `auctionTenor.test.ts` (new): term → tenor mapping, unknown → null
- [ ] Ingest pagination + incremental window + 35-day staleness guard
- [ ] `indirectBidder.test.ts`: reopenings included; per-tenor trailing 6
- [ ] Recalibrated distribution logged; before/after state report
- [ ] Brief prompt-builder: no holdings data in the prompt
- [ ] Fact-check rules: holdings reference, rebalance instruction, superseded firing, stale "this week" claim
- [ ] `tripWiresFiredThisWeek` and header count exclude superseded firings
