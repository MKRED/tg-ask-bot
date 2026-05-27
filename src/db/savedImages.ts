import { sql } from "drizzle-orm";
import { db } from "./index";
import { savedImages } from "./schema";
import type { NewSavedImage, SavedImage } from "./schema";

export async function saveImage(data: NewSavedImage): Promise<void> {
  await db.insert(savedImages).values(data);
}

export async function findImagesByTags(tags: string[], limit = 5): Promise<SavedImage[]> {
  if (tags.length === 0) return [];
  const arr1 = sql.join(tags.map((t) => sql`${t}`), sql`, `);
  const arr2 = sql.join(tags.map((t) => sql`${t}`), sql`, `);
  return db
    .select()
    .from(savedImages)
    .where(sql`mood_tags && ARRAY[${arr1}] OR content_tags && ARRAY[${arr2}]`)
    .orderBy(sql`random()`)
    .limit(limit);
}
