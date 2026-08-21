-- ============================================================
-- Automate "Threats Against Members of Congress" — was manual, now
-- scraped from USCP's predictable annual press-release URL
-- (uscp-threat-assessment-cases-{year}) by
-- computeThreatsAgainstCongressUpdate() in update-big-cycle-metrics.
-- ============================================================

alter table public.big_cycle_metrics drop constraint if exists big_cycle_metrics_refresh_method_check;
alter table public.big_cycle_metrics add constraint big_cycle_metrics_refresh_method_check
  check (refresh_method = any (array[
    'api_fred', 'api_treasury', 'api_imf', 'api_cofer', 'csv_voteview',
    'api_macro_xref', 'api_redfin', 'api_nyfed', 'api_uscp', 'manual'
  ]));

update public.big_cycle_metrics
set refresh_method = 'api_uscp',
    source_name = 'US Capitol Police, Threat Assessment Section (annual press release)',
    source_url = 'https://www.uscp.gov/media-center/press-releases'
where key = 'threats_against_congress';
