import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  isDatabaseAvailable,
  withRollback,
} from "../../db/testing";
import { creatives, experiments } from "../../db/schema";
import type { AdPusher } from "./push-creatives";
import { buildAttributedLink, pushCreativesToMeta } from "./push-creatives";

const dbAvailable = await isDatabaseAvailable();

function fakeAdPusher(): AdPusher & { creativeCalls: unknown[]; adCalls: unknown[] } {
  const creativeCalls: unknown[] = [];
  const adCalls: unknown[] = [];
  let n = 0;
  return {
    creativeCalls,
    adCalls,
    async createAdCreative(input) {
      creativeCalls.push(input);
      n++;
      return { id: `adcreative_${n}` };
    },
    async createAd(input) {
      adCalls.push(input);
      return { id: `ad_${n}` };
    },
  };
}

describe.skipIf(!dbAvailable)("pushCreativesToMeta (requires DATABASE_URL)", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("pushes creatives that have an image, storing the Ad's id", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({ hypothesis: "h", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 86_400_000) })
        .returning();
      if (!experiment) throw new Error("insert failed");

      const [creative] = await db
        .insert(creatives)
        .values({
          experimentId: experiment.id,
          angle: "curiosity",
          format: "static_image",
          audienceFraming: "beginner",
          hook: "hook",
          body: "body",
          cta: "cta",
          imageUrl: "https://example.com/img.png",
        })
        .returning();
      if (!creative) throw new Error("insert failed");

      const pusher = fakeAdPusher();
      const result = await pushCreativesToMeta(db, pusher, experiment.id);

      expect(result).toEqual({ pushed: 1, skippedNoImage: 0, skippedAlreadyPushed: 0 });
      expect(pusher.creativeCalls).toHaveLength(1);
      expect(pusher.adCalls).toHaveLength(1);

      const [row] = await db.select().from(creatives);
      expect(row?.platformCreativeId).toBe("ad_1");
    });
  });

  it("skips creatives with no image", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({ hypothesis: "h", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 86_400_000) })
        .returning();
      if (!experiment) throw new Error("insert failed");

      await db.insert(creatives).values({
        experimentId: experiment.id,
        angle: "curiosity",
        format: "text_heavy",
        audienceFraming: "beginner",
        hook: "hook",
        body: "body",
        cta: "cta",
      });

      const pusher = fakeAdPusher();
      const result = await pushCreativesToMeta(db, pusher, experiment.id);

      expect(result).toEqual({ pushed: 0, skippedNoImage: 1, skippedAlreadyPushed: 0 });
      expect(pusher.creativeCalls).toHaveLength(0);
    });
  });

  it("skips creatives already pushed", async () => {
    await withRollback(async (db) => {
      const [experiment] = await db
        .insert(experiments)
        .values({ hypothesis: "h", type: "creative_test", budgetCents: 100_000, deadline: new Date(Date.now() + 86_400_000) })
        .returning();
      if (!experiment) throw new Error("insert failed");

      await db.insert(creatives).values({
        experimentId: experiment.id,
        angle: "curiosity",
        format: "static_image",
        audienceFraming: "beginner",
        hook: "hook",
        body: "body",
        cta: "cta",
        imageUrl: "https://example.com/img.png",
        platformCreativeId: "ad_already",
      });

      const pusher = fakeAdPusher();
      const result = await pushCreativesToMeta(db, pusher, experiment.id);
      expect(result).toEqual({ pushed: 0, skippedNoImage: 0, skippedAlreadyPushed: 1 });
    });
  });
});

describe("buildAttributedLink", () => {
  it("appends utm_content with the creative id", () => {
    expect(buildAttributedLink("https://example.com/subscribe", "abc-123")).toBe(
      "https://example.com/subscribe?utm_content=abc-123",
    );
  });

  it("preserves existing query params", () => {
    expect(buildAttributedLink("https://example.com/subscribe?ref=ad", "abc-123")).toBe(
      "https://example.com/subscribe?ref=ad&utm_content=abc-123",
    );
  });
});

describe.skipIf(dbAvailable)(
  "pushCreativesToMeta (skipped: no DATABASE_URL reachable)",
  () => {
    it("skips — set DATABASE_URL and run docker compose up to exercise this suite", () => {
      expect(true).toBe(true);
    });
  },
);
