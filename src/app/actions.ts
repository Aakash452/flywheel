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
import { approveIssue } from "../services/beehiiv/send-issue";
import { enqueueDraftGeneration, enqueueSendIssue } from "../queue/queues";

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
