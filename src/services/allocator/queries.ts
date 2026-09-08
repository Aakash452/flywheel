/**
 * DB-backed inputs for the Allocator's pure math (src/lib/cohort-economics.ts).
 * Each function here does one read; the orchestrator in index.ts combines
 * them and calls the pure functions — same split as every other service
 * in this codebase.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Database } from "../../db/client";
import { ledger, subscriberEvents, subscribers, type LedgerCategory } from "../../db/schema";

export async function getDistinctCohortWeeks(db: Database): Promise<string[]> {
  const rows = await db.selectDistinct({ cohortWeek: subscribers.cohortWeek }).from(subscribers);
  return rows.map((r) => r.cohortWeek).sort();
}

export async function getCohortSubscriberIds(db: Database, cohortWeek: string): Promise<string[]> {
  const rows = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(eq(subscribers.cohortWeek, cohortWeek));
  return rows.map((r) => r.id);
}

/** One entry per subscriber who has unsubscribed, at their earliest unsubscribe timestamp. */
export async function getUnsubscribeDates(db: Database, subscriberIds: string[]): Promise<Date[]> {
  if (subscriberIds.length === 0) return [];
  const events = await db
    .select({ subscriberId: subscriberEvents.subscriberId, occurredAt: subscriberEvents.occurredAt })
    .from(subscriberEvents)
    .where(
      and(
        inArray(subscriberEvents.subscriberId, subscriberIds),
        eq(subscriberEvents.eventType, "unsubscribe"),
      ),
    );

  const earliestBySubscriber = new Map<string, Date>();
  for (const event of events) {
    const existing = earliestBySubscriber.get(event.subscriberId);
    if (!existing || event.occurredAt < existing) {
      earliestBySubscriber.set(event.subscriberId, event.occurredAt);
    }
  }
  return [...earliestBySubscriber.values()];
}

/** Active (acquired by `asOf`, not unsubscribed by `asOf`) subscriber count at a point in time. */
export async function getActiveSubscriberCount(db: Database, asOf: Date): Promise<number> {
  const acquired = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(lte(subscribers.acquiredAt, asOf));
  if (acquired.length === 0) return 0;

  const ids = acquired.map((s) => s.id);
  const unsubs = await db
    .select({ subscriberId: subscriberEvents.subscriberId })
    .from(subscriberEvents)
    .where(
      and(
        inArray(subscriberEvents.subscriberId, ids),
        eq(subscriberEvents.eventType, "unsubscribe"),
        lte(subscriberEvents.occurredAt, asOf),
      ),
    );
  const unsubscribedIds = new Set(unsubs.map((u) => u.subscriberId));
  return acquired.length - unsubscribedIds.size;
}

/**
 * Average active subscribers over a trailing window — approximated as the
 * mean of the active count at the window's start and at `asOf` (a linear
 * approximation between two endpoints, not a true time-integral). Adequate
 * for a subscriber base that doesn't swing wildly week to week; flagged
 * here as an approximation, not exact.
 */
export async function getAvgActiveSubscribers(
  db: Database,
  windowDays: number,
  asOf: Date,
): Promise<number> {
  const windowStart = new Date(asOf);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);
  // Sequential, not Promise.all: both queries share the same `db` handle,
  // and a test's single-connection transaction (see src/db/testing.ts)
  // can't pipeline concurrent queries on one client. The two reads here
  // are cheap enough that this costs nothing worth trading correctness
  // for.
  const atStart = await getActiveSubscriberCount(db, windowStart);
  const atEnd = await getActiveSubscriberCount(db, asOf);
  return (atStart + atEnd) / 2;
}

export async function getSubscribersAcquiredInWindow(
  db: Database,
  windowDays: number,
  asOf: Date,
): Promise<number> {
  const windowStart = new Date(asOf);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);
  const rows = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(and(gte(subscribers.acquiredAt, windowStart), lte(subscribers.acquiredAt, asOf)));
  return rows.length;
}

/** Sum of ledger debits/credits in the given categories, over a trailing window. */
export async function getTrailingLedgerCents(
  db: Database,
  categories: LedgerCategory[],
  direction: "credit" | "debit",
  windowDays: number,
  asOf: Date,
): Promise<number> {
  const windowStart = new Date(asOf);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);

  const rows = await db
    .select({ amountCents: ledger.amountCents })
    .from(ledger)
    .where(
      and(
        inArray(ledger.category, categories),
        eq(ledger.direction, direction),
        gte(ledger.occurredAt, windowStart),
        lte(ledger.occurredAt, asOf),
      ),
    );
  return rows.reduce((sum, r) => sum + r.amountCents, 0);
}
