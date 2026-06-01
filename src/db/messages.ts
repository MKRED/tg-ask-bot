import { desc, eq, sql } from "drizzle-orm";
import { db } from "./index.js";
import { messages } from "./schema.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { MAX_HISTORY_MESSAGES, MAX_STORED_MESSAGES } from "../constants/index.js";

export async function saveMessage(
  telegramId: number,
  role: "user" | "assistant",
  content: string,
  model?: string
): Promise<void> {
  await db.insert(messages).values({ userId: telegramId, role, content, model });
  // После каждой вставки обрезаем историю, чтобы таблица не росла бесконечно.
  // Храним до MAX_STORED_MESSAGES, хотя в контекст ответа уходит только MAX_HISTORY_MESSAGES.
  await db.execute(sql`
    DELETE FROM messages
    WHERE user_id = ${telegramId}
    AND id NOT IN (
      SELECT id FROM messages
      WHERE user_id = ${telegramId}
      ORDER BY created_at DESC
      LIMIT ${MAX_STORED_MESSAGES}
    )
  `);
}

export async function getHistory(telegramId: number): Promise<ChatCompletionMessageParam[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.userId, telegramId))
    .orderBy(desc(messages.createdAt))
    .limit(MAX_HISTORY_MESSAGES);

  return rows
    .reverse()
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

export async function clearMessages(telegramId: number): Promise<void> {
  await db.delete(messages).where(eq(messages.userId, telegramId));
}
