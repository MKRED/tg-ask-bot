import { Bot } from "grammy";
import { analyzeImage } from "../gemini";
import { addToHistory, askOpenRouter } from "../openrouter";
import { config } from "../config";
import logger from "../logger";
import { retry } from "../utils/retry";

const MAX_MSG_LENGTH = 4000;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LENGTH) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_MSG_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", MAX_MSG_LENGTH);
    if (splitAt <= 0) splitAt = MAX_MSG_LENGTH;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt + 1);
  }

  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

async function sendMessage(ctx: any, text: string) {
  for (const part of splitMessage(text)) {
    await ctx.reply(part, { parse_mode: "HTML" });
  }
}

export function registerMessageHandlers(bot: Bot): void {
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    logger.info({ chatId, length: ctx.message.text.length }, "Text message received");

    await ctx.api.sendChatAction(chatId, "typing");
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    try {
      const answer = await retry(() => askOpenRouter(chatId, ctx.message.text), 3, 1500, "OpenRouter");
      await sendMessage(ctx, answer);
    } catch (err) {
      logger.error({ chatId, err }, "OpenRouter error");
      await ctx.reply("Произошла ошибка при обращении к AI.");
      throw err;
    } finally {
      clearInterval(typingInterval);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    const prompt = ctx.message.caption ?? "Опиши подробно что изображено на картинке.";
    logger.info({ chatId }, "Photo message received");

    await ctx.api.sendChatAction(chatId, "typing");
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    try {
      const photo = ctx.message.photo.at(-1)!;
      const file = await retry(() => ctx.api.getFile(photo.file_id), 3, 1500, "getFile");
      const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

      const answer = await retry(() => analyzeImage(fileUrl, prompt), 3, 1500, "Gemini");

      addToHistory(chatId, `[Фото] ${prompt}`, answer);
      await sendMessage(ctx, answer);
    } catch (err) {
      logger.error({ chatId, err }, "Gemini error");
      await ctx.reply("Произошла ошибка при анализе изображения.");
      throw err;
    } finally {
      clearInterval(typingInterval);
    }
  });
}
