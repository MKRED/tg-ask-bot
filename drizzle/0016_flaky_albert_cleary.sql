ALTER TABLE "group_ingest_images" ADD COLUMN "route" text DEFAULT 'gemini' NOT NULL;--> statement-breakpoint
ALTER TABLE "group_ingest_images" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "group_ingest_images" ADD COLUMN "next_attempt_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "group_ingest_images" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "group_ingest_images" ADD COLUMN "processed_at" timestamp;--> statement-breakpoint
ALTER TABLE "group_ingest_images" ADD COLUMN "processing_ms" integer;--> statement-breakpoint
ALTER TABLE "group_ingest_images" ADD COLUMN "reported_at" timestamp;--> statement-breakpoint
CREATE INDEX "ingest_queue_idx" ON "group_ingest_images" USING btree ("analyzed_by","route","next_attempt_at");