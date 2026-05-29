import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { groupMessageBuffer } from "./schema";
import type { GroupMessageBuffer, NewGroupMessageBuffer } from "./schema";
import { GROUP_BUFFER_SIZE } from "../constants";
import logger from "../logger";

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
