CREATE TABLE "danbooru_ingest_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_post_id" bigint DEFAULT 0 NOT NULL,
	"storage_chat_id" bigint,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "danbooru_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"danbooru_id" bigint NOT NULL,
	"saved_image_id" integer,
	"rating" varchar(1) NOT NULL,
	"file_ext" varchar(10) NOT NULL,
	"file_size" integer,
	"md5" varchar(32),
	"source_url" text,
	"tag_string" text DEFAULT '' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"danbooru_created_at" timestamp,
	CONSTRAINT "danbooru_posts_danbooru_id_unique" UNIQUE("danbooru_id")
);
