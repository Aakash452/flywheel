/**
 * The newsletter's niche definition — what the sourcing pipeline scores
 * candidate articles/posts against, and what the draft generator (step 4)
 * will write in the voice of.
 *
 * This file is a placeholder. Every value below needs real operator input
 * before sourcing produces anything useful: relevance scoring runs a
 * candidate's title/excerpt against `description`/`audience`/`topics`, and
 * a description that doesn't describe a real newsletter will make every
 * candidate score arbitrarily, not usefully low or high.
 */
export interface NicheConfig {
  name: string;
  description: string;
  audience: string;
  topics: string[];
  /** Adjacent topics to explicitly score down, even if superficially on-topic. */
  exclude: string[];
  /** Minimum relevance score (0–100) required to persist a source. */
  relevanceThreshold: number;
}

export const niche: NicheConfig = {
  name: "Hard Money Weekly",

  description:
    "A weekly read on the two assets that trade on monetary distrust: gold and " +
    "bitcoin. Each issue connects the week's macro data — real yields, Fed " +
    "guidance, dollar strength, central bank reserve activity, ETF flows — to " +
    "what actually moved in XAU/USD and BTC/USD, and to the levels and catalysts " +
    "that matter next. The promise: a subscriber who reads only this can hold an " +
    "informed view on both assets without watching screens all week. Analysis and " +
    "scenarios, never trade calls.",

  audience:
    "Self-directed investors and part-time traders with real capital in gold, " +
    "bitcoin, or both — typically 30–55, comfortable with terms like real yields " +
    "and funding rates, already reading macro commentary but tired of sifting " +
    "crypto hype and goldbug newsletters for the signal. They open it to find out " +
    "what changed and whether their thesis still holds.",

  topics: [
    "gold price XAU/USD",
    "bitcoin price BTC/USD",
    "Federal Reserve policy FOMC rate decision",
    "real yields TIPS 10-year Treasury",
    "US dollar index DXY",
    "CPI PCE inflation data",
    "central bank gold purchases reserves",
    "spot bitcoin ETF flows",
    "gold ETF holdings GLD IAU",
    "bitcoin on-chain supply exchange balances",
    "crypto derivatives funding rates open interest",
    "CFTC COT positioning precious metals",
    "bitcoin halving supply issuance",
    "crypto regulation SEC MiCA",
    "safe haven demand geopolitical risk",
    "silver platinum precious metals",
    "bitcoin mining hashrate economics",
    "sovereign debt currency debasement",
  ],

  exclude: [
    "altcoin and memecoin price predictions",
    "NFTs and web3 gaming",
    "DeFi yield farming protocols",
    "individual equity earnings coverage",
    "gold jewelry and consumer retail",
    "gold IRA and bullion dealer promotions",
    "crypto exchange listings and airdrops",
    "generic personal finance and budgeting",
    "blockchain enterprise adoption",
    "celebrity and influencer crypto commentary",
    "technical-analysis-only chart posts with no macro thesis",
  ],

  relevanceThreshold: 65,
};