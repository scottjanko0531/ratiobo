-- Stock Picker Phase 1 follow-up: rb_ingest_ratings/rb_ingest_fool both
-- skip any symbol missing from rb_companies, and nothing adds to
-- rb_companies -- so a brand-new Fool pick or 13F "Our pick" would never
-- reach RatioBo at all. This is the missing third function: insert-only
-- (never overwrites an existing company's name/sector -- those are
-- hand-curated, not something a sync task should be able to clobber),
-- same security model as the other two ingest functions.
--
-- rb-refresh needs no code change to pick up a new company: it already
-- queries `rb_companies where active` ordered by symbol with an
-- offset/limit window per cron slice -- a newly inserted active=true row
-- is covered automatically on the next scheduled run, AS LONG AS it
-- falls within some slice's window. Today's 4 slices (0/40/80/120, limit
-- 40 each) cover 160 symbols against 155 active today -- only 5 of
-- headroom, easily exhausted by a few new Fool/13F picks. Widening this
-- now (per-slice limit 40 -> 50, 200 total capacity) in the same
-- migration rather than waiting for it to silently drop a new company
-- past the window.

create or replace function rb_ingest_companies(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row jsonb;
  v_symbol text;
  v_name text;
  v_source text;
  v_added date;
  v_yahoo_symbol text;
  v_count int := 0;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_symbol := v_row->>'symbol';
    v_name   := v_row->>'name';
    v_source := v_row->>'source';
    if v_symbol is null or v_name is null then
      continue;
    end if;
    if v_source is null or v_source not in ('fool', 'our') then
      continue;
    end if;
    -- Already known -- never overwrite an existing company's name/sector
    -- (hand-curated fields), so this is purely insert-new, not upsert.
    if exists (select 1 from rb_companies where symbol = v_symbol) then
      continue;
    end if;

    v_added        := coalesce((v_row->>'added')::date, current_date);
    v_yahoo_symbol := v_row->>'yahoo_symbol';

    insert into rb_companies (symbol, name, source, added, yahoo_symbol, active)
    values (v_symbol, v_name, v_source, v_added, v_yahoo_symbol, true);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function rb_ingest_companies(jsonb) from anon, authenticated, public;
grant execute on function rb_ingest_companies(jsonb) to service_role;

-- rb-refresh slice capacity widened from 160 (4 x 40) to 200 (4 x 50) --
-- see header comment. Same 2-minute stagger, same 90s timeout, just a
-- wider per-slice window.
select cron.unschedule('rb-refresh-slice-0-daily');
select cron.unschedule('rb-refresh-slice-1-daily');
select cron.unschedule('rb-refresh-slice-2-daily');
select cron.unschedule('rb-refresh-slice-3-daily');

select cron.schedule('rb-refresh-slice-0-daily', '15 21 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/rb-refresh?offset=0&limit=50', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 90000); $f$,
         (select substring(command from 'Bearer [A-Za-z0-9._-]+') from cron.job where jobname = 'sync-market-data-every-15-min')));

select cron.schedule('rb-refresh-slice-1-daily', '17 21 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/rb-refresh?offset=50&limit=50', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 90000); $f$,
         (select substring(command from 'Bearer [A-Za-z0-9._-]+') from cron.job where jobname = 'sync-market-data-every-15-min')));

select cron.schedule('rb-refresh-slice-2-daily', '19 21 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/rb-refresh?offset=100&limit=50', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 90000); $f$,
         (select substring(command from 'Bearer [A-Za-z0-9._-]+') from cron.job where jobname = 'sync-market-data-every-15-min')));

select cron.schedule('rb-refresh-slice-3-daily', '21 21 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/rb-refresh?offset=150&limit=50', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 90000); $f$,
         (select substring(command from 'Bearer [A-Za-z0-9._-]+') from cron.job where jobname = 'sync-market-data-every-15-min')));
