CREATE TABLE "user_facts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"key" varchar(100) NOT NULL,
	"value" text NOT NULL,
	"value_original" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_facts_user_id_key_unique" UNIQUE("user_id","key")
);
