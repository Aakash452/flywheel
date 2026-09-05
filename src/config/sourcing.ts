/**
 * Sourcing pipeline inputs. Also a placeholder — fill in real feeds and
 * subreddits for this newsletter's niche before the sourcing cron will
 * find anything worth scoring.
 */
export interface SourcingConfig {
  rssFeeds: string[];
  /** Without the "r/" prefix. */
  subreddits: string[];
  hackerNews: {
    enabled: boolean;
    /** How many of the current top stories to consider per run. */
    limit?: number;
    /** Skip stories below this score — a cheap pre-filter before relevance scoring even runs. */
    minPoints?: number;
  };
}

export const sourcingConfig: SourcingConfig = {
  rssFeeds: [
    // "https://example.com/feed.xml", // REPLACE_ME
  ],
  subreddits: [
    // "REPLACE_ME_subreddit",
  ],
  hackerNews: { enabled: true, limit: 30, minPoints: 20 },
};
