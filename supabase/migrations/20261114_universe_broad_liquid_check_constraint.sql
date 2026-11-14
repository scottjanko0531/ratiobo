-- scr_universe_membership.strategy had a check constraint allowing only
-- 'a_growth' and 'profile_b', predating the broad_liquid branch added in
-- 20261114_universe_broad_liquid.sql. Extend it to allow the new strategy.
alter table public.scr_universe_membership drop constraint scr_universe_membership_strategy_check;
alter table public.scr_universe_membership add constraint scr_universe_membership_strategy_check
  check (strategy = any (array['a_growth'::text, 'profile_b'::text, 'broad_liquid'::text]));
