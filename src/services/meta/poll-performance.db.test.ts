import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { creatives, experiments, ledger } from "../../db/schema";
import type { MetaInsightsResult } from "../../integrations/meta/types";
import type { InsightsSource } from "./poll-performance";
import { pollCreativePerformance } from "./poll-performance";

const dbAvailable = await isDatabaseAvailable();

function fakeInsightsSource(byAdId: Record<string, MetaInsightsResult>): InsightsSource {
  return {
    async getAdInsights(adId: string) {
      return byAdId[adId];
    },
  };
}

describe.skipIf(!dbAvailable)("pollCreativePerformance (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("updates impressions/clicks/signups/spend and logs the incremental spend to the ledger", async () => {
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
          platformCreativeId: "ad_1",
          spendCents: 1_000, // already had $10 recorded from a previous poll
        })
        .returning();
      if (!creative) throw new Error("insert failed");

      const source = fakeInsightsSource({
        ad_1: {
          impressions: "5000",
          clicks: "120",
          spend: "15.00", // now $15 total -> $5 (500 cents) incremental
          actions: [{ action_type: "lead", value: "4" }],
        },
      });

      const result = await pollCreativePerformance(db, source, { signupActionTypes: ["lead"] });
      expect(result).toEqual({ polled: 1, updated: 1 });

      const [row] = await db.select().from(creatives);
      expect(row?.impressions).toBe(5_000);
      expect(row?.clicks).toBe(120);
      expect(row?.signups).toBe(4);
      expect(row?.spendCents).toBe(1_500);

      const ledgerRows = await db.select().from(ledger);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.category).toBe("ad_spend");
      expect(ledgerRows[0]?.amountCents).toBe(500); // the delta, not the full 1500
      expect(ledgerRows[0]?.experimentId).toBe(experiment.id);

      const [updatedExperiment] = await db.select().from(experiments);
      expect(updatedExperiment?.spentCents).toBe(500); // started at 0, incremented by the delta
    });
  });

  it("does not log a ledger entry when Meta-reported spend hasn't increased", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({ hypothesis: "h", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 86_400_000) })
        .returning();
      if (!experiment) throw new Error("insert failed");

      await db.insert(creatives).values({
        experimentId: experiment.id,
        angle: "curiosity",
        format: "static_image",
        audienceFraming: "beginner",
        hook: "hook",
        body: "body",
        cta: "cta",
        platformCreativeId: "ad_1",
        spendCents: 1_000,
      });

      const source = fakeInsightsSource({
        ad_1: { impressions: "100", clicks: "1", spend: "10.00" }, // unchanged
      });

      await pollCreativePerformance(db, source);
      const ledgerRows = await db.select().from(ledger);
      expect(ledgerRows).toHaveLength(0);
    });
  });

  it("skips killed creatives", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({ hypothesis: "h", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 86_400_000) })
        .returning();
      if (!experiment) throw new Error("insert failed");

      await db.insert(creatives).values({
        experimentId: experiment.id,
        angle: "curiosity",
        format: "static_image",
        audienceFraming: "beginner",
        hook: "hook",
        body: "body",
        cta: "cta",
        platformCreativeId: "ad_1",
        status: "killed",
        killReason: "test",
      });

      let called = false;
      const source: InsightsSource = {
        async getAdInsights() {
          called = true;
          return undefined;
        },
      };
      const result = await pollCreativePerformance(db, source);
      expect(result).toEqual({ polled: 0, updated: 0 });
      expect(called).toBe(false);
    });
  });

  it("skips creatives never pushed to Meta (no platform_creative_id)", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({ hypothesis: "h", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 86_400_000) })
        .returning();
      if (!experiment) throw new Error("insert failed");

      await db.insert(creatives).values({
        experimentId: experiment.id,
        angle: "curiosity",
        format: "static_image",
        audienceFraming: "beginner",
        hook: "hook",
        body: "body",
        cta: "cta",
      });

      const result = await pollCreativePerformance(db, fakeInsightsSource({}));
      expect(result).toEqual({ polled: 0, updated: 0 });
    });
  });
});

describe.skipIf(dbAvailable)(
  "pollCreativePerformance (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
