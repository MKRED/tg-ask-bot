--> search_embeddings — регенерируемый кэш, очищаем перед добавлением NOT NULL-столбца без дефолта
TRUNCATE TABLE "search_embeddings";--> statement-breakpoint
ALTER TABLE "search_embeddings" ADD COLUMN "created_by" bigint NOT NULL;