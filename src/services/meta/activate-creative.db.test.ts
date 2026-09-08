import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
  type TestDatabase,
} from "../../db/testing";
import { creatives, experiments } from "../../db/schema";
import { ApprovalRequiredError, recordApproval } from "../approvals";
import type { AdActivator } from "./activate-creative";
import {
  activateCreative,
  CreativeAlreadyActiveError,
  CreativeKilledError,
  CreativeNotPushedError,
} from "./activate-creative";

const dbAvailable = await isDatabaseAvailable();

function fakeActivator(): AdActivator & { calls: Array<{ adId: string; status: string }> } {
  const calls: Array<{ adId: string; status: string }> = [];
  return {
    calls,
    async updateAdStatus(adId, status) {
      calls.push({ adId, status });
    },
  };
}

async function makeExperimentAndCreative(
  db: TestDatabase,
  overrides: Partial<typeof creatives.$inferInsert> = {},
) {
  const [experiment] = await db
    .insert(experiments)
    .values({ hypothesis: "h", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 86_400_000) })
    .returning();
  if (!experiment) throw new Error("experiment insert failed");

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
      ...overrides,
    })
    .returning();
  if (!creative) throw new Error("creative insert failed");
  return creative;
}

describe.skipIf(!dbAvailable)("activateCreative (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("refuses without a matching approval, never calling Meta", async () => {
    await withRollback(async (db) => {
      const creative = await makeExperimentAndCreative(db);
      const client = fakeActivator();

      await expect(activateCreative(db, client, creative.id)).rejects.toThrow(ApprovalRequiredError);
      expect(client.calls).toHaveLength(0);
    });
  });

  it("refuses a creative that hasn't been pushed to Meta yet", async () => {
    await withRollback(async (db) => {
      const creative = await makeExperimentAndCreative(db, { platformCreativeId: null });
      await recordApproval(db, {
        actionType: "activate_ad",
        targetTable: "creatives",
        targetId: creative.id,
        approvedBy: "operator@example.com",
      });

      await expect(activateCreative(db, fakeActivator(), creative.id)).rejects.toThrow(
        CreativeNotPushedError,
      );
    });
  });

  it("refuses an already-active creative", async () => {
    await withRollback(async (db) => {
      const creative = await makeExperimentAndCreative(db, { status: "active" });
      await recordApproval(db, {
        actionType: "activate_ad",
        targetTable: "creatives",
        targetId: creative.id,
        approvedBy: "operator@example.com",
      });

      await expect(activateCreative(db, fakeActivator(), creative.id)).rejects.toThrow(
        CreativeAlreadyActiveError,
      );
    });
  });

  it("refuses a killed creative even with an approval on file — no override path", async () => {
    await withRollback(async (db) => {
      const creative = await makeExperimentAndCreative(db, { status: "killed", killReason: "test kill" });
      await recordApproval(db, {
        actionType: "activate_ad",
        targetTable: "creatives",
        targetId: creative.id,
        approvedBy: "operator@example.com",
      });

      const client = fakeActivator();
      await expect(activateCreative(db, client, creative.id)).rejects.toThrow(CreativeKilledError);
      expect(client.calls).toHaveLength(0);
    });
  });

  it("activates a pushed, approved, paused creative", async () => {
    await withRollback(async (db) => {
      const creative = await makeExperimentAndCreative(db);
      await recordApproval(db, {
        actionType: "activate_ad",
        targetTable: "creatives",
        targetId: creative.id,
        approvedBy: "operator@example.com",
      });

      const client = fakeActivator();
      const updated = await activateCreative(db, client, creative.id);

      expect(updated.status).toBe("active");
      expect(client.calls).toEqual([{ adId: "ad_1", status: "ACTIVE" }]);
    });
  });
});

describe.skipIf(dbAvailable)(
  "activateCreative (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
