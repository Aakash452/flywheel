/**
 * Wires the real production dependencies for runDraftGeneration() from
 * env. Kept separate from index.ts so tests can construct
 * DraftingDependencies directly from a fake generator.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicDraftGenerator,
  DRAFT_GENERATOR_MODEL,
} from "./anthropic-draft-generator";
import type { DraftingDependencies } from "./index";

export function createDraftingDependenciesFromEnv(): DraftingDependencies {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — required for the draft generator.",
    );
  }

  const client = new Anthropic({ apiKey });
  return {
    generator: new AnthropicDraftGenerator(client),
    generatorModel: DRAFT_GENERATOR_MODEL,
    dailyApiSpendCapCents: Number(process.env.DAILY_API_SPEND_CAP_CENTS ?? 5_000),
  };
}
