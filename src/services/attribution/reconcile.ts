/**
 * Attribution reconciliation: subscriber → creative, verified end-to-end.
 *
 * The join itself (subscribers.source_creative_id) is established at sync
 * time — see src/services/beehiiv/sync-subscribers.ts, which sets it from
 * a subscription's utm_content. This module doesn't create the join; it
 * checks whether the join is behaving correctly, by cross-referencing
 * Meta's own reported conversion count (creatives.signups, written by
 * src/services/meta/poll-performance.ts) against how many subscribers
 * actually landed with that creative's utm_content.
 *
 * A real discrepancy here is a real signal, not noise: a utm parameter
 * getting stripped somewhere in the funnel, a sync that hasn't caught up
 * yet, or a Meta conversion event firing without a confirmed Beehiiv
 * subscription would all show up as `discrepancy !== 0`.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { creatives, subscribers } from "../../db/schema";

export interface CreativeAttributionRow {
  creativeId: string;
  experimentId: string;
  metaReportedSignups: number;
  confirmedSubscribers: number;
  /** metaReportedSignups - confirmedSubscribers. Positive: Meta reports more conversions than we've actually synced. Negative: more confirmed subscribers than Meta credits this ad with (possible if signups haven't been polled recently). */
  discrepancy: number;
}

export async function getAttributionReconciliation(
  db: Database,
): Promise<CreativeAttributionRow[]> {
  const rows = await db
    .select({
      creativeId: creatives.id,
      experimentId: creatives.experimentId,
      metaReportedSignups: creatives.signups,
      confirmedSubscribers: sql<string>`COUNT(${subscribers.id})`,
    })
    .from(creatives)
    .leftJoin(subscribers, eq(subscribers.sourceCreativeId, creatives.id))
    .groupBy(creatives.id, creatives.experimentId, creatives.signups);

  return rows.map((r) => {
    const confirmedSubscribers = Number(r.confirmedSubscribers);
    return {
      creativeId: r.creativeId,
      experimentId: r.experimentId,
      metaReportedSignups: r.metaReportedSignups,
      confirmedSubscribers,
      discrepancy: r.metaReportedSignups - confirmedSubscribers,
    };
  });
}

export interface AttributionSummary {
  totalSubscribers: number;
  attributedSubscribers: number;
  unattributedSubscribers: number;
  /** null when there are no subscribers at all yet. */
  attributionRatePercent: number | null;
  perCreative: CreativeAttributionRow[];
}

export async function getAttributionSummary(db: Database): Promise<AttributionSummary> {
  const allSubscribers = await db
    .select({ id: subscribers.id, sourceCreativeId: subscribers.sourceCreativeId })
    .from(subscribers);

  const total = allSubscribers.length;
  const attributed = allSubscribers.filter((s) => s.sourceCreativeId !== null).length;
  const perCreative = await getAttributionReconciliation(db);

  return {
    totalSubscribers: total,
    attributedSubscribers: attributed,
    unattributedSubscribers: total - attributed,
    attributionRatePercent: total === 0 ? null : (attributed / total) * 100,
    perCreative,
  };
}
