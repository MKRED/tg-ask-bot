import { and, eq } from "drizzle-orm";
import { db } from "./index";
import { groupEnabledThreads } from "./schema";
import logger from "../logger";

export async function enableThread(chatId: number, threadId: number, enabledBy: number): Promise<void> {
  const t0 = Date.now();
  await db
    .insert(groupEnabledThreads)
    .values({ chatId, threadId, enabledBy })
    .onConflictDoNothing();
  logger.info({ chatId, threadId, enabledBy, durationMs: Date.now() - t0 }, "Thread enabled");
}

export async function disableThread(chatId: number, threadId: number): Promise<void> {
  const t0 = Date.now();
  await db
    .delete(groupEnabledThreads)
    .where(and(eq(groupEnabledThreads.chatId, chatId), eq(groupEnabledThreads.threadId, threadId)));
  logger.info({ chatId, threadId, durationMs: Date.now() - t0 }, "Thread disabled");
}

export async function isThreadEnabled(chatId: number, threadId: number): Promise<boolean> {
  const rows = await db
    .select({ id: groupEnabledThreads.id })
    .from(groupEnabledThreads)
    .where(and(eq(groupEnabledThreads.chatId, chatId), eq(groupEnabledThreads.threadId, threadId)))
    .limit(1);
  return rows.length > 0;
}
