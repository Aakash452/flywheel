/**
 * Pure, unit-tested derived-metric functions shared by creatives and
 * landing_pages. Kept out of the schema as generated columns deliberately
 * — see the "Design notes" header in src/db/schema.ts, point 3.
 *
 * Every function here returns `null` instead of NaN/Infinity when the
 * denominator is zero, so callers (dashboard, allocator) have one
 * consistent "not enough data yet" signal instead of having to guard
 * against divide-by-zero themselves.
 */

function safeDivide(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

/** Cost per click, in cents. */
export function cpcCents(spendCents: number, clicks: number): number | null {
  return safeDivide(spendCents, clicks);
}

/** Cost per acquisition (signup), in cents. */
export function cpaCents(spendCents: number, signups: number): number | null {
  return safeDivide(spendCents, signups);
}

/** Click-through rate, as a 0–1 fraction. */
export function clickThroughRate(
  clicks: number,
  impressions: number,
): number | null {
  return safeDivide(clicks, impressions);
}

/** Landing page (or creative) conversion rate, as a 0–1 fraction. */
export function conversionRate(
  signups: number,
  visits: number,
): number | null {
  return safeDivide(signups, visits);
}

/** Issue open rate, as a 0–1 fraction. Backs the draft generator's "select the last 5 high-performing issues by open rate." */
export function openRate(opens: number, recipients: number): number | null {
  return safeDivide(opens, recipients);
}
