import { sql } from "drizzle-orm";
import { pgTable, serial, bigint, varchar, text, timestamp, boolean, integer, unique, index, customType } from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(",").map(Number);
  },
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull().unique(),
  username: varchar("username", { length: 255 }),
  firstName: varchar("first_name", { length: 255 }),
  lastName: varchar("last_name", { length: 255 }),
  isBlocked: boolean("is_blocked").notNull().default(false),
  nsfwEnabled: boolean("nsfw_enabled").notNull().default(false),
  requestCount: integer("request_count").notNull().default(0),
  profile: text("profile"),
  lastActiveAt: timestamp("last_active_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  role: varchar("role", { length: 20 }).notNull(), // 'user' | 'assistant'
  content: text("content").notNull(),
  model: varchar("model", { length: 100 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const userFacts = pgTable("user_facts", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  key: varchar("key", { length: 100 }).notNull(),
  value: text("value").notNull(),
  valueOriginal: text("value_original"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [unique().on(table.userId, table.key)]);

export const inlineMenus = pgTable("inline_menus", {
  id: serial("id").primaryKey(),
  menuType: varchar("menu_type", { length: 50 }).notNull().default("forget"),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  messageId: bigint("message_id", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastInteractionAt: timestamp("last_interaction_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type UserFact = typeof userFacts.$inferSelect;
export type NewUserFact = typeof userFacts.$inferInsert;
export type InlineMenu = typeof inlineMenus.$inferSelect;

export const savedImages = pgTable("saved_images", {
  id: serial("id").primaryKey(),
  fileId: varchar("file_id", { length: 255 }).notNull(),
  senderUserId: bigint("sender_user_id", { mode: "number" }).notNull(),
  description: text("description").notNull(),
  caption: text("caption"),
  moodTags: text("mood_tags").array().notNull().default(sql`'{}'::text[]`),
  contentTags: text("content_tags").array().notNull().default(sql`'{}'::text[]`),
  isNsfw: boolean("is_nsfw").notNull().default(false),
  embedding: vector("embedding", { dimensions: 3072 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type SavedImage = typeof savedImages.$inferSelect;
export type NewSavedImage = typeof savedImages.$inferInsert;

// Кэш эмбеддингов поисковых запросов inline-режима: нормализованная фраза → вектор.
// Глобальный (вектор фразы не зависит от пользователя; NSFW-фильтр применяется
// позже, на поиске). Ищем по точному queryText — нужен лишь btree unique-индекс,
// векторный индекс не требуется.
export const searchEmbeddings = pgTable("search_embeddings", {
  id: serial("id").primaryKey(),
  queryText: varchar("query_text", { length: 255 }).notNull().unique(),
  embedding: vector("embedding", { dimensions: 3072 }).notNull(),
  // Telegram-id пользователя, чей запрос первым закэшировал эту фразу (кэш глобальный).
  createdBy: bigint("created_by", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type SearchEmbedding = typeof searchEmbeddings.$inferSelect;
export type NewSearchEmbedding = typeof searchEmbeddings.$inferInsert;

// Группы, в которых состоит бот
export const groupChats = pgTable("group_chats", {
  id: serial("id").primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull().unique(),
  title: varchar("title", { length: 255 }),
  type: varchar("type", { length: 20 }).notNull(), // 'group' | 'supergroup'
  topicsEnabled: boolean("topics_enabled").notNull().default(false),
  nsfwEnabled: boolean("nsfw_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Whitelist разрешённых тредов; threadId=0 означает всю группу без тем
export const groupEnabledThreads = pgTable("group_enabled_threads", {
  id: serial("id").primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  threadId: bigint("thread_id", { mode: "number" }).notNull().default(0),
  enabledBy: bigint("enabled_by", { mode: "number" }).notNull(),
  // Режим треда: "chat" — полноценное общение, "ingest" — молчаливое поглощение картинок в базу
  mode: text("mode").notNull().default("chat"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [unique().on(table.chatId, table.threadId)]);

// Скользящая история разговора для групп
export const groupMessageBuffer = pgTable("group_message_buffer", {
  id: serial("id").primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  threadId: bigint("thread_id", { mode: "number" }).notNull().default(0),
  senderUserId: bigint("sender_user_id", { mode: "number" }),
  senderName: varchar("sender_name", { length: 255 }).notNull(),
  senderUsername: varchar("sender_username", { length: 255 }),
  content: text("content").notNull(),
  isBot: boolean("is_bot").notNull().default(false),
  isForward: boolean("is_forward").notNull().default(false),
  forwardFrom: text("forward_from"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Очередь картинок для сводки в режиме «пожиратель».
// Строки удаляются после отправки дайджеста — это временная очередь, не постоянное хранилище.
export const groupIngestImages = pgTable("group_ingest_images", {
  id: serial("id").primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  threadId: integer("thread_id").notNull().default(0),
  // null если картинку не удалось получить от Telegram до анализа
  fileId: text("file_id"),
  // Маркер очереди / результат: "pending" (ещё в очереди) | "gemini" | "ollama" | "failed" | "telegram_error"
  analyzedBy: text("analyzed_by").notNull(),
  // Какая полоса воркера обрабатывает строку: "gemini" (по умолчанию) → при блокировке/ошибке "ollama"
  route: text("route").notNull().default("gemini"),
  // Счётчик неудачных попыток в текущей полосе (сбрасывается при смене route)
  attempts: integer("attempts").notNull().default(0),
  // Воркер берёт строки с next_attempt_at <= now() и сортирует по нему (backoff уводит строку в конец)
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  // Текст последней ошибки — для разбора провалившихся картинок
  lastError: text("last_error"),
  moodTags: text("mood_tags").array().notNull().default(sql`'{}'::text[]`),
  contentTags: text("content_tags").array().notNull().default(sql`'{}'::text[]`),
  isNsfw: boolean("is_nsfw").notNull().default(false),
  // Нужны для вызова saveImage при обработке (в т.ч. после рестарта)
  senderUserId: bigint("sender_user_id", { mode: "number" }),
  caption: text("caption"),
  savedAt: timestamp("saved_at").notNull().defaultNow(),
  // Момент перехода строки в терминальный статус — для статистики времени обработки
  processedAt: timestamp("processed_at"),
  // Фактическая длительность анализа конкретной картинки (мс)
  processingMs: integer("processing_ms"),
  // Когда строку уже включили в отправленную сводку. Успешные строки удаляются,
  // а failed/telegram_error остаются с reported_at для ручного разбора и повтора.
  reportedAt: timestamp("reported_at"),
}, (table) => [
  // Под claim-запрос воркера: WHERE analyzed_by='pending' AND route=? AND next_attempt_at<=now() ORDER BY next_attempt_at
  index("ingest_queue_idx").on(table.analyzedBy, table.route, table.nextAttemptAt),
]);

export type GroupChat = typeof groupChats.$inferSelect;
export type NewGroupChat = typeof groupChats.$inferInsert;
export type GroupEnabledThread = typeof groupEnabledThreads.$inferSelect;
export type GroupMessageBuffer = typeof groupMessageBuffer.$inferSelect;
export type NewGroupMessageBuffer = typeof groupMessageBuffer.$inferInsert;
export type GroupIngestImage = typeof groupIngestImages.$inferSelect;
