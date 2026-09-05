ALTER TABLE "issues" ADD COLUMN "recipients" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "subject_line_candidates" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_recipients_nonnegative" CHECK ("issues"."recipients" >= 0);