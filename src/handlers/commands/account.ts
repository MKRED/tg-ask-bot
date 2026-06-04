// DM-команды профиля и истории: /clear, /facts, /account (+ переключение NSFW).
import { Bot, InlineKeyboard } from "grammy";
import { clearHistory } from "../../ai/openrouter.js";
import { sendForgetMenu } from "../forgetMenu/index.js";
import { disableMenu } from "../forgetMenu/render.js";
import { getUser, toggleNsfwEnabled } from "../../db/users.js";
import { countUserImages } from "../../db/savedImages.js";
import { createInlineMenu, getActiveMenuByUser } from "../../db/inlineMenus.js";
import logger from "../../logger.js";
import type { User } from "../../db/schema.js";

function buildAccountText(user: User, photoCount: number): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "Неизвестно";
  const nsfwStatus = user.nsfwEnabled ? "включён ✅" : "выключен ❌";
  const sep = "──────────────────";
  return (
    `<b>👤  Профиль</b>\n${sep}\n` +
    `🏷  Имя: <b>${name}</b>\n` +
    `🆔  ID: <code>${user.telegramId}</code>\n\n` +
    `<b>📊  Статистика</b>\n${sep}\n` +
    `💬  Сообщений: <b>${user.requestCount}</b>\n` +
    `🖼️  Фото: <b>${photoCount}</b>\n\n` +
    `<b>⚙️  Настройки</b>\n${sep}\n` +
    `🔞  NSFW-контент: <b>${nsfwStatus}</b>`
  );
}

function nsfwKeyboard(enabled: boolean): InlineKeyboard {
  return new InlineKeyboard().text(
    enabled ? "🔞 Выключить NSFW" : "🔞 Включить NSFW",
    "account:toggle_nsfw"
  );
}

export function registerAccountCommands(bot: Bot): void {
  bot.command("clear", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      return ctx.reply("Эта команда доступна только в личных сообщениях.");
    }
    await clearHistory(ctx.from!.id);
    logger.info({ chatId: ctx.chat.id }, "History cleared");
    return ctx.reply("История чата очищена.");
  });

  bot.command("facts", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      return ctx.reply("Эта команда доступна только в личных сообщениях.");
    }
    logger.info({ userId: ctx.from!.id }, "forget_menu_opened");
    await sendForgetMenu(ctx);
  });

  bot.command("account", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      return ctx.reply("Эта команда доступна только в личных сообщениях.");
    }
    const userId = ctx.from!.id;
    const chatId = ctx.chat.id;
    const t0 = Date.now();

    const existing = await getActiveMenuByUser(userId, "account");
    if (existing) await disableMenu(ctx.api, existing, "inactivity");

    const [user, photoCount] = await Promise.all([
      getUser(userId),
      countUserImages(userId),
    ]);
    if (!user) return ctx.reply("Пользователь не найден.");

    const msg = await ctx.reply(buildAccountText(user, photoCount), {
      parse_mode: "HTML",
      reply_markup: nsfwKeyboard(user.nsfwEnabled),
    });
    await createInlineMenu(userId, chatId, msg.message_id, "account");
    logger.info({ userId, durationMs: Date.now() - t0 }, "account_viewed");
  });

  bot.callbackQuery("account:toggle_nsfw", async (ctx) => {
    const userId = ctx.from.id;
    const messageId = ctx.callbackQuery.message!.message_id;
    const t0 = Date.now();

    const menu = await getActiveMenuByUser(userId, "account");
    if (!menu || menu.messageId !== messageId) {
      await ctx.answerCallbackQuery("Меню устарело. Открой /account заново.");
      return;
    }

    const newValue = await toggleNsfwEnabled(userId);
    const [user, photoCount] = await Promise.all([
      getUser(userId),
      countUserImages(userId),
    ]);
    if (!user) {
      await ctx.answerCallbackQuery("Ошибка. Попробуйте снова.");
      return;
    }
    await ctx.editMessageText(buildAccountText(user, photoCount), {
      parse_mode: "HTML",
      reply_markup: nsfwKeyboard(newValue),
    });
    await ctx.answerCallbackQuery(newValue ? "NSFW включён" : "NSFW выключен");
    logger.info({ userId, nsfwEnabled: newValue, durationMs: Date.now() - t0 }, "nsfw_toggled");
  });
}
