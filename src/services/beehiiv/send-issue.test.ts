import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { issues } from "../../db/schema";
import { ApprovalRequiredError } from "../approvals";
import {
  approveIssue,
  IssueAlreadySentError,
  IssueNotApprovedError,
  IssueNotDraftError,
  sendIssue,
  type IssueSender,
} from "./send-issue";

const dbAvailable = await isDatabaseAvailable();

function fakeSender(): IssueSender & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async createPost(input) {
      calls.push(input);
      return { id: `post_${calls.length}`, previewUrl: "https://example.com/preview" };
    },
  };
}

describe.skipIf(!dbAvailable)(
  "approveIssue / sendIssue (requires DATABASE_URL)",
  () => {
    afterAll(async () => {
      await closeTestPool();
    });

    it("sendIssue refuses a draft issue without ever calling the client", async () => {
      await withRollback(async (db) => {
        const [issue] = await db
          .insert(issues)
          .values({ subjectLine: "Subject", bodyMd: "Body" })
          .returning();
        if (!issue) throw new Error("insert failed");

        const client = fakeSender();
        await expect(sendIssue(db, client, issue.id)).rejects.toThrow(
          IssueNotApprovedError,
        );
        expect(client.calls).toHaveLength(0);
      });
    });

    it("approveIssue refuses a non-draft issue", async () => {
      await withRollback(async (db) => {
        const [issue] = await db
          .insert(issues)
          .values({ subjectLine: "Subject", bodyMd: "Body", status: "sent", sentAt: new Date(), beehiivPostId: "post_x" })
          .returning();
        if (!issue) throw new Error("insert failed");

        await expect(
          approveIssue(db, issue.id, "operator@example.com"),
        ).rejects.toThrow(IssueNotDraftError);
      });
    });

    it("approve then send: renders markdown, calls Beehiiv once, and marks the issue sent", async () => {
      await withRollback(async (db) => {
        const [issue] = await db
          .insert(issues)
          .values({ subjectLine: "Weekly Digest", bodyMd: "# Hello\n\nWorld." })
          .returning();
        if (!issue) throw new Error("insert failed");

        const approved = await approveIssue(db, issue.id, "operator@example.com", "looks good");
        expect(approved.status).toBe("approved");

        const client = fakeSender();
        const sent = await sendIssue(db, client, issue.id);

        expect(sent.status).toBe("sent");
        expect(sent.sentAt).not.toBeNull();
        expect(sent.beehiivPostId).toBe("post_1");
        expect(client.calls).toHaveLength(1);
        expect(client.calls[0]).toMatchObject({
          title: "Weekly Digest",
          emailSubjectLine: "Weekly Digest",
        });
        const bodyContent = (client.calls[0] as { bodyContent: string }).bodyContent;
        expect(bodyContent).toContain("<h1>Hello</h1>");

        const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
        expect(row?.status).toBe("sent");
      });
    });

    it("refuses to send the same issue twice", async () => {
      await withRollback(async (db) => {
        const [issue] = await db
          .insert(issues)
          .values({ subjectLine: "Subject", bodyMd: "Body" })
          .returning();
        if (!issue) throw new Error("insert failed");

        await approveIssue(db, issue.id, "operator@example.com");
        const client = fakeSender();
        await sendIssue(db, client, issue.id);

        await expect(sendIssue(db, client, issue.id)).rejects.toThrow(
          IssueAlreadySentError,
        );
        expect(client.calls).toHaveLength(1); // not called a second time
      });
    });

    it("defense in depth: sendIssue still refuses if status says 'approved' but no approval row exists", async () => {
      await withRollback(async (db) => {
        // Simulates a bug elsewhere flipping the status column directly,
        // bypassing approveIssue(). The approvals-table check must catch
        // this independently of the status flag.
        const [issue] = await db
          .insert(issues)
          .values({ subjectLine: "Subject", bodyMd: "Body", status: "approved" })
          .returning();
        if (!issue) throw new Error("insert failed");

        const client = fakeSender();
        await expect(sendIssue(db, client, issue.id)).rejects.toThrow(
          ApprovalRequiredError,
        );
        expect(client.calls).toHaveLength(0);
      });
    });
  },
);

describe.skipIf(dbAvailable)(
  "approveIssue / sendIssue (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
