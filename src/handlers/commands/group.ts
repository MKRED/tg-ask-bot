// Групповые команды управления ботом (только администраторы): /botstart, /botingest, /botstop.
import { Bot } from "grammy";
import { enableThread, disableThread } from "../../db/groupEnabledThreads.js";
import { ensureGroupAdmin } from "./shared.js";
import logger from "../../logger.js";

export function registerGroupCommands(bot: Bot): void {
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
}
