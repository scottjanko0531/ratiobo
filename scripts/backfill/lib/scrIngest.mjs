// Thin client for the scr-ingest edge function -- the one write path for
// the local backfill scripts into scr_prices_daily / scr_corporate_actions
// / scr_ticker_history / rb_job_runs (see supabase/functions/scr-ingest for
// why: rb_job_runs has an RLS SELECT-only policy for `authenticated`, so a
// script holding just the anon key can't log runs directly; scr-ingest
// does it via its service-role client, gated by the x-ingest-key shared
// secret). sendTickerHistory inserts row-by-row and reports per-row
// success/failure -- scr_ticker_history's exclusion constraint is a GIST
// constraint, not a plain unique index, so it can't go through the usual
// upsert+ignoreDuplicates path the other tables use.

export function makeScrIngest(env) {
  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/scr-ingest`;
  const key = env.SCR_INGEST_KEY;

  async function call(body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ingest-key": key },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`scr-ingest HTTP ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  return {
    sendPrices: (prices) => call({ prices }),
    sendCorporateActions: (corporateActions) => call({ corporateActions }),
    sendSecurityUpdates: (securityUpdates) => call({ securityUpdates }),
    sendFundamentals: (fundamentals) => call({ fundamentals }),
    readFundamentals: async (companyIds) => {
      const all = [];
      let offset = 0;
      for (;;) {
        const r = await call({ readFundamentals: companyIds, readFundamentalsOffset: offset });
        if (!r.readFundamentals?.ok) throw new Error(`readFundamentals failed: ${JSON.stringify(r.readFundamentals)}`);
        all.push(...r.readFundamentals.rows);
        if (r.readFundamentals.rows.length < r.readFundamentals.pageSize) break;
        offset += r.readFundamentals.rows.length;
      }
      return all;
    },
    sendSecurityMaster: (securityMaster) => call({ securityMaster }),
    readSecurities: async () => {
      const all = [];
      let offset = 0;
      for (;;) {
        const r = await call({ readSecurities: true, readSecuritiesOffset: offset });
        if (!r.readSecurities?.ok) throw new Error(`readSecurities failed: ${JSON.stringify(r.readSecurities)}`);
        all.push(...r.readSecurities.rows);
        if (r.readSecurities.rows.length < r.readSecurities.pageSize) break;
        offset += r.readSecurities.rows.length;
      }
      return all;
    },
    sendTickerHistory: (tickerHistory) => call({ tickerHistory }),
    sendTickerHistoryUpdates: (tickerHistoryUpdates) => call({ tickerHistoryUpdates }),
    readTickerHistory: async (tickers) => {
      const r = await call({ readTickerHistory: tickers });
      if (!r.readTickerHistory?.ok) throw new Error(`readTickerHistory failed: ${JSON.stringify(r.readTickerHistory)}`);
      return r.readTickerHistory.rows;
    },
    startJobRun: async (job_name, detail) => {
      const r = await call({ jobRun: { action: "start", job_name, detail } });
      if (!r.jobRun?.ok) throw new Error(`startJobRun failed: ${JSON.stringify(r.jobRun)}`);
      return r.jobRun.id;
    },
    finishJobRun: async (id, status = "ok", detail) => {
      const r = await call({ jobRun: { action: "finish", id, status, detail } });
      if (!r.jobRun?.ok) throw new Error(`finishJobRun failed: ${JSON.stringify(r.jobRun)}`);
    },
  };
}
