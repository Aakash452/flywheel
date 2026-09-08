import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { ledger, subscriberEvents, subscribers } from "../../db/schema";
import { computeAllocatorSummary, computeBlendedEconomics } from "./index";

const dbAvailable = await isDatabaseAvailable();

describe.skipIf(!dbAvailable)("Allocator (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  describe("computeBlendedEconomics", () => {
    it("computes CAC, RPS, contribution margin, and payback from real ledger + subscriber data", async () => {
      await withRollback(async (db) => {
        const asOf = new Date("2026-06-30T00:00:00Z");

        // 10 subscribers acquired in the trailing 30 days.
        await db.insert(subscribers).values(
          Array.from({ length: 10 }, (_, i) => ({
            beehiivId: `sub-${i}`,
            acquiredAt: new Date("2026-06-15T00:00:00Z"),
            cohortWeek: "2026-06-15",
          })),
        );

        // $1,000 ad spend over the window -> CAC = $100/subscriber (10_000 cents)
        await db.insert(ledger).values({
          direction: "debit",
          amountCents: 100_000,
          category: "ad_spend",
          occurredAt: new Date("2026-06-20T00:00:00Z"),
        });
        // $300 revenue over the window
        await db.insert(ledger).values({
          direction: "credit",
          amountCents: 30_000,
          category: "sponsorship_revenue",
          occurredAt: new Date("2026-06-20T00:00:00Z"),
        });
        // $50 variable cost (api_cost + tooling) over the window
        await db.insert(ledger).values({
          direction: "debit",
          amountCents: 5_000,
          category: "tooling",
          occurredAt: new Date("2026-06-20T00:00:00Z"),
        });

        const result = await computeBlendedEconomics(db, asOf);

        expect(result.subscribersAcquired).toBe(10);
        expect(result.trailingAdSpendCents).toBe(100_000);
        expect(result.cacCents).toBe(10_000); // 100_000 / 10
        expect(result.trailingRevenueCents).toBe(30_000);
        // avgActiveSubscribers = mean(active at window start, active at asOf).
        // All 10 acquired mid-window, so active-at-start = 0, active-at-end = 10 -> avg 5.
        expect(result.avgActiveSubscribers).toBe(5);
        // rps (30d) = 30_000 / 5 = 6_000 cents, scaled to month (30/30 = 1x) = 6_000
        expect(result.rpsCentsPerMonth).toBe(6_000);
        expect(result.variableCostCentsPerMonth).toBe(1_000); // 5_000 / 5
        expect(result.contributionMarginCentsPerMonth).toBe(5_000); // 6_000 - 1_000
        // payback = CAC / (margin/30) = 10_000 / (5_000/30) = 60 days
        expect(result.paybackDays).toBeCloseTo(60, 5);
      });
    });

    it("returns null CAC/payback rather than throwing when there's no spend or no subscribers", async () => {
      await withRollback(async (db) => {
        const result = await computeBlendedEconomics(db, new Date());
        expect(result.cacCents).toBeNull();
        expect(result.paybackDays).toBeNull();
      });
    });
  });

  describe("computeAllocatorSummary", () => {
    it("computes a per-cohort LTV from the real retention curve and a sensible recommendation", async () => {
      await withRollback(async (db) => {
        const cohortWeek = "2026-05-04"; // a Monday
        const asOf = new Date("2026-06-01T00:00:00Z"); // 4 weeks later

        const inserted = await db
          .insert(subscribers)
          .values(
            Array.from({ length: 10 }, (_, i) => ({
              beehiivId: `cohort-sub-${i}`,
              acquiredAt: new Date(`${cohortWeek}T00:00:00Z`),
              cohortWeek,
            })),
          )
          .returning();

        // 2 of the 10 unsubscribe within week 1.
        for (const sub of inserted.slice(0, 2)) {
          await db.insert(subscriberEvents).values({
            subscriberId: sub.id,
            eventType: "unsubscribe",
            occurredAt: new Date("2026-05-08T00:00:00Z"),
          });
        }

        // Enough ad spend to make CAC meaningful, and revenue so RPS > 0.
        await db.insert(ledger).values([
          { direction: "debit", amountCents: 50_000, category: "ad_spend", occurredAt: new Date("2026-05-20T00:00:00Z") },
          { direction: "credit", amountCents: 20_000, category: "sponsorship_revenue", occurredAt: new Date("2026-05-20T00:00:00Z") },
        ]);

        const summary = await computeAllocatorSummary(db, asOf);

        expect(summary.cohorts).toHaveLength(1);
        const cohort = summary.cohorts[0]!;
        expect(cohort.cohortWeek).toBe(cohortWeek);
        expect(cohort.cohortSize).toBe(10);
        // 4 weeks elapsed by asOf; retention should reflect the 2 unsubscribes from week 1 onward.
        expect(cohort.retentionCurve).toHaveLength(4);
        expect(cohort.retentionCurve[0]?.survivingFraction).toBeCloseTo(0.8, 5);
        expect(cohort.retentionCurve[3]?.survivingFraction).toBeCloseTo(0.8, 5);
        expect(cohort.ltvCents).toBeGreaterThan(0);
        expect(cohort.recommendation.action).toBeDefined();
      });
    });

    it("returns an empty cohorts array when there are no subscribers yet", async () => {
      await withRollback(async (db) => {
        const summary = await computeAllocatorSummary(db, new Date());
        expect(summary.cohorts).toEqual([]);
        expect(summary.blended.cacCents).toBeNull();
      });
    });

    it("recommends halting when runway is critical, regardless of cohort economics", async () => {
      await withRollback(async (db) => {
        const asOf = new Date("2026-06-30T00:00:00Z");
        await db.insert(subscribers).values({ beehiivId: "a", acquiredAt: new Date("2026-06-15T00:00:00Z"), cohortWeek: "2026-06-15" });
        // Tiny balance, heavy recent spend -> critical runway.
        await db.insert(ledger).values({ direction: "debit", amountCents: 500_000, category: "ad_spend", occurredAt: new Date("2026-06-29T00:00:00Z") });

        const summary = await computeAllocatorSummary(db, asOf);
        expect(summary.runwayDays).toBeLessThan(21);
        for (const cohort of summary.cohorts) {
          expect(cohort.recommendation.action).toBe("halt_all_spend");
        }
      });
    });
  });
});

describe.skipIf(dbAvailable)("Allocator (skipped: no DATABASE_URL reachable)", () => {
  it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
    expect(true).toBe(true);
  });
});
