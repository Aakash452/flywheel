/**
 * Zod schemas for the slice of the Meta Marketing (Graph) API this client
 * calls. Verified against developers.facebook.com on 2026-09-05 for the
 * create-ad-creative, create-ad, and update-ad-status shapes. The
 * `actions[]` shape on insights responses (used to derive `signups`) is
 * NOT independently verified against a live response — Meta's docs site
 * didn't yield a concrete example during development, and no
 * META_ACCESS_TOKEN was available to check directly (see the equivalent
 * caveat on Voyage's pricing in src/config/pricing.ts). The
 * {action_type, value} array shape here is well-established Meta API
 * behavior, but confirm against a real insights response before trusting
 * `signups` numbers for a real budget decision.
 */
import { z } from "zod";

export const metaAdStatusSchema = z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]);

export const metaCreateResponseSchema = z.object({
  id: z.string(),
});

export const metaActionSchema = z.object({
  action_type: z.string(),
  value: z.string(),
});

export const metaInsightsResultSchema = z.object({
  impressions: z.string().optional(),
  clicks: z.string().optional(),
  spend: z.string().optional(),
  actions: z.array(metaActionSchema).optional(),
  date_start: z.string().optional(),
  date_stop: z.string().optional(),
});

export const metaInsightsResponseSchema = z.object({
  data: z.array(metaInsightsResultSchema),
});

export const metaErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    fbtrace_id: z.string().optional(),
  }),
});

export type MetaAdStatus = z.infer<typeof metaAdStatusSchema>;
export type MetaInsightsResult = z.infer<typeof metaInsightsResultSchema>;
