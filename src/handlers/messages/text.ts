import type { Bot } from "grammy";
import { askOpenRouter } from "../../ai/openrouter";
import { extractFacts } from "../../ai/extractFacts";
import logger from "../../logger";
import { retry } from "../../utils/retry";
import { upsertUser } from "../../db/users";
import { processing, processingKey, sendResponseWithImage } from "./shared";
import { randomBusyReply, randomFactSavedReply } from "../../strings/replies";

export function registerTextHandler(bot: Bot): void {
  bot.chatType("private").on("message:text", async (ctx) => {

    const chatId = ctx.chat.id;
    logger.info({ chatId, length: ctx.message.text.length }, "Text message received");

    const key = processingKey(chatId);
    if (processing.has(key)) {
      await ctx.reply(randomBusyReply(), { reply_parameters: { message_id: ctx.message.message_id } });
      return;
    }

    upsertUser(ctx.from).catch((err) => logger.error({ chatId, err }, "upsertUser failed"));
    processing.add(key);
    // Fire-and-forget: если упадёт — просто не покажется индикатор печатания
    ctx.api.sendChatAction(chatId, "typing").catch((err) => logger.debug({ chatId, err }, "sendChatAction failed"));
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch((err) => logger.debug({ chatId, err }, "sendChatAction interval failed"));
    }, 4000);

    try {
      const answer = await retry(() => askOpenRouter(ctx.from.id, ctx.message.text), 3, 1500, "OpenRouter");
      await sendResponseWithImage(ctx, chatId, answer);
      extractFacts(ctx.from.id)
        .then(async (count) => {
          if (count > 0) {
            const note = await ctx.reply(randomFactSavedReply()).catch((err) => {
              logger.warn({ chatId, err }, "Failed to send fact-saved notification");
              return null;
            });
            if (note) {
              setTimeout(() => ctx.api.deleteMessage(chatId, note.message_id).catch((err) => logger.debug({ chatId, err }, "deleteMessage (fact note) failed")), 4000);
            }
          }
        })
        .catch((err) => logger.warn({ chatId, err }, "Fact extraction failed"));
    } catch (err) {
      logger.error({ chatId, err }, "OpenRouter error");
      await ctx.reply("Произошла ошибка при обращении к AI.").catch((err) => logger.warn({ chatId, err }, "Failed to send error reply"));
      throw err;
    } finally {
      clearInterval(typingInterval);
      processing.delete(key);
    }
  });
}
