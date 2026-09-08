/**
 * Flywheel — core Drizzle schema.
 *
 * Design notes (read before extending this file):
 *
 * 1. Money is always integer cents. Never floats. Every *_cents column is a
 *    plain `integer` (max ~$21.4M), which is orders of magnitude beyond what
 *    this business will move through the ledger. If that ever stops being
 *    true, migrate to bigint deliberately — don't silently widen it.
 *
 * 2. `ledger` and `subscriber_events` are the two tables the spec calls
 *    "append-only." That's enforced at the database level with triggers
 *    (see drizzle/0001_append_only_triggers.sql) that reject UPDATE and
 *    DELETE outright — not just a convention we hope services respect.
 *    Every other table is a normal mutable row store.
 *
 * 3. Computed fields called out in the spec (CPC, CPA, conversion rate,
 *    ledger balance, runway) are deliberately NOT stored as generated
 *    columns here. They're derived in src/lib/metrics.ts and
 *    src/lib/ledger-math.ts (pure, unit-tested functions) and assembled by
 *    query helpers in src/db/queries/*. Reasoning: these numbers drive real
 *    spending decisions, and a pure function you can unit test with fixture
 *    arrays is easier to get right and easier to audit than a generated
 *    column expression baked into a migration.
 *
 * 4. `approvals` is the structural human gate. Nothing in this schema lets
 *    a service mark an issue "sent," activate an ad, raise a budget, or
 *    contact a sponsor without a corresponding row here. The services that
 *    do those things must look up an approval before acting — see the
 *    "Human gates" section of the build spec. This table is intentionally
 *    polymorphic (targetTable/targetId) rather than four separate tables,
 *    because the gate logic is identical across all four action types.
 *
 * 5. Two columns were added to `creatives` beyond the literal list in the
 *    spec's "Data model" section: `format` and `audience_framing`. The
 *    Creative Engine section requires generating variants along three
 *    explicit axes (angle, format, audience framing) and enforcing coverage
 *    across that matrix — that's impossible to query for if two of the
 *    three axes aren't columns. `status` and `embedding` were added for the
 *    same reason: `status` backs the "all creatives are created paused"
 *    gate and the Reaper's kill action; `embedding` backs the >0.9 cosine
 *    similarity rejection rule. Flag these to the operator as assumptions,
 *    not spec text.
 *
 * 6. `issues.beehiiv_post_id` was added for the same class of reason:
 *    Beehiiv is only ever contacted at the moment a verified `approvals`
 *    row authorizes a send (see src/services/beehiiv-send.ts) — nothing is
 *    created in Beehiiv while an issue is still a local draft. This column
 *    is the id that call returns, and it's what the stats poller needs to
 *    pull opens/clicks back onto the row.
 *
 * 7. `sources.embedding` (`vector(1024)`) was added for the same reason as
 *    `creatives.embedding`: the sourcing pipeline's "semantic similarity
 *    against the last 30 days of sources" dedup rule needs an embedding to
 *    compare, and the spec names no embedding provider — see
 *    src/integrations/embeddings/voyage-client.ts.
 *
 * 8. `issues.recipients` was added because "select the last 5
 *    high-performing issues by open rate" (draft generator) needs a rate —
 *    `opens` alone is a raw count, incomparable across issues sent to a
 *    growing subscriber base. `issues.subject_line_candidates` was added
 *    because the draft generator scores 5 subject-line candidates and
 *    picks one; the other four are worth keeping for operator visibility,
 *    not discarding.
 *
 * 9. `experiments.target_cpa_cents` was added because the Reaper's kill
 *    rule — "spent more than 2x target CPA with zero conversions" — needs
 *    a target CPA to compare against, and it's a per-experiment call, not
 *    a niche-wide constant. Nullable: experiments where a CPA target
 *    doesn't apply just skip that kill check.
 *
 * 10. `creatives.kill_reason` was added because the spec says the Reaper's
 *     kill log "becomes training data for the creative engine's priors" —
 *     that requires the reason on the specific creative, not just its
 *     parent experiment. `creatives.image_url` was added because Meta's ad
 *     creative endpoints need a real rendered image, and this stack has no
 *     image-generation model (only the Anthropic SDK for text) —
 *     `image_prompt` is text describing what the image should be;
 *     `image_url` is where the actual asset lives once one exists, however
 *     it got made. Pushing a creative to Meta requires it to be set.
 */

