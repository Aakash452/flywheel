/**
 * Thin, typed wrapper around the Beehiiv v2 API.
 *
 * Design choices worth knowing before you extend this:
 *
 * - `fetchImpl` and `baseUrl` are constructor-injectable so tests can point
 *   the client at a local stub server instead of the real API, and so the
 *   same client works against Beehiiv's sandbox by overriding `baseUrl`.
 *
 * - `createPost()` always sends `status: "confirmed"` — there is no
 *   "create as draft in Beehiiv" path. That's deliberate: this client
 *   exists to be called exactly once, by src/services/beehiiv/send-issue.ts,
 *   at the moment an `approvals` row has already been verified. The local
 *   `issues` table is the draft/review store; Beehiiv is only ever
 *   contacted to actually send (or schedule) a real send. Keeping "create"
 *   and "send" as the same call — rather than create-draft-then-separately-
 *   confirm — means there's no intermediate state in Beehiiv that a second
 *   bug could accidentally trigger a send from.
 *
 * - Beehiiv's create-post endpoint is documented as asynchronous: it can
 *   return 202 while the post is still being created, and recommends
 *   honoring `Retry-After`. `request()` retries both 429 (rate limit) and
 *   202 (still processing) with backoff, capped, before giving up.
 */
import { z } from "zod";
import {
  beehiivCreatePostResponseSchema,
  beehiivCursorPageSchema,
  beehiivGetPostResponseSchema,
  beehiivSubscriptionSchema,
  type BeehiivPost,
  type BeehiivSubscription,
} from "./types";

export class BeehiivApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "BeehiivApiError";
  }
}

export interface BeehiivClientConfig {
  apiKey: string;
  publicationId: string;
  /** Override for testing or Beehiiv's sandbox environment. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.beehiiv.com/v2";
const RETRYABLE_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export type BeehiivSubscriptionStatusFilter =
  | "validating"
  | "invalid"
  | "pending"
  | "active"
  | "inactive"
  | "needs_attention"
  | "paused"
  | "all";

export interface ListSubscriptionsParams {
  cursor?: string;
  limit?: number;
  status?: BeehiivSubscriptionStatusFilter;
  expand?: Array<"stats" | "custom_fields" | "referrals" | "newsletter_lists">;
  orderBy?: "created";
  direction?: "asc" | "desc";
}

export interface ListSubscriptionsResult {
  data: BeehiivSubscription[];
  hasMore: boolean;
  nextCursor: string | null;
  totalResults: number;
}

export interface CreatePostInput {
  title: string;
  subtitle?: string;
  /** Raw HTML. Beehiiv strips <style>/<link> tags; inline styles survive. */
  bodyContent: string;
  /** Omit for immediate send. */
  scheduledAt?: Date;
  emailSubjectLine?: string;
  emailPreviewText?: string;
  replyToAddress?: string;
  contentTags?: string[];
}

export interface CreatePostResult {
  id: string;
  previewUrl?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  }
  return DEFAULT_RETRY_DELAY_MS * attempt;
}

