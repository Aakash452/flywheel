import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "./vectors";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  it("is scale-invariant", () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6]; // same direction, different magnitude
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 10);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });

  it("throws on empty vectors", () => {
    expect(() => cosineSimilarity([], [])).toThrow();
  });
});
