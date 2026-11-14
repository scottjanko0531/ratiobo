-- Adds `broad_liquid` as a third hardcoded strategy branch in
-- scr_rebuild_universe_membership, same pattern as the existing a_growth /
-- profile_b branches. For the exploratory value+momentum factor test:
-- US common stocks (sic_code <> '6770', same exclusion as the other two
-- strategies) with point-in-time market cap >= $1B and 3-month average
-- daily dollar volume >= $5M. Deliberately no growth or value filter --
-- revenue_growth_yoy is left unfiltered (and may be null; broad_liquid
-- doesn't require revenue history the way a_growth does).
create or replace function public.scr_rebuild_universe_membership(p_from date, p_to date)
 returns table(strategy text, row_count bigint)
 language plpgsql
as $function$
begin
  delete from scr_universe_membership where as_of_date between p_from and p_to;

  return query
  with month_ends as (
    select (date_trunc('month', d) + interval '1 month - 1 day')::date as as_of_date
    from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') d
  ),
  companies as (
    select id as company_id, needs_review from scr_securities
    where sic_code is distinct from '6770'
  ),
  base as (
    select
      m.as_of_date,
      c.company_id,
      c.needs_review,
      price.close as price,
      shares.value as shares_outstanding,
      shares.period_end as shares_period_end,
      vol.avg_dollar_volume_3m,
      rev_cur.value as revenue_current,
      rev_cur.period_end as revenue_current_end,
      rev_prior.value as revenue_prior
    from month_ends m
    cross join companies c
    left join lateral (
      select p.close, p.date
      from scr_prices_daily p
      where p.company_id = c.company_id and p.date <= m.as_of_date and p.date > m.as_of_date - 7
      order by p.date desc limit 1
    ) price on true
    left join lateral (
      select f.value, f.period_end
      from scr_fundamentals f
      where f.company_id = c.company_id and f.metric = 'shares_outstanding' and f.filed_date <= m.as_of_date
      order by f.period_end desc limit 1
    ) shares on true
    left join lateral (
      select avg(p.close * p.volume) as avg_dollar_volume_3m
      from scr_prices_daily p
      where p.company_id = c.company_id and p.date <= m.as_of_date and p.date > m.as_of_date - interval '3 months'
    ) vol on true
    left join lateral (
      select f.value, f.period_end
      from scr_fundamentals f
      where f.company_id = c.company_id and f.metric = 'revenue' and f.filed_date <= m.as_of_date
      order by f.period_end desc limit 1
    ) rev_cur on true
    left join lateral (
      select f.value
      from scr_fundamentals f
      where f.company_id = c.company_id and f.metric = 'revenue' and f.filed_date <= m.as_of_date
        and f.period_end <= rev_cur.period_end - interval '11 months' and f.period_end >= rev_cur.period_end - interval '13 months'
      order by f.period_end desc limit 1
    ) rev_prior on true
    where price.close is not null and shares.value is not null and vol.avg_dollar_volume_3m is not null
  ),
  scored as (
    select
      as_of_date, company_id, needs_review, price, shares_outstanding, shares_period_end, avg_dollar_volume_3m,
      price * shares_outstanding as market_cap,
      case when revenue_prior is not null and revenue_prior <> 0
        then (revenue_current - revenue_prior) / abs(revenue_prior) else null end as revenue_growth_yoy
    from base
  ),
  inserted as (
    insert into scr_universe_membership (as_of_date, company_id, strategy, market_cap, avg_dollar_volume_3m, revenue_growth_yoy, price, shares_outstanding, shares_period_end, needs_review)
    select as_of_date, company_id, 'a_growth', market_cap, avg_dollar_volume_3m, revenue_growth_yoy, price, shares_outstanding, shares_period_end, needs_review
    from scored
    where market_cap >= 1e9 and avg_dollar_volume_3m >= 5e6 and revenue_growth_yoy >= 0.10
    union all
    select as_of_date, company_id, 'profile_b', market_cap, avg_dollar_volume_3m, revenue_growth_yoy, price, shares_outstanding, shares_period_end, needs_review
    from scored
    where market_cap >= 3e8 and market_cap <= 2e9 and avg_dollar_volume_3m >= 5e6
    union all
    select as_of_date, company_id, 'broad_liquid', market_cap, avg_dollar_volume_3m, revenue_growth_yoy, price, shares_outstanding, shares_period_end, needs_review
    from scored
    where market_cap >= 1e9 and avg_dollar_volume_3m >= 5e6
    returning scr_universe_membership.strategy
  )
  select i.strategy, count(*)::bigint as row_count
  from inserted i
  group by i.strategy;
end;
$function$;
