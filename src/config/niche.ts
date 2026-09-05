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
  name: "REPLACE_ME",
  description:
    "REPLACE_ME — one paragraph on what this newsletter covers and the promise it makes to a subscriber.",
  audience: "REPLACE_ME — who reads this and why they'd open it",
  topics: ["REPLACE_ME topic 1", "REPLACE_ME topic 2"],
  exclude: ["REPLACE_ME adjacent topic to avoid"],
  relevanceThreshold: 60,
};
