/**
 * Applying the Allocator's "scale_up_20" recommendation to a specific
 * experiment. The Allocator itself (src/services/allocator/index.ts) only
 * ever recommends — a human reads the cohort recommendations, decides
 * which *experiment* is actually driving the winning cohort (the Allocator
 * works at the cohort level; budget lives at the experiment level, and
 * mapping one to the other is a judgment call, not a formula), and
 * approves a specific increase here.
 *
 * Same gate pattern as approveIssue(): this is the only function that
 * should insert an 'increase_budget' approval in production, and it
 * records the approval and applies the change in one transaction so there
 * is no window where an approval exists but the budget hasn't moved (or
 * vice versa).
 */
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { experiments, type Experiment } from "../../db/schema";
import { recordApproval } from "../approvals";

const DEFAULT_INCREASE_FRACTION = 0.2;

export class ExperimentNotFoundError extends Error {
  constructor(experimentId: string) {
    super(`Experiment ${experimentId} not found`);
    this.name = "ExperimentNotFoundError";
  }
}

export class ExperimentNotActiveError extends Error {
  constructor(experimentId: string, status: string) {
    super(`Experiment ${experimentId} is ${status}, not active — cannot increase its budget.`);
    this.name = "ExperimentNotActiveError";
  }
}

export async function increaseBudget(
  db: Database,
  experimentId: string,
  approvedBy: string,
  fraction: number = DEFAULT_INCREASE_FRACTION,
  notes?: string,
): Promise<Experiment> {
  return db.transaction(async (tx) => {
    const [experiment] = await tx
      .select()
      .from(experiments)
      .where(eq(experiments.id, experimentId))
      .limit(1);
    if (!experiment) throw new ExperimentNotFoundError(experimentId);
    if (experiment.status !== "active") {
      throw new ExperimentNotActiveError(experimentId, experiment.status);
    }

    const newBudgetCents = Math.round(experiment.budgetCents * (1 + fraction));

    await recordApproval(tx, {
      actionType: "increase_budget",
      targetTable: "experiments",
      targetId: experimentId,
      approvedBy,
      notes: notes ?? `Budget ${experiment.budgetCents} -> ${newBudgetCents} (+${Math.round(fraction * 100)}%)`,
    });

    const [updated] = await tx
      .update(experiments)
      .set({ budgetCents: newBudgetCents, updatedAt: new Date() })
      .where(eq(experiments.id, experimentId))
      .returning();
    if (!updated) throw new Error(`Failed to increase budget for experiment ${experimentId}`);
    return updated;
  });
}
