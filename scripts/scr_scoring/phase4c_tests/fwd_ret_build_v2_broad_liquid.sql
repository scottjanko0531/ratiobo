-- Extends scr_fwd_ret_mat_v2 (originally built in Phase 4c, scoped to the
-- a_v1_hist_ff12/b_v1 universes) to also cover broad_liquid's company-months,
-- for the exploratory value+momentum test's simulator run. Scott's decision:
-- rebuild properly rather than compute forward returns ad-hoc, since this is
-- "materially cheaper than the TTM fix -- price lookups + the already-
-- defined delisting rule, not point-in-time fundamentals matching."
--
-- Identical to fwd_ret_build.sql in every respect (delisting-to-BIL rule,
-- global price-frontier "fully observable" gate, one method for the whole
-- 2017-01..2026-10 period) -- the ONLY change is the `universe` CTE, which
-- now unions broad_liquid's membership alongside a_v1_hist_ff12/b_v1's.
--
-- Before running: scr_fwd_ret_mat_v2 was copied to scr_fwd_ret_mat_v2_backup
-- (134,518 rows) so the a_growth/profile_b-covered rows can be diffed
-- post-rebuild and confirmed unchanged.

drop table if exists scr_fwd_ret_mat_v2;

create table scr_fwd_ret_mat_v2 (
  company_id uuid not null,
  as_of_date date not null,
  ret_1m numeric,
  ret_3m numeric,
  ret_6m numeric,
  ret_12m numeric,
  ret_36m numeric,
  reached_10x_in_60m boolean,
  primary key (company_id, as_of_date)
);

with frontier as (
  select max(date) as price_frontier from scr_adjusted_prices
),
universe as (
  select distinct company_id, as_of_date
  from scr_scores
  where profile_version in ('a_v1_hist_ff12', 'b_v1')
    and as_of_date between '2017-01-31' and '2026-10-31'
  union
  select distinct company_id, as_of_date
  from scr_universe_membership
  where strategy = 'broad_liquid'
    and as_of_date between '2017-01-31' and '2026-10-31'
),
sec as (
  select id as company_id, delisted_date, final_price from scr_securities
),
base as (
  select
    u.company_id,
    u.as_of_date,
    scr_price_asof(u.company_id, u.as_of_date) as start_price,
    f.price_frontier,
    s.delisted_date,
    s.final_price
  from universe u
  left join sec s on s.company_id = u.company_id
  cross join frontier f
),
horizons as (
  select 1 as n_months, 'ret_1m' as col union all
  select 3, 'ret_3m' union all
  select 6, 'ret_6m' union all
  select 12, 'ret_12m' union all
  select 36, 'ret_36m'
),
computed as (
  select
    b.company_id,
    b.as_of_date,
    h.col,
    (b.as_of_date + (h.n_months || ' months')::interval)::date as target_date,
    case
      when b.start_price is null then null
      when b.delisted_date is not null and b.delisted_date <= (b.as_of_date + (h.n_months || ' months')::interval)::date then
        case
          when b.delisted_date < b.as_of_date then null
          else
            (
              coalesce(b.final_price, scr_price_asof(b.company_id, b.delisted_date)) / b.start_price
            ) * (
              scr_bil_price_asof((b.as_of_date + (h.n_months || ' months')::interval)::date)
              / nullif(scr_bil_price_asof(b.delisted_date), 0)
            ) - 1
        end
      when (b.as_of_date + (h.n_months || ' months')::interval)::date <= b.price_frontier then
        scr_price_asof(b.company_id, (b.as_of_date + (h.n_months || ' months')::interval)::date) / b.start_price - 1
      else null
    end as ret
  from base b
  cross join horizons h
),
pivoted as (
  select
    company_id, as_of_date,
    max(case when col = 'ret_1m' then ret end) as ret_1m,
    max(case when col = 'ret_3m' then ret end) as ret_3m,
    max(case when col = 'ret_6m' then ret end) as ret_6m,
    max(case when col = 'ret_12m' then ret end) as ret_12m,
    max(case when col = 'ret_36m' then ret end) as ret_36m
  from computed
  group by company_id, as_of_date
),
tenx as (
  select
    b.company_id, b.as_of_date,
    case
      when (b.as_of_date + interval '60 months')::date > (select max(date) from scr_adjusted_prices) then null
      else exists (
        select 1 from scr_adjusted_prices p
        where p.company_id = b.company_id
          and p.date > b.as_of_date
          and p.date <= (b.as_of_date + interval '60 months')::date
          and b.start_price > 0
          and p.adj_close >= 10 * b.start_price
      )
    end as reached_10x
  from base b
)
insert into scr_fwd_ret_mat_v2 (company_id, as_of_date, ret_1m, ret_3m, ret_6m, ret_12m, ret_36m, reached_10x_in_60m)
select p.company_id, p.as_of_date, p.ret_1m, p.ret_3m, p.ret_6m, p.ret_12m, p.ret_36m, t.reached_10x
from pivoted p
join tenx t on t.company_id = p.company_id and t.as_of_date = p.as_of_date;
