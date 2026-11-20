// Shared ISM press-release sub-index extractor. Originally written inline
// in scrape-ism-services (the (?!age) guard fixes a real false-match:
// reports commonly phrase a sub-index change as "increasing 3.7
// percentage points to 59.1 percent", and a naive /(\d+)\s+percent/
// grabs the "3.7 percentage points" change instead of the real index
// value). Growth & Inflation Indicator Gaps spec, Phase 2a pulled this
// into _shared/ so scrape-ism (Manufacturing) gets the same fix for its
// own New Orders extraction, and both scrapers share one implementation
// for the new Prices Paid extraction rather than maintaining two copies
// of the same regex.
export function extractIndexValue(text: string, label: string, anchorIdx: number): number | null {
  const idx = text.indexOf(label, anchorIdx);
  if (idx === -1) return null;
  const window = text.slice(idx, idx + 250);
  const m = window.match(/([\d.]+)\s+percent(?!age)/i);
  return m ? parseFloat(m[1]) : null;
}
