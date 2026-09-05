import { describe, expect, it } from "vitest";
import {
  clickThroughRate,
  conversionRate,
  cpaCents,
  cpcCents,
  openRate,
} from "./metrics";

describe("cpcCents", () => {
  it("divides spend by clicks", () => {
    expect(cpcCents(10_000, 100)).toBe(100);
  });

  it("returns null when there are no clicks, not Infinity/NaN", () => {
    expect(cpcCents(10_000, 0)).toBeNull();
    expect(cpcCents(0, 0)).toBeNull();
  });
});

describe("cpaCents", () => {
  it("divides spend by signups", () => {
    expect(cpaCents(50_000, 25)).toBe(2_000);
  });

  it("returns null when there are no signups", () => {
    expect(cpaCents(50_000, 0)).toBeNull();
  });
});

describe("clickThroughRate", () => {
  it("divides clicks by impressions", () => {
    expect(clickThroughRate(50, 1_000)).toBe(0.05);
  });

  it("returns null when there are no impressions", () => {
    expect(clickThroughRate(0, 0)).toBeNull();
  });
});

describe("conversionRate", () => {
  it("divides signups by visits", () => {
    expect(conversionRate(30, 1_000)).toBe(0.03);
  });

  it("returns null when there are no visits", () => {
    expect(conversionRate(0, 0)).toBeNull();
  });
});

describe("openRate", () => {
  it("divides opens by recipients", () => {
    expect(openRate(250, 1_000)).toBe(0.25);
  });

  it("returns null when there are no recipients, not Infinity/NaN", () => {
    expect(openRate(0, 0)).toBeNull();
  });
});
