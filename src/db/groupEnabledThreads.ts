import { and, eq } from "drizzle-orm";
import { db } from "./index.js";
import { groupEnabledThreads } from "./schema.js";
import logger from "../logger.js";

// Режим работы бота в треде:
//   "chat"   — полноценное общение (decision LLM + ответы)
//   "ingest" — молчаливое поглощение картинок в базу, без ответов
export type ThreadMode = "chat" | "ingest";

export async function enableThread(
  chatId: number,
  threadId: number,
  enabledBy: number,
  mode: ThreadMode = "chat"
): Promise<void> {
  const t0 = Date.now();
  // Переключение режима существующего треда — обновляем mode по уникальному (chatId, threadId)
  await db
    .insert(groupEnabledThreads)
    .values({ chatId, threadId, enabledBy, mode })
    .onConflictDoUpdate({
      target: [groupEnabledThreads.chatId, groupEnabledThreads.threadId],
      set: { mode, enabledBy },
    });
  logger.info({ chatId, threadId, enabledBy, mode, durationMs: Date.now() - t0 }, "Thread enabled");
}

export async function disableThread(chatId: number, threadId: number): Promise<void> {
  const t0 = Date.now();
  await db
    .delete(groupEnabledThreads)
    .where(and(eq(groupEnabledThreads.chatId, chatId), eq(groupEnabledThreads.threadId, threadId)));
  logger.info({ chatId, threadId, durationMs: Date.now() - t0 }, "Thread disabled");
}

// Возвращает режим треда, либо null если тред не активирован.
export async function getThreadMode(chatId: number, threadId: number): Promise<ThreadMode | null> {
  const rows = await db
    .select({ mode: groupEnabledThreads.mode })
    .from(groupEnabledThreads)
    .where(and(eq(groupEnabledThreads.chatId, chatId), eq(groupEnabledThreads.threadId, threadId)))
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0].mode as ThreadMode;
}

export async function isThreadEnabled(chatId: number, threadId: number): Promise<boolean> {
  return (await getThreadMode(chatId, threadId)) !== null;
}
