import { eq, ne, and, lte, asc, isNull, notInArray, max, count, sql } from "drizzle-orm";
import { db } from "./index.js";
import { groupIngestImages } from "./schema.js";
import logger from "../logger.js";

// "pending" — картинка в очереди (анализ ещё не завершён или прерван рестартом)
export type AnalyzedBy = "pending" | "gemini" | "ollama" | "failed" | "telegram_error";
// Полоса воркера, которая обрабатывает строку
export type Route = "gemini" | "ollama";

export interface EnqueueIngestImageParams {
  chatId: number;
  threadId: number;
  fileId: string;
  senderUserId?: number | null;
  caption?: string | null;
}

// Кладём картинку в очередь: статус "pending", полоса "gemini", готова к обработке немедленно.
// Анализ (getFile + LLM) выполняет фоновый воркер, а не обработчик сообщения.
export async function enqueueIngestImage(params: EnqueueIngestImageParams): Promise<number> {
  const t0 = Date.now();
  const [row] = await db
    .insert(groupIngestImages)
    .values({
      chatId: params.chatId,
      threadId: params.threadId,
      fileId: params.fileId,
      analyzedBy: "pending",
      route: "gemini",
      senderUserId: params.senderUserId ?? null,
      caption: params.caption ?? null,
    })
    .returning({ id: groupIngestImages.id });
  logger.debug({ ...params, durationMs: Date.now() - t0 }, "Ingest image enqueued");
  return row.id;
}

// Выбираем строки, готовые к обработке в указанной полосе:
// статус "pending", нужная route, время next_attempt_at уже наступило.
// excludeIds — строки, которые уже обрабатываются прямо сейчас (in-memory inFlight воркера).
export async function claimQueued(route: Route, limit: number, excludeIds: number[]) {
  if (limit <= 0) return [];
  const t0 = Date.now();
  const conds = [
    eq(groupIngestImages.analyzedBy, "pending"),
    eq(groupIngestImages.route, route),
    lte(groupIngestImages.nextAttemptAt, new Date()),
  ];
  if (excludeIds.length > 0) conds.push(notInArray(groupIngestImages.id, excludeIds));

  const rows = await db
    .select()
    .from(groupIngestImages)
    .where(and(...conds))
    .orderBy(asc(groupIngestImages.nextAttemptAt))
    .limit(limit);

  if (rows.length > 0) {
    logger.debug({ route, count: rows.length, durationMs: Date.now() - t0 }, "Ingest rows claimed");
  }
  return rows;
}

// Успешный анализ: переводим строку в терминальный статус и фиксируем время обработки.
export async function markDone(
  id: number,
  update: { analyzedBy: "gemini" | "ollama"; moodTags: string[]; contentTags: string[]; isNsfw: boolean; processingMs: number },
): Promise<void> {
  const t0 = Date.now();
  await db
    .update(groupIngestImages)
    .set({
      analyzedBy: update.analyzedBy,
      moodTags: update.moodTags,
      contentTags: update.contentTags,
      isNsfw: update.isNsfw,
      processingMs: update.processingMs,
      processedAt: new Date(),
      lastError: null,
    })
    .where(eq(groupIngestImages.id, id));
  logger.debug({ id, analyzedBy: update.analyzedBy, processingMs: update.processingMs, durationMs: Date.now() - t0 }, "Ingest row marked done");
}

// Gemini заблокировал/не смог — переводим строку в полосу Ollama.
// Это не провал, а маршрутизация: счётчик попыток обнуляем, обрабатываем сразу.
export async function routeToOllama(id: number, lastError: string): Promise<void> {
  const t0 = Date.now();
  await db
    .update(groupIngestImages)
    .set({ route: "ollama", attempts: 0, nextAttemptAt: new Date(), lastError })
    .where(eq(groupIngestImages.id, id));
  logger.debug({ id, durationMs: Date.now() - t0 }, "Ingest row routed to Ollama lane");
}

