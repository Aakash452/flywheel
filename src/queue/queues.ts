/**
 * Queue definitions and the recurring job schedule.
 *
 * Cadence notes:
 *   - sourcing: every 6 hours — explicit in the build spec.
 *   - subscriber-sync: hourly. The spec doesn't give an explicit interval
 *     for Beehiiv subscriber sync (only sourcing gets one). Hourly is a
 *     reasonable default for a newsletter's signup volume — flag this as
 *     an assumption, not spec text, if that's wrong for this business.
 *   - issue-stats-poll: every 4 hours, matching the cadence the spec does
 *     specify for creative performance polling (Meta), on the theory that
 *     "how often does engagement data need refreshing" is roughly the same
 *     question for both.
 *   - meta-poll: every 4 hours — explicit in the build spec ("Poll
 *     performance every 4 hours, write to creatives").
 *   - reaper: hourly — explicit in the build spec.
 *   - draft-generation, creative-generation, meta-push, activate-creative,
 *     send-issue: none of these are repeatable. Each is an on-demand job
 *     triggered by a dashboard action. Routing them through a queue rather
 *     than calling the service synchronously from a server action gets
 *     retry/backoff on calls that hit real external APIs and can fail
 *     transiently — the same reasoning as send-issue had from the start.
 */
import { Queue } from "bullmq";
import { getRedisConnection } from "./connection";

export const QUEUE_NAMES = {
  sourcing: "sourcing",
  subscriberSync: "subscriber-sync",
  issueStatsPoll: "issue-stats-poll",
  draftGeneration: "draft-generation",
  sendIssue: "send-issue",
  creativeGeneration: "creative-generation",
  metaPush: "meta-push",
  activateCreative: "activate-creative",
  metaPoll: "meta-poll",
  reaper: "reaper",
} as const;

export interface SendIssueJobData {
  issueId: string;
  /** ISO string, not Date — job data is JSON-serialized. */
  scheduledAt?: string;
  emailPreviewText?: string;
  replyToAddress?: string;
}

export interface CreativeGenerationJobData {
  experimentId: string;
  offer: string;
}

export interface MetaPushJobData {
  experimentId: string;
}

export interface ActivateCreativeJobData {
  creativeId: string;
}

let sourcingQueue: Queue | undefined;
let subscriberSyncQueue: Queue | undefined;
let issueStatsPollQueue: Queue | undefined;
let draftGenerationQueue: Queue | undefined;
let sendIssueQueue: Queue<SendIssueJobData> | undefined;
let creativeGenerationQueue: Queue<CreativeGenerationJobData> | undefined;
let metaPushQueue: Queue<MetaPushJobData> | undefined;
let activateCreativeQueue: Queue<ActivateCreativeJobData> | undefined;
let metaPollQueue: Queue | undefined;
let reaperQueue: Queue | undefined;

export function getSourcingQueue(): Queue {
  if (!sourcingQueue) {
    sourcingQueue = new Queue(QUEUE_NAMES.sourcing, { connection: getRedisConnection() });
  }
  return sourcingQueue;
}

export function getSubscriberSyncQueue(): Queue {
  if (!subscriberSyncQueue) {
    subscriberSyncQueue = new Queue(QUEUE_NAMES.subscriberSync, { connection: getRedisConnection() });
  }
  return subscriberSyncQueue;
}

export function getIssueStatsPollQueue(): Queue {
  if (!issueStatsPollQueue) {
    issueStatsPollQueue = new Queue(QUEUE_NAMES.issueStatsPoll, { connection: getRedisConnection() });
  }
  return issueStatsPollQueue;
}

export function getSendIssueQueue(): Queue<SendIssueJobData> {
  if (!sendIssueQueue) {
    sendIssueQueue = new Queue<SendIssueJobData>(QUEUE_NAMES.sendIssue, { connection: getRedisConnection() });
  }
  return sendIssueQueue;
}

export function getDraftGenerationQueue(): Queue {
  if (!draftGenerationQueue) {
    draftGenerationQueue = new Queue(QUEUE_NAMES.draftGeneration, { connection: getRedisConnection() });
  }
  return draftGenerationQueue;
}

export function getCreativeGenerationQueue(): Queue<CreativeGenerationJobData> {
  if (!creativeGenerationQueue) {
    creativeGenerationQueue = new Queue<CreativeGenerationJobData>(QUEUE_NAMES.creativeGeneration, {
      connection: getRedisConnection(),
    });
  }
  return creativeGenerationQueue;
}

export function getMetaPushQueue(): Queue<MetaPushJobData> {
  if (!metaPushQueue) {
    metaPushQueue = new Queue<MetaPushJobData>(QUEUE_NAMES.metaPush, { connection: getRedisConnection() });
  }
  return metaPushQueue;
}

export function getActivateCreativeQueue(): Queue<ActivateCreativeJobData> {
  if (!activateCreativeQueue) {
    activateCreativeQueue = new Queue<ActivateCreativeJobData>(QUEUE_NAMES.activateCreative, {
      connection: getRedisConnection(),
    });
  }
  return activateCreativeQueue;
}

export function getMetaPollQueue(): Queue {
  if (!metaPollQueue) {
    metaPollQueue = new Queue(QUEUE_NAMES.metaPoll, { connection: getRedisConnection() });
  }
  return metaPollQueue;
}

export function getReaperQueue(): Queue {
  if (!reaperQueue) {
    reaperQueue = new Queue(QUEUE_NAMES.reaper, { connection: getRedisConnection() });
  }
  return reaperQueue;
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
  /** False when META_ACCESS_TOKEN/META_AD_ACCOUNT_ID aren't configured. */
  metaEnabled?: boolean;
}

export async function registerRepeatableJobs(
  options: RegisterRepeatableJobsOptions = {},
): Promise<void> {
  if (options.sourcingEnabled ?? true) {
    await getSourcingQueue().add("run", {}, { repeat: { pattern: "0 */6 * * *" } }); // every 6 hours
  }
  await getSubscriberSyncQueue().add("sync", {}, { repeat: { pattern: "0 * * * *" } }); // hourly
  await getIssueStatsPollQueue().add("poll", {}, { repeat: { pattern: "0 */4 * * *" } }); // every 4 hours

  if (options.metaEnabled ?? true) {
    await getMetaPollQueue().add("poll", {}, { repeat: { pattern: "0 */4 * * *" } }); // every 4 hours — spec text
  }
  await getReaperQueue().add("run", {}, { repeat: { pattern: "0 * * * *" } }); // hourly — spec text, no external creds needed
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

/** Enqueues a one-off creative-generation run for an experiment. */
export async function enqueueCreativeGeneration(data: CreativeGenerationJobData): Promise<void> {
  await getCreativeGenerationQueue().add("generate", data, { attempts: 2 });
}

/** Enqueues pushing an experiment's generated creatives to Meta as paused ads. */
export async function enqueueMetaPush(data: MetaPushJobData): Promise<void> {
  await getMetaPushQueue().add("push", data, { attempts: 3, backoff: { type: "exponential", delay: 5_000 } });
}

/** Enqueues activating one creative — requires an approvals row; see src/services/meta/activate-creative.ts. */
export async function enqueueActivateCreative(data: ActivateCreativeJobData): Promise<void> {
  await getActivateCreativeQueue().add("activate", data, { attempts: 3, backoff: { type: "exponential", delay: 5_000 } });
}
