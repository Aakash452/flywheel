"use server";

/**
 * Server actions backing the dashboard's three buttons. Each one is a thin
 * wrapper over an already-gated service function — the gate itself lives
 * in src/services/*, not here, so there's no way to reach a send by
 * calling one of these out of order (sendIssueNowAction only ever enqueues
 * a job; the worker's sendIssue() call independently re-verifies the
 * approvals table before it does anything).
 *
 * OPERATOR_EMAIL identifies who's approving. There's no login system —
 * this dashboard is a single-operator internal tool with no user
 * management (explicitly out of scope per the build spec) and is assumed
 * to sit behind network-level access control (bind to localhost, a VPN,
 * or an upstream auth proxy), not behind its own auth.
 */
import { revalidatePath } from "next/cache";
import { db } from "../db/client";
import { experiments, experimentTypeEnum } from "../db/schema";
import { approveIssue } from "../services/beehiiv/send-issue";
import { recordApproval } from "../services/approvals";
import { increaseBudget } from "../services/experiments/increase-budget";
import {
  enqueueActivateCreative,
  enqueueCreativeGeneration,
  enqueueDraftGeneration,
  enqueueMetaPush,
  enqueueSendIssue,
} from "../queue/queues";

const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL ?? "operator@example.com";

export async function generateDraftAction(): Promise<void> {
  await enqueueDraftGeneration();
  revalidatePath("/");
}

export async function approveDraftAction(formData: FormData): Promise<void> {
  const issueId = String(formData.get("issueId") ?? "");
  if (!issueId) throw new Error("approveDraftAction: missing issueId");
  await approveIssue(db, issueId, OPERATOR_EMAIL);
  revalidatePath("/");
}

export async function sendIssueNowAction(formData: FormData): Promise<void> {
  const issueId = String(formData.get("issueId") ?? "");
  if (!issueId) throw new Error("sendIssueNowAction: missing issueId");
  await enqueueSendIssue({ issueId });
  revalidatePath("/");
}

const EXPERIMENT_TYPES = experimentTypeEnum.enumValues;

export async function createExperimentAction(formData: FormData): Promise<void> {
  const hypothesis = String(formData.get("hypothesis") ?? "").trim();
  const type = String(formData.get("type") ?? "");
  const budgetDollars = Number(formData.get("budgetDollars"));
  const deadlineRaw = String(formData.get("deadline") ?? "");
  const targetCpaDollars = formData.get("targetCpaDollars");

  if (!hypothesis) throw new Error("createExperimentAction: missing hypothesis");
  if (!EXPERIMENT_TYPES.includes(type as (typeof EXPERIMENT_TYPES)[number])) {
    throw new Error(`createExperimentAction: invalid type "${type}"`);
  }
  if (!Number.isFinite(budgetDollars) || budgetDollars <= 0) {
    throw new Error("createExperimentAction: budget must be a positive number");
  }
  const deadline = new Date(deadlineRaw);
  if (Number.isNaN(deadline.getTime())) {
    throw new Error("createExperimentAction: invalid deadline");
  }

  await db.insert(experiments).values({
    hypothesis,
    type: type as (typeof EXPERIMENT_TYPES)[number],
    budgetCents: Math.round(budgetDollars * 100),
    deadline,
    targetCpaCents:
      targetCpaDollars && Number(targetCpaDollars) > 0
        ? Math.round(Number(targetCpaDollars) * 100)
        : null,
  });
  revalidatePath("/");
}

export async function generateCreativesAction(formData: FormData): Promise<void> {
  const experimentId = String(formData.get("experimentId") ?? "");
  const offer = String(formData.get("offer") ?? "").trim();
  if (!experimentId) throw new Error("generateCreativesAction: missing experimentId");
  if (!offer) throw new Error("generateCreativesAction: missing offer");
  await enqueueCreativeGeneration({ experimentId, offer });
  revalidatePath("/");
}

export async function pushToMetaAction(formData: FormData): Promise<void> {
  const experimentId = String(formData.get("experimentId") ?? "");
  if (!experimentId) throw new Error("pushToMetaAction: missing experimentId");
  await enqueueMetaPush({ experimentId });
  revalidatePath("/");
}

/**
 * Records the operator's approval (the only production call site for an
 * 'increase_budget' approval — see src/services/experiments/increase-budget.ts)
 * and applies the +20% raise in the same call. No network call is involved
 * (budget is a local number, not something Meta needs to acknowledge), so
 * unlike creative activation this doesn't need a queue for retry.
 */
export async function increaseBudgetAction(formData: FormData): Promise<void> {
  const experimentId = String(formData.get("experimentId") ?? "");
  if (!experimentId) throw new Error("increaseBudgetAction: missing experimentId");
  await increaseBudget(db, experimentId, OPERATOR_EMAIL);
  revalidatePath("/");
}

/**
 * Records the operator's approval for activating a specific creative, then
 * enqueues the actual Meta call — mirroring sendIssueNowAction: the queue
 * gets retry/backoff on a real external API call, and the worker's
 * activateCreative() independently re-verifies this approval before it
 * touches Meta (see src/services/meta/activate-creative.ts).
 */
export async function activateCreativeAction(formData: FormData): Promise<void> {
  const creativeId = String(formData.get("creativeId") ?? "");
  if (!creativeId) throw new Error("activateCreativeAction: missing creativeId");
  await recordApproval(db, {
    actionType: "activate_ad",
    targetTable: "creatives",
    targetId: creativeId,
    approvedBy: OPERATOR_EMAIL,
  });
  await enqueueActivateCreative({ creativeId });
  revalidatePath("/");
}
