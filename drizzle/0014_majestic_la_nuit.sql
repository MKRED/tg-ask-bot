CREATE TABLE "group_ingest_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"thread_id" integer DEFAULT 0 NOT NULL,
	"file_id" text,
	"analyzed_by" text NOT NULL,
	"mood_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"content_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_nsfw" boolean DEFAULT false NOT NULL,
	"saved_at" timestamp DEFAULT now() NOT NULL
);