// Транзиентная ошибка обработки: увеличиваем счётчик и отодвигаем строку (backoff уводит её в конец очереди).
export async function deferRetry(id: number, attempts: number, nextAttemptAt: Date, lastError: string): Promise<void> {
  const t0 = Date.now();
  await db
    .update(groupIngestImages)
    .set({ attempts, nextAttemptAt, lastError })
    .where(eq(groupIngestImages.id, id));
  logger.debug({ id, attempts, nextAttemptAt, durationMs: Date.now() - t0 }, "Ingest row deferred for retry");
}

// Окончательный провал: исчерпан лимит попыток (failed) или не удалось получить файл от Telegram (telegram_error).
// Строка остаётся в таблице (удаляется только после сводки → reported_at), чтобы можно было разобрать причину.
export async function markFailed(
  id: number,
  analyzedBy: "failed" | "telegram_error",
  lastError: string,
  processingMs: number | null = null,
): Promise<void> {
  const t0 = Date.now();
  await db
    .update(groupIngestImages)
    .set({ analyzedBy, lastError, processingMs, processedAt: new Date() })
    .where(eq(groupIngestImages.id, id));
  logger.debug({ id, analyzedBy, durationMs: Date.now() - t0 }, "Ingest row marked failed");
}

// Терминальные строки треда, ещё не вошедшие ни в одну сводку.
// pending-строки (в очереди) исключены, чтобы статистика была полной;
// reported_at IS NULL отсекает уже отправленные (оставшиеся failed/telegram_error).
export async function getPendingBatch(chatId: number, threadId: number) {
  const t0 = Date.now();
  const rows = await db
    .select()
    .from(groupIngestImages)
    .where(and(
      eq(groupIngestImages.chatId, chatId),
      eq(groupIngestImages.threadId, threadId),
      ne(groupIngestImages.analyzedBy, "pending"),
      isNull(groupIngestImages.reportedAt),
    ));
  logger.debug({ chatId, threadId, count: rows.length, durationMs: Date.now() - t0 }, "Pending ingest batch fetched");
  return rows;
}

// Сколько строк треда ещё в очереди (analyzed_by='pending'): не обработаны/ждут Ollama.
// Дайджест не должен уходить, пока это > 0 — иначе сводка будет частичной.
export async function countPending(chatId: number, threadId: number): Promise<number> {
  const t0 = Date.now();
  const [row] = await db
    .select({ n: count() })
    .from(groupIngestImages)
    .where(and(
      eq(groupIngestImages.chatId, chatId),
      eq(groupIngestImages.threadId, threadId),
      eq(groupIngestImages.analyzedBy, "pending"),
    ));
  const n = row?.n ?? 0;
  logger.debug({ chatId, threadId, pending: n, durationMs: Date.now() - t0 }, "Pending ingest count fetched");
  return n;
}

// Удаляем только конкретные строки по ID, захваченным до отправки сводки.
// Используется для успешно поглощённых картинок (gemini/ollama).
export async function deleteBatchByIds(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const t0 = Date.now();
  await db
    .delete(groupIngestImages)
    .where(sql`${groupIngestImages.id} = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::integer[]`)})`);
  logger.debug({ ids: ids.length, durationMs: Date.now() - t0 }, "Ingest batch rows deleted");
}

// Помечаем строки как вошедшие в сводку, НЕ удаляя их.
// Используется для failed/telegram_error — остаются в таблице для ручного разбора и повтора.
export async function markReportedByIds(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const t0 = Date.now();
  await db
    .update(groupIngestImages)
    .set({ reportedAt: new Date() })
    .where(sql`${groupIngestImages.id} = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::integer[]`)})`);
  logger.debug({ ids: ids.length, durationMs: Date.now() - t0 }, "Ingest batch rows marked reported");
}

// Возвращает треды с незакрытыми (ещё не отправленными в сводку) строками и время последней картинки.
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
    .where(isNull(groupIngestImages.reportedAt))
    .groupBy(groupIngestImages.chatId, groupIngestImages.threadId);

  const result = rows
    .filter((r) => r.maxSavedAt !== null)
    .map((r) => ({ chatId: r.chatId, threadId: r.threadId, maxSavedAt: r.maxSavedAt as Date }));

  logger.debug({ threads: result.length, durationMs: Date.now() - t0 }, "Stale ingest threads fetched");
  return result;
}
