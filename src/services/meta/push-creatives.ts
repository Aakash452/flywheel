/**
 * Pushes an experiment's paused creatives to Meta as paused ads — this is
 * the mechanism behind the attribution join in
 * src/services/beehiiv/sync-subscribers.ts: every ad's landing link
 * carries `utm_content=<creative id>`, so a later Beehiiv subscription can
 * be traced back to the exact creative that acquired it.
 *
 * Pushing is not the same as spending. MetaClient.createAd() forces
 * status=PAUSED — every creative lands on Meta paused regardless of
 * anything here. A human activates separately (see activate-creative.ts),
 * which requires a verified approval.
 *
 * `creatives.platform_creative_id` stores the Ad's id, not the separate
 * ad-creative object's id Meta also returns — the Ad is the actionable
 * node (status updates, insights), so that's what activation and polling
 * need to reference going forward.
 */
import { eq } from "drizzle-orm";
import { metaConfig } from "../../config/meta";
import type { Database } from "../../db/client";
import { creatives } from "../../db/schema";
import type { CreateAdCreativeInput, CreateAdInput } from "../../integrations/meta/client";

/** The subset of MetaClient this service needs — kept narrow for testability. */
export interface AdPusher {
  createAdCreative(input: CreateAdCreativeInput): Promise<{ id: string }>;
  createAd(input: CreateAdInput): Promise<{ id: string }>;
}

export interface PushCreativesResult {
  pushed: number;
  skippedNoImage: number;
  skippedAlreadyPushed: number;
}

/** Appends utm_content=<creativeId> to the configured destination URL — the attribution join's other half. */
export function buildAttributedLink(destinationUrl: string, creativeId: string): string {
  const url = new URL(destinationUrl);
  url.searchParams.set("utm_content", creativeId);
  return url.toString();
}

export async function pushCreativesToMeta(
  db: Database,
  client: AdPusher,
  experimentId: string,
): Promise<PushCreativesResult> {
  const rows = await db
    .select()
    .from(creatives)
    .where(eq(creatives.experimentId, experimentId));

  const result: PushCreativesResult = { pushed: 0, skippedNoImage: 0, skippedAlreadyPushed: 0 };

  for (const creative of rows) {
    if (creative.platformCreativeId) {
      result.skippedAlreadyPushed++;
      continue;
    }
    // Meta's ad creative endpoints need a real image; imagePrompt is only
    // ever a description for one, not the asset itself — see the
    // deviation note on creatives.image_url in src/db/schema.ts.
    if (!creative.imageUrl) {
      result.skippedNoImage++;
      continue;
    }

    const link = buildAttributedLink(metaConfig.destinationUrl, creative.id);
    const adCreative = await client.createAdCreative({
      name: `${creative.angle}/${creative.format}/${creative.audienceFraming} — ${creative.id}`,
      pageId: metaConfig.pageId,
      message: creative.body,
      headline: creative.hook,
      link,
      callToActionType: "SIGN_UP",
      imageUrl: creative.imageUrl,
    });

    const ad = await client.createAd({
      name: `${creative.hook.slice(0, 60)} — ${creative.id}`,
      adSetId: metaConfig.defaultAdSetId,
      creativeId: adCreative.id,
    });

    await db
      .update(creatives)
      .set({ platformCreativeId: ad.id, updatedAt: new Date() })
      .where(eq(creatives.id, creative.id));
    result.pushed++;
  }

  return result;
}
