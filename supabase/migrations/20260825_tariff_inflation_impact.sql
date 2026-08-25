-- Tariff Inflation Impact: tracks US tariffs on Canada/China/Mexico/EU as a new
-- Supply Chain category, and feeds a composite estimated-CPI-impact figure into
-- the Forward Signal inflation vote (via macro_indicators.metadata.change3m_pp,
-- read by the existing usePP3m/getPP3m machinery in all three vote files).

alter table public.supply_chain_items add column if not exists tariff_cpi_impact_pp numeric;
alter table public.supply_chain_snapshots add column if not exists tariff_cpi_impact_pp numeric;

insert into public.supply_chain_items (key, name, category, is_active, sort_order, china_exposed, risk_type)
values
  ('tariff_china',  'Tariffs — China',  'Tariffs', true, 50, true,  'structural'),
  ('tariff_canada', 'Tariffs — Canada', 'Tariffs', true, 51, false, 'structural'),
  ('tariff_mexico', 'Tariffs — Mexico', 'Tariffs', true, 52, false, 'structural'),
  ('tariff_eu',     'Tariffs — EU',     'Tariffs', true, 53, false, 'structural')
on conflict (key) do nothing;
