/**
 * Anthropic Batch API-backed RelevanceScorer.
 *
 * Model choice: `claude-haiku-4-5`, not the `claude-sonnet-4-6` the build
 * spec names for generation. The spec's stack line reads "claude-sonnet-4-6
 * for generation, batch API where latency is irrelevant" — sonnet-4-6 is
 * pinned for generation (drafting, later the Creative Engine); relevance
 * scoring is a classification task the spec itself calls "a cheap ...
 * call," and Haiku 4.5 is materially cheaper ($1/$5 per MTok vs $3/$15)
 * for exactly this kind of batched yes/no-ish scoring. Combined with the
 * Batch API's 50% discount, this is the cheapest defensible choice for a
 * job that runs every 6 hours regardless of newsletter volume. Override
 * via the constructor if that reasoning doesn't hold for this niche.
 *
 * Per the spec, one Claude call scores 20 candidates at once — see
 * RELEVANCE_CHUNK_SIZE. A single sourcing run's candidates (often more
 * than 20) become multiple *requests inside one Batch*, submitted and
 * polled together, so one 6-hour cron tick costs at most one batch
 * round-trip regardless of how many chunks it contains.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicModelId } from "../../config/pricing";
import type { NicheConfig } from "../../config/niche";
import {
  buildRelevancePrompt,
  chunkCandidates,
  parseRelevanceResponse,
  type RelevanceScoreResult,
  type RelevanceScorer,
  type ScorableCandidate,
} from "./relevance-scoring";

export class RelevanceScoringTimedOutError extends Error {
  constructor(public readonly batchId: string) {
    super(
      `Relevance-scoring batch ${batchId} did not finish within the poll timeout. ` +
        "It may still complete later — Anthropic keeps batch results for 29 days — " +
        "but this run will proceed without those scores; unscored candidates are " +
        "simply not persisted and will be re-fetched and re-attempted next cycle.",
    );
    this.name = "RelevanceScoringTimedOutError";
  }
}

export interface AnthropicRelevanceScorerOptions {
  model?: AnthropicModelId;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

const DEFAULT_MODEL: AnthropicModelId = "claude-haiku-4-5";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60_000;

export class AnthropicBatchRelevanceScorer implements RelevanceScorer {
  readonly model: AnthropicModelId;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(
    private readonly client: Anthropic,
    options: AnthropicRelevanceScorerOptions = {},
  ) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  async score(
    candidates: ScorableCandidate[],
    niche: NicheConfig,
  ): Promise<RelevanceScoreResult> {
    const scores = new Map<string, number>();
    let inputTokens = 0;
    let outputTokens = 0;
    if (candidates.length === 0) return { scores, inputTokens, outputTokens };

    const chunks = chunkCandidates(candidates);
    const batch = await this.client.messages.batches.create({
      requests: chunks.map((chunk, i) => ({
        custom_id: `chunk-${i}`,
        params: {
          model: this.model,
          // Verified live against real RSS/HN content: 1024 was too small
          // and silently truncated the JSON array mid-object for any chunk
          // with several long URL slugs (some real-world feed URLs run
          // 150+ chars), which parseRelevanceResponse then rejected as "no
          // JSON array found" — the response was never malformed, just cut
          // off before the closing bracket. 4096 is real headroom for 20
          // items of realistic length; unused capacity isn't billed since
          // this only caps output, it doesn't pad it.
          max_tokens: 4_096,
          messages: [
            { role: "user" as const, content: buildRelevancePrompt(chunk, niche) },
          ],
        },
      })),
    });

    await this.awaitCompletion(batch.id);

    for await (const result of await this.client.messages.batches.results(batch.id)) {
      if (result.result.type !== "succeeded") {
        console.warn(
          `[relevance-scoring] batch ${batch.id} chunk ${result.custom_id}: ${result.result.type}, skipping`,
        );
        continue;
      }

      const message = result.result.message;
      inputTokens += message.usage.input_tokens;
      outputTokens += message.usage.output_tokens;

      const textBlock = message.content.find(
        (block): block is Anthropic.TextBlock => block.type === "text",
      );
      if (!textBlock) continue;

      try {
        const chunkScores = parseRelevanceResponse(textBlock.text);
        for (const [url, score] of chunkScores) scores.set(url, score);
      } catch (err) {
        console.warn(
          `[relevance-scoring] batch ${batch.id} chunk ${result.custom_id}: failed to parse response:`,
          err,
        );
      }
    }

    return { scores, inputTokens, outputTokens };
  }

  private async awaitCompletion(batchId: string): Promise<void> {
    const deadline = Date.now() + this.pollTimeoutMs;
    let status = (await this.client.messages.batches.retrieve(batchId))
      .processing_status;

    while (status !== "ended") {
      if (Date.now() > deadline) throw new RelevanceScoringTimedOutError(batchId);
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      status = (await this.client.messages.batches.retrieve(batchId))
        .processing_status;
    }
  }
}
