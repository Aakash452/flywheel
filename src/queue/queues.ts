/**
 * Queue definitions and the recurring job schedule.
 *
 * Cadence notes:
 *   - sourcing: every 6 hours — this one's explicit in the build spec.
 *   - subscriber-sync: hourly. The spec doesn't give an explicit interval
 *     for Beehiiv subscriber sync (only sourcing gets one). Hourly is a
 *     reasonable default for a newsletter's signup volume — flag this as
 *     an assumption, not spec text, if that's wrong for this business.
 *   - issue-stats-poll: every 4 hours, matching the cadence the spec does
 *     specify for creative performance polling (Meta), on the theory that
 *     "how often does engagement data need refreshing" is roughly the same
 *     question for both.
 *   - draft-generation: not repeatable. The build spec gives no cadence for
 *     drafting (content cadence is a business decision, not stated) — it's
 *     an on-demand job triggered by the dashboard's "Generate Draft"
 *     button, same posture as send-issue below.
 *   - send-issue: not repeatable. One job per approved send, enqueued by
 *     the dashboard after approveIssue() has run. Routing the actual
 *     Beehiiv network call through a queue (rather than calling
 *     sendIssue() synchronously from an API route) gets retry/backoff on
 *     a call that both costs real subscriber-facing side effects and can
 *     fail transiently.
 */
import { Queue } from "bullmq";
import { getRedisConnection } from "./connection";

export const QUEUE_NAMES = {
  sourcing: "sourcing",
  subscriberSync: "subscriber-sync",
  issueStatsPoll: "issue-stats-poll",
  draftGeneration: "draft-generation",
  sendIssue: "send-issue",
} as const;

export interface SendIssueJobData {
  issueId: string;
  /** ISO string, not Date — job data is JSON-serialized. */
  scheduledAt?: string;
  emailPreviewText?: string;
  replyToAddress?: string;
}

let sourcingQueue: Queue | undefined;
let subscriberSyncQueue: Queue | undefined;
let issueStatsPollQueue: Queue | undefined;
let draftGenerationQueue: Queue | undefined;
let sendIssueQueue: Queue<SendIssueJobData> | undefined;

export function getSourcingQueue(): Queue {
  if (!sourcingQueue) {
    sourcingQueue = new Queue(QUEUE_NAMES.sourcing, {
      connection: getRedisConnection(),
    });
  }
  return sourcingQueue;
}

export function getSubscriberSyncQueue(): Queue {
  if (!subscriberSyncQueue) {
    subscriberSyncQueue = new Queue(QUEUE_NAMES.subscriberSync, {
      connection: getRedisConnection(),
    });
  }
  return subscriberSyncQueue;
}

export function getIssueStatsPollQueue(): Queue {
  if (!issueStatsPollQueue) {
    issueStatsPollQueue = new Queue(QUEUE_NAMES.issueStatsPoll, {
      connection: getRedisConnection(),
    });
  }
  return issueStatsPollQueue;
}

export function getSendIssueQueue(): Queue<SendIssueJobData> {
  if (!sendIssueQueue) {
    sendIssueQueue = new Queue<SendIssueJobData>(QUEUE_NAMES.sendIssue, {
      connection: getRedisConnection(),
    });
  }
  return sendIssueQueue;
}

export function getDraftGenerationQueue(): Queue {
  if (!draftGenerationQueue) {
    draftGenerationQueue = new Queue(QUEUE_NAMES.draftGeneration, {
      connection: getRedisConnection(),
    });
  }
  return draftGenerationQueue;
}

/**
 * Registers the recurring cron schedules. Call once at worker start (see
 * src/queue/worker.ts). Idempotent — BullMQ dedupes repeatable jobs by
 * their repeat key (queue + name + pattern), so calling this again on
 * every worker restart doesn't pile up duplicate schedules.
 */
export interface RegisterRepeatableJobsOptions {
  /** False when ANTHROPIC_API_KEY isn't configured — see src/queue/worker.ts. */
  sourcingEnabled?: boolean;
}

export async function registerRepeatableJobs(
  options: RegisterRepeatableJobsOptions = {},
): Promise<void> {
  if (options.sourcingEnabled ?? true) {
    await getSourcingQueue().add(
      "run",
      {},
      { repeat: { pattern: "0 */6 * * *" } }, // every 6 hours
    );
  }
  await getSubscriberSyncQueue().add(
    "sync",
    {},
    { repeat: { pattern: "0 * * * *" } }, // hourly, on the hour
  );
  await getIssueStatsPollQueue().add(
    "poll",
    {},
    { repeat: { pattern: "0 */4 * * *" } }, // every 4 hours
  );
}

/** Enqueues a one-off send for an already-approved issue. */
export async function enqueueSendIssue(data: SendIssueJobData): Promise<void> {
  await getSendIssueQueue().add("send", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
  });
}

/** Enqueues a one-off draft-generation run — the dashboard's "Generate Draft" button. */
export async function enqueueDraftGeneration(): Promise<void> {
  await getDraftGenerationQueue().add("generate", {});
}
