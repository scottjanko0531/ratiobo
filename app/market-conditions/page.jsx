"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Scatter, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceArea,
} from "recharts";
import Shell from "../../components/Shell";
import StageInfoIcon from "../../components/StageInfoIcon";
import { supabase } from "../../lib/supabase";
import {
  TIER_META, TREND_STATE_META, SUB_INDICATOR_META, VALIDATION_SUMMARY, MACRO_CONTEXT_META,
  entrySignalDisplay, fmtDate, fmtNum,
} from "../../lib/marketConditionsMeta";

// Market Conditions Overlay — detail page. Reads market_conditions_scores
// (current + full history), asset_price_history (SPY closes), and
// mc_signal_log_live (the true out-of-sample record) directly -- no new
// API routes.

const GRID = "#2A3240", DIM = "#A8ADB8", PAPER = "#F6F4EE", BRASS = "#C9A227", GAIN = "#3FB984", LOSS = "#E0635C";

// PostgREST caps a single response at 1000 rows -- market_conditions_scores
// (~8.3k rows) and asset_price_history's SPY series (~8.5k rows) both blow
// past that, so an unpaginated .select() silently truncates to the first
// 1000 rows in ascending date order (SPY: 1993 through ~1997) rather than
// erroring, which is why the chart looked frozen in the late 90s instead of
// reaching today. Same page-through-in-1000s pattern already used by the
// edge functions (e.g. market-conditions-crossmarket's fetchAllPrices).
async function fetchAllRows(table, columns, applyFilters = (q) => q, orderCol = "date") {
  let rows = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await applyFilters(supabase.from(table).select(columns))
      .order(orderCol, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows = rows.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

const TIER_FILL = {
  FULL: GAIN, NORMAL: "transparent", CAUTIOUS: BRASS, DEFENSIVE: "#8a6a1a", RISK_OFF: LOSS,
};
const TIER_OPACITY = {
  FULL: 0.06, NORMAL: 0, CAUTIOUS: 0.06, DEFENSIVE: 0.09, RISK_OFF: 0.12,
};

const RANGES = [
  { label: "1Y", days: 252 },
  { label: "5Y", days: 252 * 5 },
  { label: "Max", days: null },
];

const LIVE_FORWARD_HORIZON = 21;

function PillarBar({ label, score }) {
  const w = score == null ? 0 : Math.min(50, Math.abs(score) * 50);
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="text-paper">{label}</span>
        <span className={`num ${score == null ? "text-paper-dim" : score >= 0 ? "text-gain" : "text-loss"}`}>
          {score == null ? "—" : `${score > 0 ? "+" : ""}${score.toFixed(2)}`}
        </span>
      </div>
      <div className="h-2 w-full bg-ink rounded relative overflow-hidden">
        <div className="absolute top-0 h-full w-px bg-paper-dim/50 left-1/2" />
        {score != null && (
          <div
            className={`absolute top-0 h-full ${score >= 0 ? "bg-gain/70" : "bg-loss/70"}`}
            style={{ left: score >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }}
          />
        )}
      </div>
    </div>
  );
}

function SubIndicatorRow({ code, ind, staleInputs, open, onToggle }) {
  const meta = SUB_INDICATOR_META[code];
  if (!ind || !meta) return null;
  const staleKeys = (meta.staleSeries ?? []).filter((s) => staleInputs?.[s] != null);
  return (
    <>
      <tr className="border-b border-ink-line last:border-b-0">
        <td className="py-2 pr-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-paper text-sm font-medium">{code}</span>
            <span className="text-paper-dim text-[11px]">{meta.label}</span>
            <StageInfoIcon active={open} onClick={onToggle} label={`About ${code}`} />
          </span>
        </td>
        <td className="py-2 pr-3 num text-sm text-paper text-right">
          {ind.excluded ? "—" : `${fmtNum(ind.raw, 3)}${meta.unit ? ` ${meta.unit}` : ""}`}
        </td>
        <td className="py-2 pr-3 num text-sm text-right">
          {ind.excluded ? (
            <span className="text-paper-dim">—</span>
          ) : (
            <span className={ind.score >= 0 ? "text-gain" : "text-loss"}>{ind.score > 0 ? "+" : ""}{fmtNum(ind.score)}</span>
          )}
        </td>
        <td className="py-2 text-right">
          {ind.excluded ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-loss/30 text-loss" title={ind.excludeReason}>excluded</span>
          ) : staleKeys.length > 0 ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-brass/30 text-brass-soft" title={staleKeys.map((s) => `${s}: ${staleInputs[s]}d stale`).join(", ")}>
              stale {staleKeys.map((s) => `${staleInputs[s]}d`).join(", ")}
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-gain/30 text-gain">fresh</span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-ink-line last:border-b-0">
          <td colSpan={4} className="pb-3 pt-1">
            <div className="p-3 rounded-lg border border-ink-line bg-ink text-[11px] leading-relaxed space-y-1.5">
              <p><span className="text-paper font-semibold">What it measures — </span><span className="text-paper-dim">{meta.what}</span></p>
              <p><span className="text-paper font-semibold">How it's measured — </span><span className="text-paper-dim">{meta.how}</span></p>
              <p><span className="text-paper font-semibold">Why it matters — </span><span className="text-paper-dim">{meta.why}</span></p>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const p = payload.find((x) => x.dataKey === "close");
  if (!p) return null;
  const tier = p.payload?.tier;
  const tierMeta = tier ? TIER_META[tier] : null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[160px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      <div className="flex justify-between gap-4">
        <span className="text-paper-dim">SPY</span>
        <span className="num text-paper">{Number(p.value).toFixed(2)}</span>
      </div>
      {tierMeta && (
        <div className="flex justify-between gap-4">
          <span className="text-paper-dim">Tier</span>
          <span className={`num ${tierMeta.tone}`}>{tierMeta.label}</span>
        </div>
      )}
      {p.payload?.entryReason && (
        <div className="flex justify-between gap-4">
          <span className="text-paper-dim">Signal</span>
          <span className="text-paper">{p.payload.entryReason}</span>
        </div>
      )}
    </div>
  );
}

export default function MarketConditionsPage() {
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState([]); // market_conditions_scores, light columns
  const [spyPrices, setSpyPrices] = useState([]); // asset_price_history SPY
  const [liveLog, setLiveLog] = useState([]); // mc_signal_log_live
  const [busy, setBusy] = useState(true);
  const [range, setRange] = useState("5Y");
  const [openSubIndicator, setOpenSubIndicator] = useState(null); // code (e.g. "T1") or null
  const toggleSubIndicator = (code) => setOpenSubIndicator((v) => (v === code ? null : code));
  const [macroSeries, setMacroSeries] = useState({}); // { seriesId: [{date, value}], ... } -- display only, not scored

  useEffect(() => {
    async function load() {
      try {
        const [{ data: lat }, hist, spy, live] = await Promise.all([
          supabase.from("market_conditions_scores")
            .select("date, config_version, trend_state, tier, exposure_multiplier, entry_signal, entry_reason, veto_active, composite, score_trend, score_breadth, score_stress, flags, components")
            .order("date", { ascending: false }).limit(1),
          fetchAllRows("market_conditions_scores", "date, tier, entry_signal, entry_reason"),
          fetchAllRows("asset_price_history", "date, close", (q) => q.eq("symbol", "SPY")),
          fetchAllRows("mc_signal_log_live", "date, tier, entry_signal, exposure_multiplier, computed_at"),
        ]);
        setLatest(lat?.[0] ?? null);
        setHistory(hist);
        setSpyPrices(spy);
        setLiveLog(live);
      } catch (e) {
        console.error("market-conditions load failed:", e);
      }
      setBusy(false);
    }
    load();
  }, []);

  // Macro context panel (display only, not scored) -- independent fetch so
  // a slow/large pull here never blocks the scored Trend/Stress load above.
  // 10 years (3650 calendar days) covers the 10y-percentile requirement;
  // 1y percentile and the 30d direction arrow both subset the same pull.
  // Uses fetchAllRows (not a bare .select()), same as spyPrices/history
  // above -- PostgREST caps a single response at 1000 rows, and this pull
  // (~27k rows across 13 series) blows well past that; a bare query would
  // silently truncate to the OLDEST 1000 rows in ascending date order,
  // which would show decades-old "current" values -- exactly the bug
  // documented at the top of this file for the SPY/scores pull.
  useEffect(() => {
    async function loadMacro() {
      const since = new Date();
      since.setDate(since.getDate() - 3650);
      const sinceStr = since.toISOString().slice(0, 10);
      const data = await fetchAllRows(
        "mc_series_daily", "series_id, date, value",
        (q) => q.in("series_id", Object.keys(MACRO_CONTEXT_META)).gte("date", sinceStr),
        "date",
      );
      const bySeries = {};
      for (const row of data ?? []) {
        (bySeries[row.series_id] ??= []).push({ date: row.date, value: Number(row.value) });
      }
      setMacroSeries(bySeries);
    }
    loadMacro().catch((e) => console.error("macro context load failed:", e));
  }, []);

  const [macroRatioOpen, setMacroRatioOpen] = useState(false);

  // Whether a RISING value is typically supportive (green) or a warning
  // (red) for that series -- review feedback: color by meaning, not raw
  // direction. Curves/breakevens/bank-lending aren't in this map and stay
  // neutral gray regardless of direction (listed explicitly below, not
  // just "whatever's missing", so a future series addition doesn't
  // silently inherit a polarity that was never decided for it).
  const DIRECTION_POLARITY = { NFCI: "warning", ICSA: "warning", VIX9D: "warning", VVIX: "warning", MOVE: "warning", HGF_GCF_RATIO: "supportive" };
  function directionColorClass(seriesId, direction) {
    const polarity = DIRECTION_POLARITY[seriesId];
    if (direction == null || direction === "flat" || !polarity) return "text-paper-dim";
    const isUp = direction === "up";
    const isGood = polarity === "supportive" ? isUp : !isUp;
    return isGood ? "text-gain" : "text-loss";
  }

  // Current value / 1y+10y percentile / 30d direction / plain-language
  // context per macro-context series -- display only, same percentile-rank
  // tie-handling as the scored sub-indicators, but with NO inversion, NO
  // minHistory gate, and NO effect on composite/tier/exposure_multiplier --
  // nothing computed here is read by anything that feeds scoring.
  const macroContextRows = useMemo(() => {
    const pctRank = (window, x) => {
      let less = 0, equal = 0;
      for (const v of window) { if (v < x) less++; else if (v === x) equal++; }
      return ((less + 0.5 * equal) / window.length) * 100;
    };
    const daysAgoStr = (dateStr, days) => {
      const d = new Date(dateStr); d.setDate(d.getDate() - days);
      return d.toISOString().slice(0, 10);
    };
    const valueBefore = (series, cutoffStr) => {
      for (let i = series.length - 2; i >= 0; i--) if (series[i].date <= cutoffStr) return series[i].value;
      return null;
    };
    const percentiles = (series, last) => {
      const oneYearAgoStr = daysAgoStr(last.date, 365);
      const window1y = series.filter((r) => r.date >= oneYearAgoStr).map((r) => r.value);
      const window10y = series.map((r) => r.value); // fetch is already capped at ~10y
      return {
        percentile1y: window1y.length ? pctRank(window1y, last.value) : null,
        percentile10y: pctRank(window10y, last.value),
      };
    };

    function baseRow(seriesId, meta, series) {
      if (!series || series.length === 0) return { seriesId, meta, missing: true };
      const last = series[series.length - 1];
      const prior30 = valueBefore(series, daysAgoStr(last.date, 30));
      const direction = prior30 == null ? null : (last.value > prior30 ? "up" : last.value < prior30 ? "down" : "flat");
      return { seriesId, meta, missing: false, date: last.date, value: last.value, direction, ...percentiles(series, last) };
    }

    // ICSA: review feedback -- display AND compute (percentile, direction)
    // from the 4-week moving average of ICSA itself, not the raw weekly
    // print. The MA4 series becomes the primary series for this row, not
    // just an input to the "vs 52w low" context line.
    function icsaRow(seriesId, meta, series) {
      if (!series || series.length < 4) return { seriesId, meta, missing: true };
      const ma4Series = series
        .map((r, i) => (i < 3 ? null : { date: r.date, value: (series[i - 3].value + series[i - 2].value + series[i - 1].value + r.value) / 4 }))
        .filter(Boolean);
      const last = ma4Series[ma4Series.length - 1];
      const prior30 = valueBefore(ma4Series, daysAgoStr(last.date, 30));
      const direction = prior30 == null ? null : (last.value > prior30 ? "up" : last.value < prior30 ? "down" : "flat");
      const oneYearAgoStr = daysAgoStr(last.date, 365);
      const window1y = ma4Series.filter((r) => r.date >= oneYearAgoStr).map((r) => r.value);
      const low = window1y.length ? Math.min(...window1y) : null;
      const pctAboveLow = low != null && low !== 0 ? ((last.value - low) / low) * 100 : null;
      const warn = pctAboveLow != null && pctAboveLow >= 20;
      const context = pctAboveLow == null ? "—" : `${pctAboveLow >= 0 ? "+" : ""}${pctAboveLow.toFixed(0)}% vs 52w low${warn ? " — Warning" : ""}`;
      return { seriesId, meta, missing: false, date: last.date, value: last.value, direction, context, warn, ...percentiles(ma4Series, last) };
    }

    function drtscilmRow(seriesId, meta, series) {
      if (!series || series.length === 0) return { seriesId, meta, missing: true };
      const last = series[series.length - 1];
      const prior = series.length >= 2 ? series[series.length - 2].value : null;
      const change = prior != null ? last.value - prior : null;
      const d = new Date(last.date);
      const q = Math.floor(d.getUTCMonth() / 3) + 1;
      const quarterLabel = `${d.getUTCFullYear()} Q${q}`;
      // Review feedback: label on the LEVEL (this series' own sign already
      // means net % tightening vs easing), not the quarter-over-quarter
      // change -- the change is still shown, just not what drives the label.
      const label = last.value > 0 ? "Tightening" : last.value < 0 ? "Easing" : "Unchanged";
      const changeStr = change == null ? "" : ` (${change >= 0 ? "+" : ""}${change.toFixed(1)}pp vs prior qtr)`;
      return { seriesId, meta, missing: false, date: last.date, value: last.value, quarterLabel, context: label + changeStr, noPercentile: true };
    }

    // Series-specific "context" -- natural reference points, not scores.
    // Each rule below is exactly the one specified for that series; any
    // series without a named rule gets no context label (dash), not a
    // guessed one. vixclsRaw comes from the already-loaded scored Stress
    // pillar (S5's raw value IS the current VIXCLS level) -- no separate
    // fetch needed for the VIX9D/VIX ratio.
    const vixclsRaw = latest?.components?.stress?.S5?.raw ?? null;
    function addContext(row, series) {
      if (row.missing || row.context !== undefined) return row; // icsaRow/drtscilmRow already set their own
      const { seriesId, value, date } = row;
      const oneYearAgoStr = daysAgoStr(date, 365);

      if (seriesId === "T10Y3M" || seriesId === "T10Y2Y") {
        if (value < 0) return { ...row, context: "Inverted" };
        const hadInversion = series.some((r) => r.date >= oneYearAgoStr && r.value < 0);
        return { ...row, context: hadInversion ? "Re-steepening after inversion" : "—" };
      }
      if (seriesId === "NFCI") {
        return { ...row, context: value > 0 ? "Tighter than average" : "Looser than average" };
      }
      if (seriesId === "T10YIE" || seriesId === "T5YIFR") {
        const d = value - 2.0;
        return { ...row, context: `${d >= 0 ? "+" : ""}${d.toFixed(2)}pp vs 2.0%` };
      }
      if (seriesId === "VIX9D") {
        if (vixclsRaw == null || vixclsRaw === 0) return { ...row, context: "—" };
        return { ...row, context: (value / vixclsRaw) >= 1.0 ? "Short-term stress" : "—" };
      }
      if (seriesId === "VVIX") {
        return { ...row, context: value >= 115 ? "Elevated hedging demand" : "—" };
      }
      // MOVE: percentile only, no context label (explicit per review).
      return { ...row, context: "—" };
    }

    const rows = [];
    for (const [seriesId, meta] of Object.entries(MACRO_CONTEXT_META)) {
      if (seriesId === "HGF" || seriesId === "GCF") continue; // folded into the ratio row below
      const series = macroSeries[seriesId] ?? [];
      const row = seriesId === "ICSA" ? icsaRow(seriesId, meta, series)
        : seriesId === "DRTSCILM" ? drtscilmRow(seriesId, meta, series)
        : baseRow(seriesId, meta, series);
      rows.push(addContext(row, series));
    }

    // Copper/gold ratio -- synthetic row, not its own mc_series_daily
    // series; HGF/GCF's own rows are collapsed into this one (expandable,
    // see macroRatioOpen). Joined by date from the already-fetched HGF/GCF
    // series; 3-month change is the series-specific context rule (rising =
    // growth improving, "falling = growth softening" is the natural
    // opposite, not separately specified). Displayed at x1000 -- the raw
    // ratio is ~0.001-0.002, unreadable at 2 decimal places otherwise.
    const hgf = macroSeries.HGF, gcf = macroSeries.GCF;
    if (hgf?.length && gcf?.length) {
      const gcfByDate = new Map(gcf.map((r) => [r.date, r.value]));
      const ratioSeries = hgf.filter((r) => gcfByDate.has(r.date)).map((r) => ({ date: r.date, value: r.value / gcfByDate.get(r.date) }));
      if (ratioSeries.length) {
        const last = ratioSeries[ratioSeries.length - 1];
        const prior3mo = valueBefore(ratioSeries, daysAgoStr(last.date, 90));
        const change3mo = prior3mo != null ? last.value - prior3mo : null;
        rows.push({
          seriesId: "HGF_GCF_RATIO",
          meta: { group: "Commodities", label: "Copper / gold ratio", unit: "", displayMultiplier: 1000, displaySuffix: "×1,000" },
          missing: false,
          date: last.date,
          value: last.value,
          direction: change3mo == null ? null : (change3mo > 0 ? "up" : change3mo < 0 ? "down" : "flat"),
          context: change3mo == null ? "—" : (change3mo > 0 ? "Growth improving" : change3mo < 0 ? "Growth softening" : "Flat"),
          ...percentiles(ratioSeries, last),
          raw: {
            hgf: hgf[hgf.length - 1], gcf: gcf[gcf.length - 1],
            hgfMeta: MACRO_CONTEXT_META.HGF, gcfMeta: MACRO_CONTEXT_META.GCF,
          },
        });
      }
    }

    return rows;
  }, [macroSeries, latest]);

  const macroGroups = useMemo(() => {
    const groups = {};
    for (const r of macroContextRows) (groups[r.meta.group] ??= []).push(r);
    return groups;
  }, [macroContextRows]);

  // Merge SPY closes + tier/entry history into one chart series, once.
  const fullSeries = useMemo(() => {
    if (!spyPrices.length) return [];
    const byDate = new Map(history.map((h) => [h.date, h]));
    return spyPrices.map((p) => {
      const h = byDate.get(p.date);
      return { date: p.date, close: Number(p.close), tier: h?.tier ?? null, entrySignal: h?.entry_signal ?? null, entryReason: h?.entry_reason ?? null };
    });
  }, [spyPrices, history]);

  const chartData = useMemo(() => {
    const r = RANGES.find((x) => x.label === range);
    if (!r || r.days == null) return fullSeries;
    return fullSeries.slice(-r.days);
  }, [fullSeries, range]);

  // Contiguous tier segments for background shading.
  const tierZones = useMemo(() => {
    const zones = [];
    let cur = null;
    for (const d of chartData) {
      if (!d.tier) continue;
      if (!cur || cur.tier !== d.tier) {
        if (cur) zones.push(cur);
        cur = { tier: d.tier, from: d.date, to: d.date };
      } else {
        cur.to = d.date;
      }
    }
    if (cur) zones.push(cur);
    return zones;
  }, [chartData]);

  // Episode-start markers for ADD (E-DIP) / WAIT (E-HOT) -- first day of
  // each streak, not every day, so the chart isn't saturated with dots.
  // Added as fields ON chartData itself (null on every other row), NOT a
  // separately-sized array passed as a Scatter's own `data` prop --
  // Recharts positions a child series' OWN `data` array by that array's
  // index into the shared category x-axis, not by matching date values
  // against the parent's `data`, so a shorter marker array rendered
  // dramatically misaligned (clustered at the start) when tried that way.
  const chartDataWithMarkers = useMemo(() => {
    let prevReason = null;
    return chartData.map((d) => {
      const isEpisodeStart = (d.entryReason === "E-DIP" || d.entryReason === "E-HOT") && d.entryReason !== prevReason;
      prevReason = d.entryReason;
      return {
        ...d,
        addMarker: isEpisodeStart && d.entryReason === "E-DIP" ? d.close : null,
        waitMarker: isEpisodeStart && d.entryReason === "E-HOT" ? d.close : null,
      };
    });
  }, [chartData]);

  // Live track record.
  const liveStats = useMemo(() => {
    if (!liveLog.length) return null;
    let tierChanges = 0;
    for (let i = 1; i < liveLog.length; i++) if (liveLog[i].tier !== liveLog[i - 1].tier) tierChanges++;
    const dateToIdx = new Map(spyPrices.map((p, i) => [p.date, i]));
    const forwardReturns = [];
    for (const row of liveLog) {
      // mc_signal_log only stores entry_signal (ADD/WAIT/NEUTRAL), not the
      // finer-grained entry_reason (E-DIP vs E-HOT vs E-DOWN) -- that finer
      // label only exists on market_conditions_scores' current-state row.
      // ADD is unambiguous (only E-DIP produces it); WAIT covers both
      // E-HOT and E-DOWN, shown generically as "WAIT" rather than
      // guessing which rule fired.
      if (row.entry_signal !== "ADD" && row.entry_signal !== "WAIT") continue;
      const idx = dateToIdx.get(row.date);
      if (idx == null) continue;
      if (idx + LIVE_FORWARD_HORIZON >= spyPrices.length) continue; // not enough elapsed trading days yet
      const ret = Number(spyPrices[idx + LIVE_FORWARD_HORIZON].close) / Number(spyPrices[idx].close) - 1;
      forwardReturns.push({ date: row.date, reason: row.entry_signal, retPct: ret * 100 });
    }
    return {
      startDate: liveLog[0].date,
      daysLogged: liveLog.length,
      tierChanges,
      forwardReturns,
    };
  }, [liveLog, spyPrices]);

  if (busy) {
    return (
      <Shell>
        <p className="text-paper-dim text-sm">Loading…</p>
      </Shell>
    );
  }
  if (!latest) {
    return (
      <Shell>
        <div className="card p-10 text-center"><p className="text-paper-dim text-sm">No data yet.</p></div>
      </Shell>
    );
  }

  const tier = TIER_META[latest.tier] ?? TIER_META.NORMAL;
  const trend = TREND_STATE_META[latest.trend_state] ?? TREND_STATE_META.MIXED;
  const entry = entrySignalDisplay(latest.entry_reason);
  const staleInputs = latest.flags?.stale_inputs;
  const staleKeys = staleInputs ? Object.keys(staleInputs) : [];

  return (
    <Shell>
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Market Conditions</h1>
          <p className="text-xs text-paper-dim mt-0.5">
            Tactical exposure &amp; entry-timing overlay · as of {fmtDate(latest.date)} · {latest.config_version}
          </p>
        </div>
      </div>

      {/* Hero */}
      <div className="grid grid-cols-1 lg:grid-cols-[220px_220px_1fr] gap-4 mb-6">
        <div className={`card p-5 flex flex-col items-center justify-center border ${tier.border} ${tier.bg}`}>
          <p className="label text-[10px] mb-2">Tier</p>
          <p className={`text-3xl font-bold ${tier.tone}`}>{tier.label}</p>
          <p className="num text-sm text-paper-dim mt-1">exposure ×{Number(latest.exposure_multiplier).toFixed(2)}</p>
        </div>
        <div className="card p-5 flex flex-col items-center justify-center text-center">
          <p className="label text-[10px] mb-2">Trend</p>
          <p className={`text-2xl font-semibold ${trend.tone}`}>{trend.label}</p>
          <p className="num text-[11px] text-paper-dim mt-1">composite {fmtNum(latest.composite)}</p>
        </div>
        <div className="card p-4">
          <p className="label text-[10px] mb-2">Entry signal</p>
          <p className={`text-lg font-semibold ${entry.tone}`}>{entry.signal}</p>
          <p className="text-[11px] text-paper-dim leading-relaxed mt-1">{entry.text}</p>
          {latest.veto_active && (
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
        </div>
      </div>

      {/* Pillar bars */}
      <div className="card p-4 mb-6">
        <p className="label text-[10px] mb-3">Pillars</p>
        <div className="space-y-3 max-w-md">
          <PillarBar label="Trend" score={latest.score_trend != null ? Number(latest.score_trend) : null} />
          <PillarBar label="Stress" score={latest.score_stress != null ? Number(latest.score_stress) : null} />
          <div>
            <div className="flex items-baseline justify-between text-xs mb-1">
              <span className="text-paper-dim">Breadth</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-ink-line text-paper-dim">Tested, not scored</span>
            </div>
            <div className="h-2 w-full bg-ink rounded opacity-40" />
          </div>
        </div>
        <p className="text-[10px] text-paper-dim/60 mt-3">
          Breadth was built and validated (proxy pillar, 9 sector SPDRs + RSP/SPY) but rejected on its own pre-registered criteria — worse Calmar on every market tested. See the Validation panel below and docs/market-conditions/DECISIONS.md.
        </p>
      </div>

      {/* Drill-down table */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="card p-4">
          <p className="label text-[10px] mb-3">Trend sub-indicators</p>
          <table className="w-full">
            <thead>
              <tr className="text-[10px] text-paper-dim border-b border-ink-line">
                <th className="text-left pb-2 font-normal">Indicator</th>
                <th className="text-right pb-2 font-normal">Raw</th>
                <th className="text-right pb-2 font-normal">Score</th>
                <th className="text-right pb-2 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {["T1", "T2", "T3", "T4"].map((code) => (
                <SubIndicatorRow
                  key={code} code={code} ind={latest.components?.trend?.[code]} staleInputs={staleInputs}
                  open={openSubIndicator === code} onToggle={() => toggleSubIndicator(code)}
                />
              ))}
            </tbody>
          </table>
        </div>
        <div className="card p-4">
          <p className="label text-[10px] mb-3">Stress sub-indicators</p>
          <table className="w-full">
            <thead>
              <tr className="text-[10px] text-paper-dim border-b border-ink-line">
                <th className="text-left pb-2 font-normal">Indicator</th>
                <th className="text-right pb-2 font-normal">Raw</th>
                <th className="text-right pb-2 font-normal">Score</th>
                <th className="text-right pb-2 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {["S1", "S2", "S3", "S4", "S5", "S6"].map((code) => (
                <SubIndicatorRow
                  key={code} code={code} ind={latest.components?.stress?.[code]} staleInputs={staleInputs}
                  open={openSubIndicator === code} onToggle={() => toggleSubIndicator(code)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Macro context (Phase 4 scope reduced to display-only) -- NOT
         scored, composite/tier/exposure_multiplier are unaffected. */}
      <div className="card p-4 mb-6">
        <p className="label text-[10px] mb-1">Macro context</p>
        <p className="text-[10px] text-paper-dim/60 mb-1">Display only — not scored, no effect on tier or exposure. "As of" lags today for weekly/quarterly series (real reporting delay, not stale data). Percentiles rank the current value against its own trailing history.</p>
        <p className="text-[10px] text-paper-dim/60 mb-3">
          <span className="text-gain">▲/▼</span> colored by whether rising is typically supportive (green) or a warning (red) for that series — not by raw direction. Curves, breakevens, and bank-lending standards are shown neutral (gray) regardless of direction.
        </p>
        <div className="overflow-x-auto">
          {Object.entries(macroGroups).map(([group, rows]) => (
            <div key={group} className="mb-5 last:mb-0 min-w-[760px]">
              <p className="text-[10px] text-paper-dim uppercase tracking-wide mb-1.5">{group}</p>
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-paper-dim border-b border-ink-line">
                    <th className="text-left pb-1.5 font-normal">Series</th>
                    <th className="text-right pb-1.5 font-normal">As of</th>
                    <th className="text-right pb-1.5 font-normal">Current</th>
                    <th className="text-right pb-1.5 font-normal">1y pctl</th>
                    <th className="text-right pb-1.5 font-normal">10y pctl</th>
                    <th className="text-right pb-1.5 font-normal">30d</th>
                    <th className="text-left pb-1.5 pl-3 font-normal">Context</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isRatio = r.seriesId === "HGF_GCF_RATIO";
                    const displayValue = r.missing ? null : (r.meta.displayMultiplier ? r.value * r.meta.displayMultiplier : r.value);
                    return (
                    <Fragment key={r.seriesId}>
                      <tr className="border-b border-ink-line/50 last:border-0">
                        <td className="py-1.5 pr-3">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="text-paper text-sm font-medium">{r.seriesId}</span>
                            <span className="text-paper-dim text-[11px]">{r.meta.label}</span>
                            {isRatio && (
                              <StageInfoIcon active={macroRatioOpen} onClick={() => setMacroRatioOpen((v) => !v)} label="Show copper/gold raw legs" />
                            )}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3 num text-[11px] text-paper-dim text-right whitespace-nowrap">
                          {r.missing ? "—" : fmtDate(r.date)}
                        </td>
                        <td className="py-1.5 pr-3 num text-sm text-paper text-right whitespace-nowrap">
                          {r.missing ? "—" : r.quarterLabel
                            ? `${fmtNum(r.value, 1)}% (${r.quarterLabel})`
                            : `${fmtNum(displayValue, 2)}${r.meta.unit ? ` ${r.meta.unit}` : ""}${r.meta.displaySuffix ? ` ${r.meta.displaySuffix}` : ""}`}
                        </td>
                        <td className="py-1.5 pr-3 num text-[11px] text-paper-dim text-right whitespace-nowrap">
                          {r.missing || r.noPercentile || r.percentile1y == null ? "—" : `${Math.round(r.percentile1y)}th`}
                        </td>
                        <td className="py-1.5 pr-3 num text-[11px] text-paper-dim text-right whitespace-nowrap">
                          {r.missing || r.noPercentile || r.percentile10y == null ? "—" : `${Math.round(r.percentile10y)}th`}
                        </td>
                        <td className="py-1.5 pr-3 text-right whitespace-nowrap">
                          {r.missing ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded border border-loss/30 text-loss">no data</span>
                          ) : r.direction === "up" ? (
                            <span className={`text-[11px] ${directionColorClass(r.seriesId, "up")}`}>▲</span>
                          ) : r.direction === "down" ? (
                            <span className={`text-[11px] ${directionColorClass(r.seriesId, "down")}`}>▼</span>
                          ) : r.direction === "flat" ? (
                            <span className="text-[11px] text-paper-dim">flat</span>
                          ) : (
                            <span className="text-[11px] text-paper-dim">—</span>
                          )}
                        </td>
                        <td className="py-1.5 pl-3 text-left whitespace-nowrap">
                          {!r.missing && r.context && r.context !== "—" ? (
                            <span className={`text-[11px] ${r.warn ? "text-loss font-medium" : "text-paper-dim"}`}>{r.context}</span>
                          ) : (
                            <span className="text-[11px] text-paper-dim">—</span>
                          )}
                        </td>
                      </tr>
                      {isRatio && macroRatioOpen && r.raw && (
                        <tr className="border-b border-ink-line/50 last:border-0">
                          <td colSpan={7} className="pb-2 pt-0.5">
                            <div className="p-2.5 rounded-lg border border-ink-line bg-ink text-[11px] leading-relaxed flex gap-6">
                              <span><span className="text-paper-dim">HGF</span> <span className="text-paper">{r.raw.hgfMeta.label}</span> — <span className="num text-paper">{fmtNum(r.raw.hgf.value, 3)}</span> <span className="text-paper-dim">as of {fmtDate(r.raw.hgf.date)}</span></span>
                              <span><span className="text-paper-dim">GCF</span> <span className="text-paper">{r.raw.gcfMeta.label}</span> — <span className="num text-paper">{fmtNum(r.raw.gcf.value, 2)}</span> <span className="text-paper-dim">as of {fmtDate(r.raw.gcf.date)}</span></span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>

      {/* History chart */}
      <div className="card p-4 mb-6">
        <div className="flex items-baseline justify-between mb-3 gap-2 flex-wrap">
          <p className="label text-[10px]">History — SPY (log scale), shaded by tier</p>
          <div className="flex items-center gap-1">
            {RANGES.map((r) => (
              <button
                key={r.label}
                onClick={() => setRange(r.label)}
                className={`text-[11px] px-2 py-1 rounded ${range === r.label ? "bg-ink-soft text-brass-soft" : "text-paper-dim hover:text-paper"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={chartDataWithMarkers} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            {tierZones.map((z, i) => (
              <ReferenceArea key={`${z.tier}-${z.from}-${i}`} x1={z.from} x2={z.to} fill={TIER_FILL[z.tier] ?? "transparent"} fillOpacity={TIER_OPACITY[z.tier] ?? 0} stroke="none" />
            ))}
            <XAxis dataKey="date" tick={{ fill: DIM, fontSize: 9 }} tickLine={false} axisLine={false} minTickGap={50} />
            <YAxis scale="log" domain={["auto", "auto"]} tick={{ fill: DIM, fontSize: 10 }} tickLine={false} axisLine={false} width={40} />
            <Tooltip content={<ChartTooltip />} />
            <Line type="monotone" dataKey="close" name="SPY" stroke={PAPER} strokeWidth={1.25} dot={false} isAnimationActive={false} />
            <Scatter dataKey="addMarker" name="ADD (E-DIP)" fill={GAIN} shape="circle" legendType="none" isAnimationActive={false} />
            <Scatter dataKey="waitMarker" name="WAIT (E-HOT)" fill={BRASS} shape="triangle" legendType="none" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="flex flex-wrap items-center gap-4 mt-2 text-[10px] text-paper-dim/70">
          <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full" style={{ background: GAIN }} />ADD (E-DIP) — episode start</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full" style={{ background: BRASS }} />WAIT (E-HOT) — episode start</span>
          <span>Background shading: green = Full, amber = Cautious/Defensive, red = Risk-off.</span>
        </div>
      </div>

      {/* Live track record */}
      <div className="card p-4 mb-6">
        <p className="label text-[10px] mb-3">Live track record</p>
        <p className="text-[11px] text-paper-dim leading-relaxed mb-3">
          From <span className="text-paper">mc_signal_log_live</span> only — rows written within 4 days of their own signal date, excluding the initial historical backfill. This is the true out-of-sample record; everything above and in Validation is in-sample or the SPX-tuned config applied unchanged to other markets, not a live forward test.
        </p>
        {!liveStats ? (
          <p className="text-paper-dim text-sm">No live rows yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-3">
              <div>
                <p className="text-[10px] text-paper-dim">Live record start</p>
                <p className="num text-sm text-paper">{fmtDate(liveStats.startDate)}</p>
              </div>
              <div>
                <p className="text-[10px] text-paper-dim">Days logged</p>
                <p className="num text-sm text-paper">{liveStats.daysLogged}</p>
              </div>
              <div>
                <p className="text-[10px] text-paper-dim">Tier changes</p>
                <p className="num text-sm text-paper">{liveStats.tierChanges}</p>
              </div>
            </div>
            <p className="label text-[10px] mb-2">Forward returns after live signals (21 trading days)</p>
            {liveStats.forwardReturns.length === 0 ? (
              <p className="text-[11px] text-paper-dim">Accumulating — no live signal has 21 trading days of history yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] text-paper-dim border-b border-ink-line">
                    <th className="text-left pb-2 font-normal">Date</th>
                    <th className="text-left pb-2 font-normal">Signal</th>
                    <th className="text-right pb-2 font-normal">21d forward return</th>
                  </tr>
                </thead>
                <tbody>
                  {liveStats.forwardReturns.map((r) => (
                    <tr key={r.date} className="border-b border-ink-line last:border-b-0">
                      <td className="py-2 text-paper">{fmtDate(r.date)}</td>
                      <td className="py-2 text-paper-dim">{r.reason}</td>
                      <td className={`py-2 num text-right ${r.retPct >= 0 ? "text-gain" : "text-loss"}`}>{r.retPct >= 0 ? "+" : ""}{r.retPct.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      {/* Validation panel */}
      <div className="card p-4 mb-6">
        <div className="flex items-baseline justify-between mb-3 gap-2 flex-wrap">
          <p className="label text-[10px]">Validation</p>
          <span className="text-[10px] text-paper-dim/70">frozen reference data, as of {VALIDATION_SUMMARY.asOf} — not recomputed live</span>
        </div>

        <p className="text-xs text-brass-soft mb-1">{VALIDATION_SUMMARY.backtest.label}</p>
        <p className="text-[10px] text-paper-dim mb-2">{VALIDATION_SUMMARY.backtest.window} · {VALIDATION_SUMMARY.backtest.note}</p>
        <div className="overflow-x-auto mb-5">
          <table className="w-full text-sm min-w-[480px]">
            <thead>
              <tr className="text-[10px] text-paper-dim border-b border-ink-line">
                <th className="text-left pb-2 font-normal">Portfolio</th>
                <th className="text-right pb-2 font-normal">CAGR</th>
                <th className="text-right pb-2 font-normal">Vol</th>
                <th className="text-right pb-2 font-normal">Sharpe</th>
                <th className="text-right pb-2 font-normal">Max DD</th>
                <th className="text-right pb-2 font-normal">Calmar</th>
              </tr>
            </thead>
            <tbody>
              {VALIDATION_SUMMARY.backtest.rows.map((r) => (
                <tr key={r.name} className="border-b border-ink-line last:border-b-0">
                  <td className="py-2 text-paper">{r.name}</td>
                  <td className="py-2 num text-right text-paper">{r.cagrPct.toFixed(2)}%</td>
                  <td className="py-2 num text-right text-paper-dim">{r.volPct.toFixed(2)}%</td>
                  <td className="py-2 num text-right text-paper-dim">{r.sharpe.toFixed(2)}</td>
                  <td className="py-2 num text-right text-loss">{r.maxDDPct.toFixed(2)}%</td>
                  <td className="py-2 num text-right text-paper font-semibold">{r.calmar.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-brass-soft mb-1">{VALIDATION_SUMMARY.crossMarket.label}</p>
        <p className="text-[10px] text-paper-dim mb-2">{VALIDATION_SUMMARY.crossMarket.note}</p>
        <div className="overflow-x-auto mb-5">
          <table className="w-full text-sm min-w-[360px]">
            <thead>
              <tr className="text-[10px] text-paper-dim border-b border-ink-line">
                <th className="text-left pb-2 font-normal">Market</th>
                <th className="text-right pb-2 font-normal">Overlay Calmar</th>
                <th className="text-right pb-2 font-normal">200-day Calmar</th>
                <th className="text-right pb-2 font-normal">Buy &amp; hold Calmar</th>
              </tr>
            </thead>
            <tbody>
              {VALIDATION_SUMMARY.crossMarket.rows.map((r) => (
                <tr key={r.market} className="border-b border-ink-line last:border-b-0">
                  <td className="py-2 text-paper">{r.market}</td>
                  <td className="py-2 num text-right text-paper font-semibold">{r.overlay.toFixed(2)}</td>
                  <td className="py-2 num text-right text-paper-dim">{r.rule200.toFixed(2)}</td>
                  <td className="py-2 num text-right text-paper-dim">{r.buyHold.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-brass-soft mb-1">{VALIDATION_SUMMARY.entryRules.label}</p>
        <p className="text-[10px] text-paper-dim mb-2">{VALIDATION_SUMMARY.entryRules.note}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[520px]">
            <thead>
              <tr className="text-[10px] text-paper-dim border-b border-ink-line">
                <th className="text-left pb-2 font-normal">Rule</th>
                <th className="text-right pb-2 font-normal">SPY</th>
                <th className="text-right pb-2 font-normal">QQQ</th>
                <th className="text-right pb-2 font-normal">IWM</th>
                <th className="text-right pb-2 font-normal">EFA</th>
              </tr>
            </thead>
            <tbody>
              {VALIDATION_SUMMARY.entryRules.rows.map((r) => (
                <tr key={r.rule} className="border-b border-ink-line last:border-b-0">
                  <td className="py-2 text-paper">{r.rule}</td>
                  <td className={`py-2 text-right text-xs ${r.spy.startsWith("pass") ? "text-gain" : r.spy.startsWith("fail") ? "text-loss" : "text-paper-dim"}`}>{r.spy}</td>
                  <td className={`py-2 text-right text-xs ${r.qqq.startsWith("pass") ? "text-gain" : r.qqq.startsWith("fail") ? "text-loss" : "text-paper-dim"}`}>{r.qqq}</td>
                  <td className={`py-2 text-right text-xs ${r.iwm.startsWith("pass") ? "text-gain" : r.iwm.startsWith("fail") ? "text-loss" : "text-paper-dim"}`}>{r.iwm}</td>
                  <td className={`py-2 text-right text-xs ${r.efa.startsWith("pass") ? "text-gain" : r.efa.startsWith("fail") ? "text-loss" : "text-paper-dim"}`}>{r.efa}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  );
}
