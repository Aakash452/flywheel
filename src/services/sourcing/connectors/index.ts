/**
 * Combines RSS, Reddit, and Hacker News into one candidate stream.
 * `Promise.allSettled` so one broken feed (a 404'd RSS URL, an expired
 * Reddit app) doesn't take the rest of sourcing down with it — a failed
 * connector is logged and skipped, not thrown.
 */
import type { SourcingConfig } from "../../../config/sourcing";
import type { RawCandidate } from "../dedupe";
import { fetchHackerNewsTopStories } from "./hackernews";
import { fetchSubredditNew, type RedditAuthConfig } from "./reddit";
import { fetchRssFeed } from "./rss";

export interface ConnectorSet {
  fetchAll(): Promise<RawCandidate[]>;
}

export function createConnectorSet(
  config: SourcingConfig,
  redditAuth?: RedditAuthConfig,
): ConnectorSet {
  return {
    async fetchAll(): Promise<RawCandidate[]> {
      const tasks: Promise<RawCandidate[]>[] = [
        ...config.rssFeeds.map((url) => fetchRssFeed(url)),
        config.hackerNews.enabled
          ? fetchHackerNewsTopStories({
              limit: config.hackerNews.limit,
              minPoints: config.hackerNews.minPoints,
            })
          : Promise.resolve([]),
      ];

      if (redditAuth) {
        tasks.push(
          ...config.subreddits.map((sub) => fetchSubredditNew(sub, redditAuth)),
        );
      } else if (config.subreddits.length > 0) {
        console.warn(
          "[sourcing] subreddits configured but no Reddit credentials provided — skipping Reddit this run",
        );
      }

      const results = await Promise.allSettled(tasks);
      const candidates: RawCandidate[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          candidates.push(...result.value);
        } else {
          console.warn("[sourcing] a connector failed:", result.reason);
        }
      }
      return candidates;
    },
  };
}

export function createRedditAuthFromEnv(): RedditAuthConfig | undefined {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT;
  if (!clientId || !clientSecret || !userAgent) return undefined;
  return { clientId, clientSecret, userAgent };
}
