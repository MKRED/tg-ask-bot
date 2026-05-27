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
  embedding: vector("embedding", { dimensions: 3072 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type SavedImage = typeof savedImages.$inferSelect;
export type NewSavedImage = typeof savedImages.$inferInsert;
