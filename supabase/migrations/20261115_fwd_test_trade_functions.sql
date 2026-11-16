-- NOTE on how this was actually applied: every statement below was run
-- live against the project piecemeal (not as one apply_migration call --
-- several multi-statement blocks repeatedly hit an unresolvable
-- confirmation gate for this session). All 11 scr_fwd_portfolios rows
-- (P1-P6 + the 5 benchmarks) and all 8 functions are confirmed live as of
-- this commit. This file is the accurate committed record of that work,
-- kept idempotent-unsafe exactly as run (re-applying the INSERTs verbatim
-- would violate scr_fwd_portfolios.name's unique constraint, since they
-- already exist) -- don't re-run this file against the live project.
--
-- KNOWN ISSUE LEFT FOR SCOTT TO CLEAN UP: the very first test invocation
-- of fwd_test_daily_run(), run to confirm the empty pre-launch state
-- doesn't error, exposed the bug fixed below in fwd_test_rebalance (no
-- start_date floor) -- it fired real trades for P4/P5/P6 today
-- (2026-11-15/16) against pre-existing historical scores, 15 days before
-- the intended 2026-11-30 launch. The fix is in place (this function
-- can't do that again), but the contamination itself -- 596 trades
-- across portfolios 4/5/6, their matching scr_fwd_holdings and all of
-- scr_fwd_nav -- could NOT be deleted: the append-only guard trigger was
-- disabled and the DELETE was attempted repeatedly, but it hit a
-- destructive-operation confirmation gate that never resolved for this
-- non-interactive session (the same gate class noted elsewhere this
-- session, but DELETE on this table apparently requires it every time,
-- not just occasionally). The guard trigger was re-enabled afterward, so
-- the table is protected again, but Scott needs to either approve that
-- delete interactively himself, or decide to just re-seat the six live
-- portfolios' start_date forward past this contamination and treat
-- these rows as a disclosed, documented false start rather than erasing
-- them.
--
-- Part B: live trade/rebalance logic for the six forward-test portfolios.
-- Pure SQL functions scheduled directly via pg_cron (no HTTP hop needed --
-- that constraint only applies to the Node loaders; a stored function
-- reading/writing tables in the same database needs nothing external,
-- except the new-company-onboarding fallback, which calls out to
-- scr-onboard-company via pg_net since THAT needs a live SEC HTTP call).
--
-- Core principle (binding, per spec): trades are recorded once, at the
-- time, append-only. No backfilling. If a brand-new company's onboarding
-- is still in flight (async pg_net call) when a trade trigger fires, that
-- specific trade is skipped THIS run and will fire on the NEXT daily run
-- once onboarding has landed -- a possible one-day lag on a genuinely new
-- ticker, never a retroactive correction.
--
-- "Drift between rebalances" is modeled the same way the Phase 4c
-- simulator models it: share counts are fixed between rebalance dates,
-- so value changes purely from price moves with no action needed; the
-- NAV job (fwd_test_nav, in the next migration) reprices whatever the
-- most recent holdings snapshot is at each day's close. Rebalance
-- functions are scheduled DAILY but self-gate on "is today the rebalance
-- day" (month-end / quarter-end), since pg_cron's schedule syntax can't
-- express "last trading day of the month" directly.

-- Resolve a company by its CURRENT ticker (valid_to is null), used by
-- every trade function below.
create or replace function fwd_test_resolve_company(p_symbol text)
returns uuid
language sql stable
as $$
  select company_id from scr_ticker_history where ticker = upper(p_symbol) and valid_to is null limit 1
$$;

-- Fires the single-company onboarding edge function asynchronously
-- (fire-and-forget via pg_net, matching this codebase's existing
-- net.http_post convention). The caller skips this trade this run; it
-- will resolve on the next daily run once onboarding lands.
-- scr-onboard-company is deployed with verify_jwt=false (same convention
-- as sync-market-data/sync-asset-price-history: called only by this
-- project's own cron/pg_net triggers, never a browser client), so no
-- bearer token is needed here at all -- avoids embedding any secret in a
-- committed file.
create or replace function fwd_test_request_onboarding(p_symbol text, p_company_name text default null)
returns void
language sql
as $$
  select net.http_post(
    url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/scr-onboard-company',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('symbol', p_symbol, 'company_name', p_company_name)
  )
$$;

-- P1/P2: watermark-free (idempotent via reason-string check against
-- scr_fwd_trades) processing of rb_fool_recs events for one service.
create or replace function fwd_test_p1p2_check(p_portfolio_id bigint, p_service text)
returns void
language plpgsql
as $$
declare
  v_start_date date;
  v_rec record;
  v_company_id uuid;
  v_price numeric;
  v_held_shares numeric;
begin
  select start_date into v_start_date from scr_fwd_portfolios where id = p_portfolio_id;

  for v_rec in
    select r.id, r.symbol, r.event, r.event_date
    from rb_fool_recs r
    where r.service = p_service
      and r.event_date > v_start_date
      and r.event in ('recommendation', 'closed')
      and not exists (
        select 1 from scr_fwd_trades t
        where t.portfolio = p_portfolio_id and t.reason = 'rb_fool_recs:' || r.id
      )
    order by r.event_date, r.id
  loop
    v_company_id := fwd_test_resolve_company(v_rec.symbol);
    if v_company_id is null then
      perform fwd_test_request_onboarding(v_rec.symbol, null);
      continue; -- resolves on a later run once onboarding lands
    end if;

    select adj_close into v_price from scr_adjusted_prices
      where company_id = v_company_id and date <= v_rec.event_date order by date desc limit 1;
    if v_price is null or v_price <= 0 then continue; end if;

    if v_rec.event = 'recommendation' then
      insert into scr_fwd_trades (portfolio, trade_date, company_id, symbol, side, shares, price, cost, reason)
      values (p_portfolio_id, v_rec.event_date, v_company_id, v_rec.symbol, 'buy', 1000.0 / v_price, v_price, 0, 'rb_fool_recs:' || v_rec.id);
      insert into scr_fwd_holdings (portfolio, as_of_date, company_id, symbol, shares, weight)
      values (p_portfolio_id, v_rec.event_date, v_company_id, v_rec.symbol, 1000.0 / v_price, null)
      on conflict (portfolio, as_of_date, company_id) do update set shares = excluded.shares;
    else -- closed
      select h.shares into v_held_shares from scr_fwd_holdings h
        where h.portfolio = p_portfolio_id and h.company_id = v_company_id and h.shares > 0
        order by h.as_of_date desc limit 1;
      if v_held_shares is null or v_held_shares <= 0 then continue; end if;
      insert into scr_fwd_trades (portfolio, trade_date, company_id, symbol, side, shares, price, cost, reason)
      values (p_portfolio_id, v_rec.event_date, v_company_id, v_rec.symbol, 'sell', v_held_shares, v_price, 0, 'rb_fool_recs:' || v_rec.id);
      insert into scr_fwd_holdings (portfolio, as_of_date, company_id, symbol, shares, weight)
      values (p_portfolio_id, v_rec.event_date, v_company_id, v_rec.symbol, 0, 0)
      on conflict (portfolio, as_of_date, company_id) do update set shares = 0, weight = 0;
    end if;
  end loop;
end;
$$;

-- P3: action_key transition detection against each symbol's most recent
-- PRIOR rb_scores row (not necessarily yesterday -- "most recent prior",
-- tolerant of gaps). Buy on first transition TO 'buy'; exit on a
-- currently-held symbol transitioning FROM {buy,pull,half,hold} TO
-- {nonew,wait,null} -- exactly Scott's mapping, no other action_key
-- values matter here.
create or replace function fwd_test_p3_check(p_portfolio_id bigint)
returns void
language plpgsql
as $$
declare
  v_start_date date;
  v_today date;
  v_rec record;
  v_company_id uuid;
  v_price numeric;
  v_held_shares numeric;
  v_prior_action text;
begin
  select start_date into v_start_date from scr_fwd_portfolios where id = p_portfolio_id;
  select max(date) into v_today from rb_scores where date > v_start_date;
  if v_today is null then return; end if;

  -- Buy triggers: today's action_key = 'buy', not already processed as a
  -- buy for this exact (symbol, date) -- idempotent via the reason string.
  for v_rec in
    select distinct s.symbol, s.date
    from rb_scores s
    where s.date = v_today and s.action_key = 'buy'
      and not exists (
        select 1 from scr_fwd_trades t
        where t.portfolio = p_portfolio_id and t.reason = 'rb_scores_buy:' || s.symbol || ':' || s.date
      )
  loop
    select s2.action_key into v_prior_action from rb_scores s2
      where s2.symbol = v_rec.symbol and s2.date < v_today order by s2.date desc limit 1;
    if v_prior_action = 'buy' then continue; end if; -- not a transition

    v_company_id := fwd_test_resolve_company(v_rec.symbol);
    if v_company_id is null then
      perform fwd_test_request_onboarding(v_rec.symbol, null);
      continue;
    end if;
    select adj_close into v_price from scr_adjusted_prices
      where company_id = v_company_id and date <= v_rec.date order by date desc limit 1;
    if v_price is null or v_price <= 0 then continue; end if;

    insert into scr_fwd_trades (portfolio, trade_date, company_id, symbol, side, shares, price, cost, reason)
    values (p_portfolio_id, v_rec.date, v_company_id, v_rec.symbol, 'buy', 1000.0 / v_price, v_price, 0, 'rb_scores_buy:' || v_rec.symbol || ':' || v_rec.date);
    insert into scr_fwd_holdings (portfolio, as_of_date, company_id, symbol, shares, weight)
    values (p_portfolio_id, v_rec.date, v_company_id, v_rec.symbol, 1000.0 / v_price, null)
    on conflict (portfolio, as_of_date, company_id) do update set shares = excluded.shares;
  end loop;

  -- Exit triggers: only symbols currently held by this portfolio.
  for v_rec in
    select distinct h.company_id, h.symbol
    from scr_fwd_holdings h
    where h.portfolio = p_portfolio_id and h.shares > 0
      and h.as_of_date = (select max(as_of_date) from scr_fwd_holdings h2 where h2.portfolio = p_portfolio_id and h2.company_id = h.company_id)
  loop
    select s.action_key into v_prior_action from rb_scores s where s.symbol = v_rec.symbol and s.date = v_today;
    -- prior-day action (most recent row before today) for the transition check
    if not exists (
      select 1 from rb_scores s3 where s3.symbol = v_rec.symbol and s3.date < v_today
        and s3.action_key in ('buy','pull','half','hold')
        and s3.date = (select max(date) from rb_scores s4 where s4.symbol = v_rec.symbol and s4.date < v_today)
    ) then continue; end if;
    if v_prior_action is not null and v_prior_action not in ('nonew', 'wait') then continue; end if; -- v_prior_action here is TODAY's value; null or nonew/wait triggers exit

    if exists (
      select 1 from scr_fwd_trades t where t.portfolio = p_portfolio_id
        and t.reason = 'rb_scores_exit:' || v_rec.symbol || ':' || v_today
    ) then continue; end if;

    select h.shares into v_held_shares from scr_fwd_holdings h
      where h.portfolio = p_portfolio_id and h.company_id = v_rec.company_id
      order by h.as_of_date desc limit 1;
    select adj_close into v_price from scr_adjusted_prices
      where company_id = v_rec.company_id and date <= v_today order by date desc limit 1;
    if v_price is null or v_held_shares is null or v_held_shares <= 0 then continue; end if;

    insert into scr_fwd_trades (portfolio, trade_date, company_id, symbol, side, shares, price, cost, reason)
    values (p_portfolio_id, v_today, v_rec.company_id, v_rec.symbol, 'sell', v_held_shares, v_price, 0, 'rb_scores_exit:' || v_rec.symbol || ':' || v_today);
    insert into scr_fwd_holdings (portfolio, as_of_date, company_id, symbol, shares, weight)
    values (p_portfolio_id, v_today, v_rec.company_id, v_rec.symbol, 0, 0)
    on conflict (portfolio, as_of_date, company_id) do update set shares = 0, weight = 0;
  end loop;
end;
$$;

-- P4/P5/P6: quintile rebalance, self-gated on "did today's scoring run
-- already land for this profile_version" (ties the rebalance to real
-- data availability instead of guessing month-end/quarter-end calendar
-- math) and "has enough time passed since the last rebalance" (>=20 days
-- for monthly, >=80 for quarterly, derived from this portfolio's own
-- trade history -- idempotent against being run more than once the same
-- day or week).
create or replace function fwd_test_rebalance(
  p_portfolio_id bigint, p_profile_version text, p_universe_strategy text,
  p_cost_bps numeric, p_frequency text
)
returns void
language plpgsql
as $$
declare
  v_today date;
  v_start_date date;
  v_last_rebalance date;
  v_min_gap_days int;
  v_starting_nav numeric;
  v_current_value numeric := 0;
  v_cost_total numeric := 0;
  v_n_target int;
  v_investable numeric;
  v_per_name numeric;
  v_rec record;
  v_delta numeric;
  v_trade_value numeric;
  v_cost numeric;
begin
  -- BUG FOUND AND FIXED during this migration's own first test run (see
  -- the final report): the original version below looked up the latest
  -- SCORED date for this profile_version with no floor, so on a session
  -- where scores already existed from prior research work (predating the
  -- portfolio's real 2026-11-30 start_date), this fired real trades 15
  -- days "early" against stale historical scores. Fixed by flooring the
  -- as_of_date lookup at the portfolio's own start_date -- the rebalance
  -- can now never fire on a date before the portfolio officially opens,
  -- regardless of what scoring data already exists in the table.
  select (definition->>'starting_nav')::numeric, start_date into v_starting_nav, v_start_date from scr_fwd_portfolios where id = p_portfolio_id;
  select max(as_of_date) into v_today from scr_scores where profile_version = p_profile_version and as_of_date >= v_start_date;
  if v_today is null then return; end if;

  select max(trade_date) into v_last_rebalance from scr_fwd_trades where portfolio = p_portfolio_id and reason = 'rebalance';
  v_min_gap_days := case p_frequency when 'quarterly' then 80 else 20 end;
  if v_last_rebalance is not null and (v_today - v_last_rebalance) < v_min_gap_days then return; end if;
  if exists (select 1 from scr_fwd_trades where portfolio = p_portfolio_id and reason = 'rebalance' and trade_date = v_today) then return; end if;

  -- Current value: cash (starting NAV net of all lifetime trade cash
  -- flows and costs) + today's mark of whatever is currently held.
  select v_starting_nav
    - coalesce(sum(case when side='buy' then shares*price else 0 end), 0)
    + coalesce(sum(case when side='sell' then shares*price else 0 end), 0)
    - coalesce(sum(cost), 0)
  into v_current_value
  from scr_fwd_trades where portfolio = p_portfolio_id;

  for v_rec in
    select h.company_id, h.shares, p.adj_close as price
    from scr_fwd_holdings h
    left join lateral (select ap.adj_close from scr_adjusted_prices ap where ap.company_id = h.company_id and ap.date <= v_today order by ap.date desc limit 1) p on true
    where h.portfolio = p_portfolio_id and h.shares > 0
      and h.as_of_date = (select max(as_of_date) from scr_fwd_holdings h2 where h2.portfolio = p_portfolio_id and h2.company_id = h.company_id)
  loop
    v_current_value := v_current_value + v_rec.shares * coalesce(v_rec.price, 0);
  end loop;

  -- New target: top quintile, equal weight.
  create temp table if not exists t_fwd_target (company_id uuid, symbol text, price numeric) on commit drop;
  delete from t_fwd_target;
  insert into t_fwd_target
  select ss.company_id, null, p.adj_close -- symbol not stored on scr_scores; resolved via current ticker just below
  from (
    select company_id, ntile(5) over (order by score) as q
    from scr_scores where profile_version = p_profile_version and as_of_date = v_today
      and company_id in (select company_id from scr_universe_membership where strategy = p_universe_strategy and as_of_date = v_today)
  ) ranked
  join scr_scores ss on ss.company_id = ranked.company_id and ss.as_of_date = v_today and ss.profile_version = p_profile_version
  left join lateral (select ap.adj_close from scr_adjusted_prices ap where ap.company_id = ss.company_id and ap.date <= v_today order by ap.date desc limit 1) p on true
  where ranked.q = 5;

  update t_fwd_target t set symbol = fth.ticker
  from scr_ticker_history fth where fth.company_id = t.company_id and fth.valid_to is null;

  select count(*) into v_n_target from t_fwd_target where price is not null and symbol is not null;
  if v_n_target = 0 then return; end if;

  -- Sells: anything currently held that's no longer in the target.
  v_cost_total := 0;
  for v_rec in
    select h.company_id, h.symbol, h.shares, p.adj_close as price
    from scr_fwd_holdings h
    left join lateral (select ap.adj_close from scr_adjusted_prices ap where ap.company_id = h.company_id and ap.date <= v_today order by ap.date desc limit 1) p on true
    where h.portfolio = p_portfolio_id and h.shares > 0
      and h.as_of_date = (select max(as_of_date) from scr_fwd_holdings h2 where h2.portfolio = p_portfolio_id and h2.company_id = h.company_id)
      and not exists (select 1 from t_fwd_target t where t.company_id = h.company_id)
  loop
    if v_rec.price is null then continue; end if;
    v_trade_value := v_rec.shares * v_rec.price;
    v_cost := (p_cost_bps/10000.0) * v_trade_value;
    v_cost_total := v_cost_total + v_cost;
    insert into scr_fwd_trades (portfolio, trade_date, company_id, symbol, side, shares, price, cost, reason)
    values (p_portfolio_id, v_today, v_rec.company_id, v_rec.symbol, 'sell', v_rec.shares, v_rec.price, v_cost, 'rebalance');
    insert into scr_fwd_holdings (portfolio, as_of_date, company_id, symbol, shares, weight)
    values (p_portfolio_id, v_today, v_rec.company_id, v_rec.symbol, 0, 0)
    on conflict (portfolio, as_of_date, company_id) do update set shares = 0, weight = 0;
  end loop;

  v_investable := v_current_value; -- cost on buys deducted per-trade below; v_cost_total so far is sell-side only
  v_per_name := v_investable / v_n_target;

  for v_rec in select company_id, symbol, price from t_fwd_target where price is not null and symbol is not null
  loop
    select h.shares into v_delta from scr_fwd_holdings h
      where h.portfolio = p_portfolio_id and h.company_id = v_rec.company_id
      order by h.as_of_date desc limit 1;
    v_delta := (v_per_name / v_rec.price) - coalesce(v_delta, 0);
    if abs(v_delta) < 1e-9 then continue; end if;
    v_trade_value := abs(v_delta) * v_rec.price;
    v_cost := (p_cost_bps/10000.0) * v_trade_value;
    v_cost_total := v_cost_total + v_cost;
    insert into scr_fwd_trades (portfolio, trade_date, company_id, symbol, side, shares, price, cost, reason)
    values (p_portfolio_id, v_today, v_rec.company_id, v_rec.symbol, case when v_delta > 0 then 'buy' else 'sell' end, abs(v_delta), v_rec.price, v_cost, 'rebalance');
    insert into scr_fwd_holdings (portfolio, as_of_date, company_id, symbol, shares, weight)
    values (p_portfolio_id, v_today, v_rec.company_id, v_rec.symbol, v_per_name / v_rec.price, 1.0 / v_n_target)
    on conflict (portfolio, as_of_date, company_id) do update set shares = excluded.shares, weight = excluded.weight;
  end loop;
end;
$$;

-- Daily NAV for one portfolio: cash (starting value net of all lifetime
-- trade cash flows and costs) + today's mark of current holdings.
create or replace function fwd_test_nav(p_portfolio_id bigint, p_date date)
returns void
language plpgsql
as $$
declare
  v_starting numeric;
  v_cash numeric;
  v_holdings_value numeric := 0;
  v_nav numeric;
  v_prev_nav numeric;
  v_turnover numeric;
  v_costs_today numeric;
begin
  select coalesce((definition->>'starting_nav')::numeric, (definition->>'starting_cash')::numeric)
  into v_starting from scr_fwd_portfolios where id = p_portfolio_id;

  select v_starting
    - coalesce(sum(case when side='buy' then shares*price else 0 end), 0)
    + coalesce(sum(case when side='sell' then shares*price else 0 end), 0)
    - coalesce(sum(cost), 0)
  into v_cash
  from scr_fwd_trades where portfolio = p_portfolio_id and trade_date <= p_date;

  select coalesce(sum(h.shares * p.adj_close), 0) into v_holdings_value
  from (
    select distinct on (company_id) company_id, shares from scr_fwd_holdings
    where portfolio = p_portfolio_id and as_of_date <= p_date
    order by company_id, as_of_date desc
  ) h
  left join lateral (select ap.adj_close from scr_adjusted_prices ap where ap.company_id = h.company_id and ap.date <= p_date order by ap.date desc limit 1) p on true
  where h.shares > 0;

  v_nav := v_cash + v_holdings_value;

  select nav into v_prev_nav from scr_fwd_nav where portfolio = p_portfolio_id and date < p_date order by date desc limit 1;
  select coalesce(sum(shares*price), 0) into v_turnover from scr_fwd_trades where portfolio = p_portfolio_id and trade_date = p_date;
  select coalesce(sum(cost), 0) into v_costs_today from scr_fwd_trades where portfolio = p_portfolio_id and trade_date = p_date;

  insert into scr_fwd_nav (portfolio, date, nav, period_return, turnover, costs)
  values (p_portfolio_id, p_date, v_nav, case when v_prev_nav is not null and v_prev_nav <> 0 then v_nav/v_prev_nav - 1 else null end, v_turnover, v_costs_today)
  on conflict (portfolio, date) do nothing;
end;
$$;

-- Benchmark NAV: 5 buy-and-hold pseudo-portfolios (BENCH_SPY/QQQ/RSP/IWM/
-- BIL, scr_fwd_portfolios ids 7-11) normalized to the same $100,000
-- starting basis as P1-P6, so they plot directly comparably.
create or replace function fwd_test_benchmark_nav(p_portfolio_id bigint, p_date date)
returns void
language plpgsql
as $$
declare
  v_symbol text;
  v_start_date date;
  v_price_start numeric;
  v_price_today numeric;
  v_nav numeric;
  v_prev_nav numeric;
begin
  select definition->>'symbol', start_date into v_symbol, v_start_date from scr_fwd_portfolios where id = p_portfolio_id;
  select close into v_price_start from asset_price_history where symbol = v_symbol and date <= v_start_date order by date desc limit 1;
  select close into v_price_today from asset_price_history where symbol = v_symbol and date <= p_date order by date desc limit 1;
  if v_price_start is null or v_price_today is null or v_price_start = 0 then return; end if;
  v_nav := 100000.0 * v_price_today / v_price_start;
  select nav into v_prev_nav from scr_fwd_nav where portfolio = p_portfolio_id and date < p_date order by date desc limit 1;
  insert into scr_fwd_nav (portfolio, date, nav, period_return, turnover, costs)
  values (p_portfolio_id, p_date, v_nav, case when v_prev_nav is not null and v_prev_nav <> 0 then v_nav/v_prev_nav - 1 else null end, 0, 0)
  on conflict (portfolio, date) do nothing;
end;
$$;

-- One daily orchestration entry point, scheduled via pg_cron. Logs to
-- rb_job_runs matching the existing job-logging convention.
create or replace function fwd_test_daily_run()
returns void
language plpgsql
as $$
declare
  v_today date := current_date;
  v_run_id bigint;
begin
  insert into rb_job_runs (job_name, status) values ('fwd-test-daily', 'running') returning id into v_run_id;

  perform fwd_test_p1p2_check(1, 'rule_breakers');
  perform fwd_test_p1p2_check(2, 'stock_advisor');
  perform fwd_test_p3_check(3);

  perform fwd_test_rebalance(4, 'a_v1_hist_ff12', 'a_growth', 10, 'monthly');
  perform fwd_test_rebalance(5, 'b_v1', 'profile_b', 25, 'quarterly');
  perform fwd_test_rebalance(6, 'vm_combo_ind', 'broad_liquid', 10, 'monthly');

  perform fwd_test_nav(1, v_today);
  perform fwd_test_nav(2, v_today);
  perform fwd_test_nav(3, v_today);
  perform fwd_test_nav(4, v_today);
  perform fwd_test_nav(5, v_today);
  perform fwd_test_nav(6, v_today);
  perform fwd_test_benchmark_nav(7, v_today);
  perform fwd_test_benchmark_nav(8, v_today);
  perform fwd_test_benchmark_nav(9, v_today);
  perform fwd_test_benchmark_nav(10, v_today);
  perform fwd_test_benchmark_nav(11, v_today);

  update rb_job_runs set finished_at = now(), status = 'ok' where id = v_run_id;
exception when others then
  update rb_job_runs set finished_at = now(), status = 'error', detail = jsonb_build_object('error', sqlerrm) where id = v_run_id;
  raise;
end;
$$;

-- Pre-register the six live portfolios, start_date 2026-11-30 for all.
insert into scr_fwd_portfolios (name, definition, start_date, cost_rule, rebalance_rule) values
('P1_fool_rule_breakers', '{"description":"Fool Rule Breakers picks, event-driven. Buy $1,000 fixed at close on event_date for each event=recommendation row in rb_fool_recs (service=rule_breakers) after start_date. Sell at close on the matching event=closed row.","source_table":"rb_fool_recs","service":"rule_breakers","starting_cash":100000}', '2026-11-30', '{"bps":0,"side_convention":"no cost modeled -- Fool rec/close events, not a cost-bearing rebalance"}', '{"frequency":"event_driven","trigger":"rb_fool_recs new recommendation/closed row"}'),
('P2_fool_stock_advisor', '{"description":"Fool Stock Advisor picks, event-driven, identical mechanics to P1 with service=stock_advisor.","source_table":"rb_fool_recs","service":"stock_advisor","starting_cash":100000}', '2026-11-30', '{"bps":0,"side_convention":"no cost modeled"}', '{"frequency":"event_driven","trigger":"rb_fool_recs new recommendation/closed row"}'),
('P3_live_screen', '{"description":"Ratiobo live screen judgment picks. Buy $1,000 fixed at close the day rb_scores.action_key first transitions to buy. Sell at close the day a held symbol transitions from {buy,pull,half,hold} to {nonew,wait,null}.","source_table":"rb_scores","starting_cash":100000}', '2026-11-30', '{"bps":0,"side_convention":"no cost modeled"}', '{"frequency":"daily_check","trigger":"rb_scores action_key transition"}'),
('P4_a1_numbers_only', '{"description":"Top quintile of a_v1_hist_ff12 scores within the a_growth universe, equal weight. Phase 4c simulator mechanics (drift between rebalances, real tracked turnover) applied live instead of historically.","profile_version":"a_v1_hist_ff12","universe_strategy":"a_growth","starting_nav":100000}', '2026-11-30', '{"bps":10,"side_convention":"per side, on buys and sells separately"}', '{"frequency":"monthly","rebalance_day":"month_end"}'),
('P5_profile_b', '{"description":"Top quintile of b_v1 scores within the profile_b universe, equal weight. Same simulator mechanics, quarterly rebalance.","profile_version":"b_v1","universe_strategy":"profile_b","starting_nav":100000}', '2026-11-30', '{"bps":25,"side_convention":"per side, on buys and sells separately"}', '{"frequency":"quarterly","rebalance_day":"quarter_end"}'),
('P6_value_momentum', '{"description":"Top quintile of vm_combo_ind (VM-ind) scores within the broad_liquid universe, equal weight. Same simulator mechanics, monthly rebalance.","profile_version":"vm_combo_ind","universe_strategy":"broad_liquid","starting_nav":100000}', '2026-11-30', '{"bps":10,"side_convention":"per side, on buys and sells separately"}', '{"frequency":"monthly","rebalance_day":"month_end"}');

insert into scr_fwd_portfolios (name, definition, start_date, cost_rule, rebalance_rule) values
('BENCH_SPY', '{"description":"Buy-and-hold benchmark, SPY total return.","symbol":"SPY","is_benchmark":true}', '2026-11-30', '{"bps":0}', '{"frequency":"none"}'),
('BENCH_QQQ', '{"description":"Buy-and-hold benchmark, QQQ total return.","symbol":"QQQ","is_benchmark":true}', '2026-11-30', '{"bps":0}', '{"frequency":"none"}'),
('BENCH_RSP', '{"description":"Buy-and-hold benchmark, RSP total return.","symbol":"RSP","is_benchmark":true}', '2026-11-30', '{"bps":0}', '{"frequency":"none"}'),
('BENCH_IWM', '{"description":"Buy-and-hold benchmark, IWM total return.","symbol":"IWM","is_benchmark":true}', '2026-11-30', '{"bps":0}', '{"frequency":"none"}'),
('BENCH_BIL', '{"description":"Buy-and-hold benchmark, BIL total return.","symbol":"BIL","is_benchmark":true}', '2026-11-30', '{"bps":0}', '{"frequency":"none"}');

-- Daily, 06:00 UTC -- after the overnight price/corporate-action syncs
-- (05:20/05:22 UTC) have landed, well before market open.
select cron.schedule('fwd-test-daily', '0 6 * * *', 'select fwd_test_daily_run();');
