import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { ledger, subscriberEvents, subscribers } from "../../db/schema";
import {
  getActiveSubscriberCount,
  getCohortSubscriberIds,
  getDistinctCohortWeeks,
  getSubscribersAcquiredInWindow,
  getTrailingLedgerCents,
  getUnsubscribeDates,
} from "./queries";

const dbAvailable = await isDatabaseAvailable();

describe.skipIf(!dbAvailable)("allocator queries (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  describe("getActiveSubscriberCount", () => {
    it("excludes subscribers not yet acquired and those unsubscribed by asOf", async () => {
      await withRollback(async (db) => {
        const now = new Date("2026-06-15T00:00:00Z");
        const [a] = await db.insert(subscribers).values({ beehiivId: "a", acquiredAt: new Date("2026-06-01T00:00:00Z"), cohortWeek: "2026-06-01" }).returning();
        await db.insert(subscribers).values({ beehiivId: "b", acquiredAt: new Date("2026-06-20T00:00:00Z"), cohortWeek: "2026-06-15" }); // not yet acquired as of `now`
        const [c] = await db.insert(subscribers).values({ beehiivId: "c", acquiredAt: new Date("2026-06-02T00:00:00Z"), cohortWeek: "2026-06-01" }).returning();
        if (!a || !c) throw new Error("insert failed");

        await db.insert(subscriberEvents).values({ subscriberId: c.id, eventType: "unsubscribe", occurredAt: new Date("2026-06-10T00:00:00Z") });

        const count = await getActiveSubscriberCount(db, now);
        expect(count).toBe(1); // only `a` — b not acquired yet, c unsubscribed
      });
    });
  });

  describe("getSubscribersAcquiredInWindow", () => {
    it("counts only subscribers acquired within the trailing window", async () => {
      await withRollback(async (db) => {
        const asOf = new Date("2026-06-30T00:00:00Z");
        await db.insert(subscribers).values([
          { beehiivId: "in-window", acquiredAt: new Date("2026-06-15T00:00:00Z"), cohortWeek: "2026-06-15" },
          { beehiivId: "too-old", acquiredAt: new Date("2026-04-01T00:00:00Z"), cohortWeek: "2026-03-30" },
        ]);
        const count = await getSubscribersAcquiredInWindow(db, 30, asOf);
        expect(count).toBe(1);
      });
    });
  });

  describe("getTrailingLedgerCents", () => {
    it("sums only matching category+direction within the window", async () => {
      await withRollback(async (db) => {
        const asOf = new Date("2026-06-30T00:00:00Z");
        await db.insert(ledger).values([
          { direction: "debit", amountCents: 1_000, category: "ad_spend", occurredAt: new Date("2026-06-20T00:00:00Z") },
          { direction: "debit", amountCents: 2_000, category: "ad_spend", occurredAt: new Date("2026-06-25T00:00:00Z") },
          { direction: "credit", amountCents: 5_000, category: "ad_spend", occurredAt: new Date("2026-06-25T00:00:00Z") }, // wrong direction
          { direction: "debit", amountCents: 9_000, category: "tooling", occurredAt: new Date("2026-06-25T00:00:00Z") }, // wrong category
          { direction: "debit", amountCents: 9_000, category: "ad_spend", occurredAt: new Date("2026-01-01T00:00:00Z") }, // outside window
        ]);

        const total = await getTrailingLedgerCents(db, ["ad_spend"], "debit", 30, asOf);
        expect(total).toBe(3_000);
      });
    });
  });

  describe("getDistinctCohortWeeks / getCohortSubscriberIds", () => {
    it("groups subscribers by cohort_week", async () => {
      await withRollback(async (db) => {
        await db.insert(subscribers).values([
          { beehiivId: "a", acquiredAt: new Date(), cohortWeek: "2026-06-01" },
          { beehiivId: "b", acquiredAt: new Date(), cohortWeek: "2026-06-01" },
          { beehiivId: "c", acquiredAt: new Date(), cohortWeek: "2026-06-08" },
        ]);

        const weeks = await getDistinctCohortWeeks(db);
        expect(weeks).toEqual(["2026-06-01", "2026-06-08"]);

        const week1Ids = await getCohortSubscriberIds(db, "2026-06-01");
        expect(week1Ids).toHaveLength(2);
      });
    });
  });

  describe("getUnsubscribeDates", () => {
    it("returns one date per subscriber, the earliest if there are duplicates", async () => {
      await withRollback(async (db) => {
        const [sub] = await db.insert(subscribers).values({ beehiivId: "a", acquiredAt: new Date(), cohortWeek: "2026-06-01" }).returning();
        if (!sub) throw new Error("insert failed");
        await db.insert(subscriberEvents).values([
          { subscriberId: sub.id, eventType: "unsubscribe", occurredAt: new Date("2026-06-10T00:00:00Z") },
          { subscriberId: sub.id, eventType: "unsubscribe", occurredAt: new Date("2026-06-05T00:00:00Z") }, // earlier duplicate
        ]);

        const dates = await getUnsubscribeDates(db, [sub.id]);
        expect(dates).toHaveLength(1);
        expect(dates[0]?.toISOString()).toBe("2026-06-05T00:00:00.000Z");
      });
    });

    it("returns an empty array for no subscriber ids", async () => {
      await withRollback(async (db) => {
        expect(await getUnsubscribeDates(db, [])).toEqual([]);
      });
    });
  });
});

describe.skipIf(dbAvailable)("allocator queries (skipped: no DATABASE_URL reachable)", () => {
  it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
    expect(true).toBe(true);
  });
});
