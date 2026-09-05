import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { issues } from "../../db/schema";
import type { BeehiivPost } from "../../integrations/beehiiv";
import { pollIssueStats, type StatsSource } from "./poll-issue-stats";

const dbAvailable = await isDatabaseAvailable();

function fakeStatsSource(post: BeehiivPost): StatsSource {
  return {
    async getPost() {
      return post;
    },
  };
}

describe.skipIf(!dbAvailable)("pollIssueStats (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("updates opens/clicks for a sent issue with a beehiiv_post_id", async () => {
    await withRollback(async (db) => {
      const [issue] = await db
        .insert(issues)
        .values({
          subjectLine: "Subject",
          bodyMd: "Body",
          status: "sent",
          sentAt: new Date(),
          beehiivPostId: "post_abc",
        })
        .returning();
      if (!issue) throw new Error("insert failed");

      const client = fakeStatsSource({
        id: "post_abc",
        status: "confirmed",
        stats: { email: { opens: 120, clicks: 34, recipients: 1_000 } },
      });

      const result = await pollIssueStats(db, client);
      expect(result).toEqual({ polled: 1, updated: 1 });

      const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(row?.opens).toBe(120);
      expect(row?.clicks).toBe(34);
      expect(row?.recipients).toBe(1_000);
    });
  });

  it("falls back to delivered when recipients is absent", async () => {
    await withRollback(async (db) => {
      const [issue] = await db
        .insert(issues)
        .values({
          subjectLine: "Subject",
          bodyMd: "Body",
          status: "sent",
          sentAt: new Date(),
          beehiivPostId: "post_delivered_fallback",
        })
        .returning();
      if (!issue) throw new Error("insert failed");

      const client = fakeStatsSource({
        id: "post_delivered_fallback",
        status: "confirmed",
        stats: { email: { opens: 10, clicks: 1, delivered: 500 } },
      });
      await pollIssueStats(db, client);

      const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(row?.recipients).toBe(500);
    });
  });

  it("ignores draft issues (no beehiiv_post_id yet)", async () => {
    await withRollback(async (db) => {
      await db.insert(issues).values({ subjectLine: "Subject", bodyMd: "Body" });
      const client = fakeStatsSource({ id: "unused", status: "draft" });
      const result = await pollIssueStats(db, client);
      expect(result).toEqual({ polled: 0, updated: 0 });
    });
  });

  it("ignores issues sent outside the trailing window", async () => {
    await withRollback(async (db) => {
      const oldSentAt = new Date();
      oldSentAt.setDate(oldSentAt.getDate() - 90);

      await db.insert(issues).values({
        subjectLine: "Old issue",
        bodyMd: "Body",
        status: "sent",
        sentAt: oldSentAt,
        beehiivPostId: "post_old",
      });

      const client = fakeStatsSource({
        id: "post_old",
        status: "confirmed",
        stats: { email: { opens: 999, clicks: 999 } },
      });

      const result = await pollIssueStats(db, client, { sentSinceDays: 30 });
      expect(result).toEqual({ polled: 0, updated: 0 });
    });
  });

  it("defaults opens/clicks to 0 when stats are missing from the response", async () => {
    await withRollback(async (db) => {
      const [issue] = await db
        .insert(issues)
        .values({
          subjectLine: "Subject",
          bodyMd: "Body",
          status: "sent",
          sentAt: new Date(),
          beehiivPostId: "post_no_stats",
        })
        .returning();
      if (!issue) throw new Error("insert failed");

      const client = fakeStatsSource({ id: "post_no_stats", status: "confirmed" });
      await pollIssueStats(db, client);

      const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(row?.opens).toBe(0);
      expect(row?.clicks).toBe(0);
      expect(row?.recipients).toBe(0);
    });
  });
});

describe.skipIf(dbAvailable)(
  "pollIssueStats (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
