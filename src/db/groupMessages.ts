import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./index.js";
import { groupMessageBuffer } from "./schema.js";
import type { GroupMessageBuffer, NewGroupMessageBuffer } from "./schema.js";
import { GROUP_BUFFER_SIZE } from "../constants/index.js";
import logger from "../logger.js";

interface AppendOpts {
  chatId: number;
  threadId: number;
  senderUserId?: number | null;
  senderName: string;
  senderUsername?: string | null;
  content: string;
  isBot?: boolean;
  isForward?: boolean;
  forwardFrom?: string | null;
}

export async function appendToBuffer(opts: AppendOpts): Promise<void> {
  const t0 = Date.now();
  const row: NewGroupMessageBuffer = {
    chatId: opts.chatId,
    threadId: opts.threadId,
    senderUserId: opts.senderUserId ?? null,
    senderName: opts.senderName,
    senderUsername: opts.senderUsername ?? null,
    content: opts.content,
    isBot: opts.isBot ?? false,
    isForward: opts.isForward ?? false,
    forwardFrom: opts.forwardFrom ?? null,
  };
  await db.insert(groupMessageBuffer).values(row);
  logger.debug({ chatId: opts.chatId, threadId: opts.threadId, isBot: opts.isBot, durationMs: Date.now() - t0 }, "appendToBuffer");
  await pruneBuffer(opts.chatId, opts.threadId);
}

export async function getBuffer(chatId: number, threadId: number, limit: number): Promise<GroupMessageBuffer[]> {
  // Берём последние N записей через DESC + реверс, как в messages.ts
  // ВНИМАНИЕ: сортировка только по created_at. При одинаковом таймстампе у двух сообщений
  // (две почти одновременные записи) их порядок не детерминирован — модель может увидеть реплики
  // в перевёрнутом виде. Точность timestamp микросекундная, поэтому риск низкий и пока не правим.
  // Полный фикс — добавить id вторым ключом сортировки (ORDER BY created_at, id).
  const rows = await db
    .select()
    .from(groupMessageBuffer)
    .where(and(eq(groupMessageBuffer.chatId, chatId), eq(groupMessageBuffer.threadId, threadId)))
    .orderBy(desc(groupMessageBuffer.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function pruneBuffer(chatId: number, threadId: number): Promise<void> {
  // Удаляем старые строки, оставляя последние GROUP_BUFFER_SIZE на тред
  // Тот же нюанс с сортировкой по created_at, что и в getBuffer: при равных таймстампах
  // может удалиться «не та» строка. При буфере 1000 обрезка срабатывает редко, так что некритично.
  const t0 = Date.now();
  await db.execute(sql`
    DELETE FROM group_message_buffer
    WHERE chat_id = ${chatId}
      AND thread_id = ${threadId}
      AND id NOT IN (
        SELECT id FROM group_message_buffer
        WHERE chat_id = ${chatId}
          AND thread_id = ${threadId}
        ORDER BY created_at DESC
        LIMIT ${GROUP_BUFFER_SIZE}
      )
  `);
  logger.debug({ chatId, threadId, durationMs: Date.now() - t0 }, "pruneBuffer");
}
