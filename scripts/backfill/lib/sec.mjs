// Shared SEC XBRL helpers for the backfill scripts -- generalized from
// supabase/functions/compute-capex-cycle/index.ts's fetchSecConcept /
// deriveQuarters / nearestCalQuarterEnd / prevCalQuarterEnd (per the Phase
// 2a spec's instruction to reuse/generalize that pattern, not rewrite it).
// compute-capex-cycle's own copy is untouched; this is a separate module.
//
// Two generalizations beyond the original, both required for fundamentals
// that capex-cycle never needed:
//
// 1. Instant facts. capex-cycle only ever fetches duration/flow concepts
//    (capex, ocf, revenue, debt-issued), which SEC XBRL reports with both
//    `start` and `end`. Balance-sheet items (Assets, Liabilities,
//    StockholdersEquity, cash, debt balances) are INSTANT facts -- a
//    snapshot with only `end`, no `start` at all. The original
//    fetchSecConcept's `u.start && u.end` filter would silently drop every
//    instant fact. fetchSecConcept here takes a `kind` ("duration" or
//    "instant") and filters accordingly; instant entries carry
//    start: null.
//
// 2. Units. capex-cycle only reads `units.USD`. EPS is `USD/shares` and
//    share counts are `shares`. fetchSecConcept takes a `unit` parameter.
//
// Point-in-time vintage rule (the one deliberate behavior change from the
// original): compute-capex-cycle's deriveQuarters keeps the LATEST-filed
// value per period (right for a live macro overlay -- use the best
// currently-known number). A point-in-time fundamentals dataset needs the
// OPPOSITE: the value AS ORIGINALLY FILED, so a later restatement doesn't
// retroactively change what was knowable at the time. Every dedup here
// keeps the EARLIEST `filed` date on a tie, not the latest.

export const SEC_UA = { "User-Agent": "Ratiobo research (ratiobo.com)", "Accept": "application/json" };
export const SEC_THROTTLE_MS = 120; // ~8.3 req/s, matches compute-capex-cycle's own throttle, under SEC's 10 req/s cap

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DAY = 86400000;

export function padCik(cikStr) {
  return String(cikStr).padStart(10, "0");
}

export function nearestCalQuarterEnd(d) {
  const t = Date.parse(d);
  const y = parseInt(d.slice(0, 4));
  const cands = [`${y - 1}-12-31`, `${y}-03-31`, `${y}-06-30`, `${y}-09-30`, `${y}-12-31`];
  return cands.reduce((best, c) => (Math.abs(Date.parse(c) - t) < Math.abs(Date.parse(best) - t) ? c : best));
}

export function prevCalQuarterEnd(q, n = 1) {
  let y = parseInt(q.slice(0, 4));
  let m = parseInt(q.slice(5, 7));
  for (let i = 0; i < n; i++) {
    m -= 3;
    if (m <= 0) { m += 12; y--; }
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${last}`;
}

// entry shape: { start: string|null, end, val, filed, form }. Shared
// between the per-company HTTP path (fetchSecConcept, below) and the
// companyfacts.zip bulk-file path (load_fundamentals_bulk.mjs) -- both
// must apply IDENTICAL filtering to the same raw units array, since the
// Phase 2a step-5 pilot is only valid if the two paths produce identical
// output from identical input.
export function filterUnitsEntries(units, kind) {
  if (!units) return null;
  if (kind === "instant") {
    return units
      .filter((u) => u.end && typeof u.val === "number" && /^10-[QK]/.test(String(u.form)))
      .map((u) => ({ start: null, end: String(u.end), val: Number(u.val), filed: String(u.filed), form: String(u.form) }));
  }
  return units
    .filter((u) => u.start && u.end && typeof u.val === "number" && /^10-[QK]/.test(String(u.form)))
    .map((u) => ({ start: String(u.start), end: String(u.end), val: Number(u.val), filed: String(u.filed), form: String(u.form) }));
}

export async function fetchSecConcept(cik, tag, { unit = "USD", kind = "duration", namespace = "us-gaap" } = {}) {
  const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${padCik(cik)}/${namespace}/${tag}.json`, { headers: SEC_UA });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`SEC ${cik}/${tag}: HTTP ${res.status}`);
  const j = await res.json();
  return filterUnitsEntries(j?.units?.[unit], kind);
}

// Point-in-time instant facts: one row per distinct `end` date, keeping the
// EARLIEST-filed vintage when a company re-files the same balance-sheet
// date (restatement) -- the value as originally reported, not as later
// corrected.
export function dedupeInstant(entries) {
  const earliest = new Map(); // end -> entry
  for (const e of entries) {
    const cur = earliest.get(e.end);
    if (!cur || e.filed < cur.filed) earliest.set(e.end, e);
  }
  return [...earliest.values()].sort((a, b) => a.end.localeCompare(b.end));
}

// Derive single-quarter values from a mix of 3-month and YTD cumulative
// duration filings -- same structure as compute-capex-cycle's
// deriveQuarters, but EARLIEST-filed wins on a tie (point-in-time), not
// latest-filed, and YTD differencing uses the earliest-filed vintage of
// each component so a derived quarter also reflects only what was knowable
// at the time its underlying filings were made.
export function deriveQuarters(entries, tag) {
  const earliest = new Map(); // "start|end" -> entry
  for (const e of entries) {
    const k = `${e.start}|${e.end}`;
    const cur = earliest.get(k);
    if (!cur || e.filed < cur.filed) earliest.set(k, e);
  }
  const all = [...earliest.values()];
  const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;
  const out = new Map(); // end -> quarter
  for (const e of all) {
    const d = dur(e);
    if (d >= 80 && d <= 100) out.set(e.end, { period_end: e.end, value: e.val, derived: false, tag, filed: e.filed });
  }
  const byStart = new Map();
  for (const e of all) {
    if (dur(e) > 100 && dur(e) < 380) {
      const arr = byStart.get(e.start) ?? [];
      arr.push(e);
      byStart.set(e.start, arr);
    }
  }
  for (const [start, arr] of byStart) {
    const q1 = all.find((e) => e.start === start && dur(e) >= 80 && dur(e) <= 100);
    const chain = [...(q1 ? [q1] : []), ...arr].sort((a, b) => a.end.localeCompare(b.end));
    for (let i = 1; i < chain.length; i++) {
      const gap = (Date.parse(chain[i].end) - Date.parse(chain[i - 1].end)) / DAY;
      if (gap < 80 || gap > 100) continue;
      if (out.has(chain[i].end) && !out.get(chain[i].end).derived) continue;
      out.set(chain[i].end, {
        period_end: chain[i].end,
        value: chain[i].val - chain[i - 1].val,
        derived: true,
        tag,
        filed: chain[i].filed > chain[i - 1].filed ? chain[i].filed : chain[i - 1].filed, // not public until BOTH components were
      });
    }
  }
  return [...out.values()].sort((a, b) => a.period_end.localeCompare(b.period_end));
}
