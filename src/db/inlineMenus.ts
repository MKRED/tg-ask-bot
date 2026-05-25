import { and, eq, lt, or } from "drizzle-orm";
import { db } from "./index";
import { inlineMenus } from "./schema";
import type { InlineMenu } from "./schema";

export async function createInlineMenu(
  userId: number,
  chatId: number,
  messageId: number
): Promise<InlineMenu> {
  const [menu] = await db
    .insert(inlineMenus)
    .values({ userId, chatId, messageId })
    .returning();
  return menu;
}

export async function getActiveMenuByUser(userId: number): Promise<InlineMenu | null> {
  const [menu] = await db
    .select()
    .from(inlineMenus)
    .where(eq(inlineMenus.userId, userId))
    .limit(1);
  return menu ?? null;
}

export async function touchInlineMenu(id: number): Promise<void> {
  await db
    .update(inlineMenus)
    .set({ lastInteractionAt: new Date() })
    .where(eq(inlineMenus.id, id));
}

export async function deleteInlineMenuById(id: number): Promise<void> {
  await db.delete(inlineMenus).where(eq(inlineMenus.id, id));
}

export async function deleteInlineMenuByUser(userId: number): Promise<void> {
  await db.delete(inlineMenus).where(eq(inlineMenus.userId, userId));
}

export async function getExpiredMenus(
  inactivityTimeoutMs: number,
  maxAgeMs: number
): Promise<InlineMenu[]> {
  const now = new Date();
  const inactivityThreshold = new Date(now.getTime() - inactivityTimeoutMs);
  const maxAgeThreshold = new Date(now.getTime() - maxAgeMs);

  return db
    .select()
    .from(inlineMenus)
    .where(
      or(
        lt(inlineMenus.lastInteractionAt, inactivityThreshold),
        lt(inlineMenus.createdAt, maxAgeThreshold)
      )
    );
}
