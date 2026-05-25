import type { Api, Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../config";
import { getUserFacts, deleteUserFactById, deleteUserFacts } from "../db/facts";
import {
  createInlineMenu,
  getActiveMenuByUser,
  touchInlineMenu,
  deleteInlineMenuById,
  deleteInlineMenuByUser,
  getExpiredMenus,
} from "../db/inlineMenus";
import type { InlineMenu, UserFact } from "../db/schema";
import logger from "../logger";

const FACTS_PER_PAGE = 5;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function totalPages(factsCount: number): number {
  return Math.ceil(factsCount / FACTS_PER_PAGE);
}

function buildMenuText(facts: UserFact[], page: number): string {
  const pages = totalPages(facts.length);
  const start = page * FACTS_PER_PAGE;
  const pageFacts = facts.slice(start, start + FACTS_PER_PAGE);
  const lines = pageFacts.map((f, i) => `${start + i + 1}. ${f.key}: ${f.valueOriginal ?? f.value}`);
  return `Твои факты (стр. ${page + 1}/${pages}):\n\n${lines.join("\n")}`;
}

function buildMenuKeyboard(facts: UserFact[], page: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const pages = totalPages(facts.length);
  const start = page * FACTS_PER_PAGE;
  const pageFacts = facts.slice(start, start + FACTS_PER_PAGE);

  pageFacts.forEach((fact, i) => {
    kb.text(`🗑 ${start + i + 1}`, `forget:del:${page}:${fact.id}`);
  });
  kb.row();

  if (pages > 1) {
    if (page > 0) kb.text("◀", `forget:page:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, "forget:noop");
    if (page < pages - 1) kb.text("▶", `forget:page:${page + 1}`);
    kb.row();
  }

  kb.text("🗑 Удалить всё", `forget:all:${page}`);

  return kb;
}

function buildConfirmKeyboard(page: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Да, удалить всё", "forget:all:confirm")
    .text("❌ Отмена", `forget:page:${page}`);
}

async function disableMenu(api: Api, menu: InlineMenu, reason: "inactivity" | "max_age"): Promise<void> {
  try {
    await api.editMessageText(
      menu.chatId,
      menu.messageId,
      "Меню устарело. /facts — открыть заново."
    );
    logger.info(
      { userId: menu.userId, chatId: menu.chatId, messageId: menu.messageId, reason },
      "menu_expired"
    );
  } catch (err: any) {
    const desc: string = err?.description ?? "";
    if (desc.includes("message to edit not found") || desc.includes("message is not modified")) {
      logger.warn(
        { userId: menu.userId, messageId: menu.messageId },
        "menu_edit_failed_not_found"
      );
    } else {
      logger.error({ err, userId: menu.userId, messageId: menu.messageId }, "menu_edit_failed");
    }
  } finally {
    await deleteInlineMenuById(menu.id);
  }
}

export async function sendForgetMenu(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;

  const existing = await getActiveMenuByUser(userId);
  if (existing) {
    await disableMenu(ctx.api, existing, "inactivity");
  }

  const facts = await getUserFacts(userId);

  if (facts.length === 0) {
    await ctx.reply("У тебя нет сохранённых фактов.");
    return;
  }

  const msg = await ctx.reply(buildMenuText(facts, 0), {
    reply_markup: buildMenuKeyboard(facts, 0),
  });

  await createInlineMenu(userId, chatId, msg.message_id);
  logger.info({ userId, chatId, messageId: msg.message_id, factsCount: facts.length }, "menu_created");
}

export function registerForgetCallbacks(bot: Bot): void {
  bot.callbackQuery(/^forget:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    const messageId = ctx.callbackQuery.message!.message_id;

    if (data === "forget:noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    const menu = await getActiveMenuByUser(userId);
    if (!menu || menu.messageId !== messageId) {
      await ctx.answerCallbackQuery("Меню устарело. Открой /forget заново.");
      return;
    }

    if (data.startsWith("forget:page:")) {
      const page = parseInt(data.slice("forget:page:".length));
      const facts = await getUserFacts(userId);
      const safePage = Math.min(page, totalPages(facts.length) - 1);

      await ctx.editMessageText(buildMenuText(facts, safePage), {
        reply_markup: buildMenuKeyboard(facts, safePage),
      });
      await touchInlineMenu(menu.id);
      await ctx.answerCallbackQuery();
      logger.info({ userId, page: safePage }, "page_changed");
      return;
    }

    if (data.startsWith("forget:del:")) {
      const parts = data.split(":");
      const page = parseInt(parts[2]);
      const factId = parseInt(parts[3]);

      const deleted = await deleteUserFactById(factId);
      logger.info({ userId, factId, key: deleted?.key }, "fact_deleted");

      const facts = await getUserFacts(userId);

      if (facts.length === 0) {
        await deleteInlineMenuByUser(userId);
        await ctx.editMessageText("Все факты удалены.");
        await ctx.answerCallbackQuery("Факт удалён");
        return;
      }

      const safePage = Math.min(page, totalPages(facts.length) - 1);
      await ctx.editMessageText(buildMenuText(facts, safePage), {
        reply_markup: buildMenuKeyboard(facts, safePage),
      });
      await touchInlineMenu(menu.id);
      await ctx.answerCallbackQuery("Факт удалён");
      return;
    }

    if (data.startsWith("forget:all:")) {
      const suffix = data.slice("forget:all:".length);

      if (suffix === "confirm") {
        await deleteUserFacts(userId);
        await deleteInlineMenuByUser(userId);
        await ctx.editMessageText("Все факты удалены.");
        await ctx.answerCallbackQuery("Готово");
        logger.info({ userId }, "fact_deleted_all");
        return;
      }

      const page = parseInt(suffix);
      const facts = await getUserFacts(userId);
      await ctx.editMessageText(
        `Удалить все ${facts.length} фактов? Это действие необратимо.`,
        { reply_markup: buildConfirmKeyboard(page) }
      );
      await touchInlineMenu(menu.id);
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
  });
}

export function startMenuCleanupScheduler(bot: Bot): void {
  setInterval(async () => {
    let expired: InlineMenu[];
    try {
      expired = await getExpiredMenus(
        config.inlineMenuInactivityTimeoutMs,
        config.inlineMenuMaxAgeMs
      );
    } catch (err) {
      logger.error({ err }, "cleanup_tick_db_error");
      return;
    }

    if (expired.length > 0) {
      logger.info({ count: expired.length }, "cleanup_tick");
    }

    for (const menu of expired) {
      const now = new Date();
      const reason: "inactivity" | "max_age" =
        now.getTime() - menu.createdAt.getTime() >= config.inlineMenuMaxAgeMs
          ? "max_age"
          : "inactivity";
      await disableMenu(bot.api, menu, reason);
    }
  }, CLEANUP_INTERVAL_MS);
}
