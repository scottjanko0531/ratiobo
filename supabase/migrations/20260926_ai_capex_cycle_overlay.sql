-- AI Capex Cycle Overlay — consolidated record of what was applied to the remote
-- project on 2026-09-26 (remote migration history: capex_cycle_overlay_schema,
-- capex_cycle_overlay_seed, capex_cycle_correction_regime, plus two ad-hoc changes
-- noted at the bottom). Already applied — kept here for version control / rebuilds.
--
-- Measures whether the AI capex boom is stretching toward a Perez/Minsky-style bust,
-- runs a Bayesian scenario update on pre-registered evidence, and emits bucket exposure
-- multipliers that lib/capexOverlay.js merges into Portfolio Actions (downside-only,
-- gated by shadow_mode).
-- Pipeline: indicators -> pillar z-scores -> CCSI + triggers -> hazard + regime ->
--           evidence rules -> scenario posteriors -> bucket multipliers.
-- Compute: supabase/functions/compute-capex-cycle (daily 06:20 UTC).
-- History check: supabase/functions/capex-cycle-backtest (stateless report).

-- ───────────────────────── schema ─────────────────────────
create table public.capex_indicator_defs (
  code text primary key,
  label text not null,
  pillar text not null check (pillar in ('intensity','financing','returns','overcapacity','market','aux')),
  source text not null check (source in ('fred','sec','yahoo','derived','manual')),
  source_key text,
  unit text not null default '',
  direction smallint not null check (direction in (-1,1)),  -- +1: higher value = more bust stress
  weight numeric not null default 1,
  frequency text not null default 'monthly',
  availability_lag_days integer not null default 0,        -- publication lag used in walk-forward history
  ref_mean numeric, ref_std numeric,                        -- anchor for short-history/manual series
  min_obs_for_z integer not null default 8,
  description text,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);
comment on table public.capex_indicator_defs is 'AI Capex Cycle Overlay: indicator registry. direction +1 means a higher value adds bust stress. Manual indicators are entered into capex_indicator_observations (is_manual=true); z-scores use own history once min_obs_for_z is reached, else ref_mean/ref_std, else skipped.';

create table public.capex_indicator_observations (
  indicator_code text not null references public.capex_indicator_defs(code) on update cascade,
  obs_date date not null,
  value numeric not null,
  is_manual boolean not null default false,
  note text,
  source_url text,
  created_at timestamptz not null default now(),
  primary key (indicator_code, obs_date)
);

create table public.capex_sec_financials (
  ticker text not null,
  metric text not null check (metric in ('capex','ocf','revenue','lt_debt_issued')),
  period_end date not null,           -- fiscal quarter end as filed
  cal_quarter_end date not null,      -- mapped to nearest calendar quarter end
  value_usd numeric not null,
  derived boolean not null default false, -- true = differenced from YTD cumulative filings
  xbrl_tag text,
  filed date,
  updated_at timestamptz not null default now(),
  primary key (ticker, metric, period_end)
);
comment on table public.capex_sec_financials is 'Single-quarter hyperscaler cash-flow items pulled from SEC XBRL companyconcept API (MSFT, GOOGL, AMZN, META, ORCL). Quarter values are derived from YTD cumulative filings where only YTD is reported.';

