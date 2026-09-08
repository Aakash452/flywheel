import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
  type TestDatabase,
} from "../../db/testing";
import { creatives, experiments, ledger } from "../../db/schema";
import type { EmbeddingProvider } from "../../integrations/embeddings/voyage-client";
import type { CreativeGenerator, GenerateVariantsResult } from "./anthropic-creative-generator";
import type { CreativeVariant } from "./prompt";
import { ANGLES, AUDIENCE_FRAMINGS, FORMATS } from "./prompt";
import { runCreativeGeneration } from "./index";

const dbAvailable = await isDatabaseAvailable();

function vec(index: number): number[] {
  const v = new Array(1024).fill(0);
  v[index] = 1;
  return v;
}

/** N variants cycling through every axis value — guarantees full coverage once N >= 6 (the largest axis). */
function coveringVariants(n: number): CreativeVariant[] {
  return Array.from({ length: n }, (_, i) => ({
    angle: ANGLES[i % ANGLES.length]!,
    format: FORMATS[i % FORMATS.length]!,
    audienceFraming: AUDIENCE_FRAMINGS[i % AUDIENCE_FRAMINGS.length]!,
    hook: `hook ${i}`,
    body: `body ${i}`,
    cta: `cta ${i}`,
    imagePrompt: null,
  }));
}

/** Every embed() call returns fresh, mutually-orthogonal vectors (indexed by an offset so different rounds never collide with each other). */
function orthogonalEmbeddings(): EmbeddingProvider {
  let counter = 0;
  return {
    async embed(texts: string[]) {
      return { embeddings: texts.map(() => vec(counter++)), tokens: 0 };
    },
  };
}

function fakeGeneratorSequence(batches: CreativeVariant[][]): CreativeGenerator {
  let call = 0;
  return {
    async generate(): Promise<GenerateVariantsResult> {
      const variants = batches[call] ?? [];
      call++;
      return { variants, inputTokens: 500, outputTokens: 300 };
    },
  };
}

async function makeExperiment(db: TestDatabase) {
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
  return experiment;
}

describe.skipIf(!dbAvailable)("runCreativeGeneration (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("persists enough diverse, fully-covering variants in one round when the generator delivers them", async () => {
    await withRollback(async (db) => {
      const experiment = await makeExperiment(db);

      const result = await runCreativeGeneration(
        db,
        {
          generator: fakeGeneratorSequence([coveringVariants(6)]),
          generatorModel: "claude-sonnet-4-6",
          embeddings: orthogonalEmbeddings(),
          dailyApiSpendCapCents: 10_000,
        },
        { experimentId: experiment.id, offer: "Free trial", minVariants: 6, variantsPerCall: 6, maxRounds: 3 },
      );

      expect(result.capExceeded).toBe(false);
      expect(result.persisted).toBe(6);
      expect(result.roundsRun).toBe(1);
      expect(result.fullAxisCoverage).toBe(true);

      const allRows = await db.select().from(creatives);
      expect(allRows).toHaveLength(6);
      expect(allRows.every((r) => r.status === "paused")).toBe(true);
    });
  });

  it("runs a second round to top up when the first round falls short after dedup", async () => {
    await withRollback(async (db) => {
      const experiment = await makeExperiment(db);

      // Round 1 delivers 6 variants but they'll all collide with each other
      // (same embedding index reused) — simulate via a generator that
      // returns duplicated hooks; instead, force shortfall by requesting
      // more than round 1 provides.
      const result = await runCreativeGeneration(
        db,
        {
          generator: fakeGeneratorSequence([coveringVariants(3), coveringVariants(6)]),
          generatorModel: "claude-sonnet-4-6",
          embeddings: orthogonalEmbeddings(),
          dailyApiSpendCapCents: 10_000,
        },
        { experimentId: experiment.id, offer: "Free trial", minVariants: 6, variantsPerCall: 6, maxRounds: 3 },
      );

      expect(result.roundsRun).toBe(2);
      expect(result.persisted).toBe(9); // 3 from round 1 + 6 from round 2, all orthogonal so none rejected
      expect(result.fullAxisCoverage).toBe(true);
    });
  });

  it("gives up after maxRounds if the generator never delivers enough", async () => {
    await withRollback(async (db) => {
      const experiment = await makeExperiment(db);

      const result = await runCreativeGeneration(
        db,
        {
          generator: fakeGeneratorSequence([coveringVariants(1), coveringVariants(1), coveringVariants(1)]),
          generatorModel: "claude-sonnet-4-6",
          embeddings: orthogonalEmbeddings(),
          dailyApiSpendCapCents: 10_000,
        },
        { experimentId: experiment.id, offer: "Free trial", minVariants: 6, variantsPerCall: 1, maxRounds: 3 },
      );

      expect(result.roundsRun).toBe(3);
      expect(result.persisted).toBe(3);
      expect(result.fullAxisCoverage).toBe(false);
    });
  });

  it("logs the generation cost to the ledger, tied to the experiment", async () => {
    await withRollback(async (db) => {
      const experiment = await makeExperiment(db);

      await runCreativeGeneration(
        db,
        {
          generator: fakeGeneratorSequence([coveringVariants(6)]),
          generatorModel: "claude-sonnet-4-6",
          embeddings: orthogonalEmbeddings(),
          dailyApiSpendCapCents: 10_000,
        },
        { experimentId: experiment.id, offer: "Free trial", minVariants: 6, variantsPerCall: 6, maxRounds: 3 },
      );

      const rows = await db.select().from(ledger);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.category).toBe("api_cost");
      expect(rows[0]?.experimentId).toBe(experiment.id);
      expect(rows[0]?.metadata).toMatchObject({ job: "creative-generation" });
    });
  });

  it("skips entirely — no generator call, nothing persisted — when the daily cap is exceeded", async () => {
    await withRollback(async (db) => {
      const experiment = await makeExperiment(db);
      await db.insert(ledger).values({ direction: "debit", amountCents: 10_000, category: "api_cost" });

      let called = false;
      const result = await runCreativeGeneration(
        db,
        {
          generator: { async generate() { called = true; throw new Error("should not be called"); } },
          generatorModel: "claude-sonnet-4-6",
          embeddings: orthogonalEmbeddings(),
          dailyApiSpendCapCents: 10_000,
        },
        { experimentId: experiment.id, offer: "Free trial" },
      );

      expect(result.capExceeded).toBe(true);
      expect(called).toBe(false);
      const rows = await db.select().from(creatives);
      expect(rows).toHaveLength(0);
    });
  });
});

describe.skipIf(dbAvailable)(
  "runCreativeGeneration (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
