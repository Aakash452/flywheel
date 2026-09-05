import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { ledger, sources } from "../../db/schema";
import type { ConnectorSet } from "./connectors";
import type { EmbeddingProvider } from "../../integrations/embeddings/voyage-client";
import type { RawCandidate } from "./dedupe";
import type { RelevanceScorer, RelevanceScoreResult } from "./relevance-scoring";
import { runSourcingCycle } from "./index";

const dbAvailable = await isDatabaseAvailable();

function candidate(url: string, overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    url,
    title: "Title",
    rawContent: "Content",
    discoveredAt: new Date(),
    ...overrides,
  };
}

function fakeConnectors(candidates: RawCandidate[]): ConnectorSet {
  return { async fetchAll() { return candidates; } };
}

/** Every embedding orthogonal to every other — no semantic dedup collisions. */
function noopEmbeddings(): EmbeddingProvider {
  return {
    async embed(texts: string[]) {
      return {
        embeddings: texts.map((_, i) => {
          const v = new Array(1024).fill(0);
          v[i] = 1;
          return v;
        }),
        tokens: 0,
      };
    },
  };
}

function fakeScorer(scoresByUrl: Record<string, number>): RelevanceScorer {
  return {
    async score(candidates): Promise<RelevanceScoreResult> {
      const scores = new Map<string, number>();
      for (const c of candidates) {
        const score = scoresByUrl[c.url];
        if (score !== undefined) scores.set(c.url, score);
      }
      return { scores, inputTokens: 1_000, outputTokens: 200 };
    },
  };
}

describe.skipIf(!dbAvailable)("runSourcingCycle (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("persists only candidates scoring at or above the niche threshold", async () => {
    await withRollback(async (db) => {
      const result = await runSourcingCycle(db, {
        connectors: fakeConnectors([
          candidate("https://example.com/high"),
          candidate("https://example.com/low"),
        ]),
        embeddings: noopEmbeddings(),
        scorer: fakeScorer({
          "https://example.com/high": 90,
          "https://example.com/low": 10,
        }),
        scorerModel: "claude-haiku-4-5",
        dailyApiSpendCapCents: 10_000,
      });

      expect(result.persisted).toBe(1);
      expect(result.scored).toBe(2);

      const rows = await db.select().from(sources);
      expect(rows.map((r) => r.url)).toEqual(["https://example.com/high"]);
    });
  });

  it("does not persist a candidate the scorer never returned a score for", async () => {
    await withRollback(async (db) => {
      const result = await runSourcingCycle(db, {
        connectors: fakeConnectors([candidate("https://example.com/unscored")]),
        embeddings: noopEmbeddings(),
        scorer: fakeScorer({}), // scores nothing
        scorerModel: "claude-haiku-4-5",
        dailyApiSpendCapCents: 10_000,
      });

      expect(result.persisted).toBe(0);
      const rows = await db.select().from(sources);
      expect(rows).toHaveLength(0);
    });
  });

  it("logs the scoring call's estimated cost to the ledger", async () => {
    await withRollback(async (db) => {
      await runSourcingCycle(db, {
        connectors: fakeConnectors([candidate("https://example.com/a")]),
        embeddings: noopEmbeddings(),
        scorer: fakeScorer({ "https://example.com/a": 90 }),
        scorerModel: "claude-haiku-4-5",
        dailyApiSpendCapCents: 10_000,
      });

      const rows = await db.select().from(ledger);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.category).toBe("api_cost");
      expect(rows[0]?.metadata).toMatchObject({ job: "sourcing-relevance-scoring" });
    });
  });

  it("skips the entire cycle — no connectors called — when the daily cap is already exceeded", async () => {
    await withRollback(async (db) => {
      await db.insert(ledger).values({
        direction: "debit",
        amountCents: 10_000,
        category: "api_cost",
      });

      let connectorsCalled = false;
      const result = await runSourcingCycle(db, {
        connectors: { async fetchAll() { connectorsCalled = true; return []; } },
        embeddings: noopEmbeddings(),
        scorer: fakeScorer({}),
        scorerModel: "claude-haiku-4-5",
        dailyApiSpendCapCents: 10_000,
      });

      expect(result.capExceeded).toBe(true);
      expect(connectorsCalled).toBe(false);

      const rows = await db.select().from(ledger);
      expect(rows).toHaveLength(1); // only the seeded row — no new spend logged
    });
  });

  it("never persists a URL already in sources, even if rescored above threshold", async () => {
    await withRollback(async (db) => {
      await db.insert(sources).values({ url: "https://example.com/existing" });

      const result = await runSourcingCycle(db, {
        connectors: fakeConnectors([candidate("https://example.com/existing")]),
        embeddings: noopEmbeddings(),
        scorer: fakeScorer({ "https://example.com/existing": 99 }),
        scorerModel: "claude-haiku-4-5",
        dailyApiSpendCapCents: 10_000,
      });

      expect(result.afterUrlDedupe).toBe(0);
      expect(result.persisted).toBe(0);
      const rows = await db.select().from(sources);
      expect(rows).toHaveLength(1); // unchanged
    });
  });

  it("falls back to URL-only dedup when no embedding provider is configured", async () => {
    await withRollback(async (db) => {
      const result = await runSourcingCycle(db, {
        connectors: fakeConnectors([candidate("https://example.com/a")]),
        // embeddings omitted entirely
        scorer: fakeScorer({ "https://example.com/a": 90 }),
        scorerModel: "claude-haiku-4-5",
        dailyApiSpendCapCents: 10_000,
      });

      expect(result.persisted).toBe(1);
      const rows = await db.select().from(sources);
      expect(rows[0]?.embedding).toBeNull();
    });
  });
});

describe.skipIf(dbAvailable)(
  "runSourcingCycle (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
