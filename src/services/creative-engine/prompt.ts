/**
 * Creative Engine prompt-building and response-parsing — pure, unit-tested
 * directly. The actual Claude call lives in anthropic-creative-generator.ts.
 *
 * Enum value lists (angle/format/audienceFraming) are imported from the
 * schema itself via each pgEnum's `.enumValues`, not re-typed here — the
 * axis matrix this module enforces coverage over must never silently drift
 * from what the database actually accepts.
 */
import { z } from "zod";
import {
  audienceFramingEnum,
  creativeAngleEnum,
  creativeFormatEnum,
} from "../../db/schema";
import type { NicheConfig } from "../../config/niche";
import type { VoiceConfig } from "../../config/voice";

export const ANGLES = creativeAngleEnum.enumValues;
export const FORMATS = creativeFormatEnum.enumValues;
export const AUDIENCE_FRAMINGS = audienceFramingEnum.enumValues;

export type Angle = (typeof ANGLES)[number];
export type Format = (typeof FORMATS)[number];
export type AudienceFraming = (typeof AUDIENCE_FRAMINGS)[number];

export interface CreativeVariant {
  angle: Angle;
  format: Format;
  audienceFraming: AudienceFraming;
  hook: string;
  body: string;
  cta: string;
  imagePrompt: string | null;
}

/** A past creative the Reaper killed — see priors.ts. Defined here (not there) so this stays a pure, DB-free module. */
export interface KillPrior {
  hook: string;
  angle: string;
  format: string;
  audienceFraming: string;
  killReason: string;
}

export interface BuildVariantPromptInput {
  niche: NicheConfig;
  voice: VoiceConfig;
  offer: string;
  count: number;
  /** Existing hooks in this experiment, so the model doesn't repeat itself across generation rounds. */
  existingHooks?: string[];
  /** Recently killed creatives — spec: "this log becomes training data for the creative engine's priors." */
  pastFailures?: KillPrior[];
}

export function buildVariantPrompt(input: BuildVariantPromptInput): string {
  const { niche, voice, offer, count, existingHooks = [], pastFailures = [] } = input;

  return [
    "You are writing ad creative variants for a paid-acquisition campaign promoting a newsletter.",
    "",
    `Newsletter: ${niche.name}`,
    `Description: ${niche.description}`,
    `Audience: ${niche.audience}`,
    `Voice: ${voice.description}`,
    "",
    `Offer being promoted: ${offer}`,
    "",
    `Generate ${count} distinct creative variants. Each variant is defined by three independent axes:`,
    `- Angle (pick one per variant): ${ANGLES.join(", ")}`,
    `- Format (pick one per variant): ${FORMATS.join(", ")}`,
    `- Audience framing (pick one per variant): ${AUDIENCE_FRAMINGS.join(", ")}`,
    "",
    `Requirements:`,
    `- Across all ${count} variants, use every angle at least once, every format at least once, and every audience framing at least once. Do not cluster on one combination.`,
    `- Each variant must be a genuinely different idea, not a reworded copy of another variant — vary the concrete hook, not just the phrasing.`,
    `- "format" describes what kind of creative asset this is meant to become (a static image ad, a text-heavy post, a meme-style image, a screenshot-style image, or a chart image) — write the hook/body/cta appropriately for that format, and write imagePrompt as a description of the actual image to produce for image-based formats (null for text_heavy).`,
    existingHooks.length > 0
      ? `Do not repeat or closely rephrase any of these existing hooks from earlier rounds:\n${existingHooks.map((h) => `- ${h}`).join("\n")}`
      : "",
    pastFailures.length > 0
      ? `These past creatives were killed for underperforming — avoid similar patterns, don't just avoid the exact wording:\n${pastFailures.map((f) => `- [${f.angle}/${f.format}/${f.audienceFraming}] "${f.hook}" — killed: ${f.killReason}`).join("\n")}`
      : "",
    "",
    "Respond with ONLY a JSON array, no other text, in this exact shape:",
    '[{"angle": "...", "format": "...", "audience_framing": "...", "hook": "...", "body": "...", "cta": "...", "image_prompt": "..." or null}, ...]',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const variantResponseSchema = z.array(
  z.object({
    angle: z.enum(ANGLES),
    format: z.enum(FORMATS),
    audience_framing: z.enum(AUDIENCE_FRAMINGS),
    hook: z.string().min(1),
    body: z.string().min(1),
    cta: z.string().min(1),
    image_prompt: z.string().nullable().optional(),
  }),
);

function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON array found in creative-variant response");
  }
  return text.slice(start, end + 1);
}

/** Tolerates the model wrapping the array in prose or a code fence. */
export function parseVariantResponse(text: string): CreativeVariant[] {
  const jsonText = extractJsonArray(text);
  const parsed = variantResponseSchema.parse(JSON.parse(jsonText));
  return parsed.map((v) => ({
    angle: v.angle,
    format: v.format,
    audienceFraming: v.audience_framing,
    hook: v.hook,
    body: v.body,
    cta: v.cta,
    imagePrompt: v.image_prompt ?? null,
  }));
}
