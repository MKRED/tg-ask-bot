import { Bot } from "grammy";
import { analyzeImage } from "../gemini";
import { addToHistory, askOpenRouter } from "../openrouter";
import { config } from "../config";

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

    await ctx.api.sendChatAction(chatId, "typing");
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    try {
      let answer: string;
      try {
        answer = await askOpenRouter(chatId, ctx.message.text);
      } catch {
        answer = await askOpenRouter(chatId, ctx.message.text);
      }
      await sendMessage(ctx, answer);
    } catch (err) {
      await ctx.reply("Произошла ошибка при обращении к AI.");
      throw err;
    } finally {
      clearInterval(typingInterval);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    const prompt = ctx.message.caption ?? "Опиши подробно что изображено на картинке.";

    await ctx.api.sendChatAction(chatId, "typing");
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    try {
      const photo = ctx.message.photo.at(-1)!;
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

      let answer: string;
      try {
        answer = await analyzeImage(fileUrl, prompt);
      } catch {
        answer = await analyzeImage(fileUrl, prompt);
      }

      addToHistory(chatId, `[Фото] ${prompt}`, answer);
      await sendMessage(ctx, answer);
    } catch (err) {
      await ctx.reply("Произошла ошибка при анализе изображения.");
      throw err;
    } finally {
      clearInterval(typingInterval);
    }
  });
}
