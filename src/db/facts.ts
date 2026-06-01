import { asc, count, eq, and } from "drizzle-orm";
import { db } from "./index.js";
import { userFacts } from "./schema.js";
import type { UserFact } from "./schema.js";
import { MAX_FACTS } from "../constants/index.js";

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
    // Достигнут лимит фактов: вытесняем наименее свежий, чтобы освободить место (LRU)
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

export async function deleteUserFact(telegramId: number, key: string): Promise<void> {
  await db.delete(userFacts).where(and(eq(userFacts.userId, telegramId), eq(userFacts.key, key)));
}

export async function deleteUserFactById(id: number): Promise<UserFact | null> {
  const [deleted] = await db.delete(userFacts).where(eq(userFacts.id, id)).returning();
  return deleted ?? null;
}

export async function deleteUserFacts(telegramId: number): Promise<void> {
  await db.delete(userFacts).where(eq(userFacts.userId, telegramId));
}
