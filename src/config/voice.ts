/**
 * The newsletter's voice — how the draft generator writes, as distinct
 * from `niche.ts` (what it covers). A placeholder: the draft generator
 * also conditions on the last 5 high-performing issues as few-shot
 * examples, but this description matters most before any issues have been
 * sent yet, and stays part of the prompt afterward as an explicit anchor.
 */
export interface VoiceConfig {
  description: string;
  /** Concrete dos and don'ts — length, structure, humor, jargon tolerance. */
  guidelines: string[];
  /** How issues typically close, if there's a standard sign-off. */
  signOff?: string;
}

export const voice: VoiceConfig = {
  description:
    "Desk-analyst voice: first person singular, plain declarative sentences, " +
    "no hedging fog. Writes like someone who holds positions and has been " +
    "wrong before — states a view, states what would break it, moves on. " +
    "Assumes the reader knows what a real yield is and doesn't re-teach it. " +
    "Dry humor is allowed, but only at the market's expense or the writer's " +
    "own, never the reader's. Median sentence around 15 words; vary it, but " +
    "when a sentence runs past 30 words it's usually two sentences.",

  guidelines: [
    "Open every issue with what actually changed this week, in one sentence, before any context.",
    "Lead with the number, then the interpretation — 'Real yields fell 18bp; that's most of gold's move' not 'Gold rallied on falling real yields.'",
    "Every price or level cited gets a date. No floating numbers.",
    "State views as probabilities, never certainties. 'I'd put this around 60/40' beats 'this is going higher.'",
    "Every thesis names its invalidation. If you can't say what would prove you wrong, cut the thesis.",
    "Say when you were wrong last week. Reference prior issues by what they claimed, not by issue number.",
    "Never write 'moon', 'explosive', 'massive', 'skyrocket', 'plunge', or 'bloodbath'. Prices rise and fall.",
    "Never write 'it remains to be seen', 'time will tell', or 'only the market knows' — these are word count, not analysis.",
    "Distinguish gold logic from bitcoin logic explicitly. When they diverge, that divergence is the story.",
    "Attribute every borrowed claim to a named source in the same sentence, not a link dump at the end.",
    "Paragraphs run 2-4 sentences. Sections run 3-5 paragraphs.",
    "One chart or table maximum per issue. If the number matters, it belongs in a sentence.",
    "Never tell the reader what to buy, sell, or size. Describe the setup and let them decide.",
    "Cut the last sentence of every section — it's almost always a restatement.",
    "Total issue length 900-1400 words. Under 900 means you didn't have enough; over 1400 means you didn't cut.",
  ],

  signOff:
    "Levels and probabilities, not advice. I hold positions in both assets. " +
    "— [NAME]",
};
