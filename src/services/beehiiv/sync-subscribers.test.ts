import { describe, expect, it } from "vitest";
import {
  looksLikeCreativeId,
  snapshotAcquisitionCostCents,
} from "./sync-subscribers";

describe("looksLikeCreativeId", () => {
  it("accepts a well-formed UUID", () => {
    expect(
      looksLikeCreativeId("3fa85f64-5717-4562-b3fc-2c963f66afa6"),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      looksLikeCreativeId("3FA85F64-5717-4562-B3FC-2C963F66AFA6"),
    ).toBe(true);
  });

  it("rejects non-UUID utm_content values", () => {
    expect(looksLikeCreativeId("google_cpc")).toBe(false);
    expect(looksLikeCreativeId("summer-sale-2026")).toBe(false);
    expect(looksLikeCreativeId("")).toBe(false);
  });

  it("rejects a UUID-shaped string with the wrong segment lengths", () => {
    expect(looksLikeCreativeId("3fa85f64-5717-4562-b3fc-2c963f66af")).toBe(
      false,
    );
  });
});

describe("snapshotAcquisitionCostCents", () => {
  it("divides spend by signups", () => {
    expect(snapshotAcquisitionCostCents(50_000, 25)).toBe(2_000);
  });

  it("returns 0 when the creative has no signups yet, not NaN/Infinity", () => {
    expect(snapshotAcquisitionCostCents(50_000, 0)).toBe(0);
    expect(snapshotAcquisitionCostCents(0, 0)).toBe(0);
  });

  it("rounds to the nearest cent", () => {
    // 10_000 / 3 = 3333.33...
    expect(snapshotAcquisitionCostCents(10_000, 3)).toBe(3_333);
  });
});
