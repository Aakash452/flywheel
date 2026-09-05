import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { creatives, experiments, subscribers } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { BeehiivSubscription } from "../../integrations/beehiiv";
import { syncSubscribers, type SubscriptionSource } from "./sync-subscribers";

const dbAvailable = await isDatabaseAvailable();

function fakeSource(subs: BeehiivSubscription[]): SubscriptionSource {
  return {
    async *listAllSubscriptions() {
      for (const sub of subs) yield sub;
    },
  };
}

function baseSub(overrides: Partial<BeehiivSubscription>): BeehiivSubscription {
  return {
    id: `sub_${randomUUID()}`,
    email: "reader@example.com",
    status: "active",
    created: Math.floor(Date.UTC(2026, 8, 7) / 1000), // 2026-09-07, a Monday
    ...overrides,
  };
}

describe.skipIf(!dbAvailable)("syncSubscribers (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("inserts a subscriber with no utm_content as unattributed", async () => {
    await withRollback(async (db) => {
      const sub = baseSub({ utm_content: null });
      const result = await syncSubscribers(db, fakeSource([sub]));

      expect(result).toEqual({
        scanned: 1,
        inserted: 1,
        skippedExisting: 0,
        attributed: 0,
      });

      const [row] = await db
        .select()
        .from(subscribers)
        .where(eq(subscribers.beehiivId, sub.id));
      expect(row?.sourceCreativeId).toBeNull();
      expect(row?.acquisitionCostCents).toBe(0);
      expect(row?.cohortWeek).toBe("2026-09-07");
    });
  });

  it("attributes a subscriber whose utm_content matches a real creative", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({
          hypothesis: "test hypothesis",
          type: "creative_test",
          budgetCents: 100_000,
          deadline: new Date(Date.now() + 7 * 86_400_000),
        })
        .returning();
      if (!experiment) throw new Error("experiment insert failed");

      const [creative] = await db
        .insert(creatives)
        .values({
          experimentId: experiment.id,
          angle: "curiosity",
          format: "static_image",
          audienceFraming: "practitioner",
          hook: "hook",
          body: "body",
          cta: "cta",
          spendCents: 10_000,
          signups: 4,
        })
        .returning();
      if (!creative) throw new Error("creative insert failed");

      const sub = baseSub({ utm_content: creative.id });
      const result = await syncSubscribers(db, fakeSource([sub]));

      expect(result.attributed).toBe(1);

      const [row] = await db
        .select()
        .from(subscribers)
        .where(eq(subscribers.beehiivId, sub.id));
      expect(row?.sourceCreativeId).toBe(creative.id);
      // 10_000 / 4 = 2_500
      expect(row?.acquisitionCostCents).toBe(2_500);
    });
  });

  it("leaves a subscriber unattributed when utm_content doesn't match any creative", async () => {
    await withRollback(async (db) => {
      const sub = baseSub({ utm_content: randomUUID() }); // well-formed UUID, no such creative
      const result = await syncSubscribers(db, fakeSource([sub]));

      expect(result.attributed).toBe(0);
      const [row] = await db
        .select()
        .from(subscribers)
        .where(eq(subscribers.beehiivId, sub.id));
      expect(row?.sourceCreativeId).toBeNull();
    });
  });

  it("ignores non-UUID utm_content without querying creatives", async () => {
    await withRollback(async (db) => {
      const sub = baseSub({ utm_content: "google_organic" });
      const result = await syncSubscribers(db, fakeSource([sub]));
      expect(result.attributed).toBe(0);
    });
  });

  it("is idempotent: re-syncing the same subscriber does not insert a duplicate or change attribution", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({
          hypothesis: "test hypothesis",
          type: "creative_test",
          budgetCents: 100_000,
          deadline: new Date(Date.now() + 7 * 86_400_000),
        })
        .returning();
      if (!experiment) throw new Error("experiment insert failed");

      const [creative] = await db
        .insert(creatives)
        .values({
          experimentId: experiment.id,
          angle: "curiosity",
          format: "static_image",
          audienceFraming: "practitioner",
          hook: "hook",
          body: "body",
          cta: "cta",
          spendCents: 10_000,
          signups: 4,
        })
        .returning();
      if (!creative) throw new Error("creative insert failed");

      const sub = baseSub({ utm_content: creative.id });

      const first = await syncSubscribers(db, fakeSource([sub]));
      expect(first.inserted).toBe(1);

      // Spend/signups change after the first sync — re-syncing the same
      // subscriber must NOT retroactively change their recorded
      // acquisition cost.
      await db
        .update(creatives)
        .set({ spendCents: 40_000, signups: 4 })
        .where(eq(creatives.id, creative.id));

      const second = await syncSubscribers(db, fakeSource([sub]));
      expect(second).toEqual({
        scanned: 1,
        inserted: 0,
        skippedExisting: 1,
        attributed: 0,
      });

      const rows = await db
        .select()
        .from(subscribers)
        .where(eq(subscribers.beehiivId, sub.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.acquisitionCostCents).toBe(2_500); // unchanged from first sync
    });
  });
});

describe.skipIf(dbAvailable)(
  "syncSubscribers (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
