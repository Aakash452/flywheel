/**
 * Activating a creative. Mirrors src/services/beehiiv/send-issue.ts's gate
 * pattern exactly: this is the only call site for
 * MetaClient.updateAdStatus(..., "ACTIVE") in the codebase, and it
 * independently re-verifies the `approvals` table before calling — not
 * just trusting the creative's own status column.
 *
 * A killed creative can never be reactivated through here — per the build
 * spec, "The Reaper has no override path. If a human wants to save
 * something, they create a new experiment."
 */
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { creatives, type Creative } from "../../db/schema";
import type { MetaAdStatus } from "../../integrations/meta/types";
import { requireApproval } from "../approvals";

/** The subset of MetaClient this service needs — kept narrow for testability. */
export interface AdActivator {
  updateAdStatus(adId: string, status: MetaAdStatus): Promise<void>;
}

export class CreativeNotFoundError extends Error {
  constructor(creativeId: string) {
    super(`Creative ${creativeId} not found`);
    this.name = "CreativeNotFoundError";
  }
}

export class CreativeNotPushedError extends Error {
  constructor(creativeId: string) {
    super(
      `Creative ${creativeId} has not been pushed to Meta yet (no platform_creative_id) — nothing to activate.`,
    );
    this.name = "CreativeNotPushedError";
  }
}

export class CreativeAlreadyActiveError extends Error {
  constructor(creativeId: string) {
    super(`Creative ${creativeId} is already active.`);
    this.name = "CreativeAlreadyActiveError";
  }
}

export class CreativeKilledError extends Error {
  constructor(creativeId: string) {
    super(
      `Creative ${creativeId} was killed by the Reaper and cannot be reactivated. ` +
        "There is no override path — create a new experiment instead.",
    );
    this.name = "CreativeKilledError";
  }
}

export async function activateCreative(
  db: Database,
  client: AdActivator,
  creativeId: string,
): Promise<Creative> {
  const [creative] = await db
    .select()
    .from(creatives)
    .where(eq(creatives.id, creativeId))
    .limit(1);
  if (!creative) throw new CreativeNotFoundError(creativeId);

  if (creative.status === "killed") throw new CreativeKilledError(creativeId);
  if (creative.status === "active") throw new CreativeAlreadyActiveError(creativeId);
  if (!creative.platformCreativeId) throw new CreativeNotPushedError(creativeId);

  // The structural gate: throws ApprovalRequiredError if no matching row
  // exists. There is no code path from here to client.updateAdStatus()
  // that skips this call.
  await requireApproval(db, "activate_ad", "creatives", creativeId);

  await client.updateAdStatus(creative.platformCreativeId, "ACTIVE");

  const [updated] = await db
    .update(creatives)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(creatives.id, creativeId))
    .returning();

  if (!updated) {
    // Meta has already activated the ad at this point — real spend can
    // now accrue. Surface loudly rather than retry silently.
    throw new Error(
      `Meta accepted the activation for creative ${creativeId} but the local UPDATE failed. ` +
        "The ad is live — reconcile creatives.status manually.",
    );
  }
  return updated;
}
