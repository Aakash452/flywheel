import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../db/testing";
import { ledger } from "../db/schema";
import {
  getDailyApiSpendCents,
  isDailyApiCapExceeded,
  logApiCost,
} from "./cost-control";

const dbAvailable = await isDatabaseAvailable();

describe.skipIf(!dbAvailable)("cost-control (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("logApiCost writes a debit row with the estimated cost and metadata", async () => {
    await withRollback(async (db) => {
      const cents = await logApiCost(db, {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        inputCentsPerMillion: 100,
        outputCentsPerMillion: 500,
        isBatch: true,
        metadata: { job: "sourcing-relevance-scoring" },
      });
      expect(cents).toBe(300); // (100 + 500) * 0.5

      const rows = await db.select().from(ledger);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.direction).toBe("debit");
      expect(rows[0]?.category).toBe("api_cost");
      expect(rows[0]?.amountCents).toBe(300);
      expect(rows[0]?.metadata).toMatchObject({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        job: "sourcing-relevance-scoring",
      });
    });
  });

  it("getDailyApiSpendCents sums only today's api_cost debits", async () => {
    await withRollback(async (db) => {
      const asOf = new Date("2026-06-15T12:00:00Z");
      const todayEarly = new Date("2026-06-15T00:30:00Z");
      const todayLate = new Date("2026-06-15T23:30:00Z");
      const yesterday = new Date("2026-06-14T23:59:00Z");
      const tomorrow = new Date("2026-06-16T00:00:01Z");

      await db.insert(ledger).values([
        { direction: "debit", amountCents: 100, category: "api_cost", occurredAt: todayEarly },
        { direction: "debit", amountCents: 200, category: "api_cost", occurredAt: todayLate },
        { direction: "debit", amountCents: 900, category: "api_cost", occurredAt: yesterday },
        { direction: "debit", amountCents: 900, category: "api_cost", occurredAt: tomorrow },
        // Different category, same day — must not be counted as API spend.
        { direction: "debit", amountCents: 5_000, category: "ad_spend", occurredAt: asOf },
      ]);

      const spend = await getDailyApiSpendCents(db, asOf);
      expect(spend).toBe(300);
    });
  });

  it("isDailyApiCapExceeded compares against the cap inclusively", async () => {
    await withRollback(async (db) => {
      const asOf = new Date("2026-06-15T12:00:00Z");
      await db.insert(ledger).values({
        direction: "debit",
        amountCents: 500,
        category: "api_cost",
        occurredAt: asOf,
      });

      expect(await isDailyApiCapExceeded(db, 500, asOf)).toBe(true);
      expect(await isDailyApiCapExceeded(db, 501, asOf)).toBe(false);
      expect(await isDailyApiCapExceeded(db, 499, asOf)).toBe(true);
    });
  });
});

describe.skipIf(dbAvailable)(
  "cost-control (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
