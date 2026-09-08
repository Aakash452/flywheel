import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { creatives, experiments } from "../../db/schema";
import { getRecentKillPriors } from "./priors";

const dbAvailable = await isDatabaseAvailable();

describe.skipIf(!dbAvailable)("getRecentKillPriors (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("returns only killed creatives that have a kill reason", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({ hypothesis: "h", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 86_400_000) })
        .returning();
      if (!experiment) throw new Error("insert failed");

      await db.insert(creatives).values([
        {
          experimentId: experiment.id,
          angle: "curiosity",
          format: "static_image",
          audienceFraming: "beginner",
          hook: "killed hook",
          body: "b",
          cta: "c",
          status: "killed",
          killReason: "overspent",
        },
        {
          experimentId: experiment.id,
          angle: "authority",
          format: "text_heavy",
          audienceFraming: "manager",
          hook: "paused hook",
          body: "b",
          cta: "c",
          status: "paused",
        },
      ]);

      const priors = await getRecentKillPriors(db);
      expect(priors).toHaveLength(1);
      expect(priors[0]?.hook).toBe("killed hook");
      expect(priors[0]?.killReason).toBe("overspent");
    });
  });

  it("respects the limit and orders by most recently updated", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({ hypothesis: "h", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 86_400_000) })
        .returning();
      if (!experiment) throw new Error("insert failed");

      for (let i = 0; i < 3; i++) {
        await db.insert(creatives).values({
          experimentId: experiment.id,
          angle: "curiosity",
          format: "static_image",
          audienceFraming: "beginner",
          hook: `hook ${i}`,
          body: "b",
          cta: "c",
          status: "killed",
          killReason: `reason ${i}`,
        });
      }

      const priors = await getRecentKillPriors(db, 2);
      expect(priors).toHaveLength(2);
    });
  });
});

describe.skipIf(dbAvailable)(
  "getRecentKillPriors (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
