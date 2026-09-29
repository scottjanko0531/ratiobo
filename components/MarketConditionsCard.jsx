"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "../lib/supabase";
import { TIER_META, TREND_STATE_META, entrySignalDisplay, fmtDate } from "../lib/marketConditionsMeta";

// Market Conditions Overlay — main-dashboard summary card. Reads the
// single latest row from market_conditions_scores directly (no new API
// route). Detail lives at /market-conditions.

export default function MarketConditionsCard() {
  const [row, setRow] = useState(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    supabase
      .from("market_conditions_scores")
      .select("date, config_version, trend_state, tier, exposure_multiplier, entry_signal, entry_reason, veto_active, flags")
      .order("date", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        setRow(data?.[0] ?? null);
        setBusy(false);
      });
  }, []);

  if (busy) {
    return (
      <div className="card p-4">
        <p className="label mb-1">Market Conditions</p>
        <p className="text-paper-dim text-sm">Loading…</p>
      </div>
    );
  }
  if (!row) {
    return (
      <div className="card p-4">
        <p className="label mb-1">Market Conditions</p>
        <p className="text-paper-dim text-sm">No data yet.</p>
      </div>
    );
  }

  const tier = TIER_META[row.tier] ?? TIER_META.NORMAL;
  const trend = TREND_STATE_META[row.trend_state] ?? TREND_STATE_META.MIXED;
  const entry = entrySignalDisplay(row.entry_reason);
  const staleInputs = row.flags?.stale_inputs;
  const staleKeys = staleInputs ? Object.keys(staleInputs) : [];

  return (
    <Link href="/market-conditions" className="card p-4 block hover:border-brass/40 transition-colors">
      <div className="flex items-baseline justify-between mb-3 gap-2 flex-wrap">
        <p className="label">Market Conditions</p>
        <span className="text-[10px] text-paper-dim/70">
          as of {fmtDate(row.date)} · {row.config_version}
        </span>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className={`rounded-lg border px-3 py-2 ${tier.border} ${tier.bg}`}>
          <p className="text-[10px] text-paper-dim">Tier</p>
          <p className={`text-lg font-semibold ${tier.tone}`}>{tier.label}</p>
        </div>
        <div>
          <p className="text-[10px] text-paper-dim">Exposure</p>
          <p className="num text-lg text-paper">{`×${Number(row.exposure_multiplier).toFixed(2)}`}</p>
        </div>
        <div>
          <p className="text-[10px] text-paper-dim">Trend</p>
          <p className={`text-lg font-semibold ${trend.tone}`}>{trend.label}</p>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-ink-line">
        <div className="flex items-baseline gap-2">
          <span className={`text-sm font-semibold ${entry.tone}`}>{entry.signal}</span>
        </div>
        <p className="text-[11px] text-paper-dim leading-relaxed mt-0.5">{entry.text}</p>
      </div>

      {row.veto_active && (
        <div className="mt-3 rounded-lg border border-brass/30 bg-brass/10 px-3 py-2">
          <p className="text-[11px] text-brass-soft leading-relaxed">
            High stress: typical forward returns above average, but downside risk wider than normal.
          </p>
        </div>
      )}

      {staleKeys.length > 0 && (
        <p className="text-[10px] text-paper-dim/70 mt-2">
          Stale inputs: {staleKeys.map((k) => `${k} (${staleInputs[k]}d)`).join(", ")}
        </p>
      )}
    </Link>
  );
}
