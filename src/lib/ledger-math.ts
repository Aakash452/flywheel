/**
 * Pure ledger arithmetic, decoupled from the database.
 *
 * These functions take plain arrays/numbers and return plain numbers so
 * they can be unit tested with fixture data instead of a live Postgres
 * instance. The DB-backed equivalents in src/db/queries/ledger.ts should do
 * as little arithmetic as possible themselves — fetch rows (or SQL-side
 * sums), then hand off to these functions.
 *
 * All money is integer cents. Never introduce a float into this file.
 */

export type LedgerDirection = "debit" | "credit";

export interface LedgerAmount {
  direction: LedgerDirection;
  amountCents: number;
}

/**
 * Balance = SUM(credit) - SUM(debit). This mirrors the "Balance is always a
 * SUM" rule in the schema — never a cached running total.
 */
export function sumLedgerCents(entries: readonly LedgerAmount[]): number {
  let balance = 0;
  for (const entry of entries) {
    if (!Number.isInteger(entry.amountCents)) {
      throw new Error(
        `amountCents must be an integer (cents), got ${entry.amountCents}`,
      );
    }
    if (entry.amountCents < 0) {
      throw new Error(
        `amountCents must be non-negative; direction encodes sign, got ${entry.amountCents}`,
      );
    }
    if (entry.direction === "credit") {
      balance += entry.amountCents;
    } else {
      balance -= entry.amountCents;
    }
  }
  return balance;
}

/**
 * Average daily burn (net debits, i.e. spend net of revenue) over a trailing
 * window, in cents/day. Returns 0 if windowDays <= 0 rather than dividing by
 * zero, since "no window" means "no burn rate can be computed."
 */
export function dailyBurnRateCents(
  entries: readonly LedgerAmount[],
  windowDays: number,
): number {
  if (windowDays <= 0) return 0;
  const netSpend = -sumLedgerCents(entries); // positive when debits > credits
  return netSpend / windowDays;
}

/**
 * Runway in days at the given daily burn rate.
 *
 * - Burn <= 0 (break-even or profitable) → Infinity: there is no burn-down
 *   clock. Callers that need a bounded number for display should clamp
 *   this themselves rather than have this function silently lie.
 * - Balance <= 0 with positive burn → 0: already out of runway.
 */
export function runwayDays(
  balanceCents: number,
  dailyBurnCents: number,
): number {
  if (dailyBurnCents <= 0) return Number.POSITIVE_INFINITY;
  if (balanceCents <= 0) return 0;
  return balanceCents / dailyBurnCents;
}

/** True when runway has dropped to or below the halt threshold (Allocator rule: halt all spend below 21 days). */
export function isRunwayCritical(
  runwayDaysValue: number,
  thresholdDays = 21,
): boolean {
  return runwayDaysValue <= thresholdDays;
}
