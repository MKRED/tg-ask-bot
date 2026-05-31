CREATE TABLE "group_chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"title" varchar(255),
	"type" varchar(20) NOT NULL,
	"topics_enabled" boolean DEFAULT false NOT NULL,
	"nsfw_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "group_chats_chat_id_unique" UNIQUE("chat_id")
);
--> statement-breakpoint
CREATE TABLE "group_enabled_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"thread_id" bigint DEFAULT 0 NOT NULL,
	"enabled_by" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "group_enabled_threads_chat_id_thread_id_unique" UNIQUE("chat_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "group_message_buffer" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"thread_id" bigint DEFAULT 0 NOT NULL,
	"sender_user_id" bigint,
	"sender_name" varchar(255) NOT NULL,
	"sender_username" varchar(255),
	"content" text NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"is_forward" boolean DEFAULT false NOT NULL,
	"forward_from" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "group_message_buffer_chat_thread_created_idx" ON "group_message_buffer" ("chat_id","thread_id","created_at");
