import { eq } from "drizzle-orm";
import { db } from "./index.js";
import { searchEmbeddings } from "./schema.js";
import logger from "../logger.js";

// Кэш эмбеддингов поисковых запросов inline-режима. Ключ — нормализованная фраза
// (trim + lowercase + схлопнутые пробелы), её формирует вызывающий код. Вектор кладём
// и читаем по одному и тому же нормализованному тексту, чтобы регистр/пробелы делили вектор.

export async function getCachedEmbedding(queryText: string): Promise<number[] | null> {
  const t0 = Date.now();
  const [row] = await db
    .select({ embedding: searchEmbeddings.embedding })
    .from(searchEmbeddings)
    .where(eq(searchEmbeddings.queryText, queryText))
    .limit(1);
  const hit = row?.embedding ?? null;
  logger.debug({ durationMs: Date.now() - t0, hit: hit !== null, queryText }, "Search embedding cache lookup");
  return hit;
}

export async function cacheEmbedding(queryText: string, embedding: number[], createdBy: number): Promise<void> {
  const t0 = Date.now();
  // Гонка двух одновременных запросов одной фразы безопасна — onConflictDoNothing.
  await db
    .insert(searchEmbeddings)
    .values({ queryText, embedding, createdBy })
    .onConflictDoNothing({ target: searchEmbeddings.queryText });
  logger.debug({ durationMs: Date.now() - t0, queryText, createdBy }, "Search embedding cached");
}
