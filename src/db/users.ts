import { eq } from "drizzle-orm";
import { db } from "./index";
import { users, type User } from "./schema";

interface TelegramFrom {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export async function upsertUser(from: TelegramFrom): Promise<User> {
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
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();

  return user;
}

export async function updateUserProfile(telegramId: number, profile: string): Promise<void> {
  await db
    .update(users)
    .set({ profile, updatedAt: new Date() })
    .where(eq(users.telegramId, telegramId));
}
