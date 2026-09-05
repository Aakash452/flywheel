/**
 * Shared cost-control infra. Per the build spec's "Cost control" section:
 * every Claude API call is logged to `ledger` as `api_cost` with an
 * estimated token cost, and a configurable daily spend cap pauses further
 * generation once exceeded. This file is what every LLM-calling service —
 * sourcing's relevance scorer today, drafting and the Creative Engine
 * later — routes its cost accounting through, so there's one place that
 * knows how to turn token counts into a ledger row.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { ledger } from "../db/schema";

export interface EstimateCostInput {
  inputTokens: number;
  outputTokens: number;
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
  /** Message Batches API: 50% off standard token pricing. */
  isBatch?: boolean;
}

/**
 * Returns at least 1 cent — `ledger.amount_cents` has a CHECK constraint
 * requiring a strictly positive value (see src/db/schema.ts), and a real
 * API call is never actually free. Rounding a trivially cheap call up to a
 * cent is more honest than a 0-cent row would be anyway.
 */
export function estimateCostCents(input: EstimateCostInput): number {
  const discount = input.isBatch ? 0.5 : 1;
  const cost =
    (input.inputTokens / 1_000_000) * input.inputCentsPerMillion * discount +
    (input.outputTokens / 1_000_000) * input.outputCentsPerMillion * discount;
  return Math.max(1, Math.round(cost));
}

export interface LogApiCostInput extends EstimateCostInput {
  /** e.g. "anthropic", "voyage". */
  provider: string;
  model: string;
  experimentId?: string;
  metadata?: Record<string, unknown>;
}

/** Logs one API call's estimated cost as a debit in the ledger. Returns the amount charged, in cents. */
export async function logApiCost(
  db: Database,
  input: LogApiCostInput,
): Promise<number> {
  const amountCents = estimateCostCents(input);
  await db.insert(ledger).values({
    direction: "debit",
    amountCents,
    category: "api_cost",
    experimentId: input.experimentId,
    metadata: {
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      isBatch: input.isBatch ?? false,
      ...input.metadata,
    },
  });
  return amountCents;
}

/** Sum of api_cost debits for the UTC calendar day containing `asOf`. */
export async function getDailyApiSpendCents(
  db: Database,
  asOf: Date = new Date(),
): Promise<number> {
  const dayStart = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  );
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${ledger.amountCents}), 0)`,
    })
    .from(ledger)
    .where(
      and(
        eq(ledger.category, "api_cost"),
        gte(ledger.occurredAt, dayStart),
        lt(ledger.occurredAt, dayEnd),
      ),
    );

  return Number(row?.total ?? 0);
}

/** True once today's api_cost spend has reached or passed `capCents`. */
export async function isDailyApiCapExceeded(
  db: Database,
  capCents: number,
  asOf: Date = new Date(),
): Promise<boolean> {
  const spent = await getDailyApiSpendCents(db, asOf);
  return spent >= capCents;
}
