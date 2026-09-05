/**
 * Approving and sending an issue. This file contains the only call site in
 * the codebase for BeehiivClient.createPost() — see that method's doc
 * comment for why "create" and "send" are the same Beehiiv call.
 *
 * Two functions, two gates:
 *   - approveIssue(): the dashboard's approve button. Flips a 'draft'
 *     issue to 'approved' and records the approval row, atomically.
 *   - sendIssue(): requires status === 'approved' AND a matching row in
 *     `approvals` (queried independently, not trusted from the status
 *     flag) before it will call Beehiiv. Both conditions normally arrive
 *     together via approveIssue(), but sendIssue re-checks the approvals
 *     table itself rather than trusting that nothing flipped the status
 *     column by some other path — that's the actual structural gate.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { issues, type Issue } from "../../db/schema";
import { renderIssueHtml } from "../../lib/markdown";
import { recordApproval, requireApproval } from "../approvals";
import type {
  CreatePostInput,
  CreatePostResult,
} from "../../integrations/beehiiv";

/** The subset of BeehiivClient this service needs — kept narrow for testability. */
export interface IssueSender {
  createPost(input: CreatePostInput): Promise<CreatePostResult>;
}

export class IssueNotFoundError extends Error {
  constructor(issueId: string) {
    super(`Issue ${issueId} not found`);
    this.name = "IssueNotFoundError";
  }
}

export class IssueNotDraftError extends Error {
  constructor(issueId: string, status: string) {
    super(
      `Issue ${issueId} is not a draft (status: ${status}); only draft issues can be approved.`,
    );
    this.name = "IssueNotDraftError";
  }
}

export class IssueNotApprovedError extends Error {
  constructor(issueId: string, status: string) {
    super(
      `Issue ${issueId} is not approved (status: ${status}); only approved issues can be sent.`,
    );
    this.name = "IssueNotApprovedError";
  }
}

export class IssueAlreadySentError extends Error {
  constructor(issueId: string, sentAt: Date | null) {
    super(
      `Issue ${issueId} was already sent${sentAt ? ` at ${sentAt.toISOString()}` : ""}. ` +
        "Sending is not idempotent against Beehiiv — refusing to send a duplicate.",
    );
    this.name = "IssueAlreadySentError";
  }
}

/**
 * Moves a draft issue to 'approved' and records the approval, in one
 * transaction. This is the only function that should insert a 'send_issue'
 * approval for an issue in production — the dashboard's approve action.
 */
export async function approveIssue(
  db: Database,
  issueId: string,
  approvedBy: string,
  notes?: string,
): Promise<Issue> {
  return db.transaction(async (tx) => {
    const [issue] = await tx
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw new IssueNotFoundError(issueId);
    if (issue.status !== "draft") {
      throw new IssueNotDraftError(issueId, issue.status);
    }

    await recordApproval(tx, {
      actionType: "send_issue",
      targetTable: "issues",
      targetId: issueId,
      approvedBy,
      notes,
    });

    const [updated] = await tx
      .update(issues)
      .set({ status: "approved", updatedAt: new Date() })
      .where(eq(issues.id, issueId))
      .returning();
    if (!updated) throw new Error(`Failed to approve issue ${issueId}`);
    return updated;
  });
}

export interface SendIssueOptions {
  /** Omit for immediate send. */
  scheduledAt?: Date;
  emailPreviewText?: string;
  replyToAddress?: string;
}

/**
 * Sends an approved issue via Beehiiv. Throws before ever touching the
 * network if the issue isn't approved, has no approval on file, or was
 * already sent.
 */
export async function sendIssue(
  db: Database,
  client: IssueSender,
  issueId: string,
  options: SendIssueOptions = {},
): Promise<Issue> {
  const [issue] = await db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) throw new IssueNotFoundError(issueId);

  if (issue.status === "sent") {
    throw new IssueAlreadySentError(issueId, issue.sentAt);
  }
  if (issue.status !== "approved") {
    throw new IssueNotApprovedError(issueId, issue.status);
  }

  // The structural gate: throws ApprovalRequiredError if no matching row
  // exists. There is no code path from here to client.createPost() that
  // skips this call.
  await requireApproval(db, "send_issue", "issues", issueId);

  const post = await client.createPost({
    title: issue.subjectLine,
    bodyContent: renderIssueHtml(issue.bodyMd),
    emailSubjectLine: issue.subjectLine,
    emailPreviewText: options.emailPreviewText,
    replyToAddress: options.replyToAddress,
    scheduledAt: options.scheduledAt,
  });

  const [updated] = await db
    .update(issues)
    .set({
      status: "sent",
      sentAt: new Date(),
      beehiivPostId: post.id,
      updatedAt: new Date(),
    })
    .where(eq(issues.id, issueId))
    .returning();

  if (!updated) {
    // Beehiiv has already sent the email at this point — this is not a
    // state to retry into silently. Surface it loudly for manual
    // reconciliation (the row exists; the UPDATE should never fail here
    // barring a concurrent delete, but if it does, someone needs to know
    // the email genuinely went out).
    throw new Error(
      `Beehiiv accepted issue ${issueId} (post id: ${post.id}) but the local ` +
        "UPDATE failed. The email was sent — reconcile issues.status manually.",
    );
  }
  return updated;
}
