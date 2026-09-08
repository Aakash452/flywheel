/**
 * Generates ~6 months of internally-consistent synthetic data so the
 * Allocator, Reaper, and dashboard can be exercised without waiting on
 * real traffic. Per the build spec's testing requirements.
 *
 * "Internally consistent" is the actual goal, not sheer volume — every
 * number here is derived from the same underlying per-experiment quality
 * parameters, so: ledger ad_spend sums match what creatives report
 * spending; a creative's signups roughly match how many real subscriber
 * rows point at it; retention curves decay monotonically; issues are sent
 * in chronological order with recipient counts that track actual cohort
 * growth. A dashboard or Allocator run against this data should produce
 * numbers that hang together, not just numbers that exist.
 *
 * Deliberately NOT run as part of `npm test` or any migration — this is a
 * standalone `npm run db:seed` you point at a scratch database, never
 * your real one (it does not clear existing data, so running it twice
 * doubles everything; that's on you to manage).
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, pool } from "./client";
import {
  creatives,
  experiments,
  issues,
  ledger,
  sources,
  sponsors,
  subscriberEvents,
  subscribers,
} from "./schema";
import { cohortWeekStart } from "../lib/cohort";
import { ANGLES, AUDIENCE_FRAMINGS, FORMATS } from "../services/creative-engine/prompt";

const WEEKS = 26;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const now = new Date();
const startDate = new Date(now.getTime() - WEEKS * WEEK_MS);

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}
function pick<T>(arr: readonly T[]): T {
  const item = arr[randInt(0, arr.length - 1)];
  if (item === undefined) throw new Error("pick from empty array");
  return item;
}
function weeksAfterStart(n: number): Date {
  return new Date(startDate.getTime() + n * WEEK_MS + randInt(0, DAY_MS - 1));
}

interface ExperimentQuality {
  /** True CPA this experiment's creatives converge toward, in cents. Lower = better. */
  trueCpaCents: number;
  /** Weekly churn rate applied to subscribers acquired via this experiment's creatives. */
  weeklyChurnRate: number;
}

