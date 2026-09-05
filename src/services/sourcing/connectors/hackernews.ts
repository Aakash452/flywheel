/**
 * Hacker News connector — the official Firebase-backed API, no auth
 * required. https://github.com/HackerNews/API
 */
import type { RawCandidate } from "../dedupe";

const BASE_URL = "https://hacker-news.firebaseio.com/v0";

interface HnItem {
  id: number;
  type?: string;
  dead?: boolean;
  deleted?: boolean;
  url?: string;
  title?: string;
  text?: string;
  score?: number;
  time?: number; // unix seconds
}

export interface FetchHackerNewsOptions {
  /** How many of the current top stories to consider. */
  limit?: number;
  /** Skip stories below this score. */
  minPoints?: number;
  fetchImpl?: typeof fetch;
}

/** Turns a raw HN item into a sourcing candidate, or null if it should be skipped (not a live story). */
export function hnItemToCandidate(
  item: HnItem | null | undefined,
  minPoints = 0,
): RawCandidate | null {
  if (!item) return null;
  if (item.type !== "story") return null;
  if (item.dead || item.deleted) return null;
  if ((item.score ?? 0) < minPoints) return null;

  return {
    // Self-text (Ask HN / Show HN) posts have no external `url` — fall
    // back to the HN discussion page itself so there's always something
    // to score and, if it clears threshold, link to.
    url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
    title: item.title ?? null,
    rawContent: item.text ?? null,
    discoveredAt: new Date((item.time ?? Date.now() / 1000) * 1000),
  };
}

export async function fetchHackerNewsTopStories(
  options: FetchHackerNewsOptions = {},
): Promise<RawCandidate[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = options.limit ?? 30;
  const minPoints = options.minPoints ?? 0;

  const idsRes = await fetchImpl(`${BASE_URL}/topstories.json`);
  if (!idsRes.ok) {
    throw new Error(`Hacker News topstories request failed: ${idsRes.status}`);
  }
  const ids = (await idsRes.json()) as number[];

  const items = await Promise.all(
    ids.slice(0, limit).map(async (id) => {
      const res = await fetchImpl(`${BASE_URL}/item/${id}.json`);
      if (!res.ok) return null;
      return (await res.json()) as HnItem;
    }),
  );

  return items
    .map((item) => hnItemToCandidate(item, minPoints))
    .filter((c): c is RawCandidate => c !== null);
}
