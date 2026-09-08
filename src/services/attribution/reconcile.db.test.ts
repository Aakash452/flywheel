import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { creatives, experiments } from "../../db/schema";
import type { BeehiivSubscription } from "../../integrations/beehiiv";
import { syncSubscribers, type SubscriptionSource } from "../beehiiv/sync-subscribers";
import { getAttributionReconciliation, getAttributionSummary } from "./reconcile";

const dbAvailable = await isDatabaseAvailable();

function fakeSource(subs: BeehiivSubscription[]): SubscriptionSource {
  return {
    async *listAllSubscriptions() {
      for (const sub of subs) yield sub;
    },
  };
}

describe.skipIf(!dbAvailable)("Attribution reconciliation, end-to-end (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("traces a real subscriber back to the exact creative that acquired them, through the real sync path", async () => {
    await withRollback(async (db) => {
      // A creative exists, paused, with Meta reporting 2 conversions.
      const [experiment] = await db
        .insert(experiments)
        .values({ hypothesis: "h", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 86_400_000) })
        .returning();
      if (!experiment) throw new Error("insert failed");

      const [creative] = await db
        .insert(creatives)
        .values({
          experimentId: experiment.id,
          angle: "curiosity",
          format: "static_image",
          audienceFraming: "beginner",
          hook: "hook",
          body: "body",
          cta: "cta",
          spendCents: 10_000,
          signups: 2, // Meta says 2 conversions
        })
        .returning();
      if (!creative) throw new Error("insert failed");

      // Only ONE of those 2 Meta-reported conversions actually shows up as
      // a real Beehiiv subscription in this sync — a realistic gap (the
      // other person may have clicked "subscribe" per Meta's pixel but
      // never confirmed, or hasn't synced yet).
      const subscription: BeehiivSubscription = {
        id: "sub_real",
        email: "reader@example.com",
        status: "active",
        created: Math.floor(Date.now() / 1000),
        utm_content: creative.id,
      };

      // The real, unmodified sync path — not a reimplementation.
      const syncResult = await syncSubscribers(db, fakeSource([subscription]));
      expect(syncResult.attributed).toBe(1);

      const summary = await getAttributionSummary(db);
      expect(summary.totalSubscribers).toBe(1);
      expect(summary.attributedSubscribers).toBe(1);
      expect(summary.attributionRatePercent).toBe(100);

      const reconciliation = await getAttributionReconciliation(db);
      const row = reconciliation.find((r) => r.creativeId === creative.id);
      expect(row?.confirmedSubscribers).toBe(1);
      expect(row?.metaReportedSignups).toBe(2);
      expect(row?.discrepancy).toBe(1); // Meta says 2, only 1 confirmed — a real, visible gap
    });
  });

  it("counts organic (unattributed) subscribers separately, not as a discrepancy on any creative", async () => {
    await withRollback(async (db) => {
      const organicSub: BeehiivSubscription = {
        id: "sub_organic",
        email: "organic@example.com",
        status: "active",
        created: Math.floor(Date.now() / 1000),
        utm_content: null,
      };

      await syncSubscribers(db, fakeSource([organicSub]));

      const summary = await getAttributionSummary(db);
      expect(summary.totalSubscribers).toBe(1);
      expect(summary.attributedSubscribers).toBe(0);
      expect(summary.unattributedSubscribers).toBe(1);
      expect(summary.attributionRatePercent).toBe(0);
    });
  });

  it("reports null attribution rate rather than dividing by zero with no subscribers at all", async () => {
    await withRollback(async (db) => {
      const summary = await getAttributionSummary(db);
      expect(summary.totalSubscribers).toBe(0);
      expect(summary.attributionRatePercent).toBeNull();
    });
  });

  it("shows zero discrepancy for a creative whose Meta signups exactly match confirmed subscribers", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({ hypothesis: "h", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 86_400_000) })
        .returning();
      if (!experiment) throw new Error("insert failed");

      const [creative] = await db
        .insert(creatives)
        .values({
          experimentId: experiment.id,
          angle: "curiosity",
          format: "static_image",
          audienceFraming: "beginner",
          hook: "hook",
          body: "body",
          cta: "cta",
          signups: 1,
        })
        .returning();
      if (!creative) throw new Error("insert failed");

      await syncSubscribers(
        db,
        fakeSource([
          {
            id: "sub_matched",
            email: "match@example.com",
            status: "active",
            created: Math.floor(Date.now() / 1000),
            utm_content: creative.id,
          },
        ]),
      );

      const reconciliation = await getAttributionReconciliation(db);
      const row = reconciliation.find((r) => r.creativeId === creative.id);
      expect(row?.discrepancy).toBe(0);
    });
  });
});

describe.skipIf(dbAvailable)(
  "Attribution reconciliation (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
