alter table portfolios drop constraint portfolios_strategy_framework_check;
alter table portfolios add constraint portfolios_strategy_framework_check
  check (strategy_framework = ANY (ARRAY['static'::text, 'tactical'::text, 'regime_driven'::text, 'resize_overlay'::text]));
