/**
 * Polls Beehiiv for each recently-sent issue's opens/clicks and writes them
 * back onto the issue row.
 *
 * The build spec gives an explicit cadence for creative performance
 * ("poll every 4 hours") but not for issue stats. Default here is a
 * trailing 30-day sweep of sent issues, on the assumption that opens/clicks
 * keep moving for a while after send but eventually stabilize — polling
 * issues from a year ago forever would just be wasted API calls. Adjust
 * `sentSinceDays` if that assumption is wrong for this newsletter's
 * engagement pattern.
 */
import { and, eq, gte, isNotNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import { issues } from "../../db/schema";
import type { BeehiivPost } from "../../integrations/beehiiv";

/** The subset of BeehiivClient this service needs — kept narrow for testability. */
export interface StatsSource {
  getPost(
    postId: string,
    opts?: { expand?: Array<"stats"> },
  ): Promise<BeehiivPost>;
}

export interface PollIssueStatsOptions {
  /** How far back to keep re-polling sent issues. Defaults to 30 days. */
  sentSinceDays?: number;
  asOf?: Date;
}

export interface PollIssueStatsResult {
  polled: number;
  updated: number;
}

export async function pollIssueStats(
  db: Database,
  client: StatsSource,
  options: PollIssueStatsOptions = {},
): Promise<PollIssueStatsResult> {
  const asOf = options.asOf ?? new Date();
  const sentSince = new Date(asOf);
  sentSince.setDate(sentSince.getDate() - (options.sentSinceDays ?? 30));

  const rows = await db
    .select({ id: issues.id, beehiivPostId: issues.beehiivPostId })
    .from(issues)
    .where(
      and(
        eq(issues.status, "sent"),
        isNotNull(issues.beehiivPostId),
        gte(issues.sentAt, sentSince),
      ),
    );

  let updated = 0;
  for (const row of rows) {
    // isNotNull(issues.beehiivPostId) already guarantees this at the SQL
    // level; the check narrows the type for TypeScript.
    if (!row.beehiivPostId) continue;

    const post = await client.getPost(row.beehiivPostId, { expand: ["stats"] });
    const opens = post.stats?.email?.opens ?? 0;
    const clicks = post.stats?.email?.clicks ?? 0;
    // Prefer recipients; delivered is the fallback for a stats shape that
    // omits it. Needed for openRate() (opens/recipients) — see
    // src/lib/metrics.ts and the deviation note on this column in schema.ts.
    const recipients =
      post.stats?.email?.recipients ?? post.stats?.email?.delivered ?? 0;

    await db
      .update(issues)
      .set({ opens, clicks, recipients, updatedAt: new Date() })
      .where(eq(issues.id, row.id));
    updated++;
  }

  return { polled: rows.length, updated };
}
