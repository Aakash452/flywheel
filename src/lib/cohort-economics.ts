/**
 * Pure cohort-economics math for the Allocator. These are the numbers that
 * drive real spend decisions, so — same discipline as ledger-math.ts and
 * metrics.ts — every formula here is a pure function taking plain
 * numbers/arrays, unit-tested with fixtures, with no DB or network
 * involved. src/services/allocator/* assembles the real inputs from the
 * database and calls these.
 *
 * Documented assumptions (the spec doesn't fully pin these down):
 *
 * - "Revenue per subscriber per month" (RPS) is computed from ledger
 *   credits (sponsorship_revenue + affiliate_revenue) over a trailing
 *   window, divided by the average active subscriber count over that same
 *   window. This is a blended, newsletter-wide number, not per-cohort or
 *   per-creative — the ledger has no way to attribute a given sponsorship
 *   dollar to a specific subscriber or cohort.
 * - "Variable cost per subscriber" is api_cost + tooling ledger debits
 *   over the trailing window, divided by the same active-subscriber
 *   count — the closest thing this system has to a genuine per-subscriber
 *   variable cost, as opposed to ad_spend (which is acquisition cost, not
 *   a recurring cost of serving an existing subscriber).
 * - LTV is a *partial, observed* lifetime value: retention(week) times
 *   weekly revenue per subscriber, summed only over weeks actually
 *   observed for that cohort — never extrapolated with a decay-curve
 *   assumption past the data available. This is a floor on true LTV, not
 *   an estimate of it. Spec text: "using observed retention curves, not
 *   assumptions."
 */

