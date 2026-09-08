create table asset_resize_rule_config (
  symbol text primary key,
  rule_type text not null check (rule_type in ('trend_ma','trailing_drawdown','vol_regime')),
  params jsonb not null,
  confidence_note text,
  updated_at timestamptz not null default now()
);

comment on table asset_resize_rule_config is 'VAMS-equivalent Bottom-Up overlay spec: per-symbol risk-state resize rule, data-driven so calibration changes do not require a redeploy. Seeded from supabase/functions/equity-resize-backtest results (walk-forward, no-look-ahead, scored on CAGR/vol/max-drawdown/Sharpe/Calmar vs buy-and-hold). Any symbol NOT in this table gets no resize (exposure_multiplier defaults to 1.0 in compute-asset-resize-signals) -- the safe fallback for anything not yet backtested. rule_type/params match the three rule implementations ported from equity-resize-backtest: trend_ma {N, exposureWhenReduced}, trailing_drawdown {dCut, dRestore, exposureWhenReduced}, vol_regime {V, triggerMult, restoreMult, warmup, exposureWhenReduced}.';

alter table asset_resize_rule_config enable row level security;

create policy asset_resize_rule_config_read on asset_resize_rule_config
  for select to authenticated using (true);

insert into asset_resize_rule_config (symbol, rule_type, params, confidence_note) values
  ('VT', 'trailing_drawdown', '{"dCut": -0.10, "dRestore": -0.05, "exposureWhenReduced": 0.5}'::jsonb,
   'Backtested 2008-2026 (18yrs, n=24 trades). Calmar 0.18->0.22, max drawdown -50.3%->-31.6%. Trend/MA rules tested but did not reduce VT''s actual max drawdown at all in this window (fast-crash-dominated sample: GFC, COVID, 2022).'),
  ('VTI', 'trend_ma', '{"N": 252, "exposureWhenReduced": 0}'::jsonb,
   'Backtested 2001-2026 (25yrs, n=128 transitions). Calmar 0.18->0.35, max drawdown -55.5%->-22.5%. Different rule type than VT despite same asset class -- VTI''s longer window includes the 2000-2002 dot-com slow-grind crash, which a 252-day MA catches well; VT''s shorter window (starts 2008) only has fast crashes, which MA handles poorly. Window-length-dependent, not a settled truth about equities generically.'),
  ('GLDM', 'vol_regime', '{"V": 90, "triggerMult": 2.0, "restoreMult": 1.1, "warmup": 250, "exposureWhenReduced": 0}'::jsonb,
   'CAUTION: backtested 2018-2026 (8yrs) but the winning config only fired ONE trigger event in the entire window (n=1). Calmar 0.62->0.79 is real but on extremely thin evidence -- do not treat with the same confidence as VTI''s 128-transition result. Revisit once more history/trigger events accumulate.'),
  ('GLD', 'vol_regime', '{"V": 90, "triggerMult": 2.0, "restoreMult": 1.1, "warmup": 250, "exposureWhenReduced": 0}'::jsonb,
   'Same rule as GLDM (both track spot gold) -- GLD itself not separately backtested; inherits GLDM''s n=1-trigger caveat.'),
  ('FBTC', 'trend_ma', '{"N": 50, "exposureWhenReduced": 0}'::jsonb,
   'FBTC''s own history (Jan-2024 launch) is too short to calibrate on directly -- rule calibrated on BTC-USD (11yrs, n=224 transitions), applied here since FBTC tracks spot BTC closely. Calmar 0.41->0.76, max drawdown -83.4%->-57.4%.'),
  ('BTC', 'trend_ma', '{"N": 50, "exposureWhenReduced": 0}'::jsonb,
   'Backtested via BTC-USD proxy, 2014-2026 (11yrs, n=224 transitions). Calmar 0.41->0.76, max drawdown -83.4%->-57.4%. Strong, consistent effect -- the cleanest result of any asset tested.');
