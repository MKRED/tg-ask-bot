import { eq, sql } from "drizzle-orm";
import { db } from "./index";
import { users, type User } from "./schema";

export async function getUser(telegramId: number): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.telegramId, telegramId))
    .limit(1);
  return user ?? null;
}

export async function toggleNsfwEnabled(telegramId: number): Promise<boolean> {
  const [row] = await db
    .update(users)
    .set({ nsfwEnabled: sql`NOT ${users.nsfwEnabled}`, updatedAt: new Date() })
    .where(eq(users.telegramId, telegramId))
    .returning({ nsfwEnabled: users.nsfwEnabled });
  return row?.nsfwEnabled ?? false;
}

interface TelegramFrom {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

// incrementRequestCount инкрементируем только для общения в ЛС — групповые сообщения не должны увеличивать счётчик
export async function upsertUser(
  from: TelegramFrom,
  incrementRequestCount = false,
): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({
      telegramId: from.id,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
    })
    .onConflictDoUpdate({
      target: users.telegramId,
      set: {
        username: from.username ?? null,
        firstName: from.first_name ?? null,
        lastName: from.last_name ?? null,
        requestCount: incrementRequestCount
          ? sql`${users.requestCount} + 1`
          : sql`${users.requestCount}`,
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();

  return user;
}

export async function getUserNsfwEnabled(telegramId: number): Promise<boolean> {
  const [row] = await db
    .select({ nsfwEnabled: users.nsfwEnabled })
    .from(users)
    .where(eq(users.telegramId, telegramId))
    .limit(1);
  return row?.nsfwEnabled ?? false;
}

export async function updateUserProfile(telegramId: number, profile: string): Promise<void> {
  await db
    .update(users)
    .set({ profile, updatedAt: new Date() })
    .where(eq(users.telegramId, telegramId));
}
