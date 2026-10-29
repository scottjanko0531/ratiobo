-- Stock Picker Phase 1 follow-up #2. Two bugs in rb_fool_history, both
-- from the original Phase 1 migration not actually checking rb_fool's
-- live schema column-for-column:
--   1. first_rec is text on rb_fool (holds a bare year, e.g. "2022") but
--      was declared date on rb_fool_history -- every update on rb_fool
--      fired the archive trigger, which tried to insert that text value
--      into a date column and errored, rolling back the whole update.
--      56 Fool-sync rows failed on this today.
--   2. rb_fool_history was also just missing two columns rb_fool
--      actually has (first_rec_date, last_rec_date) -- not a hard error,
--      but every archived snapshot would have silently dropped them,
--      making the history incomplete rather than a faithful copy of the
--      row that existed before the update.
-- Safe to fix in place: rb_fool_history has 0 rows (confirmed live).

alter table rb_fool_history alter column first_rec type text;
alter table rb_fool_history add column first_rec_date date;
alter table rb_fool_history add column last_rec_date date;

create or replace function rb_fool_archive_old() returns trigger
security definer set search_path = public
as $$
begin
  insert into rb_fool_history
    (symbol, f5, type, first_rec, first_rec_date, last_rec_date, recs, top10, status, closed_on, updated_at, replaced_at)
  values
    (old.symbol, old.f5, old.type, old.first_rec, old.first_rec_date, old.last_rec_date,
     old.recs, old.top10, old.status, old.closed_on, old.updated_at, now());
  return null;
end;
$$ language plpgsql;
