import { eq, asc, inArray } from "drizzle-orm";
import { db } from "./index.js";
import { danbooruPosts, savedImages } from "./schema.js";
import type { NewDanbooruPost, DanbooruPost, NewSavedImage } from "./schema.js";
import logger from "../logger.js";

// Фиксируем пост (обычно перед обработкой). onConflictDoNothing — если воркер
// перезапустился и снова видит тот же danbooruId, просто продолжаем.
export async function insertDanbooruPost(data: NewDanbooruPost): Promise<void> {
  await db
    .insert(danbooruPosts)
    .values(data)
    .onConflictDoNothing({ target: danbooruPosts.danbooruId });
}

// Текущий статус поста (null если строки ещё нет). Воркер по нему пропускает уже
// обработанные посты (done/skipped), чтобы повторный проход не плодил дубли в saved_images.
export async function getDanbooruPostStatus(danbooruId: number): Promise<string | null> {
  const [row] = await db
    .select({ status: danbooruPosts.status })
    .from(danbooruPosts)
    .where(eq(danbooruPosts.danbooruId, danbooruId))
    .limit(1);
  return row?.status ?? null;
}

// Атомарно: вставляем картинку в saved_images и помечаем пост done с её id.
// Транзакция закрывает окно между вставкой и пометкой — без неё краш ровно между ними
// оставил бы строку в saved_images при pending-посте, и повторный проход создал бы дубль.
export async function saveImageAndMarkDone(image: NewSavedImage, danbooruId: number): Promise<number> {
  const t0 = Date.now();
  const savedImageId = await db.transaction(async (tx) => {
    const [row] = await tx.insert(savedImages).values(image).returning({ id: savedImages.id });
    await tx
      .update(danbooruPosts)
      .set({ status: "done", savedImageId: row.id, processedAt: new Date(), lastError: null })
      .where(eq(danbooruPosts.danbooruId, danbooruId));
    return row.id;
  });
  logger.debug({ danbooruId, savedImageId, durationMs: Date.now() - t0 }, "Danbooru post saved & marked done");
  return savedImageId;
}

export async function markDanbooruPostFailed(danbooruId: number, error: string): Promise<void> {
  await db
    .update(danbooruPosts)
    .set({ status: "failed", lastError: error.slice(0, 500), processedAt: new Date() })
    .where(eq(danbooruPosts.danbooruId, danbooruId));
  logger.debug({ danbooruId, error: error.slice(0, 100) }, "Danbooru post marked failed");
}

export async function markDanbooruPostSkipped(danbooruId: number, reason: string): Promise<void> {
  await db
    .update(danbooruPosts)
    .set({ status: "skipped", lastError: reason, processedAt: new Date() })
    .where(eq(danbooruPosts.danbooruId, danbooruId));
}

// Маппинг saved_image_id → danbooru_id для набора картинок (inline-выдача).
// По нему строится ссылка на пост Danbooru. Картинки не с Danbooru просто не попадают в map.
export async function getDanbooruIdsByImageIds(savedImageIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (savedImageIds.length === 0) return map;
  const rows = await db
    .select({ savedImageId: danbooruPosts.savedImageId, danbooruId: danbooruPosts.danbooruId })
    .from(danbooruPosts)
    .where(inArray(danbooruPosts.savedImageId, savedImageIds));
  for (const r of rows) {
    if (r.savedImageId !== null) map.set(r.savedImageId, r.danbooruId);
  }
  return map;
}

// Упавшие посты (status='failed') — для скрипта восстановления.
// Упорядочены по danbooru_id, чтобы переобрабатывать в хронологическом порядке.
export async function getFailedDanbooruPosts(limit = 500): Promise<DanbooruPost[]> {
  return db
    .select()
    .from(danbooruPosts)
    .where(eq(danbooruPosts.status, "failed"))
    .orderBy(asc(danbooruPosts.danbooruId))
    .limit(limit);
}
