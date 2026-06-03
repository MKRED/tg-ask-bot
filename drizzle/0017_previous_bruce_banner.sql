CREATE TABLE "search_embeddings" (
	"id" serial PRIMARY KEY NOT NULL,
	"query_text" varchar(255) NOT NULL,
	"embedding" vector(3072) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "search_embeddings_query_text_unique" UNIQUE("query_text")
);
