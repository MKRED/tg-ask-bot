import { Bot, InlineKeyboard, type Context } from "grammy";
import { clearHistory } from "../ai/openrouter";
import { sendForgetMenu } from "./forgetMenu/index";
import { disableMenu } from "./forgetMenu/render";
import { getUser, toggleNsfwEnabled } from "../db/users";
import { countUserImages } from "../db/savedImages";
import { createInlineMenu, getActiveMenuByUser } from "../db/inlineMenus";
import { enableThread, disableThread } from "../db/groupEnabledThreads";
import logger from "../logger";
import type { User } from "../db/schema";

// Проверка прав для групповых команд (/botstart, /botstop): команда работает только в группе
// и только для администраторов/создателя. На любой неуспех сам отправляет ответ и возвращает false.
async function ensureGroupAdmin(ctx: Context, label: string): Promise<boolean> {
  const chatType = ctx.chat?.type;
  if (chatType !== "group" && chatType !== "supergroup") {
    await ctx.reply("Эта команда доступна только в группах.");
    return false;
  }

  try {
    const member = await ctx.getChatMember(ctx.from!.id);
    if (!["administrator", "creator"].includes(member.status)) {
      await ctx.reply("Только администраторы могут управлять ботом.");
      return false;
    }
  } catch (err) {
    logger.warn({ chatId: ctx.chat!.id, userId: ctx.from!.id, err }, `${label}: getChatMember failed`);
    await ctx.reply("Не удалось проверить права. Попробуйте снова.");
    return false;
  }

  return true;
}

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

export function registerCommands(bot: Bot): void {
  bot.command("start", (ctx) =>
    ctx.reply("Привет! Я бот-помощник. Напишите мне что-нибудь.")
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      "Доступные команды:\n" +
      "/start — начать\n" +
      "/clear — очистить историю чата (только в личных сообщениях)\n" +
      "/facts — управлять сохранёнными фактами (только в личных сообщениях)\n" +
      "/account — профиль и настройки (только в личных сообщениях)\n" +
      "/help — помощь\n\n" +
      "<b>Команды для групп (только администраторы):</b>\n" +
      "/botstart — включить бота в текущем разделе\n" +
      "/botingest — режим «пожиратель»: бот молча собирает картинки в базу\n" +
      "/botstop — выключить бота в текущем разделе",
      { parse_mode: "HTML" }
    )
  );

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

  bot.command("botstart", async (ctx) => {
    if (!(await ensureGroupAdmin(ctx, "botstart"))) return;

    const userId = ctx.from!.id;
    const chatId = ctx.chat!.id;
    const t0 = Date.now();
    const threadId = ctx.message?.message_thread_id ?? 0;
    await enableThread(chatId, threadId, userId, "chat");
    logger.info({ chatId, threadId, userId, durationMs: Date.now() - t0 }, "Bot enabled in thread");
    return ctx.reply("Бот включён в этом разделе.");
  });

  bot.command("botingest", async (ctx) => {
    if (!(await ensureGroupAdmin(ctx, "botingest"))) return;

    const userId = ctx.from!.id;
    const chatId = ctx.chat!.id;
    const t0 = Date.now();
    const threadId = ctx.message?.message_thread_id ?? 0;
    await enableThread(chatId, threadId, userId, "ingest");
    logger.info({ chatId, threadId, userId, durationMs: Date.now() - t0 }, "Bot ingest mode enabled in thread");
    return ctx.reply("Режим «пожиратель» включён: молча собираю картинки в базу, отвечать не буду.");
  });

  bot.command("botstop", async (ctx) => {
    if (!(await ensureGroupAdmin(ctx, "botstop"))) return;

    const userId = ctx.from!.id;
    const chatId = ctx.chat!.id;
    const t0 = Date.now();
    const threadId = ctx.message?.message_thread_id ?? 0;
    await disableThread(chatId, threadId);
    logger.info({ chatId, threadId, userId, durationMs: Date.now() - t0 }, "Bot disabled in thread");
    return ctx.reply("Бот отключён в этом разделе.");
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

  bot.on("message:entities:bot_command", (ctx) =>
    ctx.reply("Такой команды не существует. Используйте /help для списка доступных команд.")
  );
}
