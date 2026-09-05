import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { issues, ledger, sources } from "../../db/schema";
import type { DraftGenerator, DraftGenerationResult } from "./anthropic-draft-generator";
import { runDraftGeneration } from "./index";

const dbAvailable = await isDatabaseAvailable();

function fakeGenerator(overrides: Partial<DraftGenerationResult> = {}): DraftGenerator {
  return {
    async generate() {
      return {
        bodyMd: "# Generated issue\n\nBody.",
        subjectLines: [
          { subjectLine: "Low", score: 20, reasoning: "meh" },
          { subjectLine: "High", score: 90, reasoning: "great" },
        ],
        inputTokens: 5_000,
        outputTokens: 1_000,
        ...overrides,
      };
    },
  };
}

describe.skipIf(!dbAvailable)("runDraftGeneration (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("drafts an issue from the top unused sources and picks the best subject line", async () => {
    await withRollback(async (db) => {
      await db.insert(sources).values([
        { url: "https://example.com/a", relevanceScore: "90.00" },
        { url: "https://example.com/b", relevanceScore: "80.00" },
      ]);

      const result = await runDraftGeneration(db, {
        generator: fakeGenerator(),
        generatorModel: "claude-sonnet-4-6",
        dailyApiSpendCapCents: 10_000,
        sourceCount: 5,
      });

      expect(result.capExceeded).toBe(false);
      expect(result.noSourcesAvailable).toBe(false);
      expect(result.sourcesUsed).toBe(2);
      expect(result.issueId).toBeDefined();

      const [issue] = await db.select().from(issues).where(eq(issues.id, result.issueId!));
      expect(issue?.status).toBe("draft");
      expect(issue?.subjectLine).toBe("High"); // highest score, not first
      expect(issue?.bodyMd).toBe("# Generated issue\n\nBody.");
      expect(issue?.subjectLineCandidates).toHaveLength(2);
    });
  });

  it("marks the sources it used as used, and leaves others untouched", async () => {
    await withRollback(async (db) => {
      await db.insert(sources).values([
        { url: "https://example.com/used-1", relevanceScore: "99.00" },
        { url: "https://example.com/used-2", relevanceScore: "98.00" },
        { url: "https://example.com/not-picked", relevanceScore: "1.00" },
      ]);

      const result = await runDraftGeneration(db, {
        generator: fakeGenerator(),
        generatorModel: "claude-sonnet-4-6",
        dailyApiSpendCapCents: 10_000,
        sourceCount: 2, // only enough room for the top 2
      });

      expect(result.sourcesUsed).toBe(2);

      const rows = await db.select().from(sources);
      const used = rows.filter((r) => r.usedInIssueId !== null);
      const unused = rows.filter((r) => r.usedInIssueId === null);
      expect(used.map((r) => r.url).sort()).toEqual([
        "https://example.com/used-1",
        "https://example.com/used-2",
      ]);
      expect(unused.map((r) => r.url)).toEqual(["https://example.com/not-picked"]);
    });
  });

  it("does nothing and spends nothing when there are no unused sources", async () => {
    await withRollback(async (db) => {
      const result = await runDraftGeneration(db, {
        generator: fakeGenerator(),
        generatorModel: "claude-sonnet-4-6",
        dailyApiSpendCapCents: 10_000,
      });

      expect(result.noSourcesAvailable).toBe(true);
      expect(result.issueId).toBeUndefined();

      const ledgerRows = await db.select().from(ledger);
      expect(ledgerRows).toHaveLength(0);
    });
  });

  it("logs the generation call's estimated cost to the ledger", async () => {
    await withRollback(async (db) => {
      await db.insert(sources).values({ url: "https://example.com/a", relevanceScore: "90.00" });

      await runDraftGeneration(db, {
        generator: fakeGenerator(),
        generatorModel: "claude-sonnet-4-6",
        dailyApiSpendCapCents: 10_000,
      });

      const rows = await db.select().from(ledger);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.category).toBe("api_cost");
      expect(rows[0]?.metadata).toMatchObject({ job: "draft-generation" });
    });
  });

  it("skips entirely — no generator call, no sources touched — when the daily cap is exceeded", async () => {
    await withRollback(async (db) => {
      await db.insert(ledger).values({ direction: "debit", amountCents: 10_000, category: "api_cost" });
      await db.insert(sources).values({ url: "https://example.com/a", relevanceScore: "90.00" });

      let generatorCalled = false;
      const result = await runDraftGeneration(db, {
        generator: { async generate() { generatorCalled = true; throw new Error("should not be called"); } },
        generatorModel: "claude-sonnet-4-6",
        dailyApiSpendCapCents: 10_000,
      });

      expect(result.capExceeded).toBe(true);
      expect(generatorCalled).toBe(false);

      const rows = await db.select().from(sources);
      expect(rows[0]?.usedInIssueId).toBeNull();
    });
  });
});

describe.skipIf(dbAvailable)(
  "runDraftGeneration (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
