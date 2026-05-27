CREATE TABLE "saved_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_id" varchar(255) NOT NULL,
	"sender_user_id" bigint NOT NULL,
	"description" text NOT NULL,
	"caption" text,
	"mood_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"content_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
