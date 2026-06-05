import { and, count, eq, sql } from "drizzle-orm";
import { db } from "./index.js";
import { savedImages } from "./schema.js";
import type { NewSavedImage, SavedImage } from "./schema.js";
import logger from "../logger.js";

export async function countUserImages(userId: number): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(savedImages)
    .where(eq(savedImages.senderUserId, userId));
  return row?.count ?? 0;
}

// Возвращает ID новой строки — нужен Danbooru-воркеру для маппинга danbooru_posts.saved_image_id.
// Существующие вызывающие места игнорируют возвращаемое значение (void-семантика сохранена).
export async function saveImage(data: NewSavedImage): Promise<number> {
  const [row] = await db.insert(savedImages).values(data).returning({ id: savedImages.id });
  return row.id;
}

export async function findSimilarImages(
  embedding: number[],
  nsfwEnabled: boolean,
  limit = 1,
  offset = 0,
): Promise<SavedImage[]> {
  const t0 = Date.now();
  const vec = `[${embedding.join(",")}]`;
  const where = nsfwEnabled
    ? sql`embedding IS NOT NULL`
    : and(sql`embedding IS NOT NULL`, eq(savedImages.isNsfw, false));
  const rows = await db
    .select()
    .from(savedImages)
    .where(where)
    // Тайбрейкер по id обязателен: косинусное расстояние не даёт тотального порядка
    // (близкие/равные дистанции могут переставляться между запросами), а при OFFSET-пагинации
    // это привело бы к пропускам/дублям на границах страниц. id фиксирует порядок.
    .orderBy(sql`embedding <=> ${vec}::vector`, savedImages.id)
    .limit(limit)
    .offset(offset);
  // Точный NN-скан (индекса на 3072-dim векторе нет) — логируем latency, чтобы видеть рост с корпусом.
  logger.debug({ durationMs: Date.now() - t0, rows: rows.length, limit, offset, nsfwEnabled }, "Similar images search");
  return rows;
}

// Случайная выборка картинок — для browse-режима inline (пустой запрос).
// Без эмбеддинга: дешёвый ORDER BY random(). NSFW-фильтр как в findSimilarImages.
export async function findRandomImages(nsfwEnabled: boolean, limit = 25): Promise<SavedImage[]> {
  const t0 = Date.now();
  const where = nsfwEnabled
    ? sql`embedding IS NOT NULL`
    : and(sql`embedding IS NOT NULL`, eq(savedImages.isNsfw, false));
  const rows = await db
    .select()
    .from(savedImages)
    .where(where)
    .orderBy(sql`random()`)
    .limit(limit);
  // ORDER BY random() — тоже полный seq-scan; логируем latency наравне с поиском.
  logger.debug({ durationMs: Date.now() - t0, rows: rows.length, limit, nsfwEnabled }, "Random images browse");
  return rows;
}
