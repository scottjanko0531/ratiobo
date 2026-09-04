-- 3-month-forward-forecast spec follow-up: forecast 3 simultaneous horizons
-- per series (GDP: Q+1/Q+2/Q+3; CPI: M+1/M+2/M+3) instead of one, so the
-- drawer can show a rolling ledger of upcoming periods and, as each target
-- date rolls into the past, its own resolved accuracy — not just an
-- aggregate stat. All three horizons share the same flat, level-anchored
-- point forecast (no momentum-decay); only the error band widens with
-- horizon (real horizon-matched MAE, see fetch-macro-data's constants).
alter table macro_forecast_log drop constraint macro_forecast_log_series_issue_date_key;
alter table macro_forecast_log add column horizon_n integer not null default 1 check (horizon_n in (1, 2, 3));

-- Clear the two single-horizon rows from the prior pass (2026-09-04) — they
-- predate the 3-horizon scheme and one series' row (CPI, "3mo ahead") would
-- otherwise mismap onto horizon_n=1 ("M+1"), which is a different claim.
-- Fresh, correctly-labeled rows for all 3 horizons get logged on the next
-- fetch-macro-data run.
delete from macro_forecast_log;

alter table macro_forecast_log alter column horizon_n drop default;
alter table macro_forecast_log add constraint macro_forecast_log_series_issue_date_horizon_n_key unique (series, issue_date, horizon_n);

comment on column macro_forecast_log.horizon_n is 'Which of the 3 simultaneous forward periods this row is: 1/2/3 quarters ahead for GDP, 1/2/3 months ahead for CPI. All three use the same forecast_value (flat anchor); only error_band_pp and target_date differ by horizon.';
