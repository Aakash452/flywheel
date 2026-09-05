/**
 * BullMQ worker process. Run with `npm run worker`.
 *
 * Registers up to five workers:
 *   - sourcing (repeatable, every 6h): fetches RSS/Reddit/HN, dedupes, and
 *     scores relevance via Claude's Batch API — see
 *     src/services/sourcing/index.ts. Skipped entirely (with a startup
 *     warning) if ANTHROPIC_API_KEY isn't configured, so the rest of the
 *     worker still runs during initial setup before that key exists.
 *   - subscriber-sync (repeatable, hourly): pulls subscriptions from
 *     Beehiiv and attributes new subscribers to the creative that
 *     acquired them.
 *   - issue-stats-poll (repeatable, every 4h): refreshes opens/clicks for
 *     recently sent issues.
 *   - draft-generation (on-demand): generates one issue draft from the top
 *     unused sources — see src/services/drafting/index.ts. Also skipped
 *     without ANTHROPIC_API_KEY.
 *   - send-issue (on-demand): the only queue that touches Beehiiv's actual
 *     send-an-email call. Enqueued by the dashboard after approveIssue()
 *     has already recorded an approval — but sendIssue() re-verifies the
 *     approvals table itself regardless of how the job arrived here, so
 *     this queue is not itself part of the trust boundary.
 */
import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { db } from "../db/client";
import { createBeehiivClientFromEnv } from "../integrations/beehiiv";
import { syncSubscribers } from "../services/beehiiv/sync-subscribers";
import { pollIssueStats } from "../services/beehiiv/poll-issue-stats";
import { sendIssue } from "../services/beehiiv/send-issue";
import { createSourcingDependenciesFromEnv } from "../services/sourcing/factory";
import { runSourcingCycle } from "../services/sourcing";
import { createDraftingDependenciesFromEnv } from "../services/drafting/factory";
import { runDraftGeneration } from "../services/drafting";
import { getRedisConnection } from "./connection";
import {
  QUEUE_NAMES,
  registerRepeatableJobs,
  type SendIssueJobData,
} from "./queues";

async function main() {
  const connection = getRedisConnection();
  const beehiiv = createBeehiivClientFromEnv();

  const workers: Worker[] = [];

  let sourcingEnabled = true;
  try {
    const sourcingDeps = createSourcingDependenciesFromEnv();
    workers.push(
      new Worker(
        QUEUE_NAMES.sourcing,
        async () => {
          const result = await runSourcingCycle(db, sourcingDeps);
          console.log("[sourcing]", result);
          return result;
        },
        { connection },
      ),
    );
  } catch (err) {
    sourcingEnabled = false;
    console.warn(
      "[sourcing] disabled — not registering a worker or schedule for it:",
      err instanceof Error ? err.message : err,
    );
  }

  let draftingEnabled = true;
  try {
    const draftingDeps = createDraftingDependenciesFromEnv();
    workers.push(
      new Worker(
        QUEUE_NAMES.draftGeneration,
        async () => {
          const result = await runDraftGeneration(db, draftingDeps);
          console.log("[draft-generation]", result);
          return result;
        },
        { connection },
      ),
    );
  } catch (err) {
    draftingEnabled = false;
    console.warn(
      "[draft-generation] disabled — not registering a worker for it:",
      err instanceof Error ? err.message : err,
    );
  }

  workers.push(
    new Worker(
      QUEUE_NAMES.subscriberSync,
      async () => {
        const result = await syncSubscribers(db, beehiiv);
        console.log("[subscriber-sync]", result);
        return result;
      },
      { connection },
    ),
  );

  workers.push(
    new Worker(
      QUEUE_NAMES.issueStatsPoll,
      async () => {
        const result = await pollIssueStats(db, beehiiv);
        console.log("[issue-stats-poll]", result);
        return result;
      },
      { connection },
    ),
  );

  workers.push(
    new Worker<SendIssueJobData>(
      QUEUE_NAMES.sendIssue,
      async (job: Job<SendIssueJobData>) => {
        const issue = await sendIssue(db, beehiiv, job.data.issueId, {
          scheduledAt: job.data.scheduledAt
            ? new Date(job.data.scheduledAt)
            : undefined,
          emailPreviewText: job.data.emailPreviewText,
          replyToAddress: job.data.replyToAddress,
        });
        console.log("[send-issue]", {
          issueId: issue.id,
          beehiivPostId: issue.beehiivPostId,
        });
        return { issueId: issue.id };
      },
      { connection },
    ),
  );

  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      console.error(`[${worker.name}] job ${job?.id} failed:`, err);
    });
  }

  await registerRepeatableJobs({ sourcingEnabled });
  console.log(
    `Flywheel worker started: ${sourcingEnabled ? "sourcing, " : ""}subscriber-sync, issue-stats-poll, ${draftingEnabled ? "draft-generation, " : ""}send-issue`,
  );

  const shutdown = async () => {
    console.log("Shutting down worker...");
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
