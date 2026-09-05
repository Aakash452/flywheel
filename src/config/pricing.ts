/**
 * Per-token pricing used to estimate every `api_cost` ledger entry (see
 * src/services/cost-control.ts). The build spec requires every Claude API
 * call to be logged with an estimated cost — this is where that estimate
 * comes from.
 *
 * Anthropic rates below are copied from the current verified pricing table
 * (checked 2026-09-04) — re-verify before trusting these for a real budget
 * decision if pricing changes.
 *
 * Voyage's rate is a PLACEHOLDER, not independently verified — no
 * authoritative current source was available while building this.
 * Overridable via env so it can be corrected without a code change; the
 * point of logging it at all is that an embedding call shows up in the
 * ledger as *some* cost rather than silently looking free.
 */
export const ANTHROPIC_PRICING_CENTS_PER_MILLION = {
  "claude-sonnet-4-6": { input: 300, output: 1_500 },
  "claude-haiku-4-5": { input: 100, output: 500 },
} as const;

export type AnthropicModelId = keyof typeof ANTHROPIC_PRICING_CENTS_PER_MILLION;

/** PLACEHOLDER — verify against voyageai.com/pricing before relying on this for real numbers. */
export const VOYAGE_PRICING_CENTS_PER_MILLION_TOKENS = Number(
  process.env.VOYAGE_ESTIMATED_COST_CENTS_PER_MILLION_TOKENS ?? 2,
);
