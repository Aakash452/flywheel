/**
 * Polls Meta for each pushed, non-killed creative's performance every 4
 * hours (per spec) and writes impressions/clicks/signups/spend back onto
 * the creative.
 *
 * Meta's insights report cumulative totals, not deltas. Writing the
 * cumulative spend into creatives.spend_cents directly is correct (it's
 * meant to be the running total), but logging that same cumulative number
 * to the ledger on every poll would double- and triple-count it — the
 * ledger only ever gets the *increase* since the last poll, computed as
 * this poll's total minus what was already on the row.
 */
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { metaConfig } from "../../config/meta";
import type { Database } from "../../db/client";
import { creatives, experiments, ledger } from "../../db/schema";
import { extractSignups, spendCentsFromInsights } from "../../integrations/meta/client";
import type { MetaInsightsResult } from "../../integrations/meta/types";

/** The subset of MetaClient this service needs — kept narrow for testability. */
export interface InsightsSource {
  getAdInsights(adId: string, opts?: { datePreset?: string }): Promise<MetaInsightsResult | undefined>;
}

export interface PollPerformanceResult {
  polled: number;
  updated: number;
}

export interface PollPerformanceOptions {
  /** Defaults to metaConfig.signupActionTypes — overridable so this isn't coupled to the module-level placeholder config in tests (or if it ever needs to vary per call). */
  signupActionTypes?: string[];
}

export async function pollCreativePerformance(
  db: Database,
  client: InsightsSource,
  options: PollPerformanceOptions = {},
): Promise<PollPerformanceResult> {
  const signupActionTypes = options.signupActionTypes ?? metaConfig.signupActionTypes;

  const rows = await db
    .select()
    .from(creatives)
    .where(and(isNotNull(creatives.platformCreativeId), ne(creatives.status, "killed")));

  let updated = 0;

  for (const creative of rows) {
    if (!creative.platformCreativeId) continue; // isNotNull already guarantees this; narrows for TS

    const insights = await client.getAdInsights(creative.platformCreativeId);
    const impressions = Number.parseInt(insights?.impressions ?? "0", 10) || 0;
    const clicks = Number.parseInt(insights?.clicks ?? "0", 10) || 0;
    const signups = extractSignups(insights, signupActionTypes);
    const newSpendCents = spendCentsFromInsights(insights);
    const deltaCents = newSpendCents - creative.spendCents;

    if (deltaCents < 0) {
      console.warn(
        `[meta-performance-poll] creative ${creative.id}: Meta-reported spend decreased (${creative.spendCents} -> ${newSpendCents}) — recording the new total, not logging a negative ledger entry.`,
      );
    }

    await db.transaction(async (tx) => {
      await tx
        .update(creatives)
        .set({ impressions, clicks, signups, spendCents: newSpendCents, updatedAt: new Date() })
        .where(eq(creatives.id, creative.id));

      if (deltaCents > 0) {
        await tx.insert(ledger).values({
          direction: "debit",
          amountCents: deltaCents,
          category: "ad_spend",
          experimentId: creative.experimentId,
          metadata: { job: "meta-performance-poll", creativeId: creative.id },
        });
        // Keep experiments.spent_cents in sync with the ledger it's
        // derived from — the Reaper's "return unspent budget" logic and
        // the dashboard's budget-remaining display both read this column
        // directly rather than re-summing the ledger on every request.
        await tx
          .update(experiments)
          .set({ spentCents: sql`${experiments.spentCents} + ${deltaCents}`, updatedAt: new Date() })
          .where(eq(experiments.id, creative.experimentId));
      }
    });
    updated++;
  }

  return { polled: rows.length, updated };
}
