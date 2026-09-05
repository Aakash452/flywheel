/**
 * Reddit connector. Reddit's public JSON endpoints (`reddit.com/r/.../new.json`
 * with no auth) are heavily rate-limited in practice — this uses the
 * documented OAuth "script app" client-credentials grant instead, which is
 * appropriate for read-only, no-user-context access:
 * https://github.com/reddit-archive/reddit/wiki/OAuth2#application-only-oauth
 */
import type { RawCandidate } from "../dedupe";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";

export interface RedditAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Reddit requires a descriptive User-Agent identifying the app + a contact. */
  userAgent: string;
  fetchImpl?: typeof fetch;
}

interface RedditPostData {
  url?: string;
  permalink: string;
  title: string;
  selftext?: string;
  created_utc: number;
}

interface RedditListingResponse {
  data: { children: Array<{ data: RedditPostData }> };
}

export function redditPostToCandidate(post: RedditPostData): RawCandidate {
  return {
    // Link posts have an external `url`; self posts point back at
    // themselves — fall back to the permalink either way.
    url: post.url && post.url !== `https://www.reddit.com${post.permalink}`
      ? post.url
      : `https://www.reddit.com${post.permalink}`,
    title: post.title ?? null,
    rawContent: post.selftext || null,
    discoveredAt: new Date(post.created_utc * 1000),
  };
}

async function getAccessToken(config: RedditAuthConfig): Promise<string> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString(
    "base64",
  );

  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": config.userAgent,
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    throw new Error(`Reddit OAuth token request failed: ${res.status}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

export async function fetchSubredditNew(
  subreddit: string,
  config: RedditAuthConfig,
  limit = 25,
): Promise<RawCandidate[]> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const token = await getAccessToken(config);

  const res = await fetchImpl(
    `${API_BASE}/r/${subreddit}/new?limit=${limit}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": config.userAgent,
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Reddit listing request for r/${subreddit} failed: ${res.status}`);
  }
  const json = (await res.json()) as RedditListingResponse;
  return json.data.children.map((child) => redditPostToCandidate(child.data));
}
