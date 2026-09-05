/**
 * RSS/Atom connector, backed by `rss-parser`.
 *
 * Split into a pure `feedToCandidate `s mapper (unit-tested against fixture
 * XML via `parser.parseString`, no network) and a thin `fetchRssFeed`
 * network wrapper — same split used throughout this codebase for anything
 * that touches an external service.
 */
import Parser from "rss-parser";
import type { RawCandidate } from "../dedupe";

const parser = new Parser();

function itemToCandidate(item: Parser.Item): RawCandidate | null {
  if (!item.link) return null;
  return {
    url: item.link,
    title: item.title ?? null,
    rawContent: item.contentSnippet ?? item.content ?? null,
    discoveredAt: item.isoDate ? new Date(item.isoDate) : new Date(),
  };
}

/** Parses already-fetched feed XML — no network. Used directly by tests. */
export async function parseRssXml(xml: string): Promise<RawCandidate[]> {
  const feed = await parser.parseString(xml);
  return (feed.items ?? [])
    .map(itemToCandidate)
    .filter((c): c is RawCandidate => c !== null);
}

export async function fetchRssFeed(feedUrl: string): Promise<RawCandidate[]> {
  const feed = await parser.parseURL(feedUrl);
  return (feed.items ?? [])
    .map(itemToCandidate)
    .filter((c): c is RawCandidate => c !== null);
}
