CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "saved_images" ADD COLUMN "embedding" vector(768);