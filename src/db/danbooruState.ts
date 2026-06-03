import { db } from "./index.js";
import { danbooruIngestState } from "./schema.js";
import type { DanbooruIngestState } from "./schema.js";
import logger from "../logger.js";

// Таблица danbooru_ingest_state всегда содержит не более одной строки (id=1 — singleton конфиг).
// До первого вызова /setdanboorustorage строки нет вообще, getState() возвращает null.

export async function getDanbooruState(): Promise<DanbooruIngestState | null> {
  const t0 = Date.now();
  const [row] = await db.select().from(danbooruIngestState).limit(1);
  logger.debug({ durationMs: Date.now() - t0, found: !!row }, "Danbooru state fetched");
  return row ?? null;
}

// Устанавливает/меняет чат-хранилище (+ тему) и (опционально) начальный курсор.
// threadId — message_thread_id темы форум-группы; 0 = General/группа без тем.
// При первом вызове создаёт строку; при повторных — обновляет storageChatId и storageThreadId.
export async function setDanbooruStorageChat(chatId: number, threadId: number, startPostId?: number): Promise<void> {
  const t0 = Date.now();
  // Если startPostId не передан, берём текущее значение курсора или 0.
  const current = await getDanbooruState();
  const lastPostId = startPostId ?? current?.lastPostId ?? 0;
  await db
    .insert(danbooruIngestState)
    .values({ id: 1, storageChatId: chatId, storageThreadId: threadId, lastPostId })
    .onConflictDoUpdate({
      target: danbooruIngestState.id,
      set: { storageChatId: chatId, storageThreadId: threadId, ...(startPostId !== undefined ? { lastPostId: startPostId } : {}), updatedAt: new Date() },
    });
  logger.info({ chatId, threadId, startPostId, durationMs: Date.now() - t0 }, "Danbooru storage chat configured");
}

// Сдвигает курсор после успешной (или намеренно пропущенной) обработки поста.
export async function advanceDanbooruCursor(lastPostId: number): Promise<void> {
  // storageChatId не указываем: на практике строка к этому моменту всегда существует
  // (курсор двигается только после /setdanboorustorage), и onConflictDoUpdate сохранит чат.
  await db
    .insert(danbooruIngestState)
    .values({ id: 1, lastPostId })
    .onConflictDoUpdate({
      target: danbooruIngestState.id,
      set: { lastPostId, updatedAt: new Date() },
    });
}
