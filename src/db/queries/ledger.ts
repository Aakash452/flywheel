/**
 * DB-backed ledger queries. Arithmetic itself lives in src/lib/ledger-math
 * (pure, unit tested); this file's job is only to fetch the right rows and
 * hand them off.
 */
import { and, gte, lte, sql } from "drizzle-orm";
import type { Database } from "../client";
import { ledger } from "../schema";
import {
  dailyBurnRateCents,
  isRunwayCritical,
  runwayDays as computeRunwayDays,
} from "../../lib/ledger-math";

/**
 * Current balance in cents, computed as SUM(credit) - SUM(debit) directly
 * in SQL. Deliberately does not fetch rows into Node and sum them in JS —
 * for a table this could grow to millions of rows, that'd be a real cost.
 * The trailing-window functions below (`getDailyBurnRateCents`,
 * `getRunwayDays`) fetch rows because their window is bounded (default 30
 * days) and they reuse the unit-tested pure functions in ledger-math.ts.
 */
export async function getBalanceCents(
  db: Database,
  asOf: Date = new Date(),
): Promise<number> {
  const [row] = await db
    .select({
      balance: sql<string>`COALESCE(SUM(CASE WHEN ${ledger.direction} = 'credit' THEN ${ledger.amountCents} ELSE -${ledger.amountCents} END), 0)`,
    })
    .from(ledger)
    .where(lte(ledger.occurredAt, asOf));

  return Number(row?.balance ?? 0);
}

/**
 * Average daily net burn (spend minus revenue) over the trailing window
 * ending at `asOf`, in cents/day.
 */
export async function getDailyBurnRateCents(
  db: Database,
  windowDays = 30,
  asOf: Date = new Date(),
): Promise<number> {
  const windowStart = new Date(asOf);
  windowStart.setDate(windowStart.getDate() - windowDays);

  const rows = await db
    .select({
      direction: ledger.direction,
      amountCents: ledger.amountCents,
    })
    .from(ledger)
    .where(and(gte(ledger.occurredAt, windowStart), lte(ledger.occurredAt, asOf)));

  return dailyBurnRateCents(rows, windowDays);
}

/** Runway in days at the current balance and trailing daily burn rate. */
export async function getRunwayDays(
  db: Database,
  windowDays = 30,
  asOf: Date = new Date(),
): Promise<number> {
  const [balanceCents, burnCents] = await Promise.all([
    getBalanceCents(db, asOf),
    getDailyBurnRateCents(db, windowDays, asOf),
  ]);
  return computeRunwayDays(balanceCents, burnCents);
}

/**
 * True when the operator should be alerted and all spend halted (Allocator
 * rule: runway below 21 days at current burn).
 */
export async function isRunwayBelowThreshold(
  db: Database,
  thresholdDays = 21,
  windowDays = 30,
  asOf: Date = new Date(),
): Promise<boolean> {
  const runway = await getRunwayDays(db, windowDays, asOf);
  return isRunwayCritical(runway, thresholdDays);
}
