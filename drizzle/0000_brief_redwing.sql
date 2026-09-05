CREATE TYPE "public"."approval_action_type" AS ENUM('send_issue', 'activate_ad', 'increase_budget', 'sponsor_outreach');--> statement-breakpoint
CREATE TYPE "public"."audience_framing" AS ENUM('beginner', 'practitioner', 'manager');--> statement-breakpoint
CREATE TYPE "public"."creative_angle" AS ENUM('curiosity', 'authority', 'contrarian', 'problem_agitation', 'social_proof', 'specificity');--> statement-breakpoint
CREATE TYPE "public"."creative_format" AS ENUM('static_image', 'text_heavy', 'meme', 'screenshot', 'chart');--> statement-breakpoint
CREATE TYPE "public"."creative_status" AS ENUM('paused', 'active', 'killed');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('active', 'won', 'killed');--> statement-breakpoint
CREATE TYPE "public"."experiment_type" AS ENUM('creative_test', 'landing_page_test', 'channel_test', 'offer_test');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('draft', 'approved', 'sent');--> statement-breakpoint
CREATE TYPE "public"."ledger_category" AS ENUM('ad_spend', 'api_cost', 'tooling', 'sponsorship_revenue', 'affiliate_revenue');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."sponsor_status" AS ENUM('prospect', 'active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."subscriber_event_type" AS ENUM('open', 'click', 'unsubscribe', 'referral');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_type" "approval_action_type" NOT NULL,
	"target_table" text NOT NULL,
	"target_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"angle" "creative_angle" NOT NULL,
	"format" "creative_format" NOT NULL,
	"audience_framing" "audience_framing" NOT NULL,
	"hook" text NOT NULL,
	"body" text NOT NULL,
	"cta" text NOT NULL,
	"image_prompt" text,
	"embedding" vector(1024),
	"status" "creative_status" DEFAULT 'paused' NOT NULL,
	"platform_creative_id" text,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"signups" integer DEFAULT 0 NOT NULL,
	"spend_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creatives_impressions_nonnegative" CHECK ("creatives"."impressions" >= 0),
	CONSTRAINT "creatives_clicks_nonnegative" CHECK ("creatives"."clicks" >= 0),
	CONSTRAINT "creatives_signups_nonnegative" CHECK ("creatives"."signups" >= 0),
	CONSTRAINT "creatives_spend_cents_nonnegative" CHECK ("creatives"."spend_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hypothesis" text NOT NULL,
	"type" "experiment_type" NOT NULL,
	"budget_cents" integer NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"status" "experiment_status" DEFAULT 'active' NOT NULL,
	"kill_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiments_budget_cents_positive" CHECK ("experiments"."budget_cents" > 0),
	CONSTRAINT "experiments_spent_cents_nonnegative" CHECK ("experiments"."spent_cents" >= 0),
	CONSTRAINT "experiments_killed_has_reason" CHECK ("experiments"."status" <> 'killed' OR "experiments"."kill_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_line" text NOT NULL,
	"body_md" text NOT NULL,
	"status" "issue_status" DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"opens" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"sponsor_id" uuid,
	"sponsor_revenue_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issues_opens_nonnegative" CHECK ("issues"."opens" >= 0),
	CONSTRAINT "issues_clicks_nonnegative" CHECK ("issues"."clicks" >= 0),
	CONSTRAINT "issues_sponsor_revenue_cents_nonnegative" CHECK ("issues"."sponsor_revenue_cents" >= 0),
	CONSTRAINT "issues_sent_has_sent_at" CHECK ("issues"."status" <> 'sent' OR "issues"."sent_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "landing_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid,
	"slug" text NOT NULL,
	"headline" text NOT NULL,
	"subhead" text,
	"bullets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visits" integer DEFAULT 0 NOT NULL,
	"signups" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_pages_visits_nonnegative" CHECK ("landing_pages"."visits" >= 0),
	CONSTRAINT "landing_pages_signups_nonnegative" CHECK ("landing_pages"."signups" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"amount_cents" integer NOT NULL,
	"category" "ledger_category" NOT NULL,
	"experiment_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_amount_cents_positive" CHECK ("ledger"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"raw_content" text,
	"relevance_score" numeric(5, 2),
	"used_in_issue_id" uuid,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_relevance_score_range" CHECK ("sources"."relevance_score" IS NULL OR ("sources"."relevance_score" >= 0 AND "sources"."relevance_score" <= 100))
);
--> statement-breakpoint
CREATE TABLE "sponsors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_email" text,
	"status" "sponsor_status" DEFAULT 'prospect' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriber_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"event_type" "subscriber_event_type" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"beehiiv_id" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"source_creative_id" uuid,
	"acquisition_cost_cents" integer DEFAULT 0 NOT NULL,
	"cohort_week" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscribers_acquisition_cost_cents_nonnegative" CHECK ("subscribers"."acquisition_cost_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_used_in_issue_id_issues_id_fk" FOREIGN KEY ("used_in_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_events" ADD CONSTRAINT "subscriber_events_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_events" ADD CONSTRAINT "subscriber_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_source_creative_id_creatives_id_fk" FOREIGN KEY ("source_creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_target_idx" ON "approvals" USING btree ("target_table","target_id");--> statement-breakpoint
CREATE INDEX "approvals_action_type_idx" ON "approvals" USING btree ("action_type");--> statement-breakpoint
CREATE INDEX "creatives_experiment_id_idx" ON "creatives" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "creatives_status_idx" ON "creatives" USING btree ("status");--> statement-breakpoint
CREATE INDEX "creatives_angle_format_audience_idx" ON "creatives" USING btree ("angle","format","audience_framing");--> statement-breakpoint
CREATE UNIQUE INDEX "creatives_platform_creative_id_idx" ON "creatives" USING btree ("platform_creative_id");--> statement-breakpoint
CREATE INDEX "experiments_status_idx" ON "experiments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "experiments_deadline_idx" ON "experiments" USING btree ("deadline");--> statement-breakpoint
CREATE INDEX "issues_status_idx" ON "issues" USING btree ("status");--> statement-breakpoint
CREATE INDEX "issues_sponsor_id_idx" ON "issues" USING btree ("sponsor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "landing_pages_slug_idx" ON "landing_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "landing_pages_experiment_id_idx" ON "landing_pages" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "ledger_occurred_at_idx" ON "ledger" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "ledger_experiment_id_idx" ON "ledger" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "ledger_category_idx" ON "ledger" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_url_idx" ON "sources" USING btree ("url");--> statement-breakpoint
CREATE INDEX "sources_discovered_at_idx" ON "sources" USING btree ("discovered_at");--> statement-breakpoint
CREATE INDEX "sources_relevance_score_idx" ON "sources" USING btree ("relevance_score");--> statement-breakpoint
CREATE INDEX "subscriber_events_subscriber_id_occurred_at_idx" ON "subscriber_events" USING btree ("subscriber_id","occurred_at");--> statement-breakpoint
CREATE INDEX "subscriber_events_event_type_idx" ON "subscriber_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "subscriber_events_issue_id_idx" ON "subscriber_events" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_beehiiv_id_idx" ON "subscribers" USING btree ("beehiiv_id");--> statement-breakpoint
CREATE INDEX "subscribers_source_creative_id_idx" ON "subscribers" USING btree ("source_creative_id");--> statement-breakpoint
CREATE INDEX "subscribers_cohort_week_idx" ON "subscribers" USING btree ("cohort_week");