// Structured-judgment scoring for China Watch — shared by the dashboard (live
// recompute as sliders move) and duplicated in Deno in the update-china-watch
// and update-supply-chain-risk edge functions (same convention as the other
// Dalio gauges: server-computed values are the source of truth; this module
// exists so the client can preview composites before saving).

export function pillarAvg(scores) {
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// pillarAvgsByGroup: { ED: [pillarAvg, pillarAvg, ...], WC: [...], PT: [...], ER: [...] }
export function composites(pillarAvgsByGroup) {
  const avg = (arr) => (arr && arr.length ? pillarAvg(arr) : 0);
  return {
    ED: avg(pillarAvgsByGroup.ED) * 10,
    WC: avg(pillarAvgsByGroup.WC) * 10,
    PT: avg(pillarAvgsByGroup.PT) * 10,
    ER: avg(pillarAvgsByGroup.ER) * 10,
  };
}

export function spi(c) {
  return 0.4 * c.ED + 0.35 * c.WC + 0.25 * c.PT;
}

export function scenarioSplit(spiValue, er) {
  const t = Math.min(Math.max(spiValue / 100, 0), 1);
  const t0 = [70, 20, 8, 2];   // grayzone, quarantine, blockade, invasion @ SPI=0
  const t1 = [10, 15, 35, 40]; // @ SPI=100
  const base = t0.map((v, i) => v + (t1[i] - v) * t);
  let blockade = base[2] - ((er - 50) / 50) * 15;
  let invasion = base[3] + ((er - 50) / 50) * 15;
  if (blockade < 0) { invasion += blockade; blockade = 0; }
  if (invasion < 0) { blockade += invasion; invasion = 0; }
  const [grayzone, quarantine] = base;
  const total = grayzone + quarantine + blockade + invasion;
  return {
    grayzone: (grayzone / total) * 100,
    quarantine: (quarantine / total) * 100,
    blockade: (blockade / total) * 100,
    invasion: (invasion / total) * 100,
  };
}

export function pressureBand(spiValue) {
  if (spiValue < 35) return { label: "Low pressure", color: "text-gain" };
  if (spiValue < 60) return { label: "Moderate pressure", color: "text-brass-soft" };
  if (spiValue < 80) return { label: "Elevated pressure", color: "text-loss" };
  return { label: "Severe pressure", color: "text-loss" };
}

// Groups indicators by pillar, averages each pillar, then rolls pillar
// averages up into the four composites, SPI, and scenario split. Indicators
// use a flat { pillarId, pillarGroup, score }[] shape (matches the
// china_watch_indicators table).
export function computeAll(indicators) {
  const byPillar = new Map();
  for (const ind of indicators) {
    if (!byPillar.has(ind.pillarId)) byPillar.set(ind.pillarId, { group: ind.pillarGroup, scores: [] });
    byPillar.get(ind.pillarId).scores.push(Number(ind.score));
  }
  const byGroup = { ED: [], WC: [], PT: [], ER: [] };
  for (const { group, scores } of byPillar.values()) {
    byGroup[group].push(pillarAvg(scores));
  }
  const c = composites(byGroup);
  const spiValue = spi(c);
  const scenarios = scenarioSplit(spiValue, c.ER);
  return { ...c, spi: spiValue, ...scenarios, band: pressureBand(spiValue) };
}
