/**
 * Anthropic-backed creative-variant generator: `claude-sonnet-4-6`, same
 * model the spec pins for generation elsewhere (drafting). A direct
 * (non-Batch) call — one generation round produces a batch of variants
 * interactively, the same posture as drafting.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicModelId } from "../../config/pricing";
import { buildVariantPrompt, parseVariantResponse, type BuildVariantPromptInput, type CreativeVariant } from "./prompt";

export interface GenerateVariantsResult {
  variants: CreativeVariant[];
  inputTokens: number;
  outputTokens: number;
}

export interface CreativeGenerator {
  generate(input: BuildVariantPromptInput): Promise<GenerateVariantsResult>;
}

const MODEL: AnthropicModelId = "claude-sonnet-4-6";
const MAX_TOKENS = 8_192;

export class AnthropicCreativeGenerator implements CreativeGenerator {
  constructor(private readonly client: Anthropic) {}

  async generate(input: BuildVariantPromptInput): Promise<GenerateVariantsResult> {
    const prompt = buildVariantPrompt(input);

    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = message.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text",
    );
    if (!textBlock) {
      throw new Error("Creative-variant generation response contained no text block");
    }

    const variants = parseVariantResponse(textBlock.text);
    return {
      variants,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  }
}

export const CREATIVE_GENERATOR_MODEL = MODEL;
