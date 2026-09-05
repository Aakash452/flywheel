/**
 * Draft generator tuning. None of these counts are given explicit values
 * in the build spec beyond "top N sources" and "5 subject line
 * candidates" (the latter is spec text, not a default — see
 * subjectLineCandidateCount).
 */
export interface DraftingConfig {
  /** How many top-scoring, unused sources to feed into one draft. */
  sourceCount: number;
  /** How many past high-performing (by open rate) issues to use as few-shot examples. */
  fewShotCount: number;
  /** Spec text: "Generate 5 subject line candidates per issue." */
  subjectLineCandidateCount: number;
}

export const draftingConfig: DraftingConfig = {
  sourceCount: 8,
  fewShotCount: 5,
  subjectLineCandidateCount: 5,
};
