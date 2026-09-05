import { describe, expect, it } from "vitest";
import { BeehiivClient } from "./client";

/**
 * Fixture captured verbatim from a real GET /subscriptions call (cursor
 * pagination, limit=1) during development — note there is no total_results
 * field, despite Beehiiv's docs listing it as required for this response
 * shape. This test exists specifically so that gap can't silently regress:
 * the first version of beehiivCursorPageSchema required it and threw on
 * every real call until fixed.
 */
const REAL_SUBSCRIPTIONS_RESPONSE = {
  data: [
    {
      id: "sub_6bd881ed-ac9a-4a00-92d6-24dc5881c191",
      email: "reader@example.com",
      status: "active",
      created: 1_788_597_393,
      subscription_tier: "free",
      subscription_premium_tier_names: [],
      utm_source: "direct",
      utm_medium: "",
      utm_channel: "website",
      utm_campaign: "",
      utm_term: "",
      utm_content: "",
      referring_site: "",
      referral_code: "F8MixGKnil",
      stripe_customer_id: "",
    },
  ],
  limit: 1,
  has_more: false,
  next_cursor: null,
  // total_results intentionally absent
};

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("BeehiivClient.listSubscriptions", () => {
  it("parses a real-shaped response with no total_results field", async () => {
    const client = new BeehiivClient({
      apiKey: "test-key",
      publicationId: "pub_test",
      fetchImpl: fetchReturning(REAL_SUBSCRIPTIONS_RESPONSE),
    });

    const result = await client.listSubscriptions({ limit: 1 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.email).toBe("reader@example.com");
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.totalResults).toBeUndefined();
  });

  it("still parses total_results when a response does include it", async () => {
    const client = new BeehiivClient({
      apiKey: "test-key",
      publicationId: "pub_test",
      fetchImpl: fetchReturning({ ...REAL_SUBSCRIPTIONS_RESPONSE, total_results: 42 }),
    });

    const result = await client.listSubscriptions({ limit: 1 });
    expect(result.totalResults).toBe(42);
  });

  it("throws a BeehiivApiError with the response body on a non-2xx status", async () => {
    const client = new BeehiivClient({
      apiKey: "test-key",
      publicationId: "pub_test",
      fetchImpl: fetchReturning({ error: "unauthorized" }, 401),
    });

    await expect(client.listSubscriptions()).rejects.toThrow(/401/);
  });
});