export class BeehiivClient {
  private readonly apiKey: string;
  private readonly publicationId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: BeehiivClientConfig) {
    if (!config.apiKey) throw new Error("BeehiivClient requires an apiKey");
    if (!config.publicationId) {
      throw new Error("BeehiivClient requires a publicationId");
    }
    this.apiKey = config.apiKey;
    this.publicationId = config.publicationId;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | string[] | undefined>;
      body?: unknown;
      schema: z.ZodType<T>;
      /** Retry on 202 (still processing) as well as 429. */
      retryOn202?: boolean;
    },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(`${key}[]`, v);
        } else {
          url.searchParams.set(key, value);
        }
      }
    }

    let lastError: BeehiivApiError | undefined;

    for (let attempt = 1; attempt <= RETRYABLE_MAX_ATTEMPTS; attempt++) {
      const res = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });

      const text = await res.text();
      const json = text ? JSON.parse(text) : undefined;

      const retryableStatus =
        res.status === 429 || (opts.retryOn202 && res.status === 202);

      if (!res.ok && !retryableStatus) {
        throw new BeehiivApiError(
          `Beehiiv API ${method} ${path} failed with ${res.status}`,
          res.status,
          json,
        );
      }

      if (retryableStatus && attempt < RETRYABLE_MAX_ATTEMPTS) {
        lastError = new BeehiivApiError(
          `Beehiiv API ${method} ${path} returned ${res.status}; retrying`,
          res.status,
          json,
        );
        await sleep(retryDelayMs(res, attempt));
        continue;
      }

      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        throw new BeehiivApiError(
          `Beehiiv API ${method} ${path} returned an unexpected shape: ${parsed.error.message}`,
          res.status,
          json,
        );
      }
      return parsed.data;
    }

    // Unreachable in practice (the loop always returns or throws), but
    // keeps the type checker happy and gives a sane error if it ever isn't.
    throw (
      lastError ??
      new BeehiivApiError(`Beehiiv API ${method} ${path} failed`, 0, undefined)
    );
  }

  /** One page of subscriptions. Prefer listAllSubscriptions() for a full sync. */
  async listSubscriptions(
    params: ListSubscriptionsParams = {},
  ): Promise<ListSubscriptionsResult> {
    const page = await this.request(
      "GET",
      `/publications/${this.publicationId}/subscriptions`,
      {
        query: {
          cursor: params.cursor,
          limit: params.limit !== undefined ? String(params.limit) : undefined,
          status: params.status,
          expand: params.expand,
          order_by: params.orderBy,
          direction: params.direction,
        },
        schema: beehiivCursorPageSchema(beehiivSubscriptionSchema),
      },
    );
    return {
      data: page.data,
      hasMore: page.has_more,
      nextCursor: page.next_cursor,
      totalResults: page.total_results,
    };
  }

  /** Pages through every subscription matching `params`, yielding one at a time. */
  async *listAllSubscriptions(
    params: Omit<ListSubscriptionsParams, "cursor"> = {},
  ): AsyncGenerator<BeehiivSubscription> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listSubscriptions({ ...params, cursor });
      for (const sub of page.data) yield sub;
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  /**
   * Sends (or schedules) an issue. See the class-level doc comment — this
   * is deliberately the only way this client creates a post, and it always
   * results in a real send. Callers MUST have already verified an
   * `approvals` row exists; this method does not check.
   */
  async createPost(input: CreatePostInput): Promise<CreatePostResult> {
    const result = await this.request(
      "POST",
      `/publications/${this.publicationId}/posts`,
      {
        body: {
          title: input.title,
          subtitle: input.subtitle,
          body_content: input.bodyContent,
          status: "confirmed",
          scheduled_at: input.scheduledAt?.toISOString(),
          email_settings: {
            email_subject_line: input.emailSubjectLine ?? input.title,
            email_preview_text: input.emailPreviewText,
            reply_to_address: input.replyToAddress,
          },
          content_tags: input.contentTags,
        },
        schema: beehiivCreatePostResponseSchema,
        retryOn202: true,
      },
    );
    return { id: result.data.id, previewUrl: result.data.preview_url };
  }

  async getPost(
    postId: string,
    opts: { expand?: Array<"stats"> } = {},
  ): Promise<BeehiivPost> {
    const result = await this.request(
      "GET",
      `/publications/${this.publicationId}/posts/${postId}`,
      {
        query: { expand: opts.expand },
        schema: beehiivGetPostResponseSchema,
      },
    );
    return result.data;
  }
}

export function createBeehiivClientFromEnv(): BeehiivClient {
  const apiKey = process.env.BEEHIIV_API_KEY;
  const publicationId = process.env.BEEHIIV_PUBLICATION_ID;
  if (!apiKey || !publicationId) {
    throw new Error(
      "BEEHIIV_API_KEY and BEEHIIV_PUBLICATION_ID must be set to create a BeehiivClient.",
    );
  }
  // Optional override — points the client at Beehiiv's sandbox, or at a
  // local stub server for smoke-testing the worker process end-to-end
  // without hitting the real API.
  const baseUrl = process.env.BEEHIIV_API_BASE_URL;
  return new BeehiivClient({ apiKey, publicationId, baseUrl });
}
