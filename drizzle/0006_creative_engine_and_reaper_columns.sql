ALTER TABLE "creatives" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "kill_reason" text;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "target_cpa_cents" integer;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_killed_has_reason" CHECK ("creatives"."status" <> 'killed' OR "creatives"."kill_reason" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_target_cpa_cents_positive" CHECK ("experiments"."target_cpa_cents" IS NULL OR "experiments"."target_cpa_cents" > 0);