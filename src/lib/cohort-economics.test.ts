import { describe, expect, it } from "vitest";
import {
  blendedCacCents,
  computeRetentionCurve,
  contributionMarginCents,
  ltvToCac,
  observedLtvCents,
  paybackPeriodDays,
  recommendAllocation,
  revenuePerSubscriberCents,
  variableCostPerSubscriberCents,
} from "./cohort-economics";

describe("blendedCacCents", () => {
  it("divides trailing ad spend by subscribers acquired", () => {
    expect(blendedCacCents(500_000, 100)).toBe(5_000);
  });
  it("returns null when no subscribers were acquired", () => {
    expect(blendedCacCents(500_000, 0)).toBeNull();
  });
});

describe("revenuePerSubscriberCents", () => {
  it("divides trailing revenue by average active subscribers", () => {
    expect(revenuePerSubscriberCents(100_000, 1_000)).toBe(100);
  });
  it("returns null with zero active subscribers", () => {
    expect(revenuePerSubscriberCents(100_000, 0)).toBeNull();
  });
});

describe("variableCostPerSubscriberCents", () => {
  it("divides trailing variable cost by average active subscribers", () => {
    expect(variableCostPerSubscriberCents(20_000, 1_000)).toBe(20);
  });
});

describe("contributionMarginCents", () => {
  it("subtracts variable cost from revenue per subscriber", () => {
    expect(contributionMarginCents(500, 150)).toBe(350);
  });
  it("can be negative", () => {
    expect(contributionMarginCents(100, 150)).toBe(-50);
  });
});

describe("paybackPeriodDays", () => {
  it("computes days to recover CAC from monthly contribution margin", () => {
    // $50 CAC, $30/month margin => $1/day => 50 days
    expect(paybackPeriodDays(5_000, 3_000)).toBe(50);
  });
  it("returns null (never) for zero margin", () => {
    expect(paybackPeriodDays(5_000, 0)).toBeNull();
  });
  it("returns null (never) for negative margin", () => {
    expect(paybackPeriodDays(5_000, -100)).toBeNull();
  });
});

describe("observedLtvCents", () => {
  it("sums retention-weighted revenue across observed weeks only", () => {
    // $10/week revenue; retention 100%, 80%, 50% across 3 observed weeks
    const ltv = observedLtvCents(1_000, [1.0, 0.8, 0.5]);
    expect(ltv).toBe(2_300); // 1000 + 800 + 500
  });
  it("is 0 for a cohort with no observed weeks yet", () => {
    expect(observedLtvCents(1_000, [])).toBe(0);
  });
});

describe("ltvToCac", () => {
  it("divides LTV by CAC", () => {
    expect(ltvToCac(15_000, 5_000)).toBe(3);
  });
  it("returns null when CAC is 0", () => {
    expect(ltvToCac(15_000, 0)).toBeNull();
  });
});

describe("computeRetentionCurve", () => {
  const cohortStart = new Date("2026-06-01T00:00:00Z"); // a Monday

  it("returns 100% retention with no unsubscribes", () => {
    const asOf = new Date("2026-06-01T00:00:00Z");
    asOf.setUTCDate(asOf.getUTCDate() + 21); // 3 weeks elapsed
    const points = computeRetentionCurve(cohortStart, 100, [], 5, asOf);
    expect(points).toHaveLength(3);
    expect(points.every((p) => p.survivingFraction === 1)).toBe(true);
  });

  it("only includes weeks that have actually elapsed by asOf", () => {
    const asOf = new Date("2026-06-01T00:00:00Z");
    asOf.setUTCDate(asOf.getUTCDate() + 10); // just over 1 week
    const points = computeRetentionCurve(cohortStart, 100, [], 10, asOf);
    expect(points).toHaveLength(1);
    expect(points[0]?.weekOffset).toBe(1);
  });

  it("reduces surviving fraction as unsubscribes accumulate over weeks", () => {
    const week1Cutoff = new Date(cohortStart);
    week1Cutoff.setUTCDate(week1Cutoff.getUTCDate() + 7);
    const week2Cutoff = new Date(cohortStart);
    week2Cutoff.setUTCDate(week2Cutoff.getUTCDate() + 14);

    const asOf = new Date(cohortStart);
    asOf.setUTCDate(asOf.getUTCDate() + 21);

    // 100 subscribers; 10 unsubscribe within week 1, 5 more within week 2
    const unsubDates = [
      ...Array(10).fill(new Date(week1Cutoff.getTime() - 86_400_000)),
      ...Array(5).fill(new Date(week2Cutoff.getTime() - 86_400_000)),
    ];

    const points = computeRetentionCurve(cohortStart, 100, unsubDates, 3, asOf);
    expect(points.map((p) => p.survivingFraction)).toEqual([0.9, 0.85, 0.85]);
  });

  it("returns an empty array for a zero-size cohort", () => {
    expect(computeRetentionCurve(cohortStart, 0, [], 5, new Date())).toEqual([]);
  });
});

describe("recommendAllocation", () => {
  it("halts regardless of good unit economics when runway is critical", () => {
    const rec = recommendAllocation({ paybackDays: 10, ltvToCacRatio: 10, runwayDays: 5 });
    expect(rec.action).toBe("halt_all_spend");
  });

  it("scales up on fast payback and strong LTV/CAC", () => {
    const rec = recommendAllocation({ paybackDays: 20, ltvToCacRatio: 4, runwayDays: 90 });
    expect(rec.action).toBe("scale_up_20");
  });

  it("holds on a 30-60 day payback with unremarkable LTV/CAC", () => {
    const rec = recommendAllocation({ paybackDays: 45, ltvToCacRatio: 2.5, runwayDays: 90 });
    expect(rec.action).toBe("hold");
  });

  it("cuts when payback exceeds 60 days", () => {
    const rec = recommendAllocation({ paybackDays: 90, ltvToCacRatio: 4, runwayDays: 90 });
    expect(rec.action).toBe("cut_50_and_new_experiment");
  });

  it("cuts when LTV/CAC is under 2, even with a fast payback", () => {
    const rec = recommendAllocation({ paybackDays: 10, ltvToCacRatio: 1.5, runwayDays: 90 });
    expect(rec.action).toBe("cut_50_and_new_experiment");
  });

  it("cuts when payback is null (contribution margin <= 0)", () => {
    const rec = recommendAllocation({ paybackDays: null, ltvToCacRatio: null, runwayDays: 90 });
    expect(rec.action).toBe("cut_50_and_new_experiment");
  });

  it("holds — the documented default — for fast payback with middling LTV/CAC (2-3)", () => {
    const rec = recommendAllocation({ paybackDays: 15, ltvToCacRatio: 2.5, runwayDays: 90 });
    expect(rec.action).toBe("hold");
  });

  it("runway check takes precedence over the cut rule too", () => {
    const rec = recommendAllocation({ paybackDays: null, ltvToCacRatio: 0.5, runwayDays: 10 });
    expect(rec.action).toBe("halt_all_spend");
  });
});
