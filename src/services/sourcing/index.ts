/**
 * Sourcing pipeline orchestration: fetch → URL-dedup → semantic-dedup →
 * relevance-score → persist only what clears threshold.
 *
 * Nothing here writes a `sources` row until a candidate has actually been
 * scored and cleared the niche's threshold — see the comment on
 * `sources.relevance_score` in src/db/schema.ts. That means a candidate
 * that a batch fails to score (timeout, parse failure) is simply not
 * persisted this cycle; it isn't "pending," it's re-fetched and
 * re-attempted next run. Never auto-publishes anything — a persisted
 * source is raw material for the draft generator (step 4), still gated by
 * a human approving the issue that eventually cites it.
 */
import { niche } from "../../config/niche";
import type { Database } from "../../db/client";
import { sources } from "../../db/schema";
import type { EmbeddingProvider } from "../../integrations/embeddings/voyage-client";
import {
  ANTHROPIC_PRICING_CENTS_PER_MILLION,
  type AnthropicModelId,
} from "../../config/pricing";
import { isDailyApiCapExceeded, logApiCost } from "../cost-control";
import type { ConnectorSet } from "./connectors";
import {
  dedupeByUrlInMemory,
  filterNewUrls,
  filterSemanticDuplicates,
  type EmbeddedCandidate,
  type RawCandidate,
} from "./dedupe";
import type { RelevanceScorer } from "./relevance-scoring";

export interface SourcingDependencies {
  connectors: ConnectorSet;
  /** Omit to fall back to URL-only dedup (logged as a warning). */
  embeddings?: EmbeddingProvider;
  scorer: RelevanceScorer;
  /** Which model name/rates to attribute the scoring cost to — must match what `scorer` actually calls. */
  scorerModel: AnthropicModelId;
  dailyApiSpendCapCents: number;
}

export interface RunSourcingCycleResult {
  capExceeded: boolean;
  fetched: number;
  afterUrlDedupe: number;
  afterSemanticDedupe: number;
  scored: number;
  persisted: number;
}

export async function runSourcingCycle(
  db: Database,
  deps: SourcingDependencies,
): Promise<RunSourcingCycleResult> {
  const empty: RunSourcingCycleResult = {
    capExceeded: false,
    fetched: 0,
    afterUrlDedupe: 0,
    afterSemanticDedupe: 0,
    scored: 0,
    persisted: 0,
  };

  if (await isDailyApiCapExceeded(db, deps.dailyApiSpendCapCents)) {
    console.warn(
      "[sourcing] daily API spend cap exceeded — skipping this cycle entirely (no connectors called)",
    );
    return { ...empty, capExceeded: true };
  }

  const fetched = dedupeByUrlInMemory(await deps.connectors.fetchAll());
  const newCandidates = await filterNewUrls(db, fetched);

  let deduped: EmbeddedCandidate[];
  if (deps.embeddings) {
    deduped = (await filterSemanticDuplicates(db, deps.embeddings, newCandidates)).keep;
  } else {
    console.warn(
      "[sourcing] no embedding provider configured — semantic dedup skipped, URL dedup only",
    );
    deduped = newCandidates.map((c: RawCandidate) => ({ ...c, embedding: null }));
  }

  if (deduped.length === 0) {
    return {
      ...empty,
      fetched: fetched.length,
      afterUrlDedupe: newCandidates.length,
    };
  }

  const scoreResult = await deps.scorer.score(deduped, niche);
  const rates = ANTHROPIC_PRICING_CENTS_PER_MILLION[deps.scorerModel];
  await logApiCost(db, {
    provider: "anthropic",
    model: deps.scorerModel,
    inputTokens: scoreResult.inputTokens,
    outputTokens: scoreResult.outputTokens,
    inputCentsPerMillion: rates.input,
    outputCentsPerMillion: rates.output,
    isBatch: true,
    metadata: { job: "sourcing-relevance-scoring", candidateCount: deduped.length },
  });

  let persisted = 0;
  for (const candidate of deduped) {
    const score = scoreResult.scores.get(candidate.url);
    if (score === undefined || score < niche.relevanceThreshold) continue;

    await db
      .insert(sources)
      .values({
        url: candidate.url,
        title: candidate.title,
        rawContent: candidate.rawContent,
        relevanceScore: score.toFixed(2),
        embedding: candidate.embedding,
        discoveredAt: candidate.discoveredAt,
      })
      .onConflictDoNothing({ target: sources.url });
    persisted++;
  }

  return {
    capExceeded: false,
    fetched: fetched.length,
    afterUrlDedupe: newCandidates.length,
    afterSemanticDedupe: deduped.length,
    scored: scoreResult.scores.size,
    persisted,
  };
}
