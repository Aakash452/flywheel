import { afterAll, describe, expect, it } from "vitest";
import { closeTestPool, isDatabaseAvailable, withRollback, type TestDatabase } from "../../db/testing";
import { experiments } from "../../db/schema";
import { getLatestApproval } from "../approvals";
import { ExperimentNotActiveError, ExperimentNotFoundError, increaseBudget } from "./increase-budget";

const dbAvailable = await isDatabaseAvailable();

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
      deadline: new Date(Date.now() + 86_400_000),
      ...overrides,
    })
    .returning();
  if (!experiment) throw new Error("experiment insert failed");
  return experiment;
}

describe.skipIf(!dbAvailable)("increaseBudget (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("raises budget by 20% and records the approval, atomically", async () => {
    await withRollback(async (db) => {
      const experiment = await makeExperiment(db);

      const updated = await increaseBudget(db, experiment.id, "operator@example.com");

      expect(updated.budgetCents).toBe(120_000);

      const approval = await getLatestApproval(db, "increase_budget", "experiments", experiment.id);
      expect(approval).toBeDefined();
      expect(approval?.approvedBy).toBe("operator@example.com");
    });
  });

  it("accepts a custom fraction", async () => {
    await withRollback(async (db) => {
      const experiment = await makeExperiment(db);
      const updated = await increaseBudget(db, experiment.id, "operator@example.com", 0.5);
      expect(updated.budgetCents).toBe(150_000);
    });
  });

  it("refuses a non-existent experiment", async () => {
    await withRollback(async (db) => {
      await expect(
        increaseBudget(db, "00000000-0000-0000-0000-000000000000", "operator@example.com"),
      ).rejects.toThrow(ExperimentNotFoundError);
    });
  });

  it("refuses a killed experiment — no reviving spend through the budget knob", async () => {
    await withRollback(async (db) => {
      const experiment = await makeExperiment(db, { status: "killed", killReason: "test kill" });
      await expect(increaseBudget(db, experiment.id, "operator@example.com")).rejects.toThrow(
        ExperimentNotActiveError,
      );
    });
  });

  it("refuses a won experiment — already resolved, nothing left to scale", async () => {
    await withRollback(async (db) => {
      const experiment = await makeExperiment(db, { status: "won" });
      await expect(increaseBudget(db, experiment.id, "operator@example.com")).rejects.toThrow(
        ExperimentNotActiveError,
      );
    });
  });
});

describe.skipIf(dbAvailable)("increaseBudget (skipped: no DATABASE_URL reachable)", () => {
  it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
    expect(true).toBe(true);
  });
});
