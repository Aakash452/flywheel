import { describe, expect, it } from "vitest";
import type { CreativeVariant } from "./prompt";
import { computeAxisCoverage, hasFullAxisCoverage, missingAxisValues } from "./diversity";

function variant(overrides: Partial<CreativeVariant> = {}): CreativeVariant {
  return {
    angle: "curiosity",
    format: "static_image",
    audienceFraming: "beginner",
    hook: "hook",
    body: "body",
    cta: "cta",
    imagePrompt: null,
    ...overrides,
  };
}

describe("computeAxisCoverage", () => {
  it("collects the distinct values used across variants", () => {
    const coverage = computeAxisCoverage([
      variant({ angle: "curiosity" }),
      variant({ angle: "authority" }),
      variant({ angle: "curiosity" }), // duplicate angle, still one entry in the set
    ]);
    expect(coverage.angles).toEqual(new Set(["curiosity", "authority"]));
  });
});

describe("missingAxisValues / hasFullAxisCoverage", () => {
  it("reports every axis value missing for an empty list", () => {
    const missing = missingAxisValues([]);
    expect(missing.angles.length).toBeGreaterThan(0);
    expect(missing.formats.length).toBeGreaterThan(0);
    expect(missing.audienceFramings.length).toBeGreaterThan(0);
    expect(hasFullAxisCoverage([])).toBe(false);
  });

  it("reports nothing missing once every axis value appears at least once", () => {
    const variants: CreativeVariant[] = [
      variant({ angle: "curiosity", format: "static_image", audienceFraming: "beginner" }),
      variant({ angle: "authority", format: "text_heavy", audienceFraming: "practitioner" }),
      variant({ angle: "contrarian", format: "meme", audienceFraming: "manager" }),
      variant({ angle: "problem_agitation", format: "screenshot", audienceFraming: "beginner" }),
      variant({ angle: "social_proof", format: "chart", audienceFraming: "practitioner" }),
      variant({ angle: "specificity", format: "static_image", audienceFraming: "manager" }),
    ];
    expect(missingAxisValues(variants)).toEqual({ angles: [], formats: [], audienceFramings: [] });
    expect(hasFullAxisCoverage(variants)).toBe(true);
  });

  it("identifies exactly which values are still missing", () => {
    const variants: CreativeVariant[] = [variant({ angle: "curiosity", format: "static_image", audienceFraming: "beginner" })];
    const missing = missingAxisValues(variants);
    expect(missing.angles).not.toContain("curiosity");
    expect(missing.angles).toContain("authority");
    expect(missing.formats).toContain("text_heavy");
    expect(missing.audienceFramings).toContain("practitioner");
  });
});
