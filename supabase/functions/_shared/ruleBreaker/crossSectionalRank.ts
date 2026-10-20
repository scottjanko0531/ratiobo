// Rule Breaker Screener — cross-sectional percentile-ranking engine.
// Deliberately named/structured distinctly from
// marketConditions/normalize.ts's existing `percentileRank`: that one is
// TEMPORAL (a value vs its own trailing history, denominator = window
// length, mean-rank-via-(less+0.5*equal)/n) -- a materially different
// formula that was tested against this engine's own real ground truth and
// does NOT reproduce it (136/155 match vs this module's 155/155). Ranking
// one symbol against its ~155 peers on the SAME day is a different
// operation; reusing the existing helper here would silently produce wrong
// numbers.
//
// Confirmed formula (mean-rank tie convention, denominator n-1 not n):
//   midRank = (countLessThan(x) + countLessOrEqual(x) - 1) / 2
//   pct = midRank / (n - 1) * 100
// Verified 155/155 exact match reproducing `score` from `composite` across
// every baseline row, INCLUDING every tie case (e.g. two symbols sharing
// composite=77.667 both correctly resolve to score=93 via mean-rank, not
// 92 which a naive strict-less-than-only rank would give).

export interface CrossSectionalRankOptions {
  // "Lower is better" metrics invert via the identity pct' = 100 - pct --
  // derived algebraically (swapping which side of the sort counts as
  // "better" is equivalent to counting from the other end), not a separate
  // formula to maintain.
  lowerIsBetter?: boolean;
}

// `universe` MUST already include `x` itself (confirmed convention: n is
// the full live universe size, e.g. 155, not 154 excluding the symbol
// being ranked).
export function crossSectionalPercentile(
  universe: number[],
  x: number,
  options: CrossSectionalRankOptions = {},
): number {
  const n = universe.length;
  if (n <= 1) return 50;
  const sorted = [...universe].sort((a, b) => a - b);
  const lo = lowerBound(sorted, x);
  const hi = upperBound(sorted, x);
  const midRank = (lo + hi - 1) / 2;
  const pct = (midRank / (n - 1)) * 100;
  return options.lowerIsBetter ? 100 - pct : pct;
}

// Rank (1-indexed, descending) of the symbol at `targetIndex` within
// `universe` -- confirmed 155/155 exact match for rb_scores.rank via a
// STABLE descending sort of `composite` (verified with Python's
// stable-sort `sorted(rows, key=lambda r: -r.composite)`). Takes an index
// into the array rather than a bare value because ties need a tie-break,
// and the only confirmed tie-break is "whatever order the input list was
// already in" -- a value-only lookup (e.g. `array.indexOf(x)`) can't
// distinguish between two different symbols that happen to share the same
// composite, so this takes the full ordered universe and the target's
// position in it instead.
export function descendingRank(universe: number[], targetIndex: number): number {
  const x = universe[targetIndex];
  const indexed = universe.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => {
    if (a.value !== b.value) return b.value - a.value;
    return a.index - b.index; // stable tie-break: original array order
  });
  return indexed.findIndex((e) => e.index === targetIndex) + 1;
}

// First index i such that sorted[i] >= x (standard bisect_left).
function lowerBound(sorted: number[], x: number): number {
  let low = 0, high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] < x) low = mid + 1;
    else high = mid;
  }
  return low;
}

// First index i such that sorted[i] > x (standard bisect_right).
function upperBound(sorted: number[], x: number): number {
  let low = 0, high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] <= x) low = mid + 1;
    else high = mid;
  }
  return low;
}
