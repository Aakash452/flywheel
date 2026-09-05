/**
 * Wires the real production dependencies for runSourcingCycle() from env +
 * config. Kept separate from index.ts so tests can construct
 * SourcingDependencies directly from fakes without touching env vars.
 */
import Anthropic from "@anthropic-ai/sdk";
import { sourcingConfig } from "../../config/sourcing";
import { createEmbeddingProviderFromEnv } from "../../integrations/embeddings/voyage-client";
import { AnthropicBatchRelevanceScorer } from "./anthropic-relevance-scorer";
import { createConnectorSet, createRedditAuthFromEnv } from "./connectors";
import type { SourcingDependencies } from "./index";

export function createSourcingDependenciesFromEnv(): SourcingDependencies {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — required for sourcing's relevance scoring.",
    );
  }

  const client = new Anthropic({ apiKey });
  const scorer = new AnthropicBatchRelevanceScorer(client);

  return {
    connectors: createConnectorSet(sourcingConfig, createRedditAuthFromEnv()),
    embeddings: createEmbeddingProviderFromEnv(),
    scorer,
    scorerModel: scorer.model,
    dailyApiSpendCapCents: Number(process.env.DAILY_API_SPEND_CAP_CENTS ?? 5_000),
  };
}
