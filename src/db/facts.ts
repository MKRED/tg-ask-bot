import { asc, count, eq, and } from "drizzle-orm";
import { db } from "./index";
import { userFacts } from "./schema";
import type { UserFact } from "./schema";

const MAX_FACTS = 50;

export async function getUserFacts(telegramId: number): Promise<UserFact[]> {
  return db.select().from(userFacts).where(eq(userFacts.userId, telegramId));
}

export async function upsertUserFact(
  telegramId: number,
  key: string,
  value: string,
  valueOriginal?: string
): Promise<void> {
  const existing = await db
    .select({ id: userFacts.id })
    .from(userFacts)
    .where(and(eq(userFacts.userId, telegramId), eq(userFacts.key, key)))
    .limit(1);

  if (existing.length === 0) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(userFacts)
      .where(eq(userFacts.userId, telegramId));

    if (total >= MAX_FACTS) {
      const [oldest] = await db
        .select({ id: userFacts.id })
        .from(userFacts)
        .where(eq(userFacts.userId, telegramId))
        .orderBy(asc(userFacts.updatedAt))
        .limit(1);

      if (oldest) {
        await db.delete(userFacts).where(eq(userFacts.id, oldest.id));
      }
    }
  }

  await db
    .insert(userFacts)
    .values({ userId: telegramId, key, value, valueOriginal })
    .onConflictDoUpdate({
      target: [userFacts.userId, userFacts.key],
      set: { value, valueOriginal, updatedAt: new Date() },
    });
}

export async function deleteUserFacts(telegramId: number): Promise<void> {
  await db.delete(userFacts).where(eq(userFacts.userId, telegramId));
}
