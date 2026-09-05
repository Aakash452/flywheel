/**
 * Anthropic-backed draft generator: `claude-sonnet-4-6`, the model the
 * build spec pins for generation (as opposed to the cheaper Haiku 4.5 used
 * for sourcing's relevance scoring — see the comment atop
 * anthropic-relevance-scorer.ts for why those two calls use different
 * models). A direct (non-Batch) call, since one draft per invocation isn't
 * the high-volume, latency-irrelevant workload the spec reserves the
 * Batch API for.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicModelId } from "../../config/pricing";
import { parseDraftResponse, type ParsedDraft } from "./prompt";
import { buildDraftPrompt, type BuildDraftPromptInput } from "./prompt";

export interface DraftGenerationResult extends ParsedDraft {
  inputTokens: number;
  outputTokens: number;
}

export interface DraftGenerator {
  generate(input: BuildDraftPromptInput): Promise<DraftGenerationResult>;
}

const MODEL: AnthropicModelId = "claude-sonnet-4-6";
const MAX_TOKENS = 8_192;

export class AnthropicDraftGenerator implements DraftGenerator {
  constructor(private readonly client: Anthropic) {}

  async generate(input: BuildDraftPromptInput): Promise<DraftGenerationResult> {
    const prompt = buildDraftPrompt(input);

    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = message.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text",
    );
    if (!textBlock) {
      throw new Error("Draft generation response contained no text block");
    }

    const parsed = parseDraftResponse(textBlock.text);
    return {
      ...parsed,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  }
}

export const DRAFT_GENERATOR_MODEL = MODEL;
