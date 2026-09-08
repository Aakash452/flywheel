/**
 * The Reaper's kill log as Creative Engine training data — spec text:
 * "this log becomes training data for the creative engine's priors."
 * There's no ML model here; "prior" means what it does for the drafting
 * generator's subject-line scoring (see src/services/drafting/prompt.ts):
 * real past outcomes handed to Claude as context it reasons from, not a
 * fitted statistical model.
 */
import { desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { creatives } from "../../db/schema";
import type { KillPrior } from "./prompt";

export type { KillPrior };

/** The most recently killed creatives, across all experiments — what NOT to repeat. */
export async function getRecentKillPriors(db: Database, limit = 10): Promise<KillPrior[]> {
  const rows = await db
    .select({
      hook: creatives.hook,
      angle: creatives.angle,
      format: creatives.format,
      audienceFraming: creatives.audienceFraming,
      killReason: creatives.killReason,
    })
    .from(creatives)
    .where(eq(creatives.status, "killed"))
    .orderBy(desc(creatives.updatedAt))
    .limit(limit);

  return rows
    .filter((r) => r.killReason !== null)
    .map((r) => ({ ...r, killReason: r.killReason as string }));
}
