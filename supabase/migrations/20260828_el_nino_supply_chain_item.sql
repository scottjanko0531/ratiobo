-- El Niño 2026-27 (agricultural supply shock): NOAA/CPC August 2026 advisory puts
-- >90% odds of a very strong El Niño by winter 2026-27, with a real chance of
-- exceeding the 1950-record RONI threshold. WFP estimates ~49M additional people
-- pushed into acute food insecurity; USDA sees Australian wheat production down
-- ~19% (~9M mt) for 2026/27; Panama Canal draft restrictions already in effect.
-- New "Climate and agriculture" category, same pattern as "Tariffs" earlier.
--
-- Seeded with identity fields only — current_score/status/trend/summary/etc. are
-- left for the live Claude+web-search pipeline (update-supply-chain-risk) to fill
-- in immediately after this migration, same as every other tracked item, rather
-- than hand-writing an assessment that would just be overwritten by tomorrow's
-- cron run anyway.

insert into public.supply_chain_items (key, name, category, is_active, sort_order, china_exposed, risk_type)
values
  ('el-nino-2026-27', 'El Niño 2026-27 (agricultural supply shock)', 'Climate and agriculture', true, 60, false, 'active')
on conflict (key) do nothing;
