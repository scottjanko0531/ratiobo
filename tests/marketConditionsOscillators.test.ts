import { describe, it, expect } from "vitest";
import { computeOscillatorRawSeries } from "../supabase/functions/_shared/marketConditions/indicators/oscillators.ts";

describe("computeOscillatorRawSeries — O1 (RSI14, Wilder)", () => {
  it("null before the 14th index (needs 14 days of gain/loss history), first value at index 14", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const { rsi14 } = computeOscillatorRawSeries(closes);
    for (let i = 0; i < 14; i++) expect(rsi14[i]).toBeNull();
    expect(rsi14[14]).not.toBeNull();
  });

  it("a strictly rising series pins RSI at 100 (zero average loss)", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
    const { rsi14 } = computeOscillatorRawSeries(closes);
    expect(rsi14[39]).toBe(100);
  });

  it("a strictly falling series pins RSI at 0 (zero average gain)", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 200 - i);
    const { rsi14 } = computeOscillatorRawSeries(closes);
    expect(rsi14[39]).toBe(0);
  });

  it("an alternating up/down series settles near 50 (roughly equal average gain/loss)", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
    const { rsi14 } = computeOscillatorRawSeries(closes);
    expect(rsi14[59]!).toBeGreaterThan(40);
    expect(rsi14[59]!).toBeLessThan(60);
  });
});

describe("computeOscillatorRawSeries — O2 (stretch50d, z-score vs SMA50)", () => {
  it("null before 50 days of history, first value at index 49", () => {
    const closes = Array.from({ length: 60 }, () => 100);
    const { stretch50d } = computeOscillatorRawSeries(closes);
    for (let i = 0; i < 49; i++) expect(stretch50d[i]).toBeNull();
    expect(stretch50d[49]).not.toBeNull();
  });

  it("zero for a flat (zero-variance) series -- guards the div-by-zero case explicitly rather than emitting NaN/Infinity", () => {
    const closes = Array.from({ length: 60 }, () => 100);
    const { stretch50d } = computeOscillatorRawSeries(closes);
    expect(stretch50d[49]).toBe(0);
  });

  it("positive when today's close sits above its trailing 50-day mean, negative when below", () => {
    // Oscillates around 100 for 49 days (building a non-zero-variance
    // window), then one big up day and one big down day to read the sign.
    const base = Array.from({ length: 49 }, (_, i) => 100 + (i % 2 === 0 ? 2 : -2));
    const up = computeOscillatorRawSeries([...base, 130]).stretch50d;
    const down = computeOscillatorRawSeries([...base, 70]).stretch50d;
    expect(up[49]!).toBeGreaterThan(0);
    expect(down[49]!).toBeLessThan(0);
  });
});
