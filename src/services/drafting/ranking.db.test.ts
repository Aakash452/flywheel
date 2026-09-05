import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { issues, sources } from "../../db/schema";
import { getTopPerformingIssues, getTopUnusedSources } from "./ranking";

const dbAvailable = await isDatabaseAvailable();

describe.skipIf(!dbAvailable)("drafting ranking (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  describe("getTopPerformingIssues", () => {
    it("returns sent issues ranked by open rate, limited", async () => {
      await withRollback(async (db) => {
        await db.insert(issues).values([
          { subjectLine: "Low", bodyMd: "b", status: "sent", sentAt: new Date(), beehiivPostId: "p1", opens: 10, recipients: 1_000 },
          { subjectLine: "High", bodyMd: "b", status: "sent", sentAt: new Date(), beehiivPostId: "p2", opens: 400, recipients: 1_000 },
          { subjectLine: "Draft (excluded)", bodyMd: "b", status: "draft" },
        ]);

        const top = await getTopPerformingIssues(db, 5);
        expect(top.map((r) => r.issue.subjectLine)).toEqual(["High", "Low"]);
      });
    });

    it("respects the limit", async () => {
      await withRollback(async (db) => {
        await db.insert(issues).values(
          Array.from({ length: 8 }, (_, i) => ({
            subjectLine: `Issue ${i}`,
            bodyMd: "b",
            status: "sent" as const,
            sentAt: new Date(),
            beehiivPostId: `p${i}`,
            opens: i,
            recipients: 100,
          })),
        );

        const top = await getTopPerformingIssues(db, 5);
        expect(top).toHaveLength(5);
      });
    });
  });

  describe("getTopUnusedSources", () => {
    it("returns unused sources ordered by relevance score, descending", async () => {
      await withRollback(async (db) => {
        await db.insert(sources).values([
          { url: "https://example.com/low", relevanceScore: "60.00" },
          { url: "https://example.com/high", relevanceScore: "95.00" },
        ]);

        const top = await getTopUnusedSources(db, 5);
        expect(top.map((s) => s.url)).toEqual([
          "https://example.com/high",
          "https://example.com/low",
        ]);
      });
    });

    it("excludes sources already used in an issue", async () => {
      await withRollback(async (db) => {
        const [issue] = await db
          .insert(issues)
          .values({ subjectLine: "S", bodyMd: "b" })
          .returning();
        if (!issue) throw new Error("insert failed");

        await db.insert(sources).values([
          { url: "https://example.com/used", relevanceScore: "99.00", usedInIssueId: issue.id },
          { url: "https://example.com/unused", relevanceScore: "50.00" },
        ]);

        const top = await getTopUnusedSources(db, 5);
        expect(top.map((s) => s.url)).toEqual(["https://example.com/unused"]);
      });
    });
  });
});

describe.skipIf(dbAvailable)(
  "drafting ranking (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