create table public.capex_scenarios (
  code text primary key,
  label text not null,
  description text,
  prior numeric not null check (prior > 0 and prior < 1),
  bucket_multipliers jsonb not null,  -- {equity, ai_semis, credit, long_bonds, gold, bitcoin, cash}
  sort_order integer not null default 100,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.capex_evidence_rules (
  code text primary key,
  label text not null,
  description text,
  signal_key text not null,
  operator text not null check (operator in ('>','<','>=','<=')),
  threshold numeric not null,
  likelihoods jsonb not null,          -- P(evidence fires | scenario), keyed by scenario code
  correlation_group text not null,     -- fired rules in one group are combined by geometric mean (no double counting)
  weight numeric not null default 1 check (weight >= 0 and weight <= 1),  -- tempering exponent for data quality
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);
comment on table public.capex_evidence_rules is 'Pre-registered likelihoods. Posterior is recomputed from the base prior each run from the CURRENT evidence state (not recursively), so persistent evidence does not compound day after day. Non-firing rules are treated as uninformative.';

create table public.capex_model_config (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);

create table public.capex_cycle_readings (
  reading_date date primary key,
  is_backfill boolean not null default false,
  pillar_intensity numeric, pillar_financing numeric, pillar_returns numeric,
  pillar_overcapacity numeric, pillar_market numeric,
  ccsi numeric,                       -- Capex Cycle Stress Index (weighted pillar z)
  signals jsonb,                      -- raw signal values used by triggers/evidence
  triggers jsonb,                     -- {code: bool}
  trigger_count integer,
  peak_hazard_12m numeric,            -- logistic hazard of AI-equity peak within 12m (uncalibrated; informational only)
  regime_key text check (regime_key in ('boom','blowoff','correction','turn','bust','deployment')),
  regime_confidence integer,
  indicator_z jsonb,                  -- {code: {value, z, signed_z, obs_date}}
  coverage jsonb,                     -- {pillar: n_indicators_used}
  fired_evidence jsonb,
  posteriors jsonb,
  bucket_multipliers jsonb,
  equity_multiplier numeric,
  ai_semis_multiplier numeric,
  shadow_mode boolean not null default true,
  computed_at timestamptz not null default now()
);
comment on table public.capex_cycle_readings is 'AI Capex Cycle Overlay output, one row per day (live) or month-end (is_backfill, walk-forward with publication lags). This row doubles as the forecast log for later calibration scoring.';

create table public.capex_bucket_symbol_map (
  symbol text primary key,
  bucket text not null check (bucket in ('equity','ai_semis','credit','long_bonds','gold','bitcoin','cash')),
  note text
);

create or replace view public.capex_overlay_symbol_multipliers
with (security_invoker = true) as
select m.symbol, m.bucket, r.reading_date,
       coalesce((r.bucket_multipliers ->> m.bucket)::numeric, 1) as exposure_multiplier,
       r.regime_key, r.ccsi, r.peak_hazard_12m, r.shadow_mode
from public.capex_bucket_symbol_map m
cross join lateral (
  select * from public.capex_cycle_readings where not is_backfill order by reading_date desc limit 1
) r;
comment on view public.capex_overlay_symbol_multipliers is 'Latest capex-overlay exposure multiplier per symbol. Merged (downside-only) with asset_resize_signals.exposure_multiplier by lib/capexOverlay.js once shadow_mode is off.';

-- RLS: read for authenticated; writes via service role (edge function). Manual observations writable by authenticated.
alter table public.capex_indicator_defs enable row level security;
alter table public.capex_indicator_observations enable row level security;
alter table public.capex_sec_financials enable row level security;
alter table public.capex_scenarios enable row level security;
alter table public.capex_evidence_rules enable row level security;
alter table public.capex_model_config enable row level security;
alter table public.capex_cycle_readings enable row level security;
alter table public.capex_bucket_symbol_map enable row level security;
create policy capex_defs_read on public.capex_indicator_defs for select to authenticated using (true);
create policy capex_obs_read on public.capex_indicator_observations for select to authenticated using (true);
create policy capex_obs_manual_insert on public.capex_indicator_observations for insert to authenticated with check (is_manual = true);
create policy capex_obs_manual_update on public.capex_indicator_observations for update to authenticated using (is_manual = true) with check (is_manual = true);
create policy capex_sec_read on public.capex_sec_financials for select to authenticated using (true);
create policy capex_scen_read on public.capex_scenarios for select to authenticated using (true);
create policy capex_scen_update on public.capex_scenarios for update to authenticated using (true) with check (true);
create policy capex_rules_read on public.capex_evidence_rules for select to authenticated using (true);
create policy capex_cfg_read on public.capex_model_config for select to authenticated using (true);
create policy capex_read_readings on public.capex_cycle_readings for select to authenticated using (true);
create policy capex_map_read on public.capex_bucket_symbol_map for select to authenticated using (true);

-- ───────────────────────── seed: indicators ─────────────────────────
insert into public.capex_indicator_defs (code,label,pillar,source,source_key,unit,direction,weight,frequency,availability_lag_days,min_obs_for_z,sort_order,description) values
-- Intensity: how stretched spending is
('hs_capex_to_ocf','Hyperscaler capex / operating cash flow (TTM)','intensity','sec','MSFT,GOOGL,AMZN,META,ORCL','ratio',1,1.25,'quarterly',45,8,10,'Share of operating cash flow consumed by capex across the 5 hyperscalers. Above ~0.9 means the build is outrunning internal funding. Cash PP&E only: excludes finance-lease capex (material for MSFT/META), so understates true capex.'),
('hs_capex_yoy','Hyperscaler capex growth YoY (TTM)','intensity','sec','MSFT,GOOGL,AMZN,META,ORCL','%',1,1,'quarterly',45,8,20,'Year-over-year growth of trailing-12m hyperscaler capex. Its second derivative drives the capex-deceleration trigger. Cash PP&E only: excludes finance-lease capex (material for MSFT/META), so understates true capex.'),
('it_invest_gdp','IT equipment + software investment % GDP','intensity','fred','Y033RC1Q027SBEA+B985RC1Q027SBEA/GDP','% GDP',1,1,'quarterly',60,8,30,'Economy-wide tech investment intensity (BEA). The only intensity series that spans the 2000 bust, used for historical verification.'),
('dc_construction_yoy','Data center construction spending YoY','intensity','manual',null,'%',1,0.75,'monthly',30,4,40,'Manual: Census construction spending (data center subcategory) or industry trackers.'),
-- Financing: is funding getting weirder
('hy_oas','HY credit spread (OAS)','financing','fred','BAMLH0A0HYM2','%',1,1,'daily',1,8,110,'ICE BofA US High Yield OAS. Note: FRED limits ICE BofA history to ~3 years, so its z-score window is short.'),
('baa_spread','Moody''s Baa − 10Y Treasury spread','financing','fred','BAA10Y','%',1,0.75,'daily',1,8,112,'Long-history credit spread (1986+). Backstops HY OAS, whose FRED history is capped at ~3 years by ICE licensing.'),
('bizd_drawdown','BDC index drawdown from 52w high','financing','yahoo','BIZD','%',-1,1,'daily',1,8,120,'Private-credit stress proxy (BIZD). More negative = more stress.'),
('hs_debt_to_capex','Hyperscaler LT debt issuance / capex (TTM)','financing','sec','MSFT,GOOGL,AMZN,META,ORCL','ratio',1,1,'quarterly',45,8,130,'Share of capex funded by new long-term debt. Excludes off-balance-sheet SPVs and leases (see manual indicator).'),
('corp_bond_debt_yoy','Nonfinancial corporate debt securities YoY','financing','fred','NCBDBIQ027S','%',1,0.75,'quarterly',75,8,140,'Fed Z.1 nonfinancial corporate debt securities growth.'),
('sloos_ci_tightening','SLOOS: net % banks tightening C&I standards','financing','fred','DRTSCILM','%',1,0.75,'quarterly',30,8,150,'Senior Loan Officer survey.'),
('offbs_ai_financing_bn','Off-balance-sheet AI financing (SPVs, leases, vendor)','financing','manual',null,'$bn TTM',1,1,'quarterly',45,4,160,'Manual: SPV/JV data-center financings, GPU-backed loans, vendor/circular financing announced in trailing 12m.'),
-- Returns: is the money earning its keep
('hs_fcf_margin','Hyperscaler FCF margin after capex (TTM)','returns','sec','MSFT,GOOGL,AMZN,META,ORCL','%',-1,1.25,'quarterly',45,8,210,'(OCF - capex) / revenue. Falling FCF margin = capex outrunning monetization. Cash PP&E only: excludes finance-lease capex (material for MSFT/META), so understates true capex.'),
('hs_capex_to_revenue','Hyperscaler capex / revenue (TTM)','returns','sec','MSFT,GOOGL,AMZN,META,ORCL','%',1,1,'quarterly',45,8,220,'Capital intensity of the hyperscaler business model. Cash PP&E only: excludes finance-lease capex (material for MSFT/META), so understates true capex.'),
('ai_revenue_to_capex','AI revenue / AI capex run-rate','returns','manual',null,'ratio',-1,1.25,'quarterly',45,4,230,'Manual: disclosed AI revenue run-rates vs AI capex. The Sequoia "$600B question" gap.'),
-- Overcapacity: supply outrunning demand
('gpu_rental_yoy','GPU rental price YoY (H100/B200 $/hr)','overcapacity','manual',null,'%',-1,1.5,'monthly',7,4,310,'Manual: GPU-hour rental index. Collapsing rental prices are the cleanest overcapacity tell.'),
('semis_inv_ship_ratio','Computers & electronics inventories/shipments','overcapacity','fred','A34SIS','ratio',1,0.75,'monthly',45,8,320,'Census M3 inventory-to-shipments ratio for NAICS 334.'),
('dc_vacancy','Primary-market data center vacancy','overcapacity','manual',null,'%',1,1,'semiannual',30,4,330,'Manual: CBRE/JLL data center vacancy. Record lows = tight; a turn up signals overbuild.'),
('dram_price_yoy','DRAM contract price YoY','overcapacity','manual',null,'%',-1,0.75,'monthly',15,4,340,'Manual: memory pricing. Falling prices = oversupply.'),
-- Market: are prices assuming perfection
('spy_rsp_ratio','Cap-weight / equal-weight S&P (SPY/RSP)','market','yahoo','SPY/RSP','ratio',1,1,'daily',1,8,410,'Index concentration. Rising = narrow, mega-cap-led market.'),
('smh_spy_rel_12m','Semis vs S&P 12m relative return','market','yahoo','SMH/SPY','%',1,1,'daily',1,8,420,'AI-beneficiary euphoria gauge.'),
('margin_debt_yoy','FINRA margin debt YoY','market','manual',null,'%',1,0.75,'monthly',25,4,430,'Manual: FINRA margin statistics.'),
('sp500_fwd_pe','S&P 500 forward P/E','market','manual',null,'x',1,0.75,'monthly',1,4,440,'Manual: forward P/E.'),
-- Aux (signals only, not in CCSI)
('aux_dgs10','10Y Treasury yield','aux','fred','DGS10','%',1,0,'daily',1,8,900,'Used by rate-shock evidence rules; not part of CCSI.'),
('aux_nasdaqcom','NASDAQ Composite','aux','fred','NASDAQCOM','index',1,0,'daily',1,8,910,'Used for historical verification only.');

-- ───────────────────────── seed: config ─────────────────────────
insert into public.capex_model_config (key, value, description) values
('pillar_weights','{"intensity":0.25,"financing":0.25,"returns":0.20,"overcapacity":0.15,"market":0.15}','CCSI = weighted average of available pillar z-scores (weights renormalized over pillars with data).'),
('z_window_years','10','Rolling window for indicator z-scores.'),
('trigger_thresholds','{"capex_decel_pp":-10,"hy_widen_bp":75,"bdc_drawdown_pct":-15,"fcf_margin_floor_pct":5,"fcf_margin_drop_pp":-5,"gpu_rental_yoy_pct":-30}','Rate-of-change triggers. Capex busts start when growth rolls over and funding shifts outward, not when levels peak.'),
('hazard_model','{"intercept":-2.5,"b_ccsi":0.8,"b_triggers":0.7,"calibrated":false,"in_sample_brier":0.193,"climatology_brier":0.168,"note":"2012-2026 walk-forward: hazard underperforms base rate for SMH 20% drawdowns; informational only, not used in multipliers."}','Logistic hazard of an AI-equity peak within 12m. JUDGMENTAL priors until capex-cycle-backtest calibrates them.'),
('regime_thresholds','{"blowoff_ccsi":0.75,"turn_ccsi":0.5,"turn_min_triggers":2,"bust_smh_drawdown_pct":-30,"bust_min_triggers":3,"deployment_ccsi":-0.5,"capex_stall_yoy_pct":10}','Rule-based cycle regime. turn/bust require hyperscaler TTM capex growth < capex_stall_yoy_pct (capex actually stalling); trigger clusters while capex still grows are classified as correction (neutral multipliers). Evidence: 2016/2018/2022/2025 trigger clusters with capex +22-55% YoY were all cyclical corrections followed by strong 12m returns.'),
('regime_multipliers','{"boom":{},"blowoff":{},"correction":{},"turn":{"equity":0.85,"ai_semis":0.75,"credit":0.8},"bust":{"equity":0.75,"ai_semis":0.6,"credit":0.7},"deployment":{}}','Tactical where-we-are adjustment layered on the strategic scenario blend. Missing bucket = 1.0.'),
('multiplier_clamp','{"min":0.4,"max":1.5}','Bounds on any final bucket multiplier.'),
('shadow_mode','true','When true, readings are computed and logged but NOT applied to portfolio targets.'),
('backfill_start','"2012-01-31"','First month-end for walk-forward history.');

-- ───────────────────────── seed: scenarios ─────────────────────────
insert into public.capex_scenarios (code,label,description,prior,bucket_multipliers,sort_order) values
('H1_BLOWOFF_THEN_BEAR','Blow-off, then secular bear','Capex and liquidity push a final melt-up; peak 2H27–1H28; multi-year bear after. Near-term posture: stay invested, trim credit.',0.45,'{"equity":1.00,"ai_semis":1.05,"credit":0.85,"long_bonds":0.90,"gold":1.00,"bitcoin":1.00,"cash":1.00}',1),
('H2_PRODUCTIVITY_BULL','Durable productivity bull','AI revenue catches capex; ROIC stays above WACC; deployment without a crash.',0.20,'{"equity":1.10,"ai_semis":1.15,"credit":1.00,"long_bonds":0.90,"gold":0.90,"bitcoin":1.05,"cash":0.80}',2),
('H3_EARLY_BUST','Early bust (2026–27)','Capex growth rolls over and credit cracks before any blow-off; the turn comes now.',0.20,'{"equity":0.70,"ai_semis":0.50,"credit":0.60,"long_bonds":1.25,"gold":1.15,"bitcoin":0.70,"cash":1.50}',3),
('H4_RATE_SHOCK','Rate shock / multiple compression','10Y grinds toward fair value (~6%); multiples compress without a capex collapse.',0.15,'{"equity":0.80,"ai_semis":0.75,"credit":0.75,"long_bonds":0.60,"gold":1.15,"bitcoin":0.85,"cash":1.40}',4);

-- ───────────────────────── seed: evidence rules ─────────────────────────
insert into public.capex_evidence_rules (code,label,signal_key,operator,threshold,likelihoods,correlation_group,description) values
('E_capex_accel','Capex still accelerating','hs_capex_yoy_chg_2q','>',5,'{"H1_BLOWOFF_THEN_BEAR":0.70,"H2_PRODUCTIVITY_BULL":0.50,"H3_EARLY_BUST":0.20,"H4_RATE_SHOCK":0.35}','capex','TTM capex growth up >5pp vs 2 quarters ago.'),
('E_capex_decel','Capex growth rolling over','hs_capex_yoy_chg_2q','<',-10,'{"H1_BLOWOFF_THEN_BEAR":0.35,"H2_PRODUCTIVITY_BULL":0.25,"H3_EARLY_BUST":0.70,"H4_RATE_SHOCK":0.40}','capex','TTM capex growth down >10pp vs 2 quarters ago.'),
('E_hy_tight','HY spreads tight','hy_oas','<',3.25,'{"H1_BLOWOFF_THEN_BEAR":0.60,"H2_PRODUCTIVITY_BULL":0.60,"H3_EARLY_BUST":0.20,"H4_RATE_SHOCK":0.35}','credit',null),
('E_credit_widening','HY spreads widening fast','hy_oas_chg_3m_bp','>',75,'{"H1_BLOWOFF_THEN_BEAR":0.25,"H2_PRODUCTIVITY_BULL":0.10,"H3_EARLY_BUST":0.70,"H4_RATE_SHOCK":0.45}','credit','3-month HY OAS change > +75bp.'),
('E_bdc_stress','Private credit (BDC) stress','bizd_drawdown','<',-15,'{"H1_BLOWOFF_THEN_BEAR":0.30,"H2_PRODUCTIVITY_BULL":0.10,"H3_EARLY_BUST":0.65,"H4_RATE_SHOCK":0.40}','credit','BIZD >15% below 52w high.'),
('E_fcf_squeeze','Hyperscaler FCF squeeze','hs_fcf_margin','<',5,'{"H1_BLOWOFF_THEN_BEAR":0.45,"H2_PRODUCTIVITY_BULL":0.20,"H3_EARLY_BUST":0.65,"H4_RATE_SHOCK":0.35}','returns','FCF after capex below 5% of revenue.'),
('E_fcf_healthy','Hyperscaler FCF healthy','hs_fcf_margin','>',15,'{"H1_BLOWOFF_THEN_BEAR":0.50,"H2_PRODUCTIVITY_BULL":0.70,"H3_EARLY_BUST":0.25,"H4_RATE_SHOCK":0.45}','returns',null),
('E_concentration_extreme','Extreme index concentration','spy_rsp_z','>',1.5,'{"H1_BLOWOFF_THEN_BEAR":0.70,"H2_PRODUCTIVITY_BULL":0.40,"H3_EARLY_BUST":0.45,"H4_RATE_SHOCK":0.35}','market','SPY/RSP ratio z-score > 1.5.'),
('E_semis_euphoria','Semis euphoria','smh_spy_rel_12m','>',25,'{"H1_BLOWOFF_THEN_BEAR":0.70,"H2_PRODUCTIVITY_BULL":0.45,"H3_EARLY_BUST":0.25,"H4_RATE_SHOCK":0.25}','market','SMH beat SPY by >25pp over 12m.'),
('E_semis_trend_break','Semis trend break','smh_vs_200dma','<',0,'{"H1_BLOWOFF_THEN_BEAR":0.30,"H2_PRODUCTIVITY_BULL":0.25,"H3_EARLY_BUST":0.65,"H4_RATE_SHOCK":0.50}','market','SMH below its 200-day average.'),
('E_10y_high','10Y yield above 5%','dgs10','>',5.0,'{"H1_BLOWOFF_THEN_BEAR":0.30,"H2_PRODUCTIVITY_BULL":0.25,"H3_EARLY_BUST":0.35,"H4_RATE_SHOCK":0.75}','rates',null),
('E_10y_rising','10Y yield rising fast','dgs10_chg_3m_bp','>',50,'{"H1_BLOWOFF_THEN_BEAR":0.35,"H2_PRODUCTIVITY_BULL":0.30,"H3_EARLY_BUST":0.35,"H4_RATE_SHOCK":0.70}','rates','3-month 10Y change > +50bp.'),
('E_gpu_price_collapse','GPU rental prices collapsing','gpu_rental_yoy','<',-30,'{"H1_BLOWOFF_THEN_BEAR":0.35,"H2_PRODUCTIVITY_BULL":0.20,"H3_EARLY_BUST":0.70,"H4_RATE_SHOCK":0.35}','overcapacity','Manual series.'),
('E_ccsi_high','Composite stress elevated','ccsi','>',1.0,'{"H1_BLOWOFF_THEN_BEAR":0.60,"H2_PRODUCTIVITY_BULL":0.30,"H3_EARLY_BUST":0.60,"H4_RATE_SHOCK":0.40}','stress',null),
('E_ccsi_low','Composite stress low','ccsi','<',0,'{"H1_BLOWOFF_THEN_BEAR":0.35,"H2_PRODUCTIVITY_BULL":0.60,"H3_EARLY_BUST":0.20,"H4_RATE_SHOCK":0.40}','stress',null);

-- ───────────────────────── seed: symbol → bucket ─────────────────────────
insert into public.capex_bucket_symbol_map (symbol,bucket) values
('VT','equity'),('VTI','equity'),('SPY','equity'),('RSP','equity'),('VXUS','equity'),('VWO','equity'),
('QQQ','ai_semis'),('SMH','ai_semis'),
('HYG','credit'),('BKLN','credit'),('BIZD','credit'),
('TLT','long_bonds'),('IEF','long_bonds'),
('GLD','gold'),('GLDM','gold'),
('FBTC','bitcoin'),('BTC','bitcoin'),('BTC-USD','bitcoin'),
('USFR','cash'),('VTIP','cash');

-- ───────────────────────── schedule ─────────────────────────
-- compute-capex-cycle has verify_jwt=true; the job reuses the Authorization header
-- already stored on the sync-market-data job so no key is written into this file.
select cron.schedule('compute-capex-cycle-daily', '20 6 * * *',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/compute-capex-cycle', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 300000); $f$,
         (select substring(command from 'Bearer [A-Za-z0-9._-]+') from cron.job where jobname = 'sync-market-data-every-15-min')));

-- One-time backfill after first deploy (not scheduled):
--   POST /functions/v1/compute-capex-cycle?backfill=1
-- Also backfilled SPY, RSP, SMH, BIZD, HYG, BKLN, IEF into asset_price_history via
--   backfill-asset-price-history?symbols=SPY,RSP,SMH,BIZD,HYG,BKLN,IEF
