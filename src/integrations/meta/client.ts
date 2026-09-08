/**
 * Thin, typed wrapper around the Meta Marketing (Graph) API.
 *
 * Design choices worth knowing before you extend this:
 *
 * - `createAd()` always sends `status: "PAUSED"` — there is no
 *   "create active" path. Exactly like BeehiivClient.createPost() and its
 *   "one call site, no draft-in-the-platform" pattern (see that file's
 *   comment), this exists so nothing in this codebase can create a live,
 *   spending ad by accident. The only way an ad becomes ACTIVE is
 *   `updateAdStatus()`, called exclusively from
 *   src/services/meta/activate-creative.ts, which requires a verified
 *   `approvals` row first.
 *
 * - Request encoding uses form-urlencoded POST bodies with nested objects
 *   (like `object_story_spec`) JSON-stringified into a single field — the
 *   traditional, most broadly-compatible way to call the Graph API across
 *   versions. Not independently verified against a live account (no
 *   META_ACCESS_TOKEN configured during development); confirm against the
 *   real API before relying on this for a real spend decision.
 *
 * - `fetchImpl` and `baseUrl`/`apiVersion` are constructor-injectable for
 *   the same reasons as BeehiivClient: tests stub the network, and a
 *   different Graph API version can be pinned without code changes.
 */
import { z } from "zod";
import {
  metaCreateResponseSchema,
  metaErrorResponseSchema,
  metaInsightsResponseSchema,
  type MetaAdStatus,
  type MetaInsightsResult,
} from "./types";

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

export interface MetaClientConfig {
  accessToken: string;
  /** Without the "act_" prefix — the client adds it. */
  adAccountId: string;
  apiVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v25.0";

export interface CreateAdCreativeInput {
  name: string;
  pageId: string;
  /** The ad's primary text (our creative's `body`). */
  message: string;
  /** The ad's headline (our creative's `hook`). */
  headline: string;
  /** Landing destination — should already carry utm_content for attribution; see src/services/meta/push-creatives.ts. */
  link: string;
  /** A valid Meta call-to-action type, e.g. "SIGN_UP", "SUBSCRIBE", "LEARN_MORE". */
  callToActionType: string;
  /** Required for image-based formats; omit only for a text-only creative. */
  imageUrl?: string;
}

export interface CreateAdInput {
  name: string;
  adSetId: string;
  creativeId: string;
}

export interface AdInsights {
  impressions: number;
  clicks: number;
  spendCents: number;
  /** Sum of actions[].value across every action_type in metaConfig.signupActionTypes. */
  signups: number;
}

export class MetaClient {
  private readonly accessToken: string;
  private readonly adAccountId: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: MetaClientConfig) {
    if (!config.accessToken) throw new Error("MetaClient requires an accessToken");
    if (!config.adAccountId) throw new Error("MetaClient requires an adAccountId");
    this.accessToken = config.accessToken;
    this.adAccountId = config.adAccountId;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: {
      params?: Record<string, string | undefined>;
      schema: z.ZodType<T>;
    },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/${this.apiVersion}${path}`);
    const body = new URLSearchParams();
    body.set("access_token", this.accessToken);

    if (opts.params) {
      for (const [key, value] of Object.entries(opts.params)) {
        if (value === undefined) continue;
        if (method === "GET") {
          url.searchParams.set(key, value);
        } else {
          body.set(key, value);
        }
      }
    }
    if (method === "GET") {
      url.searchParams.set("access_token", this.accessToken);
    }

    const res = await this.fetchImpl(url.toString(), {
      method,
      headers:
        method === "POST"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {},
      body: method === "POST" ? body.toString() : undefined,
    });

    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;

    if (!res.ok) {
      const errorBody = metaErrorResponseSchema.safeParse(json);
      const message = errorBody.success
        ? errorBody.data.error.message
        : `Meta API ${method} ${path} failed with ${res.status}`;
      throw new MetaApiError(message, res.status, json);
    }

    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      throw new MetaApiError(
        `Meta API ${method} ${path} returned an unexpected shape: ${parsed.error.message}`,
        res.status,
        json,
      );
    }
    return parsed.data;
  }

  async createAdCreative(input: CreateAdCreativeInput): Promise<{ id: string }> {
    const linkData: Record<string, unknown> = {
      message: input.message,
      headline: input.headline,
      link: input.link,
      call_to_action: { type: input.callToActionType, value: { link: input.link } },
    };
    if (input.imageUrl) linkData.picture = input.imageUrl;

    return this.request("POST", `/act_${this.adAccountId}/adcreatives`, {
      params: {
        name: input.name,
        object_story_spec: JSON.stringify({
          page_id: input.pageId,
          link_data: linkData,
        }),
      },
      schema: metaCreateResponseSchema,
    });
  }

  /**
   * Always creates the ad PAUSED — see the class-level doc comment. There
   * is no parameter to override this; activation is a separate, gated
   * call (updateAdStatus, only ever invoked from
   * src/services/meta/activate-creative.ts).
   */
  async createAd(input: CreateAdInput): Promise<{ id: string }> {
    return this.request("POST", `/act_${this.adAccountId}/ads`, {
      params: {
        name: input.name,
        adset_id: input.adSetId,
        creative: JSON.stringify({ creative_id: input.creativeId }),
        status: "PAUSED",
      },
      schema: metaCreateResponseSchema,
    });
  }

  async updateAdStatus(adId: string, status: MetaAdStatus): Promise<void> {
    await this.request("POST", `/${adId}`, {
      params: { status },
      schema: z.object({ success: z.boolean().optional() }).passthrough(),
    });
  }

  async getAdInsights(
    adId: string,
    opts: { datePreset?: string } = {},
  ): Promise<MetaInsightsResult | undefined> {
    const result = await this.request("GET", `/${adId}/insights`, {
      params: {
        fields: "impressions,clicks,spend,actions",
        date_preset: opts.datePreset ?? "maximum",
      },
      schema: metaInsightsResponseSchema,
    });
    return result.data[0];
  }
}

/** Sums actions[].value across every action_type in `signupActionTypes`. Rounds down — Meta reports integer conversion counts as strings. */
export function extractSignups(
  insights: MetaInsightsResult | undefined,
  signupActionTypes: readonly string[],
): number {
  if (!insights?.actions) return 0;
  return insights.actions
    .filter((a) => signupActionTypes.includes(a.action_type))
    .reduce((sum, a) => sum + (Number.parseInt(a.value, 10) || 0), 0);
}

/** Meta reports spend as a decimal-dollar string ("1234.56"); the rest of this codebase is integer cents. */
export function spendCentsFromInsights(insights: MetaInsightsResult | undefined): number {
  if (!insights?.spend) return 0;
  const dollars = Number.parseFloat(insights.spend);
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
}

export function createMetaClientFromEnv(): MetaClient {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const adAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!accessToken || !adAccountId) {
    throw new Error(
      "META_ACCESS_TOKEN and META_AD_ACCOUNT_ID must be set to create a MetaClient.",
    );
  }
  return new MetaClient({ accessToken, adAccountId });
}
