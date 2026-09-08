/**
 * The Creative Engine's two diversity mechanisms, per the build spec:
 *   1. "enforce diversity by requiring coverage across the axis matrix" —
 *      every angle, format, and audience framing must appear at least once
 *      across the accepted set.
 *   2. "rejecting variants whose embedding cosine similarity to an
 *      existing variant exceeds 0.9" — checked against both creatives
 *      already persisted for this experiment and variants accepted
 *      earlier in the same generation run.
 *
 * Both are pure/DB-thin and unit-tested independently of the Claude call
 * that produces candidates.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import { creatives } from "../../db/schema";
import { cosineSimilarity } from "../../lib/vectors";
import type { EmbeddingProvider } from "../../integrations/embeddings/voyage-client";
import {
  ANGLES,
  AUDIENCE_FRAMINGS,
  FORMATS,
  type Angle,
  type AudienceFraming,
  type CreativeVariant,
  type Format,
} from "./prompt";

export const CREATIVE_SIMILARITY_THRESHOLD = 0.9;

export interface AxisCoverage {
  angles: Set<Angle>;
  formats: Set<Format>;
  audienceFramings: Set<AudienceFraming>;
}

export function computeAxisCoverage(
  variants: readonly Pick<CreativeVariant, "angle" | "format" | "audienceFraming">[],
): AxisCoverage {
  return {
    angles: new Set(variants.map((v) => v.angle)),
    formats: new Set(variants.map((v) => v.format)),
    audienceFramings: new Set(variants.map((v) => v.audienceFraming)),
  };
}

export interface MissingAxisValues {
  angles: Angle[];
  formats: Format[];
  audienceFramings: AudienceFraming[];
}

/** Everything the axis matrix requires that isn't represented yet. Empty arrays mean full coverage. */
export function missingAxisValues(
  variants: readonly Pick<CreativeVariant, "angle" | "format" | "audienceFraming">[],
): MissingAxisValues {
  const coverage = computeAxisCoverage(variants);
  return {
    angles: ANGLES.filter((a) => !coverage.angles.has(a)),
    formats: FORMATS.filter((f) => !coverage.formats.has(f)),
    audienceFramings: AUDIENCE_FRAMINGS.filter((a) => !coverage.audienceFramings.has(a)),
  };
}

export function hasFullAxisCoverage(
  variants: readonly Pick<CreativeVariant, "angle" | "format" | "audienceFraming">[],
): boolean {
  const missing = missingAxisValues(variants);
  return (
    missing.angles.length === 0 &&
    missing.formats.length === 0 &&
    missing.audienceFramings.length === 0
  );
}

function embeddingText(variant: CreativeVariant): string {
  return `${variant.angle} | ${variant.format} | ${variant.audienceFraming}\n${variant.hook}\n${variant.body}`;
}

export interface EmbeddedVariant extends CreativeVariant {
  embedding: number[];
}

export interface FilterDiverseVariantsResult {
  keep: EmbeddedVariant[];
  droppedAsDuplicate: CreativeVariant[];
}

/**
 * Embeds each candidate and drops any whose cosine similarity to an
 * existing creative in this experiment, or to a variant already accepted
 * earlier in this same call, exceeds the threshold.
 */
export async function filterDiverseVariants(
  db: Database,
  embeddings: EmbeddingProvider,
  experimentId: string,
  candidates: readonly CreativeVariant[],
): Promise<FilterDiverseVariantsResult> {
  if (candidates.length === 0) return { keep: [], droppedAsDuplicate: [] };

  const { embeddings: vectors } = await embeddings.embed(candidates.map(embeddingText));

  const existingRows = await db
    .select({ embedding: creatives.embedding })
    .from(creatives)
    .where(and(eq(creatives.experimentId, experimentId), isNotNull(creatives.embedding)));

  const comparisonPool: number[][] = existingRows
    .map((r) => r.embedding)
    .filter((e): e is number[] => e !== null);

  const keep: EmbeddedVariant[] = [];
  const droppedAsDuplicate: CreativeVariant[] = [];

  candidates.forEach((candidate, i) => {
    const vector = vectors[i];
    if (!vector) {
      // Fail open rather than silently lose a variant the model produced.
      keep.push({ ...candidate, embedding: [] });
      return;
    }

    const isDuplicate = comparisonPool.some(
      (existing) => cosineSimilarity(vector, existing) > CREATIVE_SIMILARITY_THRESHOLD,
    );

    if (isDuplicate) {
      droppedAsDuplicate.push(candidate);
    } else {
      keep.push({ ...candidate, embedding: vector });
      comparisonPool.push(vector);
    }
  });

  return { keep, droppedAsDuplicate };
}
