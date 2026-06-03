-- danbooru_posts: заменяем tag_string (plain text) на массивы по категориям тегов
-- (аналогично content_tags / mood_tags в saved_images)
ALTER TABLE "danbooru_posts" DROP COLUMN "tag_string";--> statement-breakpoint
ALTER TABLE "danbooru_posts" ADD COLUMN "general_tags" text[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "danbooru_posts" ADD COLUMN "character_tags" text[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "danbooru_posts" ADD COLUMN "copyright_tags" text[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "danbooru_posts" ADD COLUMN "artist_tags" text[] NOT NULL DEFAULT '{}';