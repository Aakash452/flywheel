/**
 * Ranking for the draft generator's two "pick the best N" needs: which
 * past issues to use as few-shot examples (by open rate), and which
 * unused sources to draft from (by relevance score).
 */
import { desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import { issues, sources, type Issue, type Source } from "../../db/schema";
import { openRate } from "../../lib/metrics";

export interface RankedIssue {
  issue: Issue;
  openRate: number;
}

/**
 * Ranks sent issues by open rate, descending. Issues with 0 recipients are
 * excluded — dividing by zero there would rank an unmeasurable issue
 * arbitrarily rather than leaving it out, and this is a "best examples"
 * selection, not a report that has to account for every row.
 */
export function rankIssuesByOpenRate(candidateIssues: readonly Issue[]): RankedIssue[] {
  return candidateIssues
    .map((issue) => ({ issue, openRate: openRate(issue.opens, issue.recipients) }))
    .filter((r): r is RankedIssue => r.openRate !== null)
    .sort((a, b) => b.openRate - a.openRate);
}

/** The top `limit` sent issues by open rate — the draft generator's few-shot examples. */
export async function getTopPerformingIssues(
  db: Database,
  limit: number,
): Promise<RankedIssue[]> {
  const sent = await db
    .select()
    .from(issues)
    .where(eq(issues.status, "sent"));
  return rankIssuesByOpenRate(sent).slice(0, limit);
}

/** The top `limit` unused sources by relevance score — the draft generator's raw material. */
export async function getTopUnusedSources(
  db: Database,
  limit: number,
): Promise<Source[]> {
  return db
    .select()
    .from(sources)
    .where(isNull(sources.usedInIssueId))
    .orderBy(desc(sources.relevanceScore))
    .limit(limit);
}
