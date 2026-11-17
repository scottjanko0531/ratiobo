import { describe, it, expect } from "vitest";
import {
  goldTrendStatus,
  goldPurchasesZScoreStatus,
  realFedFundsStance,
  convenienceYieldChangeStatus,
} from "../supabase/functions/_shared/statusThresholds.ts";

// Phase 3 (debt-metrics-integrity spec) status-threshold logic, closing out
// the §5 test checklist item: "gold trend status; real fed funds stance
// mapping; convenience-yield change status."

describe("goldTrendStatus", () => {
  it("the actual bug this was meant to fix: a high but FALLING level reads healthy, not danger", () => {
    // Live numbers from the Phase 3 decisions log: 3M avg $4,231.74 vs.
    // prior 3M avg $4,560.71 — a price level that would have been DANGER
    // under the old level-based thresholds (<2000 healthy, <3000 watch,
    // else danger), despite actively falling ~7.2%.
    expect(goldTrendStatus(4231.737, 4560.712)).toBe("healthy");
  });

  it("danger: 3M avg has risen more than 5% over the prior 3M avg", () => {
    expect(goldTrendStatus(1100, 1000)).toBe("danger"); // +10%
  });

  it("watch: rising, but 5% or less", () => {
    expect(goldTrendStatus(1040, 1000)).toBe("watch"); // +4%
  });

  it("healthy: flat (0%) falls on the healthy side, not watch", () => {
    expect(goldTrendStatus(1000, 1000)).toBe("healthy");
  });
});

describe("goldPurchasesZScoreStatus", () => {
  it("healthy: at or below a 1-sigma buying surge", () => {
    expect(goldPurchasesZScoreStatus(0.79)).toBe("healthy"); // live value, Phase 3 decisions log
    expect(goldPurchasesZScoreStatus(1.0)).toBe("healthy");
  });

  it("watch: a 1-2 sigma surge", () => {
    expect(goldPurchasesZScoreStatus(1.5)).toBe("watch");
  });

  it("danger: a >2 sigma surge", () => {
    expect(goldPurchasesZScoreStatus(2.5)).toBe("danger");
  });

  it("one-sided: a large NEGATIVE z (well below average buying) is still healthy", () => {
    expect(goldPurchasesZScoreStatus(-3)).toBe("healthy");
  });
});

describe("realFedFundsStance", () => {
  it("accommodative: negative real rate", () => {
    expect(realFedFundsStance(-0.5)).toBe("accommodative");
  });

  it("neutral: 0 to 1.5, inclusive of the upper bound", () => {
    expect(realFedFundsStance(0.033)).toBe("neutral"); // live value, Phase 4 decisions log
    expect(realFedFundsStance(0)).toBe("neutral");
    expect(realFedFundsStance(1.5)).toBe("neutral");
  });

  it("restrictive: above 1.5", () => {
    expect(realFedFundsStance(1.51)).toBe("restrictive");
    expect(realFedFundsStance(3)).toBe("restrictive");
  });

  it("returns a stance string, never a risk-level string", () => {
    for (const v of [-2, -0.5, 0, 0.75, 1.5, 2, 5]) {
      expect(["accommodative", "neutral", "restrictive"]).toContain(realFedFundsStance(v));
    }
  });
});

describe("convenienceYieldChangeStatus", () => {
  it("healthy: live values (current -45.48bp, 1y avg -47.84bp -> +2.36bp, improving)", () => {
    expect(convenienceYieldChangeStatus(-45.48, -47.84)).toBe("healthy");
  });

  it("danger: current level is more than 15bp below its trailing 1-year average", () => {
    expect(convenienceYieldChangeStatus(-30, -10)).toBe("danger"); // delta = -20bp
  });

  it("watch: 5-15bp below the trailing average", () => {
    expect(convenienceYieldChangeStatus(-20, -10)).toBe("watch"); // delta = -10bp
  });

  it("healthy: at or above the trailing average, regardless of the level's own sign", () => {
    expect(convenienceYieldChangeStatus(-5, -10)).toBe("healthy"); // delta = +5bp, level still negative
  });
});
