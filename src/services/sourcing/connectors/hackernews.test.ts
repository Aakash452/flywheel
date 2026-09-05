import { describe, expect, it } from "vitest";
import { hnItemToCandidate } from "./hackernews";

describe("hnItemToCandidate", () => {
  it("maps a normal story with an external URL", () => {
    const candidate = hnItemToCandidate({
      id: 1,
      type: "story",
      url: "https://example.com/article",
      title: "An article",
      score: 100,
      time: 1_700_000_000,
    });
    expect(candidate).toEqual({
      url: "https://example.com/article",
      title: "An article",
      rawContent: null,
      discoveredAt: new Date(1_700_000_000 * 1000),
    });
  });

  it("falls back to the HN discussion URL for a self-text post", () => {
    const candidate = hnItemToCandidate({
      id: 42,
      type: "story",
      title: "Ask HN: something",
      text: "body text",
      score: 50,
      time: 1_700_000_000,
    });
    expect(candidate?.url).toBe("https://news.ycombinator.com/item?id=42");
    expect(candidate?.rawContent).toBe("body text");
  });

  it("returns null for non-story items", () => {
    expect(hnItemToCandidate({ id: 1, type: "comment" })).toBeNull();
    expect(hnItemToCandidate({ id: 1, type: "job" })).toBeNull();
  });

  it("returns null for dead or deleted items", () => {
    expect(hnItemToCandidate({ id: 1, type: "story", dead: true })).toBeNull();
    expect(hnItemToCandidate({ id: 1, type: "story", deleted: true })).toBeNull();
  });

  it("returns null for items below minPoints", () => {
    expect(
      hnItemToCandidate({ id: 1, type: "story", score: 10 }, 20),
    ).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(hnItemToCandidate(null)).toBeNull();
    expect(hnItemToCandidate(undefined)).toBeNull();
  });
});