function safeDivide(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

/** Blended CAC, in cents: trailing ad spend / subscribers acquired in that window. */
export function blendedCacCents(
  trailingAdSpendCents: number,
  subscribersAcquired: number,
): number | null {
  return safeDivide(trailingAdSpendCents, subscribersAcquired);
}

/** Revenue per subscriber per month, in cents. See file header for the "blended, not per-cohort" assumption. */
export function revenuePerSubscriberCents(
  trailingRevenueCents: number,
  avgActiveSubscribers: number,
): number | null {
  return safeDivide(trailingRevenueCents, avgActiveSubscribers);
}

/** Variable cost per subscriber per month, in cents. See file header for what counts as "variable." */
export function variableCostPerSubscriberCents(
  trailingVariableCostCents: number,
  avgActiveSubscribers: number,
): number | null {
  return safeDivide(trailingVariableCostCents, avgActiveSubscribers);
}

/** Contribution margin per subscriber per month, in cents. Can be negative. */
export function contributionMarginCents(
  revenuePerSubscriberPerMonthCents: number,
  variableCostPerSubscriberPerMonthCents: number,
): number {
  return revenuePerSubscriberPerMonthCents - variableCostPerSubscriberPerMonthCents;
}

/**
 * Payback period in days: how long until a subscriber's cumulative
 * contribution margin covers their CAC. Returns null when the margin is
 * zero or negative — there is no finite payback period; a subscriber that
 * costs more to serve than they generate never "pays back," and it's
 * important that this reads as "never," not as a very large number a
 * comparison could accidentally treat as merely "slow."
 */
export function paybackPeriodDays(
  cacCents: number,
  contributionMarginCentsPerMonth: number,
): number | null {
  if (contributionMarginCentsPerMonth <= 0) return null;
  const dailyMarginCents = contributionMarginCentsPerMonth / 30;
  return cacCents / dailyMarginCents;
}

/**
 * Partial/observed LTV, in cents: sum of (retention fraction × weekly
 * revenue per subscriber) over every week actually observed. Not
 * extrapolated past `retentionByWeek`'s length — see file header.
 */
export function observedLtvCents(
  weeklyRevenuePerSubscriberCents: number,
  retentionByWeek: readonly number[],
): number {
  return retentionByWeek.reduce(
    (sum, retentionFraction) => sum + retentionFraction * weeklyRevenuePerSubscriberCents,
    0,
  );
}

export function ltvToCac(ltvCents: number, cacCents: number): number | null {
  return safeDivide(ltvCents, cacCents);
}

export interface RetentionCurvePoint {
  /** 1-indexed: weeks since the cohort's acquisition week started. */
  weekOffset: number;
  survivingFraction: number;
}

/**
 * Observed retention curve for one cohort. A week is only included once
 * it's actually elapsed (cohortWeekStart + weekOffset*7 days <= asOf) — no
 * projecting forward. `unsubscribeDates` is one entry per subscriber in
 * the cohort who has unsubscribed, at their actual unsubscribe timestamp;
 * a subscriber who hasn't unsubscribed contributes no entry.
 */
export function computeRetentionCurve(
  cohortWeekStart: Date,
  cohortSize: number,
  unsubscribeDates: readonly Date[],
  maxWeeks: number,
  asOf: Date,
): RetentionCurvePoint[] {
  if (cohortSize <= 0) return [];

  const points: RetentionCurvePoint[] = [];
  for (let week = 1; week <= maxWeeks; week++) {
    const cutoff = new Date(cohortWeekStart);
    cutoff.setUTCDate(cutoff.getUTCDate() + week * 7);
    if (cutoff > asOf) break; // this week hasn't fully elapsed yet — stop, don't project

    const unsubscribedByThen = unsubscribeDates.filter((d) => d <= cutoff).length;
    points.push({
      weekOffset: week,
      survivingFraction: (cohortSize - unsubscribedByThen) / cohortSize,
    });
  }
  return points;
}

export type AllocationAction = "scale_up_20" | "hold" | "cut_50_and_new_experiment" | "halt_all_spend";

export interface AllocationRecommendation {
  action: AllocationAction;
  reasoning: string;
}

export interface RecommendAllocationInput {
  /** null means "never pays back" (margin <= 0), not "very slow." */
  paybackDays: number | null;
  ltvToCacRatio: number | null;
  runwayDays: number;
}

const RUNWAY_HALT_THRESHOLD_DAYS = 21;
const SCALE_UP_PAYBACK_MAX_DAYS = 30;
const SCALE_UP_LTV_CAC_MIN = 3;
const HOLD_PAYBACK_MAX_DAYS = 60;
const CUT_LTV_CAC_MAX = 2;

/**
 * The four allocation rules, applied in the precedence the spec implies
 * even though its rules aren't perfectly mutually exclusive as written:
 *
 *   1. Runway < 21 days → halt everything. This overrides all three rules
 *      below — a cash-out risk matters regardless of how good the unit
 *      economics look on paper.
 *   2. LTV/CAC < 2, or payback is null ("never," which is worse than any
 *      finite "over 60 days"), or payback > 60 days → cut 50% + open a
 *      new experiment. Checked before the scale-up rule because the spec
 *      states LTV/CAC < 2 as an unconditional cut trigger, not one that
 *      only applies when payback is also bad.
 *   3. Payback < 30 days AND LTV/CAC > 3 → scale +20%.
 *   4. Payback 30–60 days → hold.
 *
 * A payback < 30 days but with 2 <= LTV/CAC <= 3 isn't covered by any
 * literal spec rule (it's better than the cut threshold but doesn't clear
 * the scale-up bar) — this defaults to `hold`, the conservative choice for
 * a case the spec is silent on, not a guess dressed up as a rule.
 */
export function recommendAllocation(input: RecommendAllocationInput): AllocationRecommendation {
  const { paybackDays, ltvToCacRatio, runwayDays } = input;

  if (runwayDays < RUNWAY_HALT_THRESHOLD_DAYS) {
    return {
      action: "halt_all_spend",
      reasoning: `Runway is ${runwayDays.toFixed(1)} days, below the ${RUNWAY_HALT_THRESHOLD_DAYS}-day halt threshold.`,
    };
  }

  if (ltvToCacRatio !== null && ltvToCacRatio < CUT_LTV_CAC_MAX) {
    return {
      action: "cut_50_and_new_experiment",
      reasoning: `LTV/CAC is ${ltvToCacRatio.toFixed(2)}, below ${CUT_LTV_CAC_MAX}.`,
    };
  }
  if (paybackDays === null) {
    return {
      action: "cut_50_and_new_experiment",
      reasoning: "Contribution margin is zero or negative — payback never occurs.",
    };
  }
  if (paybackDays > HOLD_PAYBACK_MAX_DAYS) {
    return {
      action: "cut_50_and_new_experiment",
      reasoning: `Payback is ${paybackDays.toFixed(1)} days, over the ${HOLD_PAYBACK_MAX_DAYS}-day cutoff.`,
    };
  }

  if (
    paybackDays < SCALE_UP_PAYBACK_MAX_DAYS &&
    ltvToCacRatio !== null &&
    ltvToCacRatio > SCALE_UP_LTV_CAC_MIN
  ) {
    return {
      action: "scale_up_20",
      reasoning: `Payback is ${paybackDays.toFixed(1)} days (< ${SCALE_UP_PAYBACK_MAX_DAYS}) and LTV/CAC is ${ltvToCacRatio.toFixed(2)} (> ${SCALE_UP_LTV_CAC_MIN}).`,
    };
  }

  if (paybackDays >= SCALE_UP_PAYBACK_MAX_DAYS && paybackDays <= HOLD_PAYBACK_MAX_DAYS) {
    return {
      action: "hold",
      reasoning: `Payback is ${paybackDays.toFixed(1)} days, in the ${SCALE_UP_PAYBACK_MAX_DAYS}-${HOLD_PAYBACK_MAX_DAYS} day hold range.`,
    };
  }

  return {
    action: "hold",
    reasoning: `Payback is ${paybackDays.toFixed(1)} days with LTV/CAC ${ltvToCacRatio?.toFixed(2) ?? "unavailable"} — doesn't clear the scale-up bar, but not bad enough to cut. Not an explicit spec rule; holding is the conservative default.`,
  };
}
