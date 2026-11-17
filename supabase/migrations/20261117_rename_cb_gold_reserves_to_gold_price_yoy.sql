-- Debt-Cycle Metrics Integrity, Phase 3a (docs/specs/debt-metrics-integrity.md).
-- Rename "CB Gold Reserves (YoY)" -> "Gold Price (YoY)" per CLAUDE.md rule
-- 2.1 (indicator name strings are keys across macro_indicators,
-- macro_snapshots, and fetch-macro-data's own INDICATORS array). This card
-- has only ever measured the YoY change in the gold PRICE (COMEX GC=F) --
-- never actual central-bank reserve holdings -- so the old name was always
-- a misnomer. Actual CB purchase tonnage is the new, separate "Central
-- Bank Gold Purchases (4Q, tonnes)" card (wgc_gold_purchases).
--
-- NOT applied live yet -- held for deploy approval alongside the code
-- changes, same two-step gate as every other phase this session. Confirmed
-- before writing this: no existing row under the new name in either table
-- (zero collision risk), and a repo-wide grep shows no remaining code
-- references to the old name once fetch-macro-data/index.ts and
-- app/macro/page.jsx are updated (see decisions log).

update public.macro_indicators
  set name = 'Gold Price (YoY)'
  where name = 'CB Gold Reserves (YoY)';

update public.macro_snapshots
  set indicator_name = 'Gold Price (YoY)'
  where indicator_name = 'CB Gold Reserves (YoY)';