import { relations, sql } from "drizzle-orm";
import {
  bigserial,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ledgerDirectionEnum = pgEnum("ledger_direction", [
  "debit",
  "credit",
]);

export const ledgerCategoryEnum = pgEnum("ledger_category", [
  "ad_spend",
  "api_cost",
  "tooling",
  "sponsorship_revenue",
  "affiliate_revenue",
]);

export const experimentTypeEnum = pgEnum("experiment_type", [
  "creative_test",
  "landing_page_test",
  "channel_test",
  "offer_test",
]);

export const experimentStatusEnum = pgEnum("experiment_status", [
  "active",
  "won",
  "killed",
]);

export const creativeAngleEnum = pgEnum("creative_angle", [
  "curiosity",
  "authority",
  "contrarian",
  "problem_agitation",
  "social_proof",
  "specificity",
]);

export const creativeFormatEnum = pgEnum("creative_format", [
  "static_image",
  "text_heavy",
  "meme",
  "screenshot",
  "chart",
]);

export const audienceFramingEnum = pgEnum("audience_framing", [
  "beginner",
  "practitioner",
  "manager",
]);

// Creation state, not performance state. "paused" is the only state Meta
// will accept creatives into — see Creative Engine spec: "Push to Meta via
// the Marketing API as paused ads. Human reviews and activates." "killed"
// is written exclusively by the Reaper.
export const creativeStatusEnum = pgEnum("creative_status", [
  "paused",
  "active",
  "killed",
]);

export const subscriberEventTypeEnum = pgEnum("subscriber_event_type", [
  "open",
  "click",
  "unsubscribe",
  "referral",
]);

export const issueStatusEnum = pgEnum("issue_status", [
  "draft",
  "approved",
  "sent",
]);

export const approvalActionTypeEnum = pgEnum("approval_action_type", [
  "send_issue",
  "activate_ad",
  "increase_budget",
  "sponsor_outreach",
]);

export const sponsorStatusEnum = pgEnum("sponsor_status", [
  "prospect",
  "active",
  "inactive",
]);

// ---------------------------------------------------------------------------
// ledger — append-only. The single source of truth for every financial
// claim the system makes. Balance is always SUM(credit) - SUM(debit); never
// a cached/materialized total. See src/db/queries/ledger.ts.
// ---------------------------------------------------------------------------

export const ledger = pgTable(
  "ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    direction: ledgerDirectionEnum("direction").notNull(),
    amountCents: integer("amount_cents").notNull(),
    category: ledgerCategoryEnum("category").notNull(),
    experimentId: uuid("experiment_id").references(() => experiments.id),
    metadata: jsonb("metadata").notNull().default({}),
    // Row insert time. Distinct from occurred_at, which is the business
    // event time and may be backdated (e.g. a Meta spend record synced
    // hours after the spend actually happened).
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ledger_occurred_at_idx").on(table.occurredAt),
    index("ledger_experiment_id_idx").on(table.experimentId),
    index("ledger_category_idx").on(table.category),
    check("ledger_amount_cents_positive", sql`${table.amountCents} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// experiments — every experiment gets a budget and a deadline at creation.
// Non-negotiable: both columns are NOT NULL with no default, so a service
// cannot create an experiment without supplying them.
// ---------------------------------------------------------------------------

export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hypothesis: text("hypothesis").notNull(),
    type: experimentTypeEnum("type").notNull(),
    budgetCents: integer("budget_cents").notNull(),
    spentCents: integer("spent_cents").notNull().default(0),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    status: experimentStatusEnum("status").notNull().default("active"),
    killReason: text("kill_reason"),
    // Not in the spec's literal column list. The Reaper's kill rule is
    // "spent more than 2x target CPA with zero conversions" — that rule is
    // meaningless without a target CPA to compare against, and it's a
    // per-experiment call (a landing-page test and a channel test don't
    // share one number), not a niche-wide constant. Nullable: experiment
    // types that aren't creative_test have no CPA target, and the Reaper
    // skips the CPA-based kill check (not the deadline check) when absent.
    targetCpaCents: integer("target_cpa_cents"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("experiments_status_idx").on(table.status),
    index("experiments_deadline_idx").on(table.deadline),
    check("experiments_budget_cents_positive", sql`${table.budgetCents} > 0`),
    check("experiments_spent_cents_nonnegative", sql`${table.spentCents} >= 0`),
    check(
      "experiments_target_cpa_cents_positive",
      sql`${table.targetCpaCents} IS NULL OR ${table.targetCpaCents} > 0`,
    ),
    check(
      "experiments_killed_has_reason",
      sql`${table.status} <> 'killed' OR ${table.killReason} IS NOT NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// creatives
// ---------------------------------------------------------------------------

export const creatives = pgTable(
  "creatives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id),
    angle: creativeAngleEnum("angle").notNull(),
    // Not in the spec's literal column list — see file header note (5).
    format: creativeFormatEnum("format").notNull(),
    audienceFraming: audienceFramingEnum("audience_framing").notNull(),
    hook: text("hook").notNull(),
    body: text("body").notNull(),
    cta: text("cta").notNull(),
    imagePrompt: text("image_prompt"),
    // Not in the spec's literal column list. The Creative Engine generates
    // imagePrompt as text describing what the image should be — there is
    // no image-generation model in this stack (only the Anthropic SDK for
    // text). imageUrl is where the actual rendered asset lives once one
    // exists (produced by a human or a future image pipeline, out of
    // scope here); pushing a creative to Meta requires it to be set, since
    // Meta's ad creative endpoints need a real image, not a prompt.
    imageUrl: text("image_url"),
    // Embedding of (angle + format + audience_framing + hook + body), used
    // by the Creative Engine's diversity gate to reject a new variant when
    // cosine similarity to any existing variant in the same experiment
    // exceeds 0.9. Dimension matches Voyage AI's voyage-3-large; swap if a
    // different embedding provider is chosen before the Creative Engine is
    // built. Nullable because embeddings are computed after generation.
    embedding: vector("embedding", { dimensions: 1024 }),
    status: creativeStatusEnum("status").notNull().default("paused"),
    // Not in the spec's literal column list, but the spec explicitly says
    // the Reaper's kill log "becomes training data for the creative
    // engine's priors" — that requires knowing *why* each specific
    // creative was killed, not just that its parent experiment was.
    killReason: text("kill_reason"),
    platformCreativeId: text("platform_creative_id"),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    signups: integer("signups").notNull().default(0),
    spendCents: integer("spend_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("creatives_experiment_id_idx").on(table.experimentId),
    index("creatives_status_idx").on(table.status),
    index("creatives_angle_format_audience_idx").on(
      table.angle,
      table.format,
      table.audienceFraming,
    ),
    uniqueIndex("creatives_platform_creative_id_idx").on(
      table.platformCreativeId,
    ),
    check("creatives_impressions_nonnegative", sql`${table.impressions} >= 0`),
    check("creatives_clicks_nonnegative", sql`${table.clicks} >= 0`),
    check("creatives_signups_nonnegative", sql`${table.signups} >= 0`),
    check("creatives_spend_cents_nonnegative", sql`${table.spendCents} >= 0`),
    check(
      "creatives_killed_has_reason",
      sql`${table.status} <> 'killed' OR ${table.killReason} IS NOT NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// landing_pages
// ---------------------------------------------------------------------------

export const landingPages = pgTable(
  "landing_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Not in the spec's literal column list. experiments.type includes
    // "landing_page_test," which is meaningless without a way to join a
    // landing page to the experiment testing it. Nullable: a landing page
    // can exist before any experiment references it.
    experimentId: uuid("experiment_id").references(() => experiments.id),
    slug: text("slug").notNull(),
    headline: text("headline").notNull(),
    subhead: text("subhead"),
    bullets: jsonb("bullets").notNull().default([]),
    visits: integer("visits").notNull().default(0),
    signups: integer("signups").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("landing_pages_slug_idx").on(table.slug),
    index("landing_pages_experiment_id_idx").on(table.experimentId),
    check("landing_pages_visits_nonnegative", sql`${table.visits} >= 0`),
    check("landing_pages_signups_nonnegative", sql`${table.signups} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// subscribers — subscriber.source_creative_id is the single most important
// join in the schema. Every cohort economics query depends on it.
// ---------------------------------------------------------------------------

export const subscribers = pgTable(
  "subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    beehiivId: text("beehiiv_id").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    // Nullable: organic, referral, and pre-Flywheel subscribers have no
    // acquiring creative. Attribution logic must treat NULL explicitly
    // rather than excluding the row.
    sourceCreativeId: uuid("source_creative_id").references(
      () => creatives.id,
    ),
    acquisitionCostCents: integer("acquisition_cost_cents")
      .notNull()
      .default(0),
    // Monday of the ISO week the subscriber was acquired, stored as a date
    // (not derived at query time) so cohort grouping is stable even if the
    // definition of "week" is ever revisited.
    cohortWeek: date("cohort_week").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("subscribers_beehiiv_id_idx").on(table.beehiivId),
    index("subscribers_source_creative_id_idx").on(table.sourceCreativeId),
    index("subscribers_cohort_week_idx").on(table.cohortWeek),
    check(
      "subscribers_acquisition_cost_cents_nonnegative",
      sql`${table.acquisitionCostCents} >= 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// subscriber_events — append-only.
// ---------------------------------------------------------------------------

export const subscriberEvents = pgTable(
  "subscriber_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    eventType: subscriberEventTypeEnum("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    issueId: uuid("issue_id").references(() => issues.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("subscriber_events_subscriber_id_occurred_at_idx").on(
      table.subscriberId,
      table.occurredAt,
    ),
    index("subscriber_events_event_type_idx").on(table.eventType),
    index("subscriber_events_issue_id_idx").on(table.issueId),
  ],
);

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectLine: text("subject_line").notNull(),
    bodyMd: text("body_md").notNull(),
    status: issueStatusEnum("status").notNull().default("draft"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // Not in the spec's literal column list. Beehiiv is only ever contacted
    // at the moment a verified approval sends an issue (see
    // src/services/beehiiv-send.ts) — this is the id of the post that call
    // created, and it's what the stats poller uses to pull opens/clicks
    // back. Without it, "poll performance" for issues has nothing to poll.
    beehiivPostId: text("beehiiv_post_id"),
    opens: integer("opens").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    // Not in the spec's literal column list. The draft generator's "select
    // the last 5 high-performing issues by open rate" requirement needs a
    // rate — opens alone is a raw count, not comparable across issues sent
    // to different-sized audiences. Populated from Beehiiv's own
    // stats.email.recipients (falling back to .delivered) by the stats
    // poller. openRate() in src/lib/metrics.ts computes opens/recipients.
    recipients: integer("recipients").notNull().default(0),
    // Not in the spec's literal column list. The draft generator scores 5
    // subject-line candidates against historical open rates and picks one
    // as `subject_line` — this is the full scored list, kept for operator
    // visibility in the approval queue (why THIS subject line, what else
    // was considered) and so a future dashboard could let a human pick a
    // different candidate instead of regenerating. Null for issues created
    // before the draft generator existed, or written by hand.
    subjectLineCandidates: jsonb("subject_line_candidates").$type<
      Array<{ subjectLine: string; score: number; reasoning: string }>
    >(),
    sponsorId: uuid("sponsor_id").references(() => sponsors.id),
    sponsorRevenueCents: integer("sponsor_revenue_cents")
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("issues_status_idx").on(table.status),
    index("issues_sponsor_id_idx").on(table.sponsorId),
    uniqueIndex("issues_beehiiv_post_id_idx").on(table.beehiivPostId),
    check("issues_opens_nonnegative", sql`${table.opens} >= 0`),
    check("issues_clicks_nonnegative", sql`${table.clicks} >= 0`),
    check("issues_recipients_nonnegative", sql`${table.recipients} >= 0`),
    check(
      "issues_sponsor_revenue_cents_nonnegative",
      sql`${table.sponsorRevenueCents} >= 0`,
    ),
    // Structural half of the send gate: a row can only reach status='sent'
    // with sent_at populated. The other half — that status only *becomes*
    // 'sent' via a service call that has already checked `approvals` — is
    // enforced in application code (src/services/*), because Postgres has
    // no way to see into the approvals table's semantics from a CHECK
    // constraint on this row alone.
    check(
      "issues_sent_has_sent_at",
      sql`${table.status} <> 'sent' OR ${table.sentAt} IS NOT NULL`,
    ),
    check(
      "issues_sent_has_beehiiv_post_id",
      sql`${table.status} <> 'sent' OR ${table.beehiivPostId} IS NOT NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    url: text("url").notNull(),
    title: text("title"),
    rawContent: text("raw_content"),
    // 0–100. The sourcing pipeline only ever inserts a row after scoring
    // succeeds and clears the niche threshold (see
    // src/services/sourcing/index.ts) — nullable here defensively (e.g. a
    // future manual backfill), not because unscored rows are expected in
    // normal operation.
    relevanceScore: numeric("relevance_score", { precision: 5, scale: 2 }),
    // Not in the spec's literal column list — backs the "semantic
    // similarity against the last 30 days of sources" dedup rule, the same
    // way creatives.embedding backs the Creative Engine's diversity gate.
    // Nullable: populated only when an embedding provider is configured
    // (see src/integrations/embeddings/voyage-client.ts); dedup falls back
    // to URL-only matching without one.
    embedding: vector("embedding", { dimensions: 1024 }),
    usedInIssueId: uuid("used_in_issue_id").references(() => issues.id),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sources_url_idx").on(table.url),
    index("sources_discovered_at_idx").on(table.discoveredAt),
    index("sources_relevance_score_idx").on(table.relevanceScore),
    check(
      "sources_relevance_score_range",
      sql`${table.relevanceScore} IS NULL OR (${table.relevanceScore} >= 0 AND ${table.relevanceScore} <= 100)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// sponsors — minimal. Beehiiv owns the sponsorship marketplace; this table
// only exists so issues.sponsor_id and the sponsor_outreach approval gate
// have somewhere to point.
// ---------------------------------------------------------------------------

export const sponsors = pgTable("sponsors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  contactEmail: text("contact_email"),
  status: sponsorStatusEnum("status").notNull().default("prospect"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// approvals — the structural human gate. See file header note (4).
//
// targetTable/targetId is intentionally polymorphic rather than four FK
// columns: an approval always names exactly one of {issues, creatives,
// experiments (budget increase), sponsors} by table name + id. Postgres
// can't express a conditional multi-table FK, so referential integrity for
// targetId is enforced in application code (src/services/approvals.ts),
// not the database. Every write path that performs a gated action must
// look up a matching row here *before* acting — see build spec "Human
// gates."
// ---------------------------------------------------------------------------

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Monotonic tiebreaker for "most recent approval" queries. Postgres's
    // now()/defaultNow() is frozen at transaction start, not statement
    // execution — two approvals recorded in the same transaction get an
    // identical approved_at, which makes ORDER BY approved_at DESC
    // ambiguous. A bigserial has no such tie, ever. approved_at stays as
    // meaningful data (when the operator clicked approve); this column
    // exists purely to order rows correctly.
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    actionType: approvalActionTypeEnum("action_type").notNull(),
    targetTable: text("target_table").notNull(),
    targetId: uuid("target_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Operator identity (e.g. their email). Required — an approval with no
    // named human behind it is not an approval.
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("approvals_target_idx").on(table.targetTable, table.targetId),
    index("approvals_action_type_idx").on(table.actionType),
    index("approvals_sequence_idx").on(table.sequence),
  ],
);

// ---------------------------------------------------------------------------
// Relations (query-builder ergonomics only — no schema effect)
// ---------------------------------------------------------------------------

export const experimentsRelations = relations(experiments, ({ many }) => ({
  creatives: many(creatives),
  landingPages: many(landingPages),
  ledgerEntries: many(ledger),
}));

export const creativesRelations = relations(creatives, ({ one, many }) => ({
  experiment: one(experiments, {
    fields: [creatives.experimentId],
    references: [experiments.id],
  }),
  subscribers: many(subscribers),
}));

export const landingPagesRelations = relations(landingPages, ({ one }) => ({
  experiment: one(experiments, {
    fields: [landingPages.experimentId],
    references: [experiments.id],
  }),
}));

export const subscribersRelations = relations(
  subscribers,
  ({ one, many }) => ({
    sourceCreative: one(creatives, {
      fields: [subscribers.sourceCreativeId],
      references: [creatives.id],
    }),
    events: many(subscriberEvents),
  }),
);

export const subscriberEventsRelations = relations(
  subscriberEvents,
  ({ one }) => ({
    subscriber: one(subscribers, {
      fields: [subscriberEvents.subscriberId],
      references: [subscribers.id],
    }),
    issue: one(issues, {
      fields: [subscriberEvents.issueId],
      references: [issues.id],
    }),
  }),
);

export const issuesRelations = relations(issues, ({ one, many }) => ({
  sponsor: one(sponsors, {
    fields: [issues.sponsorId],
    references: [sponsors.id],
  }),
  events: many(subscriberEvents),
  sourcesUsed: many(sources),
}));

export const sourcesRelations = relations(sources, ({ one }) => ({
  usedInIssue: one(issues, {
    fields: [sources.usedInIssueId],
    references: [issues.id],
  }),
}));

export const sponsorsRelations = relations(sponsors, ({ many }) => ({
  issues: many(issues),
}));

export const ledgerRelations = relations(ledger, ({ one }) => ({
  experiment: one(experiments, {
    fields: [ledger.experimentId],
    references: [experiments.id],
  }),
}));

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Ledger = typeof ledger.$inferSelect;
export type NewLedger = typeof ledger.$inferInsert;
export type LedgerCategory = (typeof ledgerCategoryEnum.enumValues)[number];

export type Experiment = typeof experiments.$inferSelect;
export type NewExperiment = typeof experiments.$inferInsert;

export type Creative = typeof creatives.$inferSelect;
export type NewCreative = typeof creatives.$inferInsert;

export type LandingPage = typeof landingPages.$inferSelect;
export type NewLandingPage = typeof landingPages.$inferInsert;

export type Subscriber = typeof subscribers.$inferSelect;
export type NewSubscriber = typeof subscribers.$inferInsert;

export type SubscriberEvent = typeof subscriberEvents.$inferSelect;
export type NewSubscriberEvent = typeof subscriberEvents.$inferInsert;

export type Issue = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;

export type Sponsor = typeof sponsors.$inferSelect;
export type NewSponsor = typeof sponsors.$inferInsert;

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
