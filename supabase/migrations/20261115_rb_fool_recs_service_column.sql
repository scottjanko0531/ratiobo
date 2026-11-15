-- Part C (forward-test infrastructure spec): add Stock Advisor as a second
-- Fool service alongside Rule Breakers. Same insert-only/dedupe model as
-- rule_breakers; rb_ingest_fool_recs extended to accept `service` in its
-- request body, dedup key becomes (service, symbol, event, event_date).

alter table rb_fool_recs add column service text;
update rb_fool_recs set service = 'rule_breakers' where service is null;
alter table rb_fool_recs alter column service set not null;
alter table rb_fool_recs alter column service set default 'rule_breakers';
alter table rb_fool_recs add constraint rb_fool_recs_service_check
  check (service = any (array['rule_breakers', 'stock_advisor']));

-- Secondary DB-level backstop (app-level dedup in rb_ingest_fool_recs is
-- what actually governs inserts, same as before -- this constraint's job
-- is only to keep a duplicate from landing some other way) widened to
-- include service, since a Stock Advisor rec can legitimately share
-- fool_symbol/event/event_date/price with a Rule Breakers rec for the
-- same stock on the same day.
alter table rb_fool_recs drop constraint rb_fool_recs_fool_symbol_event_event_date_price_key;
alter table rb_fool_recs add constraint rb_fool_recs_service_fool_symbol_event_event_date_price_key
  unique (service, fool_symbol, event, event_date, price);

create or replace function rb_ingest_fool_recs(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row jsonb;
  v_symbol text;
  v_fool_symbol text;
  v_event text;
  v_event_date date;
  v_price numeric;
  v_risk_type text;
  v_source text;
  v_service text;
  v_count int := 0;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_symbol := v_row->>'symbol';
    v_fool_symbol := v_row->>'fool_symbol';
    v_event := v_row->>'event';
    v_source := v_row->>'source';
    v_service := coalesce(v_row->>'service', 'rule_breakers');

    if v_service not in ('rule_breakers', 'stock_advisor') then
      continue;
    end if;

    if v_symbol is null or v_fool_symbol is null or v_source is null then
      continue;
    end if;
    if v_event is null or v_event not in ('recommendation', 'closed') then
      continue;
    end if;

    begin
      v_event_date := (v_row->>'event_date')::date;
    exception when others then
      continue;
    end;
    if v_event_date is null then
      continue;
    end if;

    v_price := nullif(v_row->>'price', '')::numeric;
    v_risk_type := nullif(v_row->>'risk_type', '');
    if v_risk_type is not null and v_risk_type not in ('Cautious', 'Moderate', 'Aggressive') then
      continue;
    end if;

    -- Dedup key is now (service, symbol, event, event_date), same coarser-
    -- than-the-table's-own-unique-constraint convention as before.
    if exists (
      select 1 from rb_fool_recs
      where service = v_service and symbol = v_symbol and event = v_event and event_date = v_event_date
    ) then
      continue;
    end if;

    insert into rb_fool_recs (symbol, fool_symbol, event, event_date, price, risk_type, source, scraped_on, service)
    values (v_symbol, v_fool_symbol, v_event, v_event_date, v_price, v_risk_type, v_source, current_date, v_service);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;
