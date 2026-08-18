-- ============================================================
-- Macro Measurement Upgrade — Phase 1 (Privilege Panel)
-- Source: RatioBo Macro Measurement Upgrade Spec v2
-- Scoped to Phase 1 only — Phase 2 (Solvency) and Phase 3 (Dominance)
-- tables/columns/gauge8 are intentionally not created here.
-- ============================================================

create table if not exists public.swap_curve_observations (
  obs_date      date        not null,
  tenor_years   numeric     not null,
  swap_rate_pct numeric     not null,
  source        text        not null default 'chatham',
  created_at    timestamptz not null default now(),
  primary key (obs_date, tenor_years, source)
);

create table if not exists public.convenience_yield_observations (
  obs_date           date        not null,
  tenor_years        numeric     not null,
  swap_rate_pct      numeric,
  treasury_yield_pct numeric,
  convenience_bp     numeric     not null,
  is_proxy           boolean     not null default false,
  proxy_method       text,                       -- e.g. 'aaa_minus_dgs20'
  source             text        not null,
  created_at         timestamptz not null default now(),
  primary key (obs_date, tenor_years)
);

create index if not exists cy_obs_tenor_date_idx
  on public.convenience_yield_observations (tenor_years, obs_date desc);

-- Foreign official custody holdings (FRED WMTSECL1, weekly)  [1.3b]
create table if not exists public.foreign_custody_holdings (
  obs_date        date        not null primary key,
  treasury_bn     numeric     not null,
  change_13w_bn   numeric,
  change_52w_bn   numeric,
  source          text        not null default 'FRED:WMTSECL1',
  created_at      timestamptz not null default now()
);

-- Auction internals (Treasury Fiscal Data auctions_query)     [1.3c]
create table if not exists public.treasury_auction_results (
  auction_date                date    not null,
  cusip                       text    not null,
  security_type               text,
  security_term               text,
  total_tendered_bn           numeric,
  total_accepted_bn           numeric,
  indirect_accepted_bn        numeric,
  direct_accepted_bn          numeric,
  primary_dealer_accepted_bn  numeric,
  indirect_share_pct          numeric,
  dealer_share_pct            numeric,
  bid_to_cover_ratio          numeric,
  high_yield_pct              numeric,
  avg_med_yield_pct           numeric,
  dispersion_bp               numeric,   -- high_yield - avg_med_yield; a TAIL PROXY, not a tail
  created_at                  timestamptz not null default now(),
  primary key (auction_date, cusip)
);

create index if not exists auction_term_date_idx
  on public.treasury_auction_results (security_term, auction_date desc);

-- Stock/bond correlation (portfolio bridge)                   [1.3d]
create table if not exists public.stock_bond_correlation (
  obs_date      date        not null primary key,
  corr_30d      numeric,
  corr_90d      numeric,
  corr_180d     numeric,
  equity_symbol text        not null default 'SPY',
  bond_symbol   text        not null default 'TLT',
  created_at    timestamptz not null default now()
);

create table if not exists public.gold_rate_correlation (
  obs_date        date        not null primary key,
  corr_30d        numeric,
  corr_90d        numeric,
  corr_180d       numeric,
  real_yield_pct  numeric,
  gold_price      numeric,
  created_at      timestamptz not null default now()
);

-- ============================================================
-- Gauge 7 component columns (gauge8 / Phase 3 columns intentionally omitted)
-- ============================================================

alter table public.dalio_gauge_readings
  add column if not exists gauge7            numeric,
  add column if not exists z_conv_yield      numeric,
  add column if not exists z_cy_slope        numeric,
  add column if not exists z_official_share  numeric,
  add column if not exists z_custody         numeric,
  add column if not exists z_gold_real_corr  numeric,
  add column if not exists z_term_premium    numeric;
-- NOTE: z_indirect_bidder already exists on this table. Populate it; do not re-add.

-- Gauge 7's pairwise-component-correlation diagnostic (spec §1.5 requires
-- logging this every computation, since 3 of the grouped demand-side
-- components are all measuring foreign official demand from different
-- angles and will co-move). No jsonb/metadata column exists on
-- dalio_gauge_readings for this, so it gets its own small log table instead
-- of overloading a shared gauge table with a single gauge's diagnostic data.
create table if not exists public.gauge7_component_correlations (
  computed_at        timestamptz not null default now() primary key,
  matrix              jsonb       not null,
  max_abs_pair_corr   numeric,
  flagged             boolean     not null default false
);

alter table public.gauge7_component_correlations enable row level security;
create policy gauge7_component_correlations_read on public.gauge7_component_correlations
  for select to authenticated using (true);

-- ============================================================
-- RLS — match the pattern used by the other user-facing tables
-- ============================================================

alter table public.swap_curve_observations         enable row level security;
alter table public.convenience_yield_observations  enable row level security;
alter table public.foreign_custody_holdings        enable row level security;
alter table public.treasury_auction_results        enable row level security;
alter table public.stock_bond_correlation          enable row level security;
alter table public.gold_rate_correlation           enable row level security;

-- Reference/macro data is not user-scoped: readable by authenticated users,
-- writable only by service_role (edge functions, which bypass RLS).
do $$
declare t text;
begin
  foreach t in array array[
    'swap_curve_observations','convenience_yield_observations',
    'foreign_custody_holdings','treasury_auction_results',
    'stock_bond_correlation','gold_rate_correlation'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_read', t);
  end loop;
end $$;
