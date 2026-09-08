/**
 * The Allocator: assembles the real inputs (ledger, subscribers,
 * subscriber_events) and hands them to the pure math in
 * src/lib/cohort-economics.ts. Recommendations only — nothing here writes
 * a budget change or acts on anything; a human reads this and decides.
 *
 * Interpretation of "per cohort" (the spec isn't fully explicit here):
 * CAC, revenue-per-subscriber, contribution margin, and payback are
 * computed *blended* — one newsletter-wide trailing-30-day figure — since
 * "blended CAC" is the spec's own term and a per-cohort CAC would need
 * knowing exactly how much was spent acquiring *that* cohort specifically,
 * which the ledger doesn't break out. What genuinely varies per cohort is
 * retention (each cohort has its own observed survival curve) and
 * therefore LTV — so LTV, LTV/CAC, and the resulting recommendation are
 * computed per cohort, using each cohort's own retention curve against
 * the shared blended CAC and payback.
 */
import { getBalanceCents, getRunwayDays } from "../../db/queries/ledger";
import type { Database } from "../../db/client";
import {
  blendedCacCents,
  computeRetentionCurve,
  contributionMarginCents,
  ltvToCac,
  observedLtvCents,
  paybackPeriodDays,
  recommendAllocation,
  revenuePerSubscriberCents,
  variableCostPerSubscriberCents,
  type AllocationRecommendation,
  type RetentionCurvePoint,
} from "../../lib/cohort-economics";
import {
  getAvgActiveSubscribers,
  getCohortSubscriberIds,
  getDistinctCohortWeeks,
  getSubscribersAcquiredInWindow,
  getTrailingLedgerCents,
  getUnsubscribeDates,
} from "./queries";

const TRAILING_WINDOW_DAYS = 30;
const RETENTION_MAX_WEEKS = 52;
const DAYS_PER_MONTH = 30;
const DAYS_PER_WEEK = 7;

export interface BlendedEconomics {
  windowDays: number;
  trailingAdSpendCents: number;
  subscribersAcquired: number;
  cacCents: number | null;
  trailingRevenueCents: number;
  avgActiveSubscribers: number;
  rpsCentsPerMonth: number | null;
  trailingVariableCostCents: number;
  variableCostCentsPerMonth: number | null;
  contributionMarginCentsPerMonth: number | null;
  /** null means "never" (margin <= 0), not "unknown." */
  paybackDays: number | null;
}

export async function computeBlendedEconomics(
  db: Database,
  asOf: Date = new Date(),
  windowDays: number = TRAILING_WINDOW_DAYS,
): Promise<BlendedEconomics> {
  const [
    trailingAdSpendCents,
    subscribersAcquired,
    trailingRevenueCents,
    avgActiveSubscribers,
    trailingVariableCostCents,
  ] = await Promise.all([
    getTrailingLedgerCents(db, ["ad_spend"], "debit", windowDays, asOf),
    getSubscribersAcquiredInWindow(db, windowDays, asOf),
    getTrailingLedgerCents(db, ["sponsorship_revenue", "affiliate_revenue"], "credit", windowDays, asOf),
    getAvgActiveSubscribers(db, windowDays, asOf),
    getTrailingLedgerCents(db, ["api_cost", "tooling"], "debit", windowDays, asOf),
  ]);

  const cacCents = blendedCacCents(trailingAdSpendCents, subscribersAcquired);

  // RPS/variable-cost are explicitly *per month* figures; the trailing
  // window defaults to 30 days but is configurable, so scale explicitly
  // rather than silently assuming windowDays === a month.
  const scaleToMonth = DAYS_PER_MONTH / windowDays;
  const rpsRaw = revenuePerSubscriberCents(trailingRevenueCents, avgActiveSubscribers);
  const rpsCentsPerMonth = rpsRaw === null ? null : rpsRaw * scaleToMonth;
  const variableCostRaw = variableCostPerSubscriberCents(trailingVariableCostCents, avgActiveSubscribers);
  const variableCostCentsPerMonth = variableCostRaw === null ? null : variableCostRaw * scaleToMonth;

  const contributionMargin =
    rpsCentsPerMonth === null || variableCostCentsPerMonth === null
      ? null
      : contributionMarginCents(rpsCentsPerMonth, variableCostCentsPerMonth);

  const paybackDays =
    cacCents === null || contributionMargin === null
      ? null
      : paybackPeriodDays(cacCents, contributionMargin);

  return {
    windowDays,
    trailingAdSpendCents,
    subscribersAcquired,
    cacCents,
    trailingRevenueCents,
    avgActiveSubscribers,
    rpsCentsPerMonth,
    trailingVariableCostCents,
    variableCostCentsPerMonth,
    contributionMarginCentsPerMonth: contributionMargin,
    paybackDays,
  };
}

export interface CohortSummary {
  cohortWeek: string;
  cohortSize: number;
  retentionCurve: RetentionCurvePoint[];
  ltvCents: number;
  ltvToCacRatio: number | null;
  recommendation: AllocationRecommendation;
}

async function computeCohortSummary(
  db: Database,
  cohortWeek: string,
  blended: BlendedEconomics,
  runwayDays: number,
  asOf: Date,
): Promise<CohortSummary> {
  const subscriberIds = await getCohortSubscriberIds(db, cohortWeek);
  const unsubscribeDates = await getUnsubscribeDates(db, subscriberIds);
  // cohort_week is stored as a plain date (the Monday of that ISO week) — see cohortWeekStart in src/lib/cohort.ts.
  const cohortWeekDate = new Date(`${cohortWeek}T00:00:00.000Z`);

  const retentionCurve = computeRetentionCurve(
    cohortWeekDate,
    subscriberIds.length,
    unsubscribeDates,
    RETENTION_MAX_WEEKS,
    asOf,
  );

  const weeklyRevenuePerSubscriberCents =
    blended.rpsCentsPerMonth === null ? 0 : (blended.rpsCentsPerMonth * DAYS_PER_WEEK) / DAYS_PER_MONTH;
  const ltvCents = observedLtvCents(
    weeklyRevenuePerSubscriberCents,
    retentionCurve.map((p) => p.survivingFraction),
  );
  const ratio = blended.cacCents === null ? null : ltvToCac(ltvCents, blended.cacCents);

  const recommendation = recommendAllocation({
    paybackDays: blended.paybackDays,
    ltvToCacRatio: ratio,
    runwayDays,
  });

  return {
    cohortWeek,
    cohortSize: subscriberIds.length,
    retentionCurve,
    ltvCents,
    ltvToCacRatio: ratio,
    recommendation,
  };
}

export interface AllocatorSummary {
  asOf: Date;
  balanceCents: number;
  runwayDays: number;
  blended: BlendedEconomics;
  cohorts: CohortSummary[];
}

export async function computeAllocatorSummary(
  db: Database,
  asOf: Date = new Date(),
): Promise<AllocatorSummary> {
  const [balanceCents, runwayDays, blended, cohortWeeks] = await Promise.all([
    getBalanceCents(db, asOf),
    getRunwayDays(db, TRAILING_WINDOW_DAYS, asOf),
    computeBlendedEconomics(db, asOf),
    getDistinctCohortWeeks(db),
  ]);

  const cohorts = await Promise.all(
    cohortWeeks.map((cohortWeek) => computeCohortSummary(db, cohortWeek, blended, runwayDays, asOf)),
  );

  return { asOf, balanceCents, runwayDays, blended, cohorts };
}
