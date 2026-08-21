"use client";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import ProvenanceBadge from "./ProvenanceBadge";
import { computeAllocationDeltas, ILLIQUID_KEYS, BW_ALLOC, SIMULATOR_KEYS } from "../lib/simulatorKeys";
import { DALIO_BENCHMARKS } from "../lib/dalioBenchmarks";

const KEY_LABEL = Object.fromEntries(SIMULATOR_KEYS.map((s) => [s.key, s.label]));

const STAGE_META = {
  "MP1": { color: "text-gain", border: "border-gain/30", bg: "bg-gain/10" },
  "MP1 (strained)": { color: "text-brass-soft", border: "border-brass/30", bg: "bg-brass/10" },
  "MP2": { color: "text-brass-soft", border: "border-brass/30", bg: "bg-brass/10" },
  "MP3": { color: "text-loss", border: "border-loss/30", bg: "bg-loss/10" },
};

const CONDITION_ROWS = [
  { key: "debtServiceStrained", label: "Debt service strained", detail: (r) => r?.interestExpenseRevenuePct != null ? `Interest expense ${r.interestExpenseRevenuePct.toFixed(1)}% of revenue (> 20% threshold)` : null },
  { key: "rGreaterG", label: "r > g", detail: (r) => r?.rateGrowthSpread != null ? `10Y yield minus real GDP growth = ${r.rateGrowthSpread >= 0 ? "+" : ""}${r.rateGrowthSpread.toFixed(2)}pts` : null },
  { key: "fedPrintingRising", label: "Fed printing rising", detail: () => "Fed Balance Sheet % GDP in a sustained multi-week uptrend" },
  { key: "mp2Gate", label: "MP2 gate", detail: () => "Near-zero fed funds AND Fed printing rising, together" },
  { key: "mp3AuctionDemandWeak", label: "Auction demand weak", detail: (r) => r?.indirectBidderShareAvg6 != null ? `Trailing-6 indirect bidder share ${r.indirectBidderShareAvg6.toFixed(1)}%` : null },
  { key: "mp3SomaAbsorbing", label: "Fed absorbing duration", detail: () => "SOMA long-duration holdings sustained positive over trailing weeks" },
];

const TRIP_WIRE_LABELS = {
  mp2_onset_watch: "MP2 onset watch",
  auction_demand_deterioration: "Auction demand deterioration",
  dollar_divergence_widening: "Dollar confidence divergence widening",
  fiscal_dominance_confirmed: "Fiscal-dominance regime confirmed",
};

function fmtDateTime(d) {
  return d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
}

