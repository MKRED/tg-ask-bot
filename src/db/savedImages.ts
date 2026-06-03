import { and, count, eq, sql } from "drizzle-orm";
import { db } from "./index.js";
import { savedImages } from "./schema.js";
import type { NewSavedImage, SavedImage } from "./schema.js";

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

export async function findSimilarImages(embedding: number[], nsfwEnabled: boolean, limit = 1): Promise<SavedImage[]> {
  const vec = `[${embedding.join(",")}]`;
  const where = nsfwEnabled
    ? sql`embedding IS NOT NULL`
    : and(sql`embedding IS NOT NULL`, eq(savedImages.isNsfw, false));
  return db
    .select()
    .from(savedImages)
    .where(where)
    .orderBy(sql`embedding <=> ${vec}::vector`)
    .limit(limit);
}

// Случайная выборка картинок — для browse-режима inline (пустой запрос).
// Без эмбеддинга: дешёвый ORDER BY random(). NSFW-фильтр как в findSimilarImages.
export async function findRandomImages(nsfwEnabled: boolean, limit = 25): Promise<SavedImage[]> {
  const where = nsfwEnabled
    ? sql`embedding IS NOT NULL`
    : and(sql`embedding IS NOT NULL`, eq(savedImages.isNsfw, false));
  return db
    .select()
    .from(savedImages)
    .where(where)
    .orderBy(sql`random()`)
    .limit(limit);
}

export async function findImagesByTags(tags: string[], nsfwEnabled: boolean, limit = 5): Promise<SavedImage[]> {
  if (tags.length === 0) return [];
  const arr1 = sql.join(tags.map((t) => sql`${t}`), sql`, `);
  const arr2 = sql.join(tags.map((t) => sql`${t}`), sql`, `);
  const tagsWhere = sql`mood_tags && ARRAY[${arr1}] OR content_tags && ARRAY[${arr2}]`;
  const where = nsfwEnabled
    ? tagsWhere
    : and(tagsWhere, eq(savedImages.isNsfw, false));
  return db
    .select()
    .from(savedImages)
    .where(where)
    .orderBy(sql`random()`)
    .limit(limit);
}
