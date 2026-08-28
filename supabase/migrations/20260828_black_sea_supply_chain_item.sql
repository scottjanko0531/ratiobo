-- Black Sea shipping corridor: >90% of Russia's Azov-Black Sea grain export
-- capacity offline after Ukrainian strikes (Aug 2026), 57+ merchant ships hit
-- by Russian missiles/drones in July alone, both sides now targeting maritime
-- logistics directly. Live, active disruption to grain/steel/mining exports —
-- an omission next to the existing Bab-el-Mandeb/Hormuz/Malacca chokepoints.

insert into public.supply_chain_items (key, name, category, is_active, sort_order, china_exposed, risk_type)
values
  ('black-sea', 'Black Sea (grain, steel, mining exports)', 'Energy and maritime chokepoints', true, 34, false, 'active')
on conflict (key) do nothing;
