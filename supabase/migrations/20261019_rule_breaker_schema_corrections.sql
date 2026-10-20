-- Rule Breaker Screener, Phase 1 — corrections discovered against Scott's
-- real artifact export (rule-breaker-ratiobo-import.zip, 2026-10-19). The
-- Phase 1 schema was designed from the build spec's prose before any real
-- data existed; several fields turned out to have a different shape than
-- assumed. Each correction below is a literal fix to match what the real
-- export actually contains, not a design change:
--
--   1. rb_companies: spec lists "yahoo symbol" as its own field, distinct
--      from the canonical `symbol` key -- missed in the original migration.
--   2. rb_fool.first_rec: real values are bare year strings ("2022"), not
--      parseable dates.
--   3. rb_holders_13f.quarter: real values are free-text filing labels
--      ("Jun 30, 2026 13F (filed Aug 2026)"), not a quarter-end date --
--      the README explicitly calls it "the holders_asof label".
--   4. rb_ratings.rated_by: real values are a free-text annotator name
--      ("Claude"), not a uuid referencing a RatioBo auth user -- drop the
--      FK, mirror the type change onto rb_ratings_history. Also add
--      appeal_rated_on, present in the real export and missing from the
--      original migration.
--   5. rb_scores.c1..c6: the build spec's Scoring model scores each sign
--      as a 0-100 percentile (met = score >= 60), not a boolean -- the
--      original migration wrongly modeled these as booleans. Table was
--      empty (Phase 1 never wrote to it) so drop+re-add rather than cast.
--   6. rb_scores.safety: same percentile scoring, wrongly modeled as text.
--   7. rb_scores.vwap_state: real values are full human-readable action
--      labels ("Below VWAP: exit / stay out"), not the indicator's raw
--      u/d state -- drop the check, add the missing vwap_z column.
--   8. rb_scores.partial: the weekly-snapshot history file flags a
--      score-only (non-full-breakdown) row; missing from the original
--      migration.
--   9. rb_theses.id / rb_thesis_tags.thesis_id: real thesis ids are
--      human-chosen slugs ("fool-rb", "robotics"), not uuids -- the
--      dependent rb_thesis_tags RLS policy and FK are dropped and
--      recreated unchanged around the type change.

alter table rb_companies add column yahoo_symbol text;
comment on column rb_companies.yahoo_symbol is 'Yahoo Finance symbol, may differ from the canonical symbol key (share-class suffixes etc.) -- spec''s own "yahoo symbol" field, missed in the original migration.';

alter table rb_fool alter column first_rec type text using first_rec::text;

alter table rb_holders_13f alter column quarter type text using quarter::text;

alter table rb_ratings drop constraint rb_ratings_rated_by_fkey;
alter table rb_ratings alter column rated_by type text using rated_by::text;
alter table rb_ratings add column appeal_rated_on date;

alter table rb_ratings_history alter column rated_by type text using rated_by::text;
alter table rb_ratings_history add column appeal_rated_on date;

create or replace function rb_ratings_archive_old() returns trigger
security definer set search_path = public
as $$
begin
  insert into rb_ratings_history
    (symbol, user_id, td, moat, mgmt, appeal, founder, why, appeal_why,
     appeal_basis, rated_by, rated_on, appeal_rated_on, source_url, created_at, updated_at, replaced_at)
  values
    (old.symbol, old.user_id, old.td, old.moat, old.mgmt, old.appeal, old.founder,
     old.why, old.appeal_why, old.appeal_basis, old.rated_by, old.rated_on,
     old.appeal_rated_on, old.source_url, old.created_at, old.updated_at, now());
  return null;
end;
$$ language plpgsql;

alter table rb_scores drop column c1, drop column c2, drop column c3, drop column c4, drop column c5, drop column c6, drop column safety;
alter table rb_scores add column c1 numeric, add column c2 numeric, add column c3 numeric, add column c4 numeric, add column c5 numeric, add column c6 numeric, add column safety numeric;
alter table rb_scores drop constraint rb_scores_vwap_state_check;
alter table rb_scores add column vwap_z numeric;
alter table rb_scores add column partial boolean;

-- rb_theses.id / rb_thesis_tags.thesis_id: drop the dependent policy + FK
-- first, alter types, then recreate both unchanged.
drop policy "users manage own rb_thesis_tags" on rb_thesis_tags;
alter table rb_thesis_tags drop constraint rb_thesis_tags_thesis_id_fkey;
alter table rb_theses alter column id drop default;
alter table rb_theses alter column id type text using id::text;
alter table rb_thesis_tags alter column thesis_id type text using thesis_id::text;
alter table rb_thesis_tags add constraint rb_thesis_tags_thesis_id_fkey foreign key (thesis_id) references rb_theses(id) on delete cascade;
create policy "users manage own rb_thesis_tags" on rb_thesis_tags
  for all using (exists (select 1 from rb_theses t where t.id = rb_thesis_tags.thesis_id and t.user_id = auth.uid()))
  with check (exists (select 1 from rb_theses t where t.id = rb_thesis_tags.thesis_id and t.user_id = auth.uid()));

comment on table rb_scores is 'Append-only, mirrors mc_signal_log''s immutability pattern exactly. c1-c6/safety/quality are 0-100 percentile scores (sign/pillar "met" at >=60 per the build spec''s Scoring model), not booleans. config_version is NOT FK''d to rb_config.config_version -- rb_config only ever holds the current version, while historical rb_scores rows legitimately reference past versions that no longer match it. Written by the daily compute job (Phase 2+); Phase 1 only seeds historical rows via scripts/rb-import.ts.';

-- rb_companies.added: real export data has explicit null for every
-- Fool-sourced pick (no add date tracked -- only "our"-sourced picks carry
-- one) -- NOT NULL + a current_date default was a Phase-1 guess that broke
-- on the first real import attempt.
alter table rb_companies alter column added drop not null;
