ALTER TABLE "issues" ADD COLUMN "beehiiv_post_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_beehiiv_post_id_idx" ON "issues" USING btree ("beehiiv_post_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_sent_has_beehiiv_post_id" CHECK ("issues"."status" <> 'sent' OR "issues"."beehiiv_post_id" IS NOT NULL);