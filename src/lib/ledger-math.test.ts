import { describe, expect, it } from "vitest";
import {
  dailyBurnRateCents,
  isRunwayCritical,
  runwayDays,
  sumLedgerCents,
} from "./ledger-math";

describe("sumLedgerCents", () => {
  it("returns 0 for an empty ledger", () => {
    expect(sumLedgerCents([])).toBe(0);
  });

  it("sums credits as positive and debits as negative", () => {
    const balance = sumLedgerCents([
      { direction: "credit", amountCents: 10_000 },
      { direction: "debit", amountCents: 3_000 },
      { direction: "credit", amountCents: 500 },
    ]);
    expect(balance).toBe(7_500);
  });

  it("can go negative when debits exceed credits", () => {
    const balance = sumLedgerCents([
      { direction: "credit", amountCents: 1_000 },
      { direction: "debit", amountCents: 5_000 },
    ]);
    expect(balance).toBe(-4_000);
  });

  it("rejects non-integer amounts", () => {
    expect(() =>
      sumLedgerCents([{ direction: "credit", amountCents: 10.5 }]),
    ).toThrow();
  });

  it("rejects negative amounts (sign must come from direction)", () => {
    expect(() =>
      sumLedgerCents([{ direction: "debit", amountCents: -100 }]),
    ).toThrow();
  });

  it("is exact for many small entries (no float drift)", () => {
    const entries = Array.from({ length: 10_000 }, () => ({
      direction: "credit" as const,
      amountCents: 1,
    }));
    expect(sumLedgerCents(entries)).toBe(10_000);
  });
});

describe("dailyBurnRateCents", () => {
  it("returns 0 for a zero or negative window", () => {
    const entries = [{ direction: "debit" as const, amountCents: 1_000 }];
    expect(dailyBurnRateCents(entries, 0)).toBe(0);
    expect(dailyBurnRateCents(entries, -5)).toBe(0);
  });

  it("computes positive burn when debits exceed credits", () => {
    // $300 spent, $0 revenue, over 30 days => $10/day => 1000 cents/day
    const entries = [{ direction: "debit" as const, amountCents: 30_000 }];
    expect(dailyBurnRateCents(entries, 30)).toBe(1_000);
  });

  it("computes negative burn (net profit) when credits exceed debits", () => {
    const entries = [
      { direction: "credit" as const, amountCents: 60_000 },
      { direction: "debit" as const, amountCents: 30_000 },
    ];
    // net spend = -30_000 (i.e. net profit of 30_000) over 30 days
    expect(dailyBurnRateCents(entries, 30)).toBe(-1_000);
  });
});

describe("runwayDays", () => {
  it("is Infinity when burn is zero", () => {
    expect(runwayDays(100_000, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("is Infinity when burn is negative (profitable)", () => {
    expect(runwayDays(100_000, -500)).toBe(Number.POSITIVE_INFINITY);
  });

  it("is 0 when balance is already exhausted and burn is positive", () => {
    expect(runwayDays(0, 500)).toBe(0);
    expect(runwayDays(-1_000, 500)).toBe(0);
  });

  it("divides balance by burn rate otherwise", () => {
    // $1000 balance, $50/day burn => 20 days
    expect(runwayDays(100_000, 5_000)).toBe(20);
  });
});

describe("isRunwayCritical", () => {
  it("flags runway at or below the default 21-day threshold", () => {
    expect(isRunwayCritical(21)).toBe(true);
    expect(isRunwayCritical(20)).toBe(true);
    expect(isRunwayCritical(22)).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(isRunwayCritical(45, 60)).toBe(true);
    expect(isRunwayCritical(61, 60)).toBe(false);
  });

  it("Infinity runway is never critical", () => {
    expect(isRunwayCritical(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
