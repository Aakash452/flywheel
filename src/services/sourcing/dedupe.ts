/**
 * Deduplication for the sourcing pipeline: by URL, then by semantic
 * similarity against the last 30 days of persisted sources.
 *
 * Ordering matters for cost: URL dedup is a free DB lookup and runs first;
 * semantic dedup costs one embedding call per surviving candidate and runs
 * second, before the much more expensive relevance-scoring LLM call — so a
 * near-duplicate is filtered before anything is spent scoring it.
 */
import { and, gte, inArray, isNotNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import { sources } from "../../db/schema";
import { cosineSimilarity } from "../../lib/vectors";
import type { EmbeddingProvider } from "../../integrations/embeddings/voyage-client";

export interface RawCandidate {
  url: string;
  title: string | null;
  rawContent: string | null;
  discoveredAt: Date;
}

export interface EmbeddedCandidate extends RawCandidate {
  embedding: number[] | null;
}

const SEMANTIC_SIMILARITY_THRESHOLD = 0.9;
const SEMANTIC_LOOKBACK_DAYS = 30;
/** Cap on characters embedded per candidate — keeps embedding cost bounded regardless of article length. */
const EMBEDDING_TEXT_MAX_CHARS = 2_000;

/** Collapses candidates sharing a URL (e.g. the same article syndicated across two feeds) within a single fetch. Keeps the first occurrence. */
export function dedupeByUrlInMemory(
  candidates: readonly RawCandidate[],
): RawCandidate[] {
  const seen = new Map<string, RawCandidate>();
  for (const candidate of candidates) {
    if (candidate.url && !seen.has(candidate.url)) {
      seen.set(candidate.url, candidate);
    }
  }
  return [...seen.values()];
}

/** Drops candidates whose URL already exists in `sources`, at any time — a URL is never re-ingested once seen. */
export async function filterNewUrls(
  db: Database,
  candidates: readonly RawCandidate[],
): Promise<RawCandidate[]> {
  if (candidates.length === 0) return [];
  const urls = candidates.map((c) => c.url);
  const existing = await db
    .select({ url: sources.url })
    .from(sources)
    .where(inArray(sources.url, urls));
  const existingUrls = new Set(existing.map((r) => r.url));
  return candidates.filter((c) => !existingUrls.has(c.url));
}

export interface SemanticDedupeResult {
  keep: EmbeddedCandidate[];
  droppedAsDuplicate: RawCandidate[];
}

function embeddingText(candidate: RawCandidate): string {
  return `${candidate.title ?? ""}\n${candidate.rawContent ?? ""}`
    .trim()
    .slice(0, EMBEDDING_TEXT_MAX_CHARS);
}

/**
 * Embeds each candidate and drops any whose cosine similarity to an
 * existing source (persisted in the last 30 days) or to an
 * already-kept candidate earlier in this same batch exceeds 0.9.
 *
 * Returns the embeddings alongside kept candidates so callers can persist
 * them (see src/services/sourcing/index.ts) without re-embedding.
 */
export async function filterSemanticDuplicates(
  db: Database,
  embeddings: EmbeddingProvider,
  candidates: readonly RawCandidate[],
  asOf: Date = new Date(),
): Promise<SemanticDedupeResult> {
  if (candidates.length === 0) return { keep: [], droppedAsDuplicate: [] };

  const { embeddings: vectors } = await embeddings.embed(
    candidates.map(embeddingText),
  );

  const cutoff = new Date(asOf);
  cutoff.setDate(cutoff.getDate() - SEMANTIC_LOOKBACK_DAYS);

  const existingRows = await db
    .select({ embedding: sources.embedding })
    .from(sources)
    .where(and(gte(sources.discoveredAt, cutoff), isNotNull(sources.embedding)));

  const comparisonPool: number[][] = existingRows
    .map((r) => r.embedding)
    .filter((e): e is number[] => e !== null);

  const keep: EmbeddedCandidate[] = [];
  const droppedAsDuplicate: RawCandidate[] = [];

  candidates.forEach((candidate, i) => {
    const vector = vectors[i];
    if (!vector) {
      // Voyage returned fewer embeddings than requested — shouldn't
      // happen, but fail open (keep, without a stored embedding) rather
      // than silently drop a candidate sourcing never got to evaluate.
      keep.push({ ...candidate, embedding: null });
      return;
    }

    const isDuplicate = comparisonPool.some(
      (existing) => cosineSimilarity(vector, existing) > SEMANTIC_SIMILARITY_THRESHOLD,
    );

    if (isDuplicate) {
      droppedAsDuplicate.push(candidate);
    } else {
      keep.push({ ...candidate, embedding: vector });
      // So two near-duplicates arriving in the same run don't both survive.
      comparisonPool.push(vector);
    }
  });

  return { keep, droppedAsDuplicate };
}
