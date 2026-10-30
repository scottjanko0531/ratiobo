-- Regime Tilt Recalibration Phase 3: the regime_shadow_divergence view
-- picks up the new phase3 lane, as anticipated in its own prior
-- migration's comment ("Add a 4th join + 3 more columns when phase3
-- lands").

create or replace view regime_shadow_divergence
  with (security_invoker = true) as
select
  live.snapshot_date, live.portfolio_id,
  live.regime_key as live_regime_key, legacy.regime_key as legacy_regime_key,
  phase2.regime_key as phase2_regime_key, phase3.regime_key as phase3_regime_key,
  regime_shadow_weight_distance(live.target_allocations, legacy.target_allocations) as live_vs_legacy,
  regime_shadow_weight_distance(live.target_allocations, phase2.target_allocations) as live_vs_phase2,
  regime_shadow_weight_distance(legacy.target_allocations, phase2.target_allocations) as legacy_vs_phase2,
  regime_shadow_weight_distance(live.target_allocations, phase3.target_allocations) as live_vs_phase3,
  regime_shadow_weight_distance(legacy.target_allocations, phase3.target_allocations) as legacy_vs_phase3,
  regime_shadow_weight_distance(phase2.target_allocations, phase3.target_allocations) as phase2_vs_phase3
from regime_shadow_targets live
join regime_shadow_targets legacy on legacy.snapshot_date = live.snapshot_date and legacy.portfolio_id = live.portfolio_id and legacy.lane = 'legacy'
join regime_shadow_targets phase2 on phase2.snapshot_date = live.snapshot_date and phase2.portfolio_id = live.portfolio_id and phase2.lane = 'phase2'
join regime_shadow_targets phase3 on phase3.snapshot_date = live.snapshot_date and phase3.portfolio_id = live.portfolio_id and phase3.lane = 'phase3'
where live.lane = 'live';

grant select on regime_shadow_divergence to authenticated;
