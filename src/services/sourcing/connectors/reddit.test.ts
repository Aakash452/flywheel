import { describe, expect, it } from "vitest";
import { fetchSubredditNew, redditPostToCandidate } from "./reddit";

describe("redditPostToCandidate", () => {
  it("uses the external URL for a link post", () => {
    const candidate = redditPostToCandidate({
      url: "https://example.com/article",
      permalink: "/r/test/comments/abc/title/",
      title: "A link post",
      created_utc: 1_700_000_000,
    });
    expect(candidate.url).toBe("https://example.com/article");
    expect(candidate.rawContent).toBeNull();
  });

  it("falls back to the permalink for a self post", () => {
    const candidate = redditPostToCandidate({
      url: "https://www.reddit.com/r/test/comments/abc/title/",
      permalink: "/r/test/comments/abc/title/",
      title: "A self post",
      selftext: "body text",
      created_utc: 1_700_000_000,
    });
    expect(candidate.url).toBe("https://www.reddit.com/r/test/comments/abc/title/");
    expect(candidate.rawContent).toBe("body text");
  });
});

describe("fetchSubredditNew", () => {
  it("authenticates via client-credentials, then lists new posts", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const urlString = url.toString();
      calls.push(urlString);

      if (urlString === "https://www.reddit.com/api/v1/access_token") {
        expect(init?.headers).toMatchObject({
          Authorization: expect.stringMatching(/^Basic /),
        });
        return new Response(JSON.stringify({ access_token: "fake-token" }), {
          status: 200,
        });
      }

      if (urlString.startsWith("https://oauth.reddit.com/r/testsub/new")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer fake-token" });
        return new Response(
          JSON.stringify({
            data: {
              children: [
                {
                  data: {
                    url: "https://example.com/post",
                    permalink: "/r/testsub/comments/1/x/",
                    title: "A post",
                    created_utc: 1_700_000_000,
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }

      throw new Error(`unexpected fetch: ${urlString}`);
    }) as typeof fetch;

    const candidates = await fetchSubredditNew(
      "testsub",
      {
        clientId: "id",
        clientSecret: "secret",
        userAgent: "test-agent/1.0",
        fetchImpl,
      },
      25,
    );

    expect(candidates).toEqual([
      {
        url: "https://example.com/post",
        title: "A post",
        rawContent: null,
        discoveredAt: new Date(1_700_000_000 * 1000),
      },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("throws when the token request fails", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;

    await expect(
      fetchSubredditNew("testsub", {
        clientId: "id",
        clientSecret: "bad",
        userAgent: "test-agent/1.0",
        fetchImpl,
      }),
    ).rejects.toThrow(/token request failed/);
  });
});
