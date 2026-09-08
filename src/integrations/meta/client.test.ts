import { describe, expect, it } from "vitest";
import { MetaClient, MetaApiError, extractSignups, spendCentsFromInsights } from "./client";

function fetchStub(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
    return handler(url, init);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("MetaClient.createAd", () => {
  it("always sends status=PAUSED, regardless of what's happening elsewhere", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = fetchStub((url, init) => {
      capturedBody = init?.body as string;
      expect(url.pathname).toBe("/v25.0/act_123/ads");
      return jsonResponse({ id: "ad_1" });
    });

    const client = new MetaClient({ accessToken: "token", adAccountId: "123", fetchImpl });
    const result = await client.createAd({ name: "Test ad", adSetId: "adset_1", creativeId: "creative_1" });

    expect(result.id).toBe("ad_1");
    const params = new URLSearchParams(capturedBody);
    expect(params.get("status")).toBe("PAUSED");
    expect(params.get("adset_id")).toBe("adset_1");
    expect(JSON.parse(params.get("creative")!)).toEqual({ creative_id: "creative_1" });
  });
});

describe("MetaClient.createAdCreative", () => {
  it("builds a link_data object_story_spec with the given fields", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = fetchStub((url, init) => {
      capturedBody = init?.body as string;
      expect(url.pathname).toBe("/v25.0/act_123/adcreatives");
      return jsonResponse({ id: "creative_1" });
    });

    const client = new MetaClient({ accessToken: "token", adAccountId: "123", fetchImpl });
    const result = await client.createAdCreative({
      name: "Test creative",
      pageId: "page_1",
      message: "Body text",
      headline: "Hook text",
      link: "https://example.com/?utm_content=abc",
      callToActionType: "SIGN_UP",
      imageUrl: "https://example.com/image.png",
    });

    expect(result.id).toBe("creative_1");
    const params = new URLSearchParams(capturedBody);
    const spec = JSON.parse(params.get("object_story_spec")!);
    expect(spec.page_id).toBe("page_1");
    expect(spec.link_data.message).toBe("Body text");
    expect(spec.link_data.headline).toBe("Hook text");
    expect(spec.link_data.link).toBe("https://example.com/?utm_content=abc");
    expect(spec.link_data.call_to_action.type).toBe("SIGN_UP");
    expect(spec.link_data.picture).toBe("https://example.com/image.png");
  });

  it("omits picture when no imageUrl is given", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = fetchStub((_url, init) => {
      capturedBody = init?.body as string;
      return jsonResponse({ id: "creative_1" });
    });

    const client = new MetaClient({ accessToken: "token", adAccountId: "123", fetchImpl });
    await client.createAdCreative({
      name: "Test",
      pageId: "page_1",
      message: "m",
      headline: "h",
      link: "https://example.com",
      callToActionType: "SIGN_UP",
    });

    const spec = JSON.parse(new URLSearchParams(capturedBody).get("object_story_spec")!);
    expect(spec.link_data.picture).toBeUndefined();
  });
});

describe("MetaClient.updateAdStatus", () => {
  it("posts the requested status to the ad's own node", async () => {
    let capturedUrl: URL | undefined;
    let capturedBody: string | undefined;
    const fetchImpl = fetchStub((url, init) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      return jsonResponse({ success: true });
    });

    const client = new MetaClient({ accessToken: "token", adAccountId: "123", fetchImpl });
    await client.updateAdStatus("ad_1", "ACTIVE");

    expect(capturedUrl?.pathname).toBe("/v25.0/ad_1");
    expect(new URLSearchParams(capturedBody).get("status")).toBe("ACTIVE");
  });
});

describe("MetaClient error handling", () => {
  it("throws MetaApiError with the API's own message on a non-2xx response", async () => {
    const fetchImpl = fetchStub(() =>
      jsonResponse({ error: { message: "Invalid OAuth access token.", code: 190 } }, 401),
    );
    const client = new MetaClient({ accessToken: "bad", adAccountId: "123", fetchImpl });

    await expect(client.createAd({ name: "x", adSetId: "a", creativeId: "c" })).rejects.toThrow(
      /Invalid OAuth access token/,
    );
  });
});

describe("MetaClient.getAdInsights", () => {
  it("returns the first (and only) result row", async () => {
    const fetchImpl = fetchStub((url) => {
      expect(url.pathname).toBe("/v25.0/ad_1/insights");
      return jsonResponse({
        data: [{ impressions: "1000", clicks: "50", spend: "12.34", actions: [{ action_type: "lead", value: "3" }] }],
      });
    });
    const client = new MetaClient({ accessToken: "token", adAccountId: "123", fetchImpl });
    const insights = await client.getAdInsights("ad_1");
    expect(insights?.impressions).toBe("1000");
    expect(insights?.spend).toBe("12.34");
  });

  it("returns undefined when there is no data yet", async () => {
    const fetchImpl = fetchStub(() => jsonResponse({ data: [] }));
    const client = new MetaClient({ accessToken: "token", adAccountId: "123", fetchImpl });
    expect(await client.getAdInsights("ad_1")).toBeUndefined();
  });
});

describe("extractSignups", () => {
  it("sums matching action types and ignores others", () => {
    const insights = {
      actions: [
        { action_type: "lead", value: "3" },
        { action_type: "link_click", value: "50" },
        { action_type: "offsite_conversion.fb_pixel_lead", value: "2" },
      ],
    };
    expect(extractSignups(insights, ["lead", "offsite_conversion.fb_pixel_lead"])).toBe(5);
  });

  it("returns 0 when there are no actions", () => {
    expect(extractSignups(undefined, ["lead"])).toBe(0);
    expect(extractSignups({}, ["lead"])).toBe(0);
  });
});

describe("spendCentsFromInsights", () => {
  it("converts a decimal-dollar spend string to integer cents", () => {
    expect(spendCentsFromInsights({ spend: "12.34" })).toBe(1_234);
  });

  it("returns 0 when spend is absent", () => {
    expect(spendCentsFromInsights(undefined)).toBe(0);
    expect(spendCentsFromInsights({})).toBe(0);
  });
});
