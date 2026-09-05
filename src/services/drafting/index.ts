/**
 * Draft generator orchestration: pick the top unused sources and the best
 * past few-shot examples, generate a full issue + 5 scored subject-line
 * candidates, and insert it as a draft. Never sends anything — a draft
 * only ever reaches a subscriber after a human calls approveIssue() and
 * then sendIssue() (see src/services/beehiiv/send-issue.ts).
 */
import { inArray } from "drizzle-orm";
import { draftingConfig } from "../../config/drafting";
import { niche } from "../../config/niche";
import type { AnthropicModelId } from "../../config/pricing";
import { ANTHROPIC_PRICING_CENTS_PER_MILLION } from "../../config/pricing";
import { voice } from "../../config/voice";
import type { Database } from "../../db/client";
import { issues, sources } from "../../db/schema";
import { isDailyApiCapExceeded, logApiCost } from "../cost-control";
import { pickBestSubjectLine } from "./prompt";
import type { DraftGenerator } from "./anthropic-draft-generator";
import { getTopPerformingIssues, getTopUnusedSources } from "./ranking";

export interface DraftingDependencies {
  generator: DraftGenerator;
  /** Must match what `generator` actually calls — used for ledger cost attribution. */
  generatorModel: AnthropicModelId;
  dailyApiSpendCapCents: number;
  sourceCount?: number;
  fewShotCount?: number;
  subjectLineCandidateCount?: number;
}

export interface RunDraftGenerationResult {
  capExceeded: boolean;
  /** True when there were no unused sources above threshold to draft from — nothing was generated or spent. */
  noSourcesAvailable: boolean;
  issueId?: string;
  sourcesUsed: number;
}

export async function runDraftGeneration(
  db: Database,
  deps: DraftingDependencies,
): Promise<RunDraftGenerationResult> {
  const empty: RunDraftGenerationResult = {
    capExceeded: false,
    noSourcesAvailable: false,
    sourcesUsed: 0,
  };

  if (await isDailyApiCapExceeded(db, deps.dailyApiSpendCapCents)) {
    console.warn(
      "[drafting] daily API spend cap exceeded — skipping this cycle",
    );
    return { ...empty, capExceeded: true };
  }

  const topSources = await getTopUnusedSources(
    db,
    deps.sourceCount ?? draftingConfig.sourceCount,
  );
  if (topSources.length === 0) {
    return { ...empty, noSourcesAvailable: true };
  }

  const fewShotIssues = await getTopPerformingIssues(
    db,
    deps.fewShotCount ?? draftingConfig.fewShotCount,
  );

  const result = await deps.generator.generate({
    sources: topSources,
    niche,
    voice,
    fewShotIssues,
    subjectLineCandidateCount:
      deps.subjectLineCandidateCount ?? draftingConfig.subjectLineCandidateCount,
  });

  const rates = ANTHROPIC_PRICING_CENTS_PER_MILLION[deps.generatorModel];
  await logApiCost(db, {
    provider: "anthropic",
    model: deps.generatorModel,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    inputCentsPerMillion: rates.input,
    outputCentsPerMillion: rates.output,
    isBatch: false,
    metadata: { job: "draft-generation", sourceCount: topSources.length },
  });

  const best = pickBestSubjectLine(result.subjectLines);
  const sourceIds = topSources.map((s) => s.id);

  const issueId = await db.transaction(async (tx) => {
    const [issue] = await tx
      .insert(issues)
      .values({
        subjectLine: best.subjectLine,
        bodyMd: result.bodyMd,
        subjectLineCandidates: result.subjectLines,
        status: "draft",
      })
      .returning();
    if (!issue) throw new Error("Failed to insert draft issue");

    await tx
      .update(sources)
      .set({ usedInIssueId: issue.id })
      .where(inArray(sources.id, sourceIds));

    return issue.id;
  });

  return { ...empty, issueId, sourcesUsed: topSources.length };
}
