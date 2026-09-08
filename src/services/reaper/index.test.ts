import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
  type TestDatabase,
} from "../../db/testing";
import { creatives, experiments } from "../../db/schema";
import type { AdActivator } from "../meta/activate-creative";
import {
  killExpiredExperiments,
  killOverspendingCreatives,
  runReaper,
} from "./index";

const dbAvailable = await isDatabaseAvailable();

function fakePauser(): AdActivator & { calls: Array<{ adId: string; status: string }> } {
  const calls: Array<{ adId: string; status: string }> = [];
  return {
    calls,
    async updateAdStatus(adId, status) {
      calls.push({ adId, status });
    },
  };
}

async function makeExperiment(
  db: TestDatabase,
  overrides: Partial<typeof experiments.$inferInsert> = {},
) {
  const [experiment] = await db
    .insert(experiments)
    .values({
      hypothesis: "h",
      type: "creative_test",
      budgetCents: 100_000,
      deadline: new Date(Date.now() + 7 * 86_400_000),
      ...overrides,
    })
    .returning();
  if (!experiment) throw new Error("experiment insert failed");
  return experiment;
}

async function makeCreative(
  db: TestDatabase,
  experimentId: string,
  overrides: Partial<typeof creatives.$inferInsert> = {},
) {
  const [creative] = await db
    .insert(creatives)
    .values({
      experimentId,
      angle: "curiosity",
      format: "static_image",
      audienceFraming: "beginner",
      hook: "hook",
      body: "body",
      cta: "cta",
      ...overrides,
    })
    .returning();
  if (!creative) throw new Error("creative insert failed");
  return creative;
}

describe.skipIf(!dbAvailable)("Reaper (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  describe("killOverspendingCreatives", () => {
    it("kills a creative that spent more than 2x target CPA with zero signups", async () => {
      await withRollback(async (db) => {
        const experiment = await makeExperiment(db, { targetCpaCents: 1_000 }); // $10 target
        const creative = await makeCreative(db, experiment.id, { spendCents: 2_100, signups: 0 }); // $21 spent, 0 signups

        const result = await killOverspendingCreatives(db);

        expect(result.killed.map((k) => k.creativeId)).toEqual([creative.id]);
        const [row] = await db.select().from(creatives);
        expect(row?.status).toBe("killed");
        expect(row?.killReason).toContain("zero signups");
      });
    });

    it("does not kill a creative at or under the 2x threshold", async () => {
      await withRollback(async (db) => {
        const experiment = await makeExperiment(db, { targetCpaCents: 1_000 });
        await makeCreative(db, experiment.id, { spendCents: 2_000, signups: 0 }); // exactly 2x — not over

        const result = await killOverspendingCreatives(db);
        expect(result.killed).toHaveLength(0);
      });
    });

    it("does not kill an overspending creative that has at least one signup", async () => {
      await withRollback(async (db) => {
        const experiment = await makeExperiment(db, { targetCpaCents: 1_000 });
        await makeCreative(db, experiment.id, { spendCents: 5_000, signups: 1 });

        const result = await killOverspendingCreatives(db);
        expect(result.killed).toHaveLength(0);
      });
    });

    it("skips experiments with no target CPA set", async () => {
      await withRollback(async (db) => {
        const experiment = await makeExperiment(db); // no targetCpaCents
        await makeCreative(db, experiment.id, { spendCents: 100_000, signups: 0 });

        const result = await killOverspendingCreatives(db);
        expect(result.killed).toHaveLength(0);
      });
    });

    it("pauses the ad on Meta when the killed creative was pushed", async () => {
      await withRollback(async (db) => {
        const experiment = await makeExperiment(db, { targetCpaCents: 1_000 });
        await makeCreative(db, experiment.id, {
          spendCents: 3_000,
          signups: 0,
          platformCreativeId: "ad_1",
        });

        const pauser = fakePauser();
        await killOverspendingCreatives(db, pauser);

        expect(pauser.calls).toEqual([{ adId: "ad_1", status: "PAUSED" }]);
      });
    });
  });

  describe("killExpiredExperiments", () => {
    it("kills an active experiment past its deadline", async () => {
      await withRollback(async (db) => {
        const experiment = await makeExperiment(db, { deadline: new Date(Date.now() - 1_000) });

        const result = await killExpiredExperiments(db);

        expect(result.killed.map((k) => k.experimentId)).toEqual([experiment.id]);
        const [row] = await db.select().from(experiments);
        expect(row?.status).toBe("killed");
        expect(row?.killReason).toContain("Deadline passed");
      });
    });

    it("does not touch an experiment whose deadline hasn't passed yet", async () => {
      await withRollback(async (db) => {
        await makeExperiment(db, { deadline: new Date(Date.now() + 86_400_000) });
        const result = await killExpiredExperiments(db);
        expect(result.killed).toHaveLength(0);
      });
    });

    it("does not re-kill an experiment that's already killed", async () => {
      await withRollback(async (db) => {
        await makeExperiment(db, {
          deadline: new Date(Date.now() - 1_000),
          status: "killed",
          killReason: "already dead",
        });
        const result = await killExpiredExperiments(db);
        expect(result.killed).toHaveLength(0);
      });
    });

    it("cascades: kills every still-live creative under the expired experiment and pauses pushed ones", async () => {
      await withRollback(async (db) => {
        const experiment = await makeExperiment(db, { deadline: new Date(Date.now() - 1_000) });
        const live = await makeCreative(db, experiment.id, { platformCreativeId: "ad_live" });
        const alreadyKilled = await makeCreative(db, experiment.id, {
          status: "killed",
          killReason: "pre-existing",
        });

        const pauser = fakePauser();
        const result = await killExpiredExperiments(db, pauser);

        expect(result.killed[0]?.cascadedCreativeKills).toBe(1); // only the live one
        expect(pauser.calls).toEqual([{ adId: "ad_live", status: "PAUSED" }]);

        const rows = await db.select().from(creatives);
        const liveRow = rows.find((r) => r.id === live.id);
        const alreadyKilledRow = rows.find((r) => r.id === alreadyKilled.id);
        expect(liveRow?.status).toBe("killed");
        expect(liveRow?.killReason).toContain("Parent experiment killed");
        expect(alreadyKilledRow?.killReason).toBe("pre-existing"); // untouched, not overwritten
      });
    });

    it("reports unspent budget correctly", async () => {
      await withRollback(async (db) => {
        await makeExperiment(db, {
          deadline: new Date(Date.now() - 1_000),
          budgetCents: 10_000,
          spentCents: 3_000,
        });
        const result = await killExpiredExperiments(db);
        expect(result.killed[0]?.unspentCents).toBe(7_000);
      });
    });
  });

  describe("runReaper", () => {
    it("runs both kill rules in one call", async () => {
      await withRollback(async (db) => {
        const overspendExperiment = await makeExperiment(db, { targetCpaCents: 500 });
        await makeCreative(db, overspendExperiment.id, { spendCents: 2_000, signups: 0 });
        await makeExperiment(db, { deadline: new Date(Date.now() - 1_000) });

        const result = await runReaper(db);
        expect(result.creatives.killed).toHaveLength(1);
        expect(result.experiments.killed).toHaveLength(1);
      });
    });
  });
});

describe.skipIf(dbAvailable)("Reaper (skipped: no DATABASE_URL reachable)", () => {
  it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
    expect(true).toBe(true);
  });
});
