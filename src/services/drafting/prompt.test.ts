import { describe, expect, it } from "vitest";
import type { NicheConfig } from "../../config/niche";
import type { VoiceConfig } from "../../config/voice";
import type { Source } from "../../db/schema";
import type { RankedIssue } from "./ranking";
import {
  buildDraftPrompt,
  parseDraftResponse,
  pickBestSubjectLine,
  type SubjectLineCandidate,
} from "./prompt";

const niche: NicheConfig = {
  name: "Test Niche",
  description: "A newsletter about testing.",
  audience: "QA engineers",
  topics: ["unit testing"],
  exclude: [],
  relevanceThreshold: 60,
};

const voice: VoiceConfig = {
  description: "Direct and dry.",
  guidelines: ["Keep it short.", "No filler."],
  signOff: "— The Test Bot",
};

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: crypto.randomUUID(),
    url: "https://example.com/a",
    title: "A source",
    rawContent: "Some excerpt text.",
    relevanceScore: "90.00",
    embedding: null,
    usedInIssueId: null,
    discoveredAt: new Date(),
    ...overrides,
  };
}

describe("buildDraftPrompt", () => {
  it("includes niche, voice, guidelines, and sign-off", () => {
    const prompt = buildDraftPrompt({
      sources: [source()],
      niche,
      voice,
      fewShotIssues: [],
      subjectLineCandidateCount: 5,
    });
    expect(prompt).toContain("A newsletter about testing.");
    expect(prompt).toContain("QA engineers");
    expect(prompt).toContain("Direct and dry.");
    expect(prompt).toContain("Keep it short.");
    expect(prompt).toContain("— The Test Bot");
    expect(prompt).toContain("exactly 5 distinct subject line");
  });

  it("includes source titles, URLs, and excerpts", () => {
    const prompt = buildDraftPrompt({
      sources: [source({ title: "My Title", url: "https://example.com/x" })],
      niche,
      voice,
      fewShotIssues: [],
      subjectLineCandidateCount: 5,
    });
    expect(prompt).toContain("My Title");
    expect(prompt).toContain("https://example.com/x");
  });

  it("includes few-shot examples with their open rate when provided", () => {
    const fewShot: RankedIssue[] = [
      {
        issue: {
          id: crypto.randomUUID(),
          subjectLine: "A great past issue",
          bodyMd: "Past body content",
          status: "sent",
          sentAt: new Date(),
          beehiivPostId: "post_1",
          opens: 400,
          clicks: 10,
          recipients: 1_000,
          subjectLineCandidates: null,
          sponsorId: null,
          sponsorRevenueCents: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        openRate: 0.4,
      },
    ];
    const prompt = buildDraftPrompt({
      sources: [source()],
      niche,
      voice,
      fewShotIssues: fewShot,
      subjectLineCandidateCount: 5,
    });
    expect(prompt).toContain("A great past issue");
    expect(prompt).toContain("40.0%");
    expect(prompt).toContain("Past body content");
  });

  it("notes explicitly when there are no past issues yet", () => {
    const prompt = buildDraftPrompt({
      sources: [source()],
      niche,
      voice,
      fewShotIssues: [],
      subjectLineCandidateCount: 5,
    });
    expect(prompt).toContain("No past issues have been sent yet");
  });
});

describe("parseDraftResponse", () => {
  it("parses a clean JSON object", () => {
    const parsed = parseDraftResponse(
      JSON.stringify({
        body_md: "# Hello\n\nBody.",
        subject_lines: [
          { subject_line: "A", score: 80, reasoning: "reason A" },
          { subject_line: "B", score: 40, reasoning: "reason B" },
        ],
      }),
    );
    expect(parsed.bodyMd).toBe("# Hello\n\nBody.");
    expect(parsed.subjectLines).toHaveLength(2);
    expect(parsed.subjectLines[0]).toEqual({
      subjectLine: "A",
      score: 80,
      reasoning: "reason A",
    });
  });

  it("tolerates surrounding prose or a code fence", () => {
    const parsed = parseDraftResponse(
      'Here you go:\n```json\n{"body_md": "x", "subject_lines": [{"subject_line": "A", "score": 50, "reasoning": "r"}]}\n```',
    );
    expect(parsed.bodyMd).toBe("x");
  });

  it("throws when body_md is missing", () => {
    expect(() =>
      parseDraftResponse(
        '{"subject_lines": [{"subject_line": "A", "score": 50, "reasoning": "r"}]}',
      ),
    ).toThrow();
  });

  it("throws when subject_lines is empty", () => {
    expect(() =>
      parseDraftResponse('{"body_md": "x", "subject_lines": []}'),
    ).toThrow();
  });

  it("throws on malformed JSON", () => {
    expect(() => parseDraftResponse("not json at all")).toThrow();
  });
});

describe("pickBestSubjectLine", () => {
  it("picks the highest-scoring candidate", () => {
    const candidates: SubjectLineCandidate[] = [
      { subjectLine: "Low", score: 30, reasoning: "" },
      { subjectLine: "High", score: 90, reasoning: "" },
      { subjectLine: "Mid", score: 60, reasoning: "" },
    ];
    expect(pickBestSubjectLine(candidates).subjectLine).toBe("High");
  });

  it("keeps the first candidate on a tie", () => {
    const candidates: SubjectLineCandidate[] = [
      { subjectLine: "First", score: 50, reasoning: "" },
      { subjectLine: "Second", score: 50, reasoning: "" },
    ];
    expect(pickBestSubjectLine(candidates).subjectLine).toBe("First");
  });

  it("throws on an empty list", () => {
    expect(() => pickBestSubjectLine([])).toThrow();
  });
});
