/**
 * Draft generator prompt-building and response-parsing — pure, unit-tested
 * directly. The actual Claude call lives in anthropic-draft-generator.ts.
 *
 * Subject-line scoring: the spec calls for 5 subject-line candidates
 * "scored against historical open rates of past subject lines." There's no
 * statistically fitted subject-line model here — with a "last 5 issues"
 * few-shot window there isn't remotely enough data to fit one honestly.
 * Instead, the same call that writes the candidates is given the
 * historical (subject line, open rate) pairs as data to reason from, and
 * asked to score its own candidates by predicted relative appeal against
 * that pattern. That score is a qualitative LLM judgment *conditioned on*
 * real historical performance, not a calibrated probability — callers
 * should treat it accordingly (see IssueDraft.subjectLines below).
 */
import { z } from "zod";
import type { NicheConfig } from "../../config/niche";
import type { VoiceConfig } from "../../config/voice";
import type { Source } from "../../db/schema";
import type { RankedIssue } from "./ranking";

export interface BuildDraftPromptInput {
  sources: Source[];
  niche: NicheConfig;
  voice: VoiceConfig;
  fewShotIssues: RankedIssue[];
  subjectLineCandidateCount: number;
}

export function buildDraftPrompt(input: BuildDraftPromptInput): string {
  const { sources, niche, voice, fewShotIssues, subjectLineCandidateCount } = input;

  const sourceList = sources
    .map(
      (s, i) =>
        `${i + 1}. Title: ${s.title ?? "(no title)"}\nURL: ${s.url}\nExcerpt: ${(s.rawContent ?? "").slice(0, 1_000)}`,
    )
    .join("\n\n");

  const fewShotBlock =
    fewShotIssues.length > 0
      ? fewShotIssues
          .map(
            (r, i) =>
              `Example ${i + 1} (open rate ${(r.openRate * 100).toFixed(1)}%):\nSubject: ${r.issue.subjectLine}\n---\n${r.issue.bodyMd}`,
          )
          .join("\n\n")
      : "(No past issues have been sent yet — write in the voice described below with no historical examples to match against.)";

  return [
    "You are writing an issue of a newsletter. Use the sources below as your raw material — synthesize and cite them, don't just summarize each one in turn.",
    "",
    `Newsletter: ${niche.name}`,
    `Description: ${niche.description}`,
    `Audience: ${niche.audience}`,
    "",
    `Voice: ${voice.description}`,
    voice.guidelines.length > 0
      ? `Style guidelines:\n${voice.guidelines.map((g) => `- ${g}`).join("\n")}`
      : "",
    voice.signOff ? `Sign off with: ${voice.signOff}` : "",
    "",
    "Past high-performing issues (write in a style consistent with what has actually worked, adjusted to fit today's sources):",
    fewShotBlock,
    "",
    "Sources for this issue:",
    sourceList,
    "",
    `Write the full issue body in Markdown. Then generate exactly ${subjectLineCandidateCount} distinct subject line candidates for this issue. For each, give a 0-100 score for predicted relative appeal — informed by the open rates of the past issues above where given, otherwise your best editorial judgment — and one sentence of reasoning.`,
    "",
    "Respond with ONLY a JSON object, no other text, in this exact shape:",
    '{"body_md": "...", "subject_lines": [{"subject_line": "...", "score": 0, "reasoning": "..."}, ...]}',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const draftResponseSchema = z.object({
  body_md: z.string().min(1),
  subject_lines: z
    .array(
      z.object({
        subject_line: z.string().min(1),
        score: z.number().min(0).max(100),
        reasoning: z.string(),
      }),
    )
    .min(1),
});

export interface SubjectLineCandidate {
  subjectLine: string;
  score: number;
  reasoning: string;
}

export interface ParsedDraft {
  bodyMd: string;
  subjectLines: SubjectLineCandidate[];
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in draft-generation response");
  }
  return text.slice(start, end + 1);
}

/** Tolerates the model wrapping the object in prose or a code fence. */
export function parseDraftResponse(text: string): ParsedDraft {
  const jsonText = extractJsonObject(text);
  const parsed = draftResponseSchema.parse(JSON.parse(jsonText));
  return {
    bodyMd: parsed.body_md,
    subjectLines: parsed.subject_lines.map((s) => ({
      subjectLine: s.subject_line,
      score: s.score,
      reasoning: s.reasoning,
    })),
  };
}

/** The subject line with the highest score. Ties keep the first (model's own preferred ordering). */
export function pickBestSubjectLine(
  candidates: readonly SubjectLineCandidate[],
): SubjectLineCandidate {
  if (candidates.length === 0) {
    throw new Error("pickBestSubjectLine: no candidates to choose from");
  }
  return candidates.reduce((best, c) => (c.score > best.score ? c : best));
}