export default function DebtCyclePositionCheck({ metrics }) {
  const [audit, setAudit] = useState(null);
  const [firedCount, setFiredCount] = useState(0);
  const [holdings, setHoldings] = useState([]);
  const [brief, setBrief] = useState(null);
  const [loadingBrief, setLoadingBrief] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function loadAudit() {
    const { data } = await supabase
      .from("big_cycle_stage_audit_log")
      .select("*")
      .order("run_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setAudit(data ?? null);
  }

  async function loadFiredCount() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("category", "debt_cycle")
      .eq("type", "trip_wire")
      .gte("created_at", sevenDaysAgo);
    setFiredCount(count ?? 0);
  }

  async function loadHoldings() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("holdings_valued")
      .select("id, symbol, name, simulator_key, asset_type, current_value")
      .eq("user_id", user.id);
    setHoldings(data ?? []);
  }

  async function loadBrief(refresh = false) {
    if (refresh) setRefreshing(true); else setLoadingBrief(true);
    try {
      const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/generate-debt-cycle-brief${refresh ? "?refresh=true" : ""}`;
      const res = await fetch(url);
      const j = await res.json();
      if (!j.error) setBrief(j);
      // The brief's own handler defensively triggers update-big-cycle-metrics
      // if today's audit row is missing, so re-load the audit after it resolves.
      await loadAudit();
    } catch { /* silent */ }
    setLoadingBrief(false);
    setRefreshing(false);
  }

  useEffect(() => {
    loadAudit();
    loadFiredCount();
    loadHoldings();
    loadBrief(false);
  }, []);

  const stage = audit?.stage ?? null;
  const stageMeta = STAGE_META[stage] ?? { color: "text-paper-dim", border: "border-ink-line", bg: "" };
  const conditions = audit?.conditions ?? {};
  const rawInputs = audit?.raw_inputs ?? {};
  const tripWires = audit?.trip_wires ?? {};

  const metricByKey = Object.fromEntries((metrics ?? []).map((m) => [m.key, m]));

  const { actionRows } = computeAllocationDeltas(holdings, BW_ALLOC, { illiquidKeys: ILLIQUID_KEYS });
  const topGaps = [...actionRows].sort((a, b) => Math.abs(b.deltaVal) - Math.abs(a.deltaVal)).slice(0, 6);

  return (
    <div className="card p-5 mb-6 border border-ink-line">
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div>
          <p className="label mb-1">Debt Cycle Position Check</p>
          <p className="text-[10px] text-paper-dim/60">
            Synthesizes the Long-Term Debt Cycle gauges above into an explicit MP-stage read, benchmarked against Dalio's own published figures.
          </p>
        </div>
        {stage && (
          <div className={`px-3 py-1.5 rounded-lg text-sm font-semibold border ${stageMeta.border} ${stageMeta.bg} ${stageMeta.color}`}>
            {stage}
          </div>
        )}
      </div>

      {!audit ? (
        <p className="text-paper-dim text-sm">No stage data yet — click "Refresh Now" above to run the classifier.</p>
      ) : (
        <>
          {/* Conditions checklist */}
          <div className="mb-5">
            <p className="label text-[10px] mb-2">Conditions Driving This Stage</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {CONDITION_ROWS.map((c) => {
                const met = Boolean(conditions[c.key]);
                const detail = c.detail(rawInputs);
                return (
                  <div key={c.key} className="flex items-start gap-2 text-xs">
                    <span className={met ? "text-gain" : "text-paper-dim/40"}>{met ? "✓" : "✗"}</span>
                    <span className={met ? "text-paper" : "text-paper-dim"}>
                      {c.label}
                      {detail && <span className="text-paper-dim/60"> — {detail}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
            {audit.trend_confidence && audit.trend_confidence !== "normal" && (
              <p className="text-[10px] text-brass-soft mt-2">
                Trend confidence: {audit.trend_confidence} — fewer than 8 distinct weekly readings available for the trend tests above; treat the stage read as provisional.
              </p>
            )}
          </div>

          {/* Dalio benchmark comparison */}
          <div className="mb-5">
            <p className="label text-[10px] mb-2">Dalio's Published Checkpoints</p>
            <div className="space-y-1.5">
              {DALIO_BENCHMARKS.map((b) => {
                const live = metricByKey[b.compareToMetricKey];
                return (
                  <div key={b.key} className="flex items-center justify-between text-xs border-b border-ink-line/40 pb-1.5">
                    <span className="text-paper-dim" title={b.note}>{b.label}</span>
                    <span className="num">
                      <span className="text-paper">{live?.value_display ?? "—"}</span>
                      <span className="text-paper-dim/50 mx-1.5">vs.</span>
                      <span className="text-paper-dim" title={`${b.citation}, ${b.citedDate}`}>~{b.value}{b.unit}</span>
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-[9px] text-paper-dim/40 mt-1.5">Dalio's figures are static citations, not live data — see each row's tooltip for source.</p>
          </div>

          {/* Trip-wires */}
          <div className="mb-5">
            <p className="label text-[10px] mb-2">
              Trip-Wires {firedCount > 0 && <span className="text-brass-soft">· {firedCount} fired in last 7 days</span>}
            </p>
            <div className="space-y-1">
              {Object.entries(TRIP_WIRE_LABELS).map(([key, label]) => {
                const tw = tripWires[key];
                const armed = Boolean(tw?.armed);
                return (
                  <div key={key} className="flex items-center justify-between text-xs">
                    <span className={armed ? "text-brass-soft" : "text-paper-dim"}>{armed ? "⚑" : "—"} {label}</span>
                    {armed && tw?.sinceDate && <span className="text-paper-dim/50 text-[10px]">since {tw.sinceDate}</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Portfolio gap */}
          {topGaps.length > 0 && (
            <div className="mb-5">
              <p className="label text-[10px] mb-2">Portfolio Gap vs. BW Modified</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {topGaps.map((r) => (
                      <tr key={r.symbol} className="border-b border-ink-line/40 last:border-0">
                        <td className="py-1 pr-2">
                          <span className="font-medium">{r.symbol}</span>
                          <span className="text-paper-dim/60 ml-1">{KEY_LABEL[r.key] ?? r.key}</span>
                        </td>
                        <td className="num text-right py-1 pr-2 text-paper-dim">{r.currentPct.toFixed(1)}%</td>
                        <td className={`num text-right py-1 ${r.deltaVal > 0 ? "text-gain" : r.deltaVal < 0 ? "text-loss" : "text-paper-dim"}`}>
                          {r.deltaVal >= 0 ? "+" : ""}{r.deltaVal.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Narrative */}
          <div className="border-t border-ink-line pt-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <p className="label text-[10px]">Position Check Brief</p>
                <ProvenanceBadge />
              </div>
              <button
                onClick={() => loadBrief(true)}
                disabled={refreshing}
                className="text-[10px] text-paper-dim/50 hover:text-paper-dim transition-colors disabled:opacity-40"
              >
                {refreshing ? "Refreshing…" : "↻ Refresh"}
              </button>
            </div>
            {loadingBrief ? (
              <p className="text-paper-dim text-sm">Generating brief…</p>
            ) : brief?.narrative ? (
              <div className="space-y-3">
                {brief.narrative.split(/\n\n+/).map((block, i) => {
                  const lines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
                  const bulletLines = lines.filter((l) => /^[-*]\s+/.test(l));
                  const isBulletBlock = bulletLines.length >= 2 && bulletLines.length >= lines.length - 1;
                  if (!isBulletBlock) {
                    return <p key={i} className="text-sm text-paper-dim leading-relaxed">{block.trim()}</p>;
                  }
                  const leadIn = lines.filter((l) => !/^[-*]\s+/.test(l));
                  return (
                    <div key={i}>
                      {leadIn.map((l, j) => (
                        <p key={`lead-${j}`} className="text-sm text-paper-dim leading-relaxed mb-2">{l}</p>
                      ))}
                      <ul className="list-disc pl-5 space-y-1.5">
                        {bulletLines.map((l, j) => (
                          <li key={j} className="text-sm text-paper-dim leading-relaxed">{l.replace(/^[-*]\s+/, "")}</li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-paper-dim text-sm">No brief yet.</p>
            )}
            {brief?.generated_at && (
              <p className="text-[10px] text-paper-dim/40 mt-3">Brief by Claude · {fmtDateTime(brief.generated_at)}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
