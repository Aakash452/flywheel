import { describe, expect, it } from "vitest";
import type { NicheConfig } from "../../config/niche";
import type { VoiceConfig } from "../../config/voice";
import { ANGLES, AUDIENCE_FRAMINGS, buildVariantPrompt, FORMATS, parseVariantResponse } from "./prompt";

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
  guidelines: [],
};

describe("buildVariantPrompt", () => {
  it("includes the niche, voice, offer, and every axis value", () => {
    const prompt = buildVariantPrompt({ niche, voice, offer: "Free trial", count: 30 });
    expect(prompt).toContain("A newsletter about testing.");
    expect(prompt).toContain("QA engineers");
    expect(prompt).toContain("Free trial");
    for (const angle of ANGLES) expect(prompt).toContain(angle);
    for (const format of FORMATS) expect(prompt).toContain(format);
    for (const framing of AUDIENCE_FRAMINGS) expect(prompt).toContain(framing);
  });

  it("includes existing hooks to avoid when provided", () => {
    const prompt = buildVariantPrompt({
      niche,
      voice,
      offer: "Free trial",
      count: 10,
      existingHooks: ["Stop wasting time on manual QA"],
    });
    expect(prompt).toContain("Stop wasting time on manual QA");
  });

  it("omits the existing-hooks section when none are given", () => {
    const prompt = buildVariantPrompt({ niche, voice, offer: "Free trial", count: 10 });
    expect(prompt).not.toContain("Do not repeat");
  });

  it("includes past kill reasons as priors when provided", () => {
    const prompt = buildVariantPrompt({
      niche,
      voice,
      offer: "Free trial",
      count: 10,
      pastFailures: [
        {
          hook: "A hook that flopped",
          angle: "curiosity",
          format: "static_image",
          audienceFraming: "beginner",
          killReason: "Spent $40 with zero signups",
        },
      ],
    });
    expect(prompt).toContain("A hook that flopped");
    expect(prompt).toContain("Spent $40 with zero signups");
    expect(prompt).toContain("were killed for underperforming");
  });

  it("omits the past-failures section when none are given", () => {
    const prompt = buildVariantPrompt({ niche, voice, offer: "Free trial", count: 10 });
    expect(prompt).not.toContain("killed for underperforming");
  });
});

describe("parseVariantResponse", () => {
  const validEntry = {
    angle: "curiosity",
    format: "static_image",
    audience_framing: "beginner",
    hook: "A hook",
    body: "A body",
    cta: "Subscribe",
    image_prompt: "A description",
  };

  it("parses a clean JSON array", () => {
    const variants = parseVariantResponse(JSON.stringify([validEntry]));
    expect(variants).toHaveLength(1);
    expect(variants[0]).toEqual({
      angle: "curiosity",
      format: "static_image",
      audienceFraming: "beginner",
      hook: "A hook",
      body: "A body",
      cta: "Subscribe",
      imagePrompt: "A description",
    });
  });

  it("maps a null image_prompt through", () => {
    const variants = parseVariantResponse(
      JSON.stringify([{ ...validEntry, format: "text_heavy", image_prompt: null }]),
    );
    expect(variants[0]?.imagePrompt).toBeNull();
  });

  it("tolerates surrounding prose or a code fence", () => {
    const variants = parseVariantResponse(
      `Here you go:\n\`\`\`json\n${JSON.stringify([validEntry])}\n\`\`\``,
    );
    expect(variants).toHaveLength(1);
  });

  it("throws on an invalid angle", () => {
    expect(() =>
      parseVariantResponse(JSON.stringify([{ ...validEntry, angle: "not-a-real-angle" }])),
    ).toThrow();
  });

  it("throws on malformed JSON", () => {
    expect(() => parseVariantResponse("not json")).toThrow();
  });
});
