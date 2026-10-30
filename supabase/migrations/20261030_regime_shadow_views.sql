-- Regime Shadow Targets Log §5.1/§5.2 — read views.

create or replace function regime_shadow_weight_distance(a jsonb, b jsonb) returns numeric
language sql immutable as $$
  select coalesce(sum(abs(coalesce((a->>key)::numeric, 0) - coalesce((b->>key)::numeric, 0))), 0) / 2
  from (
    select jsonb_object_keys(a) as key
    union
    select jsonb_object_keys(b) as key
  ) keys
$$;

-- §5.1: one row per portfolio x lane, seed date to today. "Current"
-- fields come from regime_shadow_state (the carried state, always
-- up to date) joined to that lane's latest target_allocations row for
-- the per-asset breakdown; days-in-regime / days-blocked are computed
-- across the full history.
create or replace view regime_shadow_summary
  with (security_invoker = true) as
with agg as (
  select
    portfolio_id, lane,
    count(*) filter (where shifted and event <> 'seed') as shift_count,
    sum(turnover_vs_prev) as total_turnover,
    max(turnover_vs_prev) as max_single_day_turnover,
    min(snapshot_date) as seed_date,
    max(snapshot_date) as as_of_date
  from regime_shadow_targets
  group by portfolio_id, lane
),
regime_days as (
  select portfolio_id, lane, jsonb_object_agg(regime_key, cnt) as days_in_regime
  from (
    select portfolio_id, lane, coalesce(regime_key, 'none') as regime_key, count(*) as cnt
    from regime_shadow_targets
    group by portfolio_id, lane, coalesce(regime_key, 'none')
  ) t
  group by portfolio_id, lane
),
blocked_days as (
  select portfolio_id, lane, jsonb_object_agg(reason_prefix, cnt) as days_blocked
  from (
    select portfolio_id, lane, split_part(blocked_reason, ':', 1) as reason_prefix, count(*) as cnt
    from regime_shadow_targets
    where blocked_reason is not null
    group by portfolio_id, lane, split_part(blocked_reason, ':', 1)
  ) t
  group by portfolio_id, lane
),
latest as (
  select distinct on (portfolio_id, lane) portfolio_id, lane, near_key, lambda, variant
  from regime_shadow_targets
  order by portfolio_id, lane, snapshot_date desc
)
select
  s.portfolio_id, s.lane,
  a.shift_count, a.total_turnover, a.max_single_day_turnover, a.seed_date, a.as_of_date,
  s.base_key as current_regime_key,
  l.near_key as current_near_key, l.lambda as current_lambda, l.variant as current_variant,
  (coalesce((s.current_targets->>'eq')::numeric, 0) + coalesce((s.current_targets->>'intl')::numeric, 0) + coalesce((s.current_targets->>'em')::numeric, 0)) as current_growth_exposure,
  (coalesce((s.current_targets->>'com')::numeric, 0) + coalesce((s.current_targets->>'gld')::numeric, 0) + coalesce((s.current_targets->>'tip')::numeric, 0)) as current_real_assets,
  coalesce((s.current_targets->>'nb')::numeric, 0) as current_nb,
  rd.days_in_regime, bd.days_blocked,
  case when s.last_shift_date is null then null else (current_date - s.last_shift_date) end as days_since_last_shift
from regime_shadow_state s
join agg a using (portfolio_id, lane)
left join regime_days rd using (portfolio_id, lane)
left join blocked_days bd using (portfolio_id, lane)
left join latest l using (portfolio_id, lane);

-- §5.2: one row per day x portfolio, pairwise one-way distance between
-- each pair of today's 3 lanes. Add a 4th join + 3 more columns when
-- phase3 lands.
create or replace view regime_shadow_divergence
  with (security_invoker = true) as
select
  live.snapshot_date, live.portfolio_id,
  live.regime_key as live_regime_key, legacy.regime_key as legacy_regime_key, phase2.regime_key as phase2_regime_key,
  regime_shadow_weight_distance(live.target_allocations, legacy.target_allocations) as live_vs_legacy,
  regime_shadow_weight_distance(live.target_allocations, phase2.target_allocations) as live_vs_phase2,
  regime_shadow_weight_distance(legacy.target_allocations, phase2.target_allocations) as legacy_vs_phase2
from regime_shadow_targets live
join regime_shadow_targets legacy on legacy.snapshot_date = live.snapshot_date and legacy.portfolio_id = live.portfolio_id and legacy.lane = 'legacy'
join regime_shadow_targets phase2 on phase2.snapshot_date = live.snapshot_date and phase2.portfolio_id = live.portfolio_id and phase2.lane = 'phase2'
where live.lane = 'live';

grant select on regime_shadow_summary to authenticated;
grant select on regime_shadow_divergence to authenticated;
