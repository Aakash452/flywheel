import { describe, expect, it } from "vitest";
import type { NicheConfig } from "../../config/niche";
import {
  buildRelevancePrompt,
  chunkCandidates,
  parseRelevanceResponse,
  RELEVANCE_CHUNK_SIZE,
} from "./relevance-scoring";

const niche: NicheConfig = {
  name: "Test Niche",
  description: "A newsletter about testing.",
  audience: "QA engineers",
  topics: ["unit testing", "integration testing"],
  exclude: ["manual testing"],
  relevanceThreshold: 60,
};

describe("chunkCandidates", () => {
  it("chunks into groups of the default size", () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    const chunks = chunkCandidates(items);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(RELEVANCE_CHUNK_SIZE);
    expect(chunks[1]).toHaveLength(RELEVANCE_CHUNK_SIZE);
    expect(chunks[2]).toHaveLength(5);
  });

  it("returns an empty array for empty input", () => {
    expect(chunkCandidates([])).toEqual([]);
  });

  it("respects a custom chunk size", () => {
    expect(chunkCandidates([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("buildRelevancePrompt", () => {
  it("includes the niche description, audience, topics, and exclusions", () => {
    const prompt = buildRelevancePrompt(
      [{ url: "https://example.com/a", title: "A", rawContent: "excerpt" }],
      niche,
    );
    expect(prompt).toContain("A newsletter about testing.");
    expect(prompt).toContain("QA engineers");
    expect(prompt).toContain("unit testing, integration testing");
    expect(prompt).toContain("manual testing");
    expect(prompt).toContain("https://example.com/a");
  });

  it("omits the exclusions line when there are none", () => {
    const prompt = buildRelevancePrompt(
      [{ url: "https://example.com/a", title: "A", rawContent: null }],
      { ...niche, exclude: [] },
    );
    expect(prompt).not.toContain("Explicitly out of scope");
  });

  it("truncates long excerpts", () => {
    const longContent = "x".repeat(5_000);
    const prompt = buildRelevancePrompt(
      [{ url: "https://example.com/a", title: "A", rawContent: longContent }],
      niche,
    );
    expect(prompt.length).toBeLessThan(longContent.length);
  });
});

describe("parseRelevanceResponse", () => {
  it("parses a clean JSON array", () => {
    const scores = parseRelevanceResponse(
      '[{"url": "https://a.com", "score": 80}, {"url": "https://b.com", "score": 20}]',
    );
    expect(scores.get("https://a.com")).toBe(80);
    expect(scores.get("https://b.com")).toBe(20);
  });

  it("tolerates surrounding prose or a code fence", () => {
    const scores = parseRelevanceResponse(
      'Here are the scores:\n```json\n[{"url": "https://a.com", "score": 55}]\n```\nDone.',
    );
    expect(scores.get("https://a.com")).toBe(55);
  });

  it("throws when no JSON array is present", () => {
    expect(() => parseRelevanceResponse("I refuse to answer.")).toThrow();
  });

  it("throws when a score is out of range", () => {
    expect(() =>
      parseRelevanceResponse('[{"url": "https://a.com", "score": 150}]'),
    ).toThrow();
  });

  it("throws on malformed JSON", () => {
    expect(() => parseRelevanceResponse("[{not json}]")).toThrow();
  });

  it("recovers complete entries from a response truncated mid-object (real max_tokens cutoff behavior)", () => {
    // Reproduces what was actually observed against real Claude output: the
    // model hits max_tokens partway through writing the next object, so the
    // response has no closing "]" at all.
    const truncated =
      '```json\n[\n  {"url": "https://a.com", "score": 15},\n  {"url": "https://b.com", "score": 42},\n  {"url": "https://c.com/long-slug-that-got-cut-off", "sco';
    const scores = parseRelevanceResponse(truncated);
    expect(scores.get("https://a.com")).toBe(15);
    expect(scores.get("https://b.com")).toBe(42);
    expect(scores.size).toBe(2);
  });

  it("still throws when truncated before any complete object", () => {
    expect(() => parseRelevanceResponse('[\n  {"url": "https://a.com", "sco')).toThrow();
  });
});
