import { sql } from "drizzle-orm";
import { pgTable, serial, bigint, varchar, text, timestamp, boolean, integer, unique, customType } from "drizzle-orm/pg-core";

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

export type GroupChat = typeof groupChats.$inferSelect;
export type NewGroupChat = typeof groupChats.$inferInsert;
export type GroupEnabledThread = typeof groupEnabledThreads.$inferSelect;
export type GroupMessageBuffer = typeof groupMessageBuffer.$inferSelect;
export type NewGroupMessageBuffer = typeof groupMessageBuffer.$inferInsert;
