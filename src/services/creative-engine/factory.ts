/**
 * Wires the real production dependencies for runCreativeGeneration() from
 * env. Unlike sourcing, an embedding provider is mandatory here — the
 * Creative Engine's diversity gate has no degraded mode without one.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createEmbeddingProviderFromEnv } from "../../integrations/embeddings/voyage-client";
import {
  AnthropicCreativeGenerator,
  CREATIVE_GENERATOR_MODEL,
} from "./anthropic-creative-generator";
import type { CreativeEngineDependencies } from "./index";

export function createCreativeEngineDependenciesFromEnv(): CreativeEngineDependencies {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — required for the Creative Engine.",
    );
  }

  const embeddings = createEmbeddingProviderFromEnv();
  if (!embeddings) {
    throw new Error(
      "VOYAGE_API_KEY is not set — required for the Creative Engine's diversity gate (no degraded mode, unlike sourcing).",
    );
  }

  const client = new Anthropic({ apiKey });
  return {
    generator: new AnthropicCreativeGenerator(client),
    generatorModel: CREATIVE_GENERATOR_MODEL,
    embeddings,
    dailyApiSpendCapCents: Number(process.env.DAILY_API_SPEND_CAP_CENTS ?? 5_000),
  };
}
