import type { Bot, Context } from "grammy";
import { config } from "../../config.js";
import { getUserFacts, deleteUserFactById, deleteUserFacts } from "../../db/facts.js";
import {
  createInlineMenu,
  getActiveMenuByUser,
  touchInlineMenu,
  deleteInlineMenuByUser,
  getExpiredMenus,
} from "../../db/inlineMenus.js";
import type { InlineMenu } from "../../db/schema.js";
import logger from "../../logger.js";
import { CLEANUP_INTERVAL_MS } from "../../constants/index.js";
import {
  totalPages,
  buildMenuText,
  buildMenuKeyboard,
  buildConfirmKeyboard,
  disableMenu,
} from "./render.js";

export async function sendForgetMenu(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;

  const existing = await getActiveMenuByUser(userId, "forget");
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

  await createInlineMenu(userId, chatId, msg.message_id, "forget");
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

    const menu = await getActiveMenuByUser(userId, "forget");
    // Несоответствие messageId означает, что кнопка принадлежит старому, уже замененному меню
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
