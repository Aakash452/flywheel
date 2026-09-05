import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { sources } from "../../db/schema";
import type { EmbeddingProvider } from "../../integrations/embeddings/voyage-client";
import {
  filterNewUrls,
  filterSemanticDuplicates,
  type RawCandidate,
} from "./dedupe";

const dbAvailable = await isDatabaseAvailable();

/** Pads a short "signal" vector out to 1024 dims with zeros — matches every vector(1024) column while keeping cosine-similarity math legible in fixtures. */
function vec(signal: number[]): number[] {
  return [...signal, ...Array(1024 - signal.length).fill(0)];
}

function candidate(url: string, overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    url,
    title: "Title",
    rawContent: "Content",
    discoveredAt: new Date(),
    ...overrides,
  };
}

function fakeEmbeddingProvider(vectors: number[][]): EmbeddingProvider {
  return {
    async embed(texts: string[]) {
      return { embeddings: vectors.slice(0, texts.length), tokens: texts.join(" ").length };
    },
  };
}

describe.skipIf(!dbAvailable)("sourcing dedupe (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  describe("filterNewUrls", () => {
    it("drops candidates whose URL already exists in sources", async () => {
      await withRollback(async (db) => {
        await db.insert(sources).values({ url: "https://example.com/seen" });

        const result = await filterNewUrls(db, [
          candidate("https://example.com/seen"),
          candidate("https://example.com/new"),
        ]);

        expect(result.map((c) => c.url)).toEqual(["https://example.com/new"]);
      });
    });

    it("returns everything when nothing exists yet", async () => {
      await withRollback(async (db) => {
        const result = await filterNewUrls(db, [candidate("https://example.com/fresh")]);
        expect(result).toHaveLength(1);
      });
    });
  });

  describe("filterSemanticDuplicates", () => {
    it("keeps dissimilar candidates and returns their embeddings", async () => {
      await withRollback(async (db) => {
        const a = candidate("https://example.com/a");
        const b = candidate("https://example.com/b");
        const provider = fakeEmbeddingProvider([vec([1, 0, 0, 0]), vec([0, 1, 0, 0])]);

        const result = await filterSemanticDuplicates(db, provider, [a, b]);

        expect(result.droppedAsDuplicate).toHaveLength(0);
        expect(result.keep).toHaveLength(2);
        expect(result.keep[0]?.embedding).toHaveLength(1024);
      });
    });

    it("drops a near-duplicate arriving in the same batch", async () => {
      await withRollback(async (db) => {
        const original = candidate("https://example.com/original");
        const nearDup = candidate("https://example.com/near-dup");
        // cosine(original, nearDup) ≈ 0.9986 > 0.9 threshold
        const provider = fakeEmbeddingProvider([
          vec([1, 0, 0, 0]),
          vec([0.95, 0.05, 0, 0]),
        ]);

        const result = await filterSemanticDuplicates(db, provider, [original, nearDup]);

        expect(result.keep.map((c) => c.url)).toEqual(["https://example.com/original"]);
        expect(result.droppedAsDuplicate.map((c) => c.url)).toEqual([
          "https://example.com/near-dup",
        ]);
      });
    });

    it("drops a candidate similar to a source persisted within the last 30 days", async () => {
      await withRollback(async (db) => {
        const recent = new Date();
        recent.setDate(recent.getDate() - 5);
        await db.insert(sources).values({
          url: "https://example.com/existing-recent",
          embedding: vec([1, 0, 0, 0]),
          discoveredAt: recent,
        });

        const provider = fakeEmbeddingProvider([vec([0.95, 0.05, 0, 0])]);
        const result = await filterSemanticDuplicates(db, provider, [
          candidate("https://example.com/candidate"),
        ]);

        expect(result.keep).toHaveLength(0);
        expect(result.droppedAsDuplicate).toHaveLength(1);
      });
    });

    it("does NOT drop a candidate similar to a source outside the 30-day window", async () => {
      await withRollback(async (db) => {
        const old = new Date();
        old.setDate(old.getDate() - 45);
        await db.insert(sources).values({
          url: "https://example.com/existing-old",
          embedding: vec([1, 0, 0, 0]),
          discoveredAt: old,
        });

        const provider = fakeEmbeddingProvider([vec([0.95, 0.05, 0, 0])]);
        const result = await filterSemanticDuplicates(db, provider, [
          candidate("https://example.com/candidate"),
        ]);

        expect(result.keep).toHaveLength(1);
        expect(result.droppedAsDuplicate).toHaveLength(0);
      });
    });

    it("fails open (keeps, with a null embedding) if the provider returns fewer vectors than requested", async () => {
      await withRollback(async (db) => {
        const provider = fakeEmbeddingProvider([]); // returns nothing
        const result = await filterSemanticDuplicates(db, provider, [
          candidate("https://example.com/unembedded"),
        ]);

        expect(result.keep).toHaveLength(1);
        expect(result.keep[0]?.embedding).toBeNull();
      });
    });

    it("returns empty results for an empty candidate list without calling the provider", async () => {
      await withRollback(async (db) => {
        let called = false;
        const provider: EmbeddingProvider = {
          async embed() {
            called = true;
            return { embeddings: [], tokens: 0 };
          },
        };
        const result = await filterSemanticDuplicates(db, provider, []);
        expect(result).toEqual({ keep: [], droppedAsDuplicate: [] });
        expect(called).toBe(false);
      });
    });
  });
});

describe.skipIf(dbAvailable)(
  "sourcing dedupe (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
