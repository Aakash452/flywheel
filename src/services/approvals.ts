/**
 * The structural human gate. See src/db/schema.ts's `approvals` table
 * comment for why it's a single polymorphic table.
 *
 * Every service that performs a gated action — sending an issue, activating
 * an ad, raising a budget, contacting a sponsor — must call
 * `requireApproval()` immediately before acting, and must use the row it
 * returns (not just treat it as a boolean) so the approval that authorized
 * the action is traceable. There is no config flag that disables this.
 */
import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { approvals, type Approval, type NewApproval } from "../db/schema";

export type ApprovalActionType = NewApproval["actionType"];

export class ApprovalRequiredError extends Error {
  constructor(
    public readonly actionType: ApprovalActionType,
    public readonly targetTable: string,
    public readonly targetId: string,
  ) {
    super(
      `No approval on file for action "${actionType}" on ${targetTable}:${targetId}. ` +
        "This action cannot proceed without an operator approval.",
    );
    this.name = "ApprovalRequiredError";
  }
}

export interface RecordApprovalInput {
  actionType: ApprovalActionType;
  targetTable: string;
  targetId: string;
  approvedBy: string;
  notes?: string;
}

/**
 * Records an operator's approval. This is the *only* function in the
 * codebase that should insert into `approvals` — the dashboard's approve
 * button is the only caller in production.
 */
export async function recordApproval(
  db: DbClient,
  input: RecordApprovalInput,
): Promise<Approval> {
  const [row] = await db
    .insert(approvals)
    .values({
      actionType: input.actionType,
      targetTable: input.targetTable,
      targetId: input.targetId,
      approvedBy: input.approvedBy,
      notes: input.notes,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to record approval: insert returned no row");
  }
  return row;
}

/** The most recent matching approval, or undefined if none exists. */
export async function getLatestApproval(
  db: DbClient,
  actionType: ApprovalActionType,
  targetTable: string,
  targetId: string,
): Promise<Approval | undefined> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.actionType, actionType),
        eq(approvals.targetTable, targetTable),
        eq(approvals.targetId, targetId),
      ),
    )
    // Ordered by the monotonic `sequence` column, not `approvedAt` —
    // Postgres freezes now()/defaultNow() at transaction start, so two
    // approvals recorded in the same transaction can carry an identical
    // approvedAt. sequence (bigserial) never ties.
    .orderBy(desc(approvals.sequence))
    .limit(1);
  return row;
}

/**
 * Looks up an approval for the given action/target and throws
 * ApprovalRequiredError if none exists. Call this — and use its return
 * value — as the last thing before performing a gated action.
 */
export async function requireApproval(
  db: DbClient,
  actionType: ApprovalActionType,
  targetTable: string,
  targetId: string,
): Promise<Approval> {
  const approval = await getLatestApproval(db, actionType, targetTable, targetId);
  if (!approval) {
    throw new ApprovalRequiredError(actionType, targetTable, targetId);
  }
  return approval;
}
