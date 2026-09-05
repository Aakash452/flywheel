import { describe, expect, it } from "vitest";
import { dedupeByUrlInMemory, type RawCandidate } from "./dedupe";

function candidate(url: string, overrides: Partial<RawCandidate> = {}): RawCandidate {
  return { url, title: "Title", rawContent: "Content", discoveredAt: new Date(), ...overrides };
}

describe("dedupeByUrlInMemory", () => {
  it("keeps one entry per unique URL", () => {
    const result = dedupeByUrlInMemory([
      candidate("https://a.example.com"),
      candidate("https://b.example.com"),
    ]);
    expect(result.map((c) => c.url).sort()).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("collapses duplicate URLs, keeping the first occurrence", () => {
    const first = candidate("https://a.example.com", { title: "First" });
    const second = candidate("https://a.example.com", { title: "Second (from another feed)" });
    const result = dedupeByUrlInMemory([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("First");
  });

  it("returns an empty array for an empty input", () => {
    expect(dedupeByUrlInMemory([])).toEqual([]);
  });
});
