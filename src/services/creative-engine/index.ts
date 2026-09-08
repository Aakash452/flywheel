/**
 * Creative Engine orchestration: generate → embed → reject near-duplicates
 * → top up any gaps in axis coverage or count → persist, always paused.
 *
 * Every creative this writes lands with status='paused' (the column
 * default) — there is no code path here that activates anything. See
 * src/services/meta/activate-creative.ts for the one gated call that can.
 */
import { niche } from "../../config/niche";
import { voice } from "../../config/voice";
import { creativeEngineConfig } from "../../config/creative";
import { ANTHROPIC_PRICING_CENTS_PER_MILLION, type AnthropicModelId } from "../../config/pricing";
import type { Database } from "../../db/client";
import { creatives } from "../../db/schema";
import type { EmbeddingProvider } from "../../integrations/embeddings/voyage-client";
import { isDailyApiCapExceeded, logApiCost } from "../cost-control";
import { filterDiverseVariants, hasFullAxisCoverage, missingAxisValues, type EmbeddedVariant } from "./diversity";
import { getRecentKillPriors } from "./priors";
import type { CreativeGenerator } from "./anthropic-creative-generator";

export interface CreativeEngineDependencies {
  generator: CreativeGenerator;
  generatorModel: AnthropicModelId;
  /** Not optional here, unlike sourcing — the diversity gate this engine exists to enforce has no non-embedding fallback. */
  embeddings: EmbeddingProvider;
  dailyApiSpendCapCents: number;
}

export interface RunCreativeGenerationInput {
  experimentId: string;
  offer: string;
  minVariants?: number;
  variantsPerCall?: number;
  maxRounds?: number;
}

export interface RunCreativeGenerationResult {
  capExceeded: boolean;
  roundsRun: number;
  generated: number;
  droppedAsDuplicate: number;
  persisted: number;
  fullAxisCoverage: boolean;
}

export async function runCreativeGeneration(
  db: Database,
  deps: CreativeEngineDependencies,
  input: RunCreativeGenerationInput,
): Promise<RunCreativeGenerationResult> {
  const empty: RunCreativeGenerationResult = {
    capExceeded: false,
    roundsRun: 0,
    generated: 0,
    droppedAsDuplicate: 0,
    persisted: 0,
    fullAxisCoverage: false,
  };

  if (await isDailyApiCapExceeded(db, deps.dailyApiSpendCapCents)) {
    console.warn("[creative-engine] daily API spend cap exceeded — skipping this run");
    return { ...empty, capExceeded: true };
  }

  const minVariants = input.minVariants ?? creativeEngineConfig.minVariants;
  const variantsPerCall = input.variantsPerCall ?? creativeEngineConfig.variantsPerCall;
  const maxRounds = input.maxRounds ?? creativeEngineConfig.maxRounds;
  const pastFailures = await getRecentKillPriors(db);

  const accepted: EmbeddedVariant[] = [];
  let generated = 0;
  let droppedAsDuplicate = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let rounds = 0;

  while (rounds < maxRounds) {
    if (accepted.length >= minVariants && hasFullAxisCoverage(accepted)) {
      break;
    }

    const remaining = Math.max(0, minVariants - accepted.length);
    const requestCount = Math.max(variantsPerCall, remaining);

    const result = await deps.generator.generate({
      niche,
      voice,
      offer: input.offer,
      count: requestCount,
      existingHooks: accepted.map((v) => v.hook),
      pastFailures,
    });
    generated += result.variants.length;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    rounds++;

    const { keep, droppedAsDuplicate: dropped } = await filterDiverseVariants(
      db,
      deps.embeddings,
      input.experimentId,
      result.variants,
    );
    droppedAsDuplicate += dropped.length;
    accepted.push(...keep);
  }

  if (inputTokens > 0 || outputTokens > 0) {
    const rates = ANTHROPIC_PRICING_CENTS_PER_MILLION[deps.generatorModel];
    await logApiCost(db, {
      provider: "anthropic",
      model: deps.generatorModel,
      inputTokens,
      outputTokens,
      inputCentsPerMillion: rates.input,
      outputCentsPerMillion: rates.output,
      isBatch: false,
      experimentId: input.experimentId,
      metadata: {
        job: "creative-generation",
        rounds,
        generated,
        droppedAsDuplicate,
      },
    });
  }

  if (accepted.length < minVariants) {
    console.warn(
      `[creative-engine] only reached ${accepted.length}/${minVariants} variants after ${rounds} rounds`,
    );
  }
  const stillMissing = missingAxisValues(accepted);
  if (stillMissing.angles.length + stillMissing.formats.length + stillMissing.audienceFramings.length > 0) {
    console.warn("[creative-engine] axis coverage incomplete:", stillMissing);
  }

  let persisted = 0;
  for (const variant of accepted) {
    await db.insert(creatives).values({
      experimentId: input.experimentId,
      angle: variant.angle,
      format: variant.format,
      audienceFraming: variant.audienceFraming,
      hook: variant.hook,
      body: variant.body,
      cta: variant.cta,
      imagePrompt: variant.imagePrompt,
      embedding: variant.embedding.length > 0 ? variant.embedding : null,
      // status omitted deliberately — the column default is 'paused'; no
      // path in this function ever sets anything else.
    });
    persisted++;
  }

  return {
    capExceeded: false,
    roundsRun: rounds,
    generated,
    droppedAsDuplicate,
    persisted,
    fullAxisCoverage: hasFullAxisCoverage(accepted),
  };
}
