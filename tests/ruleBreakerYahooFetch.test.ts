import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchChart2y, fetchChart1y } from "../supabase/functions/_shared/ruleBreaker/yahooFetch.ts";

// Synthetic v8 chart response: 10 weeks of Mon-Fri daily bars (50 days),
// constant volume and h=l=c each day (so typical price == close, making
// the volume-weighted mean a plain mean of closes -- hand-checkable).
// Weekly close values (same close for all 5 days in that week):
const WEEKLY_CLOSES = [100, 100, 100, 100, 100, 100, 110, 100, 100, 140];

function buildDailyChartJson(weeklyCloses: number[]) {
  const timestamps: number[] = [];
  const closes: number[] = [];
  // 2024-01-01 is a Monday (UTC) -- start there so week grouping is exact.
  const firstMonday = Date.UTC(2024, 0, 1) / 1000;
  for (let w = 0; w < weeklyCloses.length; w++) {
    for (let d = 0; d < 5; d++) {
      timestamps.push(firstMonday + w * 7 * 86400 + d * 86400);
      closes.push(weeklyCloses[w]);
    }
  }
  const n = closes.length;
  return {
    chart: {
      result: [
        {
          timestamp: timestamps,
          indicators: {
            quote: [
              {
                open: closes.slice(),
                high: closes.slice(),
                low: closes.slice(),
                close: closes.slice(),
                volume: new Array(n).fill(100),
              },
            ],
          },
        },
      ],
    },
  };
}

describe("fetchChart2y", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("groups daily bars into Monday-start weeks and computes volume-weighted vwap6/vwap12 exactly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => buildDailyChartJson(WEEKLY_CLOSES) }),
    );
    const { weeklyBars } = await fetchChart2y("TEST");
    expect(weeklyBars).toHaveLength(10);
    expect(weeklyBars[0].week_start).toBe("2024-01-01"); // a real Monday

    const last = weeklyBars[9];
    expect(last.close).toBe(140);
    expect(last.vwap6_a).toBeCloseTo(108.3333, 3); // hand-verified: mean of weeks 4-9
    expect(last.vwap6_sigma).toBeCloseTo(14.6249, 3);
    expect(last.vwap12_b).toBeNull(); // needs 12 weeks of history, only 10 available

    expect(weeklyBars[7].vwap6_a).toBeCloseTo(101.6667, 3); // mean of weeks 2-7
    expect(weeklyBars[8].vwap6_a).toBeCloseTo(101.6667, 3); // mean of weeks 3-8
  });

  it("fires a 'u' signal exactly when up && !prior-up && rising, only once i>=8 weeks of history exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => buildDailyChartJson(WEEKLY_CLOSES) }),
    );
    const { weeklyBars } = await fetchChart2y("TEST");
    // Week 9: close(140) > vm(108.33) [up]; week 8's close(100) was NOT
    // above week 8's own vm(101.67) [!prior-up]; vm(108.33) > vm two
    // weeks back (101.67) [rising] -- all three hold, so 'u'.
    expect(weeklyBars[9].signal).toBe("u");
    // Weeks before index 8 can't fire a signal at all (i<8 gate), even
    // though va() itself is already computable from index 5 onward.
    expect(weeklyBars[6].signal).toBeNull();
    expect(weeklyBars[7].signal).toBeNull();
  });

  it("captures every daily close for asset_price_history, not just week-end closes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => buildDailyChartJson(WEEKLY_CLOSES) }),
    );
    const { dailyCloses } = await fetchChart2y("TEST");
    expect(dailyCloses).toHaveLength(50);
    expect(dailyCloses[0]).toEqual({ date: "2024-01-01", close: 100 });
    expect(dailyCloses[49].close).toBe(140);
  });
});

describe("fetchChart1y", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("null-gates ret1y/mom12_1/mom6/mom3 below their minimum trading-day thresholds", async () => {
    // Only 50 days total -- well under every threshold (200/200/126/63).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => buildDailyChartJson(WEEKLY_CLOSES) }),
    );
    const fields = await fetchChart1y("TEST");
    expect(fields.n).toBe(50);
    expect(fields.ret1y).toBeNull();
    expect(fields.mom12_1).toBeNull();
    expect(fields.mom6).toBeNull();
    expect(fields.mom3).toBeNull();
  });

  it("mdd1y captures the real 110->100 dip (week 6->7) as a negative drawdown, and rv is positive given that volatility", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => buildDailyChartJson(WEEKLY_CLOSES) }),
    );
    const fields = await fetchChart1y("TEST");
    expect(fields.mdd1y).toBeLessThan(0);
    expect(fields.mdd1y).toBeCloseTo(100 / 110 - 1, 6);
    expect(fields.rv).toBeGreaterThan(0);
  });
});
