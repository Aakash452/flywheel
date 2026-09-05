import { describe, expect, it } from "vitest";
import { estimateCostCents } from "./cost-control";

describe("estimateCostCents", () => {
  it("computes cost from input/output tokens at standard rates", () => {
    // 1M input tokens @ $3/M + 1M output tokens @ $15/M = 300 + 1500 cents
    const cents = estimateCostCents({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      inputCentsPerMillion: 300,
      outputCentsPerMillion: 1_500,
    });
    expect(cents).toBe(1_800);
  });

  it("applies the 50% batch discount", () => {
    const cents = estimateCostCents({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      inputCentsPerMillion: 300,
      outputCentsPerMillion: 1_500,
      isBatch: true,
    });
    expect(cents).toBe(900);
  });

  it("never returns 0, even for a tiny call", () => {
    const cents = estimateCostCents({
      inputTokens: 10,
      outputTokens: 5,
      inputCentsPerMillion: 100,
      outputCentsPerMillion: 500,
    });
    expect(cents).toBeGreaterThanOrEqual(1);
  });

  it("rounds to the nearest cent", () => {
    // 333,333 tokens @ $3/M = 99.9999 cents -> rounds to 100
    const cents = estimateCostCents({
      inputTokens: 333_333,
      outputTokens: 0,
      inputCentsPerMillion: 300,
      outputCentsPerMillion: 1_500,
    });
    expect(cents).toBe(100);
  });
});
