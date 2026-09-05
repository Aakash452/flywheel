ALTER TABLE "approvals" ADD COLUMN "sequence" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "approvals_sequence_idx" ON "approvals" USING btree ("sequence");