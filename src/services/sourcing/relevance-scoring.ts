/**
 * Relevance scoring: "a cheap single Claude call that batches 20
 * candidates at once" (build spec). The prompt-building and response-
 * parsing here are pure and unit-tested directly; the actual Claude call
 * (via the Batch API, per the spec's cost-control section) lives in
 * anthropic-relevance-scorer.ts, injectable through the `RelevanceScorer`
 * interface so the orchestrator never has to know which model or API
 * surface did the scoring.
 */
import { z } from "zod";
import type { NicheConfig } from "../../config/niche";

export interface ScorableCandidate {
  url: string;
  title: string | null;
  rawContent: string | null;
}

export interface RelevanceScoreResult {
  /** url -> 0-100 */
  scores: Map<string, number>;
  inputTokens: number;
  outputTokens: number;
}

export interface RelevanceScorer {
  score(
    candidates: ScorableCandidate[],
    niche: NicheConfig,
  ): Promise<RelevanceScoreResult>;
}

export const RELEVANCE_CHUNK_SIZE = 20;
/** Keeps the scoring prompt (and its cost) bounded regardless of article length. */
const EXCERPT_MAX_CHARS = 500;

export function chunkCandidates<T>(items: T[], size = RELEVANCE_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function buildRelevancePrompt(
  candidates: ScorableCandidate[],
  niche: NicheConfig,
): string {
  const list = candidates
    .map(
      (c, i) =>
        `${i + 1}. URL: ${c.url}\nTitle: ${c.title ?? "(no title)"}\nExcerpt: ${(c.rawContent ?? "").slice(0, EXCERPT_MAX_CHARS)}`,
    )
    .join("\n\n");

  return [
    "You are scoring article/post candidates for relevance to a newsletter with this niche:",
    `Name: ${niche.name}`,
    `Description: ${niche.description}`,
    `Audience: ${niche.audience}`,
    `Topics of interest: ${niche.topics.join(", ")}`,
    niche.exclude.length > 0
      ? `Explicitly out of scope: ${niche.exclude.join(", ")}`
      : "",
    "",
    "Score each candidate 0-100 for how relevant and worth covering it is for this newsletter's next issue. 0 = completely irrelevant, 100 = perfect fit.",
    "",
    "Candidates:",
    list,
    "",
    "Respond with ONLY a JSON array, no other text, in this exact shape:",
    '[{"url": "...", "score": 0}, ...]',
    "Include exactly one entry per candidate, in any order, using the exact URL given above.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const relevanceResponseSchema = z.array(
  z.object({ url: z.string(), score: z.number().min(0).max(100) }),
);

function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON array found in relevance-scoring response");
  }
  return text.slice(start, end + 1);
}

/** Tolerates the model wrapping the array in prose or a code fence — extracts the first/last bracket rather than requiring an exact match. */
export function parseRelevanceResponse(text: string): Map<string, number> {
  const jsonText = extractJsonArray(text);
  const parsed = relevanceResponseSchema.parse(JSON.parse(jsonText));
  const scores = new Map<string, number>();
  for (const entry of parsed) scores.set(entry.url, entry.score);
  return scores;
}
