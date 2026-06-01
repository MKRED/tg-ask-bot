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

export async function saveImage(data: NewSavedImage): Promise<void> {
  await db.insert(savedImages).values(data);
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
