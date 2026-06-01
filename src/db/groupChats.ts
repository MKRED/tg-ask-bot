import { eq } from "drizzle-orm";
import { db } from "./index.js";
import { groupChats } from "./schema.js";
import type { GroupChat } from "./schema.js";
import logger from "../logger.js";

export async function upsertGroupChat(
  chatId: number,
  title: string | undefined,
  type: string,
  topicsEnabled: boolean
): Promise<GroupChat> {
  const t0 = Date.now();
  const existing = await db.select().from(groupChats).where(eq(groupChats.chatId, chatId)).limit(1);

  let result: GroupChat;
  if (existing.length > 0) {
    const [updated] = await db
      .update(groupChats)
      .set({ title, type, topicsEnabled, updatedAt: new Date() })
      .where(eq(groupChats.chatId, chatId))
      .returning();
    result = updated;
  } else {
    const [inserted] = await db
      .insert(groupChats)
      .values({ chatId, title, type, topicsEnabled })
      .returning();
    result = inserted;
  }

  logger.info({ chatId, type, topicsEnabled, durationMs: Date.now() - t0 }, "upsertGroupChat completed");
  return result;
}

export async function getGroupChat(chatId: number): Promise<GroupChat | null> {
  const rows = await db.select().from(groupChats).where(eq(groupChats.chatId, chatId)).limit(1);
  return rows[0] ?? null;
}

export async function getGroupNsfwEnabled(chatId: number): Promise<boolean> {
  const rows = await db
    .select({ nsfwEnabled: groupChats.nsfwEnabled })
    .from(groupChats)
    .where(eq(groupChats.chatId, chatId))
    .limit(1);
  return rows[0]?.nsfwEnabled ?? false;
}
