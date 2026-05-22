import { Bot } from "grammy";
import { analyzeImage } from "../gemini";
import { addToHistory, askOpenRouter } from "../openrouter";
import { config } from "../config";
import logger from "../logger";
import { retry } from "../utils/retry";
import { upsertUser } from "../db/users";

const MAX_MSG_LENGTH = 4000;

const BUSY_REPLIES = [
  "Стоп. Я однопоточный. Жди.",
  "Уже думаю над предыдущим. Один мозг — одна задача.",
  "Подожди, я ещё не закончил. Структурируй мысли заранее.",
  "Эй, я не ChatGPT с датацентром. Один запрос за раз.",
  "Занят. Попробуй сформулировать всё в одном сообщении.",
  "Всё ещё обрабатываю. Ты быстрее, чем я думаю — это комплимент?",
  "Один поток, одно сообщение. Закон природы.",
  "Да погоди ты! Уже отвечаю на предыдущее.",
  "Я не параллельный. Подожди буквально несколько секунд.",
  "Обрабатываю. Пока жди — или напиши всё одним сообщением в следующий раз.",
];

const processing = new Set<number>();

function randomBusyReply(): string {
  return BUSY_REPLIES[Math.floor(Math.random() * BUSY_REPLIES.length)];
}

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

    if (processing.has(chatId)) {
      await ctx.reply(randomBusyReply(), { reply_parameters: { message_id: ctx.message.message_id } });
      return;
    }

    await upsertUser(ctx.from);
    processing.add(chatId);
    await ctx.api.sendChatAction(chatId, "typing");
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    try {
      const answer = await retry(() => askOpenRouter(ctx.from.id, ctx.message.text), 3, 1500, "OpenRouter");
      await sendMessage(ctx, answer);
    } catch (err) {
      logger.error({ chatId, err }, "OpenRouter error");
      await ctx.reply("Произошла ошибка при обращении к AI.");
      throw err;
    } finally {
      clearInterval(typingInterval);
      processing.delete(chatId);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    const prompt = ctx.message.caption ?? "Опиши подробно что изображено на картинке.";
    logger.info({ chatId }, "Photo message received");

    if (processing.has(chatId)) {
      await ctx.reply(randomBusyReply(), { reply_parameters: { message_id: ctx.message.message_id } });
      return;
    }

    await upsertUser(ctx.from);
    processing.add(chatId);
    await ctx.api.sendChatAction(chatId, "typing");
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    try {
      const photo = ctx.message.photo.at(-1)!;
      const file = await retry(() => ctx.api.getFile(photo.file_id), 3, 1500, "getFile");
      const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

      const answer = await retry(() => analyzeImage(fileUrl, prompt), 3, 1500, "Gemini");

      await addToHistory(ctx.from.id, `[Фото] ${prompt}`, answer);
      await sendMessage(ctx, answer);
    } catch (err) {
      logger.error({ chatId, err }, "Gemini error");
      await ctx.reply("Произошла ошибка при анализе изображения.");
      throw err;
    } finally {
      clearInterval(typingInterval);
      processing.delete(chatId);
    }
  });
}
