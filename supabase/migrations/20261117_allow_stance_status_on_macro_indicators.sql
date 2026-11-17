-- Debt-Cycle Metrics Integrity, Phase 3b (docs/specs/debt-metrics-integrity.md).
-- Widens macro_indicators' AND macro_snapshots' status CHECK constraints to
-- allow the new "stance" family (accommodative/neutral/restrictive) used by
-- "Real Fed Funds Rate" -- a genuinely different semantic axis from the
-- healthy/watch/danger risk scale, not a relabeling of it. Both tables carry
-- an identical constraint; missing the macro_snapshots one would have failed
-- the ENTIRE daily snapshot upsert batch (a single multi-row upsert is one
-- statement -- one bad row aborts all of it), not just this one indicator's
-- row, since fetch-macro-data writes every indicator's snapshot in one
-- upsert call. Found by checking both tables before deploying, not
-- discovered live. app/macro/page.jsx's StatusBadge already renders any
-- status string it doesn't recognize with neutral styling (confirmed by
-- reading the component before deciding this needed no frontend change).
--
-- NOT applied live yet -- held for deploy approval, same two-step gate as
-- every other phase this session.

alter table public.macro_indicators drop constraint macro_indicators_status_check;
alter table public.macro_indicators add constraint macro_indicators_status_check
  check (status = any (array['healthy'::text, 'watch'::text, 'danger'::text, 'unknown'::text, 'accommodative'::text, 'neutral'::text, 'restrictive'::text]));

alter table public.macro_snapshots drop constraint macro_snapshots_status_check;
alter table public.macro_snapshots add constraint macro_snapshots_status_check
  check (status = any (array['healthy'::text, 'watch'::text, 'danger'::text, 'unknown'::text, 'accommodative'::text, 'neutral'::text, 'restrictive'::text]));
