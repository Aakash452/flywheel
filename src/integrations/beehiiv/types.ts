/**
 * Zod schemas for the slice of the Beehiiv v2 API Flywheel actually calls.
 * Field names/shapes verified against developers.beehiiv.com on 2026-09-04.
 * Beehiiv's API responds with additional fields we don't use; schemas below
 * only declare what we read; `z.object` strips the rest by default (not
 * `.strict()`), so an upstream field addition never breaks parsing.
 */
import { z } from "zod";

export const beehiivSubscriptionStatusSchema = z.enum([
  "validating",
  "invalid",
  "pending",
  "active",
  "inactive",
  "needs_attention",
  "paused",
]);

export const beehiivCustomFieldSchema = z.object({
  name: z.string().optional(),
  kind: z
    .enum(["string", "integer", "boolean", "date", "datetime", "list", "double"])
    .optional(),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .nullable()
    .optional(),
});
export type BeehiivCustomField = z.infer<typeof beehiivCustomFieldSchema>;

export const beehiivSubscriptionSchema = z.object({
  id: z.string(),
  email: z.string(),
  status: beehiivSubscriptionStatusSchema,
  // Unix seconds, per Beehiiv's docs — not milliseconds, not ISO.
  created: z.number(),
  subscription_tier: z.enum(["free", "premium"]).optional(),
  utm_source: z.string().nullable().optional(),
  utm_medium: z.string().nullable().optional(),
  utm_channel: z.string().nullable().optional(),
  utm_campaign: z.string().nullable().optional(),
  utm_term: z.string().nullable().optional(),
  // This is Flywheel's attribution join key: the Creative Engine encodes a
  // creative's id as utm_content on every ad/landing-page link it produces.
  // See src/services/beehiiv/sync-subscribers.ts.
  utm_content: z.string().nullable().optional(),
  referring_site: z.string().nullable().optional(),
  referral_code: z.string().nullable().optional(),
  custom_fields: z.array(beehiivCustomFieldSchema).optional(),
});
export type BeehiivSubscription = z.infer<typeof beehiivSubscriptionSchema>;

export function beehiivCursorPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    limit: z.number(),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    // Documented as required for cursor-paginated responses, but verified
    // live against the real API: a real GET /subscriptions response with
    // cursor pagination came back with no total_results field at all.
    // Optional here so a real response doesn't fail to parse over a field
    // nothing actually depends on (see ListSubscriptionsResult.totalResults).
    total_results: z.number().optional(),
  });
}

export const beehiivPostStatusSchema = z.enum(["draft", "confirmed", "archived"]);

const beehiivEmailStatsSchema = z.object({
  recipients: z.number().optional(),
  delivered: z.number().optional(),
  opens: z.number().optional(),
  unique_opens: z.number().optional(),
  open_rate: z.number().optional(),
  clicks: z.number().optional(),
  unique_clicks: z.number().optional(),
  verified_clicks: z.number().optional(),
  unique_verified_clicks: z.number().optional(),
  click_rate: z.number().optional(),
  unsubscribes: z.number().optional(),
  spam_reports: z.number().optional(),
});

const beehiivWebStatsSchema = z.object({
  views: z.number().optional(),
  clicks: z.number().optional(),
});

export const beehiivPostStatsSchema = z.object({
  email: beehiivEmailStatsSchema.optional(),
  web: beehiivWebStatsSchema.optional(),
});
export type BeehiivPostStats = z.infer<typeof beehiivPostStatsSchema>;

export const beehiivPostSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  status: beehiivPostStatusSchema,
  subject_line: z.string().nullable().optional(),
  created: z.number().optional(),
  publish_date: z.number().nullable().optional(),
  web_url: z.string().nullable().optional(),
  preview_url: z.string().nullable().optional(),
  stats: beehiivPostStatsSchema.optional(),
});
export type BeehiivPost = z.infer<typeof beehiivPostSchema>;

export const beehiivCreatePostResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    preview_url: z.string().optional(),
  }),
});

export const beehiivGetPostResponseSchema = z.object({
  data: beehiivPostSchema,
});
