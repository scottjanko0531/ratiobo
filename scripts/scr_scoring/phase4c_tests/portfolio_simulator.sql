-- Phase 4c holdout directive, condition 2: the real equal-weight,
-- drift-then-rebalance, real-turnover portfolio simulator -- NOT Phase
-- 4a's Q5-Q1 spread-with-assumed-costs test, which Scott's conditions
-- explicitly said isn't sufficient for this phase.
--
-- Mechanics (exact, from Scott's approval message):
--  - At each rebalance date t: form the equal-weight top quintile from
--    scores as of t; hold to the next rebalance with weights DRIFTING
--    with realized returns (not re-equal-weighted) until the next
--    rebalance.
--  - Turnover = traded notional at rebalance = new target weights vs. the
--    drifted weights just before rebalancing. Cost per side (p_cost_bps)
--    applied to buys AND sells separately (so cost = cost_bps/10000 *
--    (buys + sells); at the very first rebalance, sells=0 since there's
--    nothing yet to sell, so only one side of cost is paid -- this falls
--    out automatically from the buys/sells split below, not special-cased).
--  - Gate (A gated configs only): the mc_signal_log reading AS OF
--    month-end t decides the HOLDING for month t+1 (decided at t, no
--    lookahead). Unfavorable -> hold BIL instead of the equity basket for
--    that holding period. Switching into/out of BIL pays the same
--    per-side costs as any other turnover.
--  - Benchmarks/BIL: monthly total returns from asset_price_history
--    (nearest-trading-day-on-or-before convention, matching
--    fwd_ret_build.sql).
--  - Delisting: a held company's exit-to-BIL economics for the month it
--    delists in are already blended into that month's scr_fwd_ret_mat_v2
--    ret_1m value (see fwd_ret_build.sql) -- the simulator doesn't need
--    special-case logic for the delisting month itself. For any LATER
--    month where that same company_id would have a null ret_1m (data gap,
--    or it has fully exited the universe), its slice is simply carried
--    forward as BIL from that point, since the money is already sitting
--    in T-bills per the delisting rule and there's no more company-
--    specific return to look up.
--
-- One call simulates ONE configuration end to end and returns one row per
-- calendar month with that month's realized portfolio return (gross/net),
-- that month's turnover/cost (0 on non-rebalance months), and the
-- post-rebalance holding composition (as jsonb) for later hand-checking.

create or replace function scr_sim_portfolio(
  p_profile text,
  p_rebalance_months int,
  p_cost_bps numeric,
  p_gated boolean,
  p_start date,
  p_end date
) returns table (
  as_of_date date,
  is_rebalance boolean,
  gate_state text,
  gross_ret numeric,
  cost_frac numeric,
  net_ret numeric,
  turnover_oneway numeric,
  holdings jsonb
) language plpgsql as $$
declare
  v_dates date[];
  v_n int;
  v_i int;
  v_holdings jsonb := '{}'::jsonb; -- {key: weight}, key = company_id text or 'BIL'
  v_new_target jsonb;
  v_drifted jsonb;
  v_keys text[];
  v_k text;
  v_ret numeric;
  v_port_ret numeric;
  v_buys numeric;
  v_sells numeric;
  v_delta numeric;
  v_gate_favorable boolean;
  v_rebal boolean;
  v_result_gross numeric;
  v_result_cost numeric;
begin
  select array_agg(d order by d) into v_dates
  from (select distinct ss.as_of_date as d from scr_scores ss
        where ss.profile_version = p_profile and ss.as_of_date between p_start and p_end) x;
  v_n := array_length(v_dates, 1);

  for v_i in 1..v_n loop
    -- 1. Drift existing holdings forward using the PRIOR month's 1-month
    -- forward return (keyed at v_dates[v_i-1]), i.e. the return realized
    -- going INTO v_dates[v_i]. The very first date has no prior holdings
    -- (v_holdings starts empty), so this step is a no-op then.
    v_drifted := '{}'::jsonb;
    v_port_ret := 0;
    if v_i > 1 and v_holdings <> '{}'::jsonb then
      select array_agg(k) into v_keys from jsonb_object_keys(v_holdings) k;
      for v_k in select * from unnest(v_keys) loop
        if v_k = 'BIL' then
          v_ret := scr_bil_price_asof(v_dates[v_i]) / nullif(scr_bil_price_asof(v_dates[v_i-1]), 0) - 1;
        else
          select f.ret_1m into v_ret from scr_fwd_ret_mat_v2 f
            where f.company_id = v_k::uuid and f.as_of_date = v_dates[v_i-1];
          if v_ret is null then
            -- already dead / data gap: treat as BIL for this step, and
            -- this slice will be relabeled to BIL below.
            v_ret := scr_bil_price_asof(v_dates[v_i]) / nullif(scr_bil_price_asof(v_dates[v_i-1]), 0) - 1;
          end if;
        end if;
        v_port_ret := v_port_ret + (v_holdings->>v_k)::numeric * v_ret;
      end loop;
      -- Renormalize and relabel dead names to BIL, merging BIL buckets.
      for v_k in select * from unnest(v_keys) loop
        if v_k = 'BIL' then
          v_ret := scr_bil_price_asof(v_dates[v_i]) / nullif(scr_bil_price_asof(v_dates[v_i-1]), 0) - 1;
          v_drifted := jsonb_set(v_drifted, array['BIL'],
            to_jsonb(coalesce((v_drifted->>'BIL')::numeric, 0) + (v_holdings->>v_k)::numeric * (1+v_ret) / (1+v_port_ret)));
        else
          select f.ret_1m into v_ret from scr_fwd_ret_mat_v2 f
            where f.company_id = v_k::uuid and f.as_of_date = v_dates[v_i-1];
          if v_ret is null then
            v_ret := scr_bil_price_asof(v_dates[v_i]) / nullif(scr_bil_price_asof(v_dates[v_i-1]), 0) - 1;
            v_drifted := jsonb_set(v_drifted, array['BIL'],
              to_jsonb(coalesce((v_drifted->>'BIL')::numeric, 0) + (v_holdings->>v_k)::numeric * (1+v_ret) / (1+v_port_ret)));
          else
            v_drifted := jsonb_set(v_drifted, array[v_k], to_jsonb((v_holdings->>v_k)::numeric * (1+v_ret) / (1+v_port_ret)));
          end if;
        end if;
      end loop;
    else
      v_drifted := v_holdings; -- empty on i=1
    end if;

    -- 2. Rebalance?
    v_rebal := (v_i = 1) or ((v_i - 1) % p_rebalance_months = 0);
    v_gate_favorable := null;

    if v_rebal then
      if p_gated then
        select exposure_multiplier >= 1 into v_gate_favorable
        from mc_signal_log where date <= v_dates[v_i] order by date desc limit 1;
      end if;

      if p_gated and coalesce(v_gate_favorable, true) = false then
        v_new_target := jsonb_build_object('BIL', 1.0);
      else
        with ranked as (
          select ss.company_id, ntile(5) over (order by ss.score) as q
          from scr_scores ss where ss.profile_version = p_profile and ss.as_of_date = v_dates[v_i]
        ),
        top as (select company_id from ranked where q = 5),
        n as (select count(*) as c from top)
        select jsonb_object_agg(company_id::text, 1.0 / n.c)
        into v_new_target
        from top, n;
      end if;

      -- Turnover: buys/sells between v_drifted and v_new_target.
      v_buys := 0; v_sells := 0;
      select array_agg(distinct k) into v_keys
      from (select jsonb_object_keys(v_drifted) as k union select jsonb_object_keys(v_new_target)) u;
      if v_keys is not null then
        for v_k in select * from unnest(v_keys) loop
          v_delta := coalesce((v_new_target->>v_k)::numeric,0) - coalesce((v_drifted->>v_k)::numeric,0);
          if v_delta > 0 then v_buys := v_buys + v_delta; else v_sells := v_sells + abs(v_delta); end if;
        end loop;
      end if;
      v_result_cost := (p_cost_bps/10000.0) * (v_buys + v_sells);
      v_holdings := v_new_target;
    else
      v_result_cost := 0;
      v_holdings := v_drifted;
    end if;

    v_result_gross := v_port_ret;

    as_of_date := v_dates[v_i];
    is_rebalance := v_rebal;
    gate_state := case when not p_gated then null when v_gate_favorable is null then null when v_gate_favorable then 'invested' else 'bil' end;
    gross_ret := v_result_gross;
    cost_frac := v_result_cost;
    net_ret := v_result_gross - v_result_cost;
    turnover_oneway := case when v_rebal then (v_buys + v_sells)/2.0 else 0 end;
    holdings := v_holdings;
    return next;
  end loop;
end;
$$;
