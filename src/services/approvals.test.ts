import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPool, isDatabaseAvailable, withRollback } from "../db/testing";
import {
  ApprovalRequiredError,
  getLatestApproval,
  recordApproval,
  requireApproval,
} from "./approvals";

const dbAvailable = await isDatabaseAvailable();

describe.skipIf(!dbAvailable)("approvals (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("requireApproval throws ApprovalRequiredError when nothing is on file", async () => {
    await withRollback(async (db) => {
      const issueId = randomUUID();
      await expect(
        requireApproval(db, "send_issue", "issues", issueId),
      ).rejects.toThrow(ApprovalRequiredError);
    });
  });

  it("requireApproval succeeds once an approval is recorded", async () => {
    await withRollback(async (db) => {
      const issueId = randomUUID();
      await recordApproval(db, {
        actionType: "send_issue",
        targetTable: "issues",
        targetId: issueId,
        approvedBy: "operator@example.com",
      });

      const approval = await requireApproval(db, "send_issue", "issues", issueId);
      expect(approval.approvedBy).toBe("operator@example.com");
      expect(approval.actionType).toBe("send_issue");
      expect(approval.targetId).toBe(issueId);
    });
  });

  it("an approval for a different target does not satisfy the gate", async () => {
    await withRollback(async (db) => {
      const approvedIssueId = randomUUID();
      const otherIssueId = randomUUID();
      await recordApproval(db, {
        actionType: "send_issue",
        targetTable: "issues",
        targetId: approvedIssueId,
        approvedBy: "operator@example.com",
      });

      await expect(
        requireApproval(db, "send_issue", "issues", otherIssueId),
      ).rejects.toThrow(ApprovalRequiredError);
    });
  });

  it("an approval for a different action type does not satisfy the gate", async () => {
    await withRollback(async (db) => {
      const creativeId = randomUUID();
      await recordApproval(db, {
        actionType: "increase_budget",
        targetTable: "experiments",
        targetId: creativeId,
        approvedBy: "operator@example.com",
      });

      await expect(
        requireApproval(db, "activate_ad", "experiments", creativeId),
      ).rejects.toThrow(ApprovalRequiredError);
    });
  });

  it("getLatestApproval returns the most recently approved row", async () => {
    await withRollback(async (db) => {
      const issueId = randomUUID();
      await recordApproval(db, {
        actionType: "send_issue",
        targetTable: "issues",
        targetId: issueId,
        approvedBy: "first@example.com",
      });
      await recordApproval(db, {
        actionType: "send_issue",
        targetTable: "issues",
        targetId: issueId,
        approvedBy: "second@example.com",
      });

      const latest = await getLatestApproval(db, "send_issue", "issues", issueId);
      expect(latest?.approvedBy).toBe("second@example.com");
    });
  });
});

describe.skipIf(dbAvailable)("approvals (skipped: no DATABASE_URL reachable)", () => {
  it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
    expect(true).toBe(true);
  });
});
