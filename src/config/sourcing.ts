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
    // — Crypto / BTC —
    "https://www.coindesk.com/arc/outboundfeeds/rss/", // ✅ verified 2026-09-05
    "https://cointelegraph.com/rss",
    "https://www.theblock.co/rss.xml",
    "https://decrypt.co/feed",
    "https://bitcoinmagazine.com/feed",

    // — Gold / precious metals —
    "https://www.kitco.com/rss/KitcoNews.xml",
    "https://www.mining.com/feed/",
    "https://www.gold.org/rss.xml",

    // — Macro / rates / Fed —
    "https://www.federalreserve.gov/feeds/press_monetary.xml",
    "https://www.federalreserve.gov/feeds/press_all.xml",
    "https://libertystreeteconomics.newyorkfed.org/feed/",
    "https://www.bls.gov/feed/bls_latest.rss",
    "https://feeds.content.dowjones.io/public/rss/mw_marketpulse",
  ],

  subreddits: [
    "Gold",
    "Silverbugs",
    "preciousmetals",
    "Bitcoin",
    "BitcoinMarkets",   // best signal-to-noise of the BTC subs
    "CryptoMarkets",
    "economy",
    "econmonitor",
    "wallstreetbets",   // sentiment proxy only — expect low scores
  ],

  hackerNews: { enabled: true, limit: 50, minPoints: 100 },
};
