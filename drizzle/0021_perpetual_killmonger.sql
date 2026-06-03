ALTER TABLE "danbooru_posts" ALTER COLUMN "general_tags" SET DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "danbooru_posts" ALTER COLUMN "character_tags" SET DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "danbooru_posts" ALTER COLUMN "copyright_tags" SET DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "danbooru_posts" ALTER COLUMN "artist_tags" SET DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "danbooru_ingest_state" ADD COLUMN "storage_thread_id" bigint DEFAULT 0 NOT NULL;