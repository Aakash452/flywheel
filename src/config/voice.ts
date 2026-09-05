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
    "REPLACE_ME — describe the newsletter's voice: formal or casual, first- or third-person, sentence length, humor level.",
  guidelines: [
    "REPLACE_ME — e.g. 'Keep paragraphs under 3 sentences.'",
    "REPLACE_ME — e.g. 'Lead with the concrete detail, not the abstraction.'",
  ],
};
