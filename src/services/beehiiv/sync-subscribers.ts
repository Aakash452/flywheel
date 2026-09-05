/**
 * Subscriber sync: pulls subscriptions from Beehiiv and upserts them into
 * `subscribers`. This is where the single most important join in the
 * schema — subscriber → acquiring creative — actually gets made.
 *
 * How attribution works: the Creative Engine (not yet built) will encode a
 * creative's id as `utm_content` on every ad/landing-page link it produces.
 * Beehiiv captures utm_content on signup and returns it on the subscription
 * object. When a new subscriber's utm_content matches a real creative id,
 * we set `source_creative_id` and snapshot that creative's current CPA
 * (spend_cents / signups, from Meta polling) as `acquisition_cost_cents`.
 * No match (organic, referral, direct, or a creative id that predates this
 * system) leaves both null/0 — attribution absence is recorded explicitly,
 * never guessed at.
 *
 * Idempotency: `subscribers.beehiiv_id` is unique, and inserts use
 * ON CONFLICT DO NOTHING. A subscriber's attribution is fixed at the
 * moment they're first synced and is never overwritten by a later sync —
 * these are facts about how they were acquired, not a live view.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { creatives, subscribers } from "../../db/schema";
import { cohortWeekStartFromUnixSeconds } from "../../lib/cohort";
import { cpaCents } from "../../lib/metrics";
import type {
  BeehiivSubscription,
  ListSubscriptionsParams,
} from "../../integrations/beehiiv";

/** The subset of BeehiivClient this service needs — kept narrow for testability. */
export interface SubscriptionSource {
  listAllSubscriptions(
    params?: Omit<ListSubscriptionsParams, "cursor">,
  ): AsyncGenerator<BeehiivSubscription>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeCreativeId(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * A subscriber's allocated acquisition cost, snapshotted at sync time:
 * the acquiring creative's spend divided by its signups so far. Returns 0
 * (not null) when there's not yet enough data — acquisition_cost_cents is
 * NOT NULL in the schema, and "unknown yet" and "free" are different
 * claims we don't have a column to distinguish, so this deliberately
 * under-claims rather than blocking the sync.
 */
export function snapshotAcquisitionCostCents(
  creativeSpendCents: number,
  creativeSignups: number,
): number {
  const cpa = cpaCents(creativeSpendCents, creativeSignups);
  return cpa === null ? 0 : Math.round(cpa);
}

export interface SyncSubscribersOptions {
  /** Beehiiv subscription status to sync. Defaults to "active". */
  status?: ListSubscriptionsParams["status"];
}

export interface SyncSubscribersResult {
  scanned: number;
  inserted: number;
  skippedExisting: number;
  attributed: number;
}

export async function syncSubscribers(
  db: Database,
  client: SubscriptionSource,
  opts: SyncSubscribersOptions = {},
): Promise<SyncSubscribersResult> {
  const result: SyncSubscribersResult = {
    scanned: 0,
    inserted: 0,
    skippedExisting: 0,
    attributed: 0,
  };

  for await (const sub of client.listAllSubscriptions({
    status: opts.status ?? "active",
    expand: ["custom_fields"],
    orderBy: "created",
    direction: "asc",
  })) {
    result.scanned++;

    const acquiredAt = new Date(sub.created * 1_000);
    const cohortWeek = cohortWeekStartFromUnixSeconds(sub.created);

    let sourceCreativeId: string | null = null;
    let acquisitionCostCents = 0;

    const utmContent = sub.utm_content;
    if (utmContent && looksLikeCreativeId(utmContent)) {
      const [creative] = await db
        .select({
          id: creatives.id,
          spendCents: creatives.spendCents,
          signups: creatives.signups,
        })
        .from(creatives)
        .where(eq(creatives.id, utmContent))
        .limit(1);

      if (creative) {
        sourceCreativeId = creative.id;
        acquisitionCostCents = snapshotAcquisitionCostCents(
          creative.spendCents,
          creative.signups,
        );
      }
    }

    const inserted = await db
      .insert(subscribers)
      .values({
        beehiivId: sub.id,
        acquiredAt,
        sourceCreativeId,
        acquisitionCostCents,
        cohortWeek,
      })
      .onConflictDoNothing({ target: subscribers.beehiivId })
      .returning({ id: subscribers.id });

    if (inserted.length > 0) {
      result.inserted++;
      if (sourceCreativeId) result.attributed++;
    } else {
      result.skippedExisting++;
    }
  }

  return result;
}
