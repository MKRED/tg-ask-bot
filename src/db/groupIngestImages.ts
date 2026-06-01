import { eq, ne, and, max, sql } from "drizzle-orm";
import { db } from "./index.js";
import { groupIngestImages } from "./schema.js";
import logger from "../logger.js";

// "pending" — картинка принята, анализ ещё не завершён (или прерван рестартом)
export type AnalyzedBy = "pending" | "gemini" | "ollama" | "failed" | "telegram_error";

export interface AddIngestImageParams {
  chatId: number;
  threadId: number;
  fileId: string | null;
  analyzedBy: AnalyzedBy;
  moodTags: string[];
  contentTags: string[];
  isNsfw: boolean;
  senderUserId?: number | null;
  caption?: string | null;
}

// Возвращает ID вставленной строки — нужен для последующего updateIngestImage
export async function addIngestImage(params: AddIngestImageParams): Promise<number> {
  const t0 = Date.now();
  const [row] = await db.insert(groupIngestImages).values(params).returning({ id: groupIngestImages.id });
  logger.debug({ ...params, durationMs: Date.now() - t0 }, "Ingest image added to batch queue");
  return row.id;
}

// Обновляем строку после завершения анализа (pending → реальный статус)
export async function updateIngestImage(
  id: number,
  update: { analyzedBy: AnalyzedBy; moodTags: string[]; contentTags: string[]; isNsfw: boolean },
): Promise<void> {
  const t0 = Date.now();
  await db.update(groupIngestImages).set(update).where(eq(groupIngestImages.id, id));
  logger.debug({ id, analyzedBy: update.analyzedBy, durationMs: Date.now() - t0 }, "Ingest image row updated");
}

// Строки в статусе "pending" — картинки, анализ которых был прерван рестартом бота
export async function getPendingIngestImages() {
  const t0 = Date.now();
  const rows = await db.select().from(groupIngestImages).where(eq(groupIngestImages.analyzedBy, "pending"));
  logger.debug({ count: rows.length, durationMs: Date.now() - t0 }, "Pending ingest images fetched for retry");
  return rows;
}

export async function getPendingBatch(chatId: number, threadId: number) {
  const t0 = Date.now();
  const rows = await db
    .select()
    .from(groupIngestImages)
    .where(and(
      eq(groupIngestImages.chatId, chatId),
      eq(groupIngestImages.threadId, threadId),
      // Строки "pending" ещё обрабатываются — в статистику дайджеста не включаем,
      // чтобы не получить total > sum(категорий) если updateIngestImage упал с ошибкой.
      ne(groupIngestImages.analyzedBy, "pending"),
    ));
  logger.debug({ chatId, threadId, count: rows.length, durationMs: Date.now() - t0 }, "Pending ingest batch fetched");
  return rows;
}

// Удаляем только конкретные строки по ID, захваченным до отправки сводки.
// Это защищает от потери картинки, пришедшей в процессе отправки.
export async function deleteBatchByIds(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const t0 = Date.now();
  await db
    .delete(groupIngestImages)
    .where(sql`${groupIngestImages.id} = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::integer[]`)})`);
  logger.debug({ ids: ids.length, durationMs: Date.now() - t0 }, "Ingest batch rows deleted");
}

// Возвращает треды с незакрытыми строками и время последней картинки в каждом.
// Используется при старте бота для восстановления пропущенных дайджестов.
export async function getStaleIngestThreads(): Promise<{ chatId: number; threadId: number; maxSavedAt: Date }[]> {
  const t0 = Date.now();
  const rows = await db
    .select({
      chatId: groupIngestImages.chatId,
      threadId: groupIngestImages.threadId,
      maxSavedAt: max(groupIngestImages.savedAt),
    })
    .from(groupIngestImages)
    .groupBy(groupIngestImages.chatId, groupIngestImages.threadId);

  const result = rows
    .filter((r) => r.maxSavedAt !== null)
    .map((r) => ({ chatId: r.chatId, threadId: r.threadId, maxSavedAt: r.maxSavedAt as Date }));

  logger.debug({ threads: result.length, durationMs: Date.now() - t0 }, "Stale ingest threads fetched");
  return result;
}
