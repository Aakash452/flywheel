/**
 * The Reaper: runs hourly, kills what's not working, and has no override
 * path. Two independent kill rules, per spec:
 *
 *   1. Any creative that has spent more than 2x its experiment's target
 *      CPA with zero conversions.
 *   2. Any experiment past its deadline — which cascades: every non-killed
 *      creative under it is killed too, and its underlying Meta ad (if
 *      any) is paused. An experiment being "dead" while its ads keep
 *      spending would defeat the entire point of this service. Pausing
 *      the ad server-side needs no approval — activation is the direction
 *      that's gated, not stopping spend — but a real network call can
 *      still fail, so a pause failure is logged and the local kill still
 *      proceeds rather than blocking on it (better to be marked killed
 *      locally with a manual Meta cleanup flagged than to silently do
 *      nothing).
 *
 * "Returns unspent budget to available balance" — the ledger only ever
 * reflects actual spend (see the ledger's header comment in
 * src/db/schema.ts), so a budget was never itself debited as a
 * reservation. Killing an experiment just stops it from claiming any more
 * of it; there is nothing to write back to the ledger.
 *
 * Every kill call here writes kill_reason — on the creative, on the
 * experiment, or both. Per spec, that log is training data for the
 * Creative Engine's priors; see src/services/creative-engine/index.ts's
 * use of getRecentKillReasons().
 */
import { and, eq, isNotNull, lt, ne } from "drizzle-orm";
import type { Database } from "../../db/client";
import { creatives, experiments } from "../../db/schema";
import type { AdActivator } from "../meta/activate-creative";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function pauseOnMetaIfPushed(
  metaClient: AdActivator | undefined,
  platformCreativeId: string | null,
  creativeId: string,
): Promise<void> {
  if (!metaClient || !platformCreativeId) return;
  try {
    await metaClient.updateAdStatus(platformCreativeId, "PAUSED");
  } catch (err) {
    console.warn(
      `[reaper] killed creative ${creativeId} locally, but pausing it on Meta failed — pause it manually:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export interface KilledCreative {
  creativeId: string;
  experimentId: string;
  reason: string;
}

export interface KillOverspendingCreativesResult {
  evaluated: number;
  killed: KilledCreative[];
}

/**
 * Kills any creative that has spent more than 2x its experiment's target
 * CPA with zero conversions. Experiments with no target_cpa_cents set are
 * skipped for this check — nothing to compare against; see the deviation
 * note on experiments.target_cpa_cents in src/db/schema.ts.
 */
export async function killOverspendingCreatives(
  db: Database,
  metaClient?: AdActivator,
): Promise<KillOverspendingCreativesResult> {
  const rows = await db
    .select({ creative: creatives, targetCpaCents: experiments.targetCpaCents })
    .from(creatives)
    .innerJoin(experiments, eq(creatives.experimentId, experiments.id))
    .where(and(ne(creatives.status, "killed"), isNotNull(experiments.targetCpaCents)));

  const killed: KilledCreative[] = [];

  for (const { creative, targetCpaCents } of rows) {
    if (targetCpaCents === null) continue; // isNotNull already guarantees this; narrows for TS
    if (creative.signups > 0) continue;
    if (creative.spendCents <= targetCpaCents * 2) continue;

    const reason = `Spent ${formatCents(creative.spendCents)} with zero signups — exceeds 2x target CPA (${formatCents(targetCpaCents)}).`;

    await db
      .update(creatives)
      .set({ status: "killed", killReason: reason, updatedAt: new Date() })
      .where(eq(creatives.id, creative.id));
    await pauseOnMetaIfPushed(metaClient, creative.platformCreativeId, creative.id);

    killed.push({ creativeId: creative.id, experimentId: creative.experimentId, reason });
  }

  return { evaluated: rows.length, killed };
}

export interface KilledExperiment {
  experimentId: string;
  reason: string;
  unspentCents: number;
  cascadedCreativeKills: number;
}

export interface KillExpiredExperimentsResult {
  evaluated: number;
  killed: KilledExperiment[];
}

/** Kills any active experiment past its deadline, cascading to its still-live creatives. */
export async function killExpiredExperiments(
  db: Database,
  metaClient?: AdActivator,
  asOf: Date = new Date(),
): Promise<KillExpiredExperimentsResult> {
  const expired = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.status, "active"), lt(experiments.deadline, asOf)));

  const killed: KilledExperiment[] = [];

  for (const experiment of expired) {
    const unspentCents = experiment.budgetCents - experiment.spentCents;
    const reason = `Deadline passed (${experiment.deadline.toISOString()}). ${formatCents(unspentCents)} unspent budget freed.`;

    await db
      .update(experiments)
      .set({ status: "killed", killReason: reason, updatedAt: new Date() })
      .where(eq(experiments.id, experiment.id));

    const liveCreatives = await db
      .select()
      .from(creatives)
      .where(and(eq(creatives.experimentId, experiment.id), ne(creatives.status, "killed")));

    for (const creative of liveCreatives) {
      await db
        .update(creatives)
        .set({
          status: "killed",
          killReason: `Parent experiment killed: deadline passed (${experiment.deadline.toISOString()}).`,
          updatedAt: new Date(),
        })
        .where(eq(creatives.id, creative.id));
      await pauseOnMetaIfPushed(metaClient, creative.platformCreativeId, creative.id);
    }

    killed.push({
      experimentId: experiment.id,
      reason,
      unspentCents,
      cascadedCreativeKills: liveCreatives.length,
    });
  }

  return { evaluated: expired.length, killed };
}

export interface RunReaperResult {
  creatives: KillOverspendingCreativesResult;
  experiments: KillExpiredExperimentsResult;
}

export async function runReaper(
  db: Database,
  metaClient?: AdActivator,
  asOf: Date = new Date(),
): Promise<RunReaperResult> {
  const creativesResult = await killOverspendingCreatives(db, metaClient);
  const experimentsResult = await killExpiredExperiments(db, metaClient, asOf);

  if (creativesResult.killed.length > 0 || experimentsResult.killed.length > 0) {
    console.log("[reaper]", {
      killedCreatives: creativesResult.killed.length,
      killedExperiments: experimentsResult.killed.length,
    });
  }

  return { creatives: creativesResult, experiments: experimentsResult };
}
