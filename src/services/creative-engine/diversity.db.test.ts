import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { creatives, experiments } from "../../db/schema";
import type { EmbeddingProvider } from "../../integrations/embeddings/voyage-client";
import type { CreativeVariant } from "./prompt";
import { filterDiverseVariants } from "./diversity";

const dbAvailable = await isDatabaseAvailable();

function vec(signal: number[]): number[] {
  return [...signal, ...Array(1024 - signal.length).fill(0)];
}

function variant(overrides: Partial<CreativeVariant> = {}): CreativeVariant {
  return {
    angle: "curiosity",
    format: "static_image",
    audienceFraming: "beginner",
    hook: "hook",
    body: "body",
    cta: "cta",
    imagePrompt: null,
    ...overrides,
  };
}

function fakeEmbeddingProvider(vectors: number[][]): EmbeddingProvider {
  return {
    async embed(texts: string[]) {
      return { embeddings: vectors.slice(0, texts.length), tokens: 0 };
    },
  };
}

describe.skipIf(!dbAvailable)("filterDiverseVariants (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("keeps dissimilar variants and returns their embeddings", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({
          hypothesis: "test",
          type: "creative_test",
          budgetCents: 100_000,
          deadline: new Date(Date.now() + 7 * 86_400_000),
        })
        .returning();
      if (!experiment) throw new Error("experiment insert failed");

      const provider = fakeEmbeddingProvider([vec([1, 0, 0, 0]), vec([0, 1, 0, 0])]);
      const result = await filterDiverseVariants(db, provider, experiment.id, [
        variant({ hook: "a" }),
        variant({ hook: "b" }),
      ]);

      expect(result.droppedAsDuplicate).toHaveLength(0);
      expect(result.keep).toHaveLength(2);
    });
  });

  it("drops a near-duplicate arriving in the same batch", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({
          hypothesis: "test",
          type: "creative_test",
          budgetCents: 100_000,
          deadline: new Date(Date.now() + 7 * 86_400_000),
        })
        .returning();
      if (!experiment) throw new Error("experiment insert failed");

      const provider = fakeEmbeddingProvider([vec([1, 0, 0, 0]), vec([0.95, 0.05, 0, 0])]);
      const result = await filterDiverseVariants(db, provider, experiment.id, [
        variant({ hook: "original" }),
        variant({ hook: "near dup" }),
      ]);

      expect(result.keep.map((v) => v.hook)).toEqual(["original"]);
      expect(result.droppedAsDuplicate.map((v) => v.hook)).toEqual(["near dup"]);
    });
  });

  it("drops a variant similar to a creative already persisted for this experiment", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({
          hypothesis: "test",
          type: "creative_test",
          budgetCents: 100_000,
          deadline: new Date(Date.now() + 7 * 86_400_000),
        })
        .returning();
      if (!experiment) throw new Error("experiment insert failed");

      await db.insert(creatives).values({
        experimentId: experiment.id,
        angle: "curiosity",
        format: "static_image",
        audienceFraming: "beginner",
        hook: "existing",
        body: "body",
        cta: "cta",
        embedding: vec([1, 0, 0, 0]),
      });

      const provider = fakeEmbeddingProvider([vec([0.95, 0.05, 0, 0])]);
      const result = await filterDiverseVariants(db, provider, experiment.id, [
        variant({ hook: "candidate" }),
      ]);

      expect(result.keep).toHaveLength(0);
      expect(result.droppedAsDuplicate).toHaveLength(1);
    });
  });

  it("does not compare against creatives from a different experiment", async () => {
    await withRollback(async (db) => {
      const [expA] = await db
        .insert(experiments)
        .values({ hypothesis: "a", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 7 * 86_400_000) })
        .returning();
      const [expB] = await db
        .insert(experiments)
        .values({ hypothesis: "b", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 7 * 86_400_000) })
        .returning();
      if (!expA || !expB) throw new Error("experiment insert failed");

      await db.insert(creatives).values({
        experimentId: expA.id,
        angle: "curiosity",
        format: "static_image",
        audienceFraming: "beginner",
        hook: "existing in A",
        body: "body",
        cta: "cta",
        embedding: vec([1, 0, 0, 0]),
      });

      const provider = fakeEmbeddingProvider([vec([0.95, 0.05, 0, 0])]);
      const result = await filterDiverseVariants(db, provider, expB.id, [
        variant({ hook: "candidate for B" }),
      ]);

      expect(result.keep).toHaveLength(1); // no collision — expA's creative doesn't count against expB
    });
  });
});

describe.skipIf(dbAvailable)(
  "filterDiverseVariants (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
