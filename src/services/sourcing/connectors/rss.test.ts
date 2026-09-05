import { describe, expect, it } from "vitest";
import { parseRssXml } from "./rss";

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>First Post</title>
      <link>https://example.com/first</link>
      <description>An excerpt of the first post.</description>
      <pubDate>Mon, 01 Jun 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/second</link>
      <description>An excerpt of the second post.</description>
      <pubDate>Tue, 02 Jun 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>No Link Post</title>
      <description>This one has no link and should be dropped.</description>
    </item>
  </channel>
</rss>`;

describe("parseRssXml", () => {
  it("parses items into candidates", async () => {
    const candidates = await parseRssXml(SAMPLE_FEED);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.url).toBe("https://example.com/first");
    expect(candidates[0]?.title).toBe("First Post");
    expect(candidates[0]?.rawContent).toContain("excerpt of the first post");
  });

  it("drops items with no link", async () => {
    const candidates = await parseRssXml(SAMPLE_FEED);
    expect(candidates.some((c) => c.title === "No Link Post")).toBe(false);
  });

  it("parses pubDate into discoveredAt", async () => {
    const candidates = await parseRssXml(SAMPLE_FEED);
    expect(candidates[0]?.discoveredAt.toISOString()).toBe(
      "2026-06-01T12:00:00.000Z",
    );
  });

  it("returns an empty array for a feed with no items", async () => {
    const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`;
    expect(await parseRssXml(empty)).toEqual([]);
  });
});