async function main() {
  console.log(`Seeding ~${WEEKS} weeks of synthetic data (${startDate.toISOString()} -> ${now.toISOString()})...`);

  // --- Sponsors -----------------------------------------------------------
  const [sponsorA] = await db
    .insert(sponsors)
    .values({ name: "Ridgeline Capital", contactEmail: "partnerships@ridgeline.example.com", status: "active" })
    .returning();
  const [sponsorB] = await db
    .insert(sponsors)
    .values({ name: "Northbeam Analytics", contactEmail: "ads@northbeam.example.com", status: "active" })
    .returning();
  if (!sponsorA || !sponsorB) throw new Error("sponsor seed failed");

  // --- Experiments + creatives ---------------------------------------------
  // 5 experiments spread across the window: 3 concluded (won/killed), 2 still active.
  const experimentDefs: Array<{ weekStart: number; weekEnd: number; quality: ExperimentQuality; status: "active" | "won" | "killed" }> = [
    { weekStart: 0, weekEnd: 8, quality: { trueCpaCents: 250, weeklyChurnRate: 0.02 }, status: "won" }, // a genuinely good experiment
    { weekStart: 3, weekEnd: 10, quality: { trueCpaCents: 1_400, weeklyChurnRate: 0.06 }, status: "killed" }, // a bad one, correctly killed
    { weekStart: 9, weekEnd: 16, quality: { trueCpaCents: 450, weeklyChurnRate: 0.03 }, status: "won" },
    { weekStart: 14, weekEnd: 22, quality: { trueCpaCents: 900, weeklyChurnRate: 0.045 }, status: "active" },
    { weekStart: 19, weekEnd: WEEKS, quality: { trueCpaCents: 350, weeklyChurnRate: 0.025 }, status: "active" },
  ];

  interface SeededCreative {
    id: string;
    experimentId: string;
    quality: ExperimentQuality;
    activeFromWeek: number;
    activeToWeek: number;
    cpaCents: number;
  }
  const seededCreatives: SeededCreative[] = [];

  for (const def of experimentDefs) {
    const deadline = weeksAfterStart(def.weekEnd);
    const budgetCents = randInt(80_000, 250_000);
    const [experiment] = await db
      .insert(experiments)
      .values({
        hypothesis: `Synthetic experiment: CPA target ~$${(def.quality.trueCpaCents / 100).toFixed(0)}, ${def.status}`,
        type: "creative_test",
        budgetCents,
        spentCents: 0, // filled in below as we log ledger ad_spend
        deadline,
        status: def.status === "active" ? "active" : def.status,
        killReason: def.status === "killed" ? "Spent well over 2x target CPA with negligible conversions across the flight." : null,
        targetCpaCents: def.quality.trueCpaCents,
      })
      .returning();
    if (!experiment) throw new Error("experiment insert failed");

    const creativeCount = randInt(8, 14);
    for (let i = 0; i < creativeCount; i++) {
      // Each creative's own CPA wobbles around the experiment's true CPA —
      // some creatives within a "good" experiment still underperform, and
      // vice versa, which is realistic and gives the Reaper/dashboard
      // something to differentiate.
      const cpaCents = Math.max(50, Math.round(def.quality.trueCpaCents * (0.5 + Math.random() * 1.3)));
      const isKilled = def.status === "killed" && i < Math.floor(creativeCount * 0.6);
      const angle = pick(ANGLES);
      const format = pick(FORMATS);
      const audienceFraming = pick(AUDIENCE_FRAMINGS);

      const [creative] = await db
        .insert(creatives)
        .values({
          experimentId: experiment.id,
          angle,
          format,
          audienceFraming,
          hook: `[synthetic] ${angle} hook #${i}`,
          body: `Synthetic creative body for a ${format} ad framed at a ${audienceFraming} audience.`,
          cta: "Subscribe free",
          status: isKilled ? "killed" : def.status === "won" ? "active" : "paused",
          killReason: isKilled ? `Spent well over target CPA ($${(cpaCents / 100).toFixed(0)}) with too few signups.` : null,
        })
        .returning();
      if (!creative) throw new Error("creative insert failed");

      seededCreatives.push({
        id: creative.id,
        experimentId: experiment.id,
        quality: def.quality,
        activeFromWeek: def.weekStart,
        activeToWeek: isKilled ? Math.min(def.weekEnd, def.weekStart + randInt(1, 3)) : def.weekEnd,
        cpaCents,
      });
    }
  }

  // --- Weekly subscriber acquisition + spend + ledger ----------------------
  let totalAdSpendCents = 0;
  const experimentSpend = new Map<string, number>();
  const creativeSpend = new Map<string, number>();
  const creativeSignups = new Map<string, number>();

  interface SeededSubscriber {
    id: string;
    weekIndex: number;
    churnRate: number;
  }
  const seededSubscribers: SeededSubscriber[] = [];

  for (let week = 0; week < WEEKS; week++) {
    const activeCreatives = seededCreatives.filter((c) => week >= c.activeFromWeek && week < c.activeToWeek);
    if (activeCreatives.length === 0) continue;

    for (const creative of activeCreatives) {
      // Weekly spend wobbles; killed creatives taper off fast (Reaper caught them).
      const weeklySpendCents = randInt(1_200, 4_500);
      const weeklySignups = Math.max(0, Math.round(weeklySpendCents / creative.cpaCents + (Math.random() - 0.5) * 2));

      creativeSpend.set(creative.id, (creativeSpend.get(creative.id) ?? 0) + weeklySpendCents);
      creativeSignups.set(creative.id, (creativeSignups.get(creative.id) ?? 0) + weeklySignups);
      experimentSpend.set(creative.experimentId, (experimentSpend.get(creative.experimentId) ?? 0) + weeklySpendCents);
      totalAdSpendCents += weeklySpendCents;

      await db.insert(ledger).values({
        direction: "debit",
        amountCents: weeklySpendCents,
        category: "ad_spend",
        experimentId: creative.experimentId,
        occurredAt: weeksAfterStart(week),
        metadata: { job: "seed", creativeId: creative.id },
      });

      for (let s = 0; s < weeklySignups; s++) {
        const acquiredAt = weeksAfterStart(week);
        const [subscriber] = await db
          .insert(subscribers)
          .values({
            beehiivId: `seed_${creative.id}_${week}_${s}`,
            acquiredAt,
            sourceCreativeId: creative.id,
            acquisitionCostCents: Math.round(weeklySpendCents / Math.max(1, weeklySignups)),
            cohortWeek: cohortWeekStart(acquiredAt),
          })
          .returning();
        if (!subscriber) continue;
        seededSubscribers.push({ id: subscriber.id, weekIndex: week, churnRate: creative.quality.weeklyChurnRate });
      }
    }
  }

  // A modest slice of organic (unattributed) subscribers too — real
  // newsletters always have some, and attribution reconciliation should
  // show them as unattributed, not as noise on some creative.
  for (let i = 0; i < 40; i++) {
    const week = randInt(0, WEEKS - 1);
    const acquiredAt = weeksAfterStart(week);
    const [subscriber] = await db
      .insert(subscribers)
      .values({
        beehiivId: `seed_organic_${i}`,
        acquiredAt,
        acquisitionCostCents: 0,
        cohortWeek: cohortWeekStart(acquiredAt),
      })
      .returning();
    if (subscriber) seededSubscribers.push({ id: subscriber.id, weekIndex: week, churnRate: 0.02 });
  }

  // Sync experiments.spent_cents to what was actually logged, same as
  // poll-performance.ts does incrementally in the real system.
  for (const [experimentId, spentCents] of experimentSpend) {
    await db.update(experiments).set({ spentCents }).where(eq(experiments.id, experimentId));
  }
  for (const creative of seededCreatives) {
    await db
      .update(creatives)
      .set({
        spendCents: creativeSpend.get(creative.id) ?? 0,
        signups: creativeSignups.get(creative.id) ?? 0,
        impressions: (creativeSpend.get(creative.id) ?? 0) * randInt(15, 40),
        clicks: Math.round(((creativeSpend.get(creative.id) ?? 0) * randInt(15, 40)) / randInt(80, 200)),
      })
      .where(eq(creatives.id, creative.id));
  }

  console.log(`Seeded ${seededSubscribers.length} subscribers, ${seededCreatives.length} creatives, $${(totalAdSpendCents / 100).toFixed(0)} in ad spend.`);

  // --- Retention: weekly churn per subscriber, decaying realistically -----
  let unsubscribeCount = 0;
  for (const sub of seededSubscribers) {
    const weeksObserved = WEEKS - sub.weekIndex;
    for (let w = 1; w <= weeksObserved; w++) {
      if (Math.random() < sub.churnRate) {
        const unsubAt = new Date(weeksAfterStart(sub.weekIndex).getTime() + w * WEEK_MS);
        if (unsubAt > now) break;
        await db.insert(subscriberEvents).values({
          subscriberId: sub.id,
          eventType: "unsubscribe",
          occurredAt: unsubAt,
        });
        unsubscribeCount++;
        break; // one unsubscribe per subscriber
      }
    }
  }
  console.log(`Seeded ${unsubscribeCount} unsubscribe events.`);

  // --- Weekly issues, sent chronologically, with plausible engagement -----
  let issueCount = 0;
  for (let week = 0; week < WEEKS - 1; week++) {
    const sentAt = weeksAfterStart(week);
    const recipientsAtSend = seededSubscribers.filter((s) => weeksAfterStart(s.weekIndex) <= sentAt).length;
    if (recipientsAtSend === 0) continue;

    const openRate = 0.35 + Math.random() * 0.25; // 35-60%, a healthy range
    const clickRate = openRate * (0.15 + Math.random() * 0.15);
    // Weekly sponsorship, not monthly — calibrated so the "good" synthetic
    // experiments (low true CPA) can plausibly clear the scale-up bar and
    // the "bad" ones still fail, rather than every cohort reading as a
    // uniform halt regardless of quality. A newsletter of this size having
    // a sponsor most weeks is realistic for the growth stage this system
    // targets.
    const hasSponsor = Math.random() < 0.85;

    const [issue] = await db
      .insert(issues)
      .values({
        subjectLine: `[synthetic] Weekly issue #${week + 1}`,
        bodyMd: `# Weekly issue #${week + 1}\n\nSynthetic seeded content for allocator/dashboard testing.`,
        status: "sent",
        sentAt,
        beehiivPostId: `seed_post_${week}`,
        recipients: recipientsAtSend,
        opens: Math.round(recipientsAtSend * openRate),
        clicks: Math.round(recipientsAtSend * clickRate),
        sponsorId: hasSponsor ? (week % 8 === 2 ? sponsorA.id : sponsorB.id) : null,
        sponsorRevenueCents: hasSponsor ? randInt(150_000, 350_000) : 0,
      })
      .returning();
    if (!issue) continue;
    issueCount++;

    if (issue.sponsorRevenueCents > 0) {
      await db.insert(ledger).values({
        direction: "credit",
        amountCents: issue.sponsorRevenueCents,
        category: "sponsorship_revenue",
        occurredAt: sentAt,
        metadata: { job: "seed", issueId: issue.id },
      });
    }

    // Frequent affiliate revenue, independent of sponsorship.
    if (Math.random() < 0.5) {
      await db.insert(ledger).values({
        direction: "credit",
        amountCents: randInt(5_000, 25_000),
        category: "affiliate_revenue",
        occurredAt: sentAt,
        metadata: { job: "seed" },
      });
    }

    // Ongoing small operating costs — api_cost and tooling. Kept modest
    // deliberately: at this business's scale, tooling/API spend should be
    // a rounding error next to ad spend and revenue, not comparable to
    // either — a real weekly SaaS-tooling bill for one newsletter, not an
    // engineering team's infra budget.
    await db.insert(ledger).values([
      {
        direction: "debit",
        amountCents: randInt(20, 150),
        category: "api_cost",
        occurredAt: sentAt,
        metadata: { job: "seed", note: "sourcing + drafting for this issue" },
      },
      {
        direction: "debit",
        amountCents: randInt(40, 120),
        category: "tooling",
        occurredAt: sentAt,
        metadata: { job: "seed", note: "weekly infra/tooling amortized" },
      },
    ]);
  }
  console.log(`Seeded ${issueCount} sent issues.`);

  // --- A handful of unused sourced material, for the draft-generation queue ---
  for (let i = 0; i < 12; i++) {
    await db.insert(sources).values({
      url: `https://example.com/seed-source-${i}`,
      title: `[synthetic] Source candidate #${i}`,
      rawContent: "Synthetic source content for testing the draft generator's source pool.",
      relevanceScore: (60 + Math.random() * 35).toFixed(2),
      discoveredAt: weeksAfterStart(WEEKS - 1),
    });
  }

  console.log("Seed complete.");
  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
