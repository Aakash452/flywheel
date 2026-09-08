/**
 * Meta Marketing API settings that are genuinely business-specific and
 * can't be inferred — same category as niche.ts/voice.ts. Every creative
 * pushed to Meta needs a home (a campaign + ad set) and a landing
 * destination; both are operator decisions, not something the Creative
 * Engine can decide on its own.
 */
export interface MetaConfig {
  /** The Facebook Page ID ads are posted as. Required by Meta's ad creative object_story_spec. */
  pageId: string;
  /**
   * An existing ad set ID every generated ad is created under. This system
   * does not create campaigns/ad sets (targeting, bid strategy, and
   * placement are business decisions with real budget consequences) — set
   * one up in Ads Manager per experiment and put its ID here, or extend
   * push-creatives.ts to accept a per-experiment override.
   */
  defaultAdSetId: string;
  /** Where an ad's link points — typically the newsletter's subscribe/landing page. */
  destinationUrl: string;
  /**
   * Which Meta insights `actions[].action_type` value(s) count as a
   * "signup" for creatives.signups. Depends entirely on how this ad
   * account's pixel/Conversions API events are configured — there is no
   * universal default. Common values: "lead",
   * "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped".
   */
  signupActionTypes: string[];
}

export const metaConfig: MetaConfig = {
  pageId: "REPLACE_ME",
  defaultAdSetId: "REPLACE_ME",
  destinationUrl: "https://REPLACE_ME.example.com",
  signupActionTypes: ["REPLACE_ME_lead_action_type"],
};
