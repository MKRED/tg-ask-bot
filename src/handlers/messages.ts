import { Bot } from "grammy";
import { analyzeImage, generateEmbedding, GeminiBlockedError } from "../gemini";
import { askOpenRouter, type BotResponse } from "../openrouter";
import { extractFacts } from "../extractFacts";
import { config } from "../config";
import logger from "../logger";
import { retry } from "../utils/retry";
import { upsertUser } from "../db/users";
import { saveImage, findSimilarImages } from "../db/savedImages";

const MAX_MSG_LENGTH = 4000;

const FACT_SAVED_REPLIES = [
  "✨ Запомнил кое-что о тебе",
  "🧠 Принял к сведению",
  "📌 Зафиксировал",
  "💾 Сохранил в памяти",
  "🔖 Отметил для себя",
  "✅ Учту в следующий раз",
  "📝 Записал",
  "💡 Понял, запомнил",
  "🗂️ Добавил в досье",
  "🤫 Запомнил, никому не скажу",
];

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

function randomFactSavedReply(): string {
  return FACT_SAVED_REPLIES[Math.floor(Math.random() * FACT_SAVED_REPLIES.length)];
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

async function sendResponseWithImage(ctx: any, chatId: number, answer: BotResponse): Promise<void> {
  await sendMessage(ctx, answer.text);
  if (!answer.imageTags || answer.imageTags.length === 0) return;
  const queryText = answer.imageTags.join(" ");
  logger.info({ chatId, tags: answer.imageTags }, "Searching similar image by embedding");
  generateEmbedding(queryText)
    .then((embedding) => findSimilarImages(embedding))
    .then(async (images) => {
      if (images.length === 0) {
        logger.info({ chatId, tags: answer.imageTags }, "Image requested but no match found in DB");
        return;
      }
      const chosen = images[0];
      logger.info({ chatId, imageId: chosen.id, tags: answer.imageTags }, "Sending image with response");
      await ctx.replyWithPhoto(chosen.fileId).catch(() => {});
    })
    .catch((err) => logger.warn({ chatId, err }, "Image retrieval failed"));
}

async function sendMessage(ctx: any, text: string) {
  const parts = splitMessage(text);
  const t0 = Date.now();
  for (const part of parts) {
    try {
      await ctx.reply(part, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(part);
    }
  }
  logger.info({ chatId: ctx.chat.id, durationMs: Date.now() - t0, parts: parts.length }, "Telegram sendMessage completed");
}

export function registerMessageHandlers(bot: Bot): void {
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    logger.info({ chatId, length: ctx.message.text.length }, "Text message received");

    if (processing.has(chatId)) {
      await ctx.reply(randomBusyReply(), { reply_parameters: { message_id: ctx.message.message_id } });
      return;
    }

    upsertUser(ctx.from).catch((err) => logger.error({ chatId, err }, "upsertUser failed"));
    processing.add(chatId);
    ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    try {
      const answer = await retry(() => askOpenRouter(ctx.from.id, ctx.message.text), 3, 1500, "OpenRouter");
      await sendResponseWithImage(ctx, chatId, answer);
      extractFacts(ctx.from.id).then(async (count) => {
        if (count > 0) {
          const note = await ctx.reply(randomFactSavedReply());
          setTimeout(() => ctx.api.deleteMessage(chatId, note.message_id).catch(() => {}), 4000);
        }
      }).catch((err) => logger.warn({ chatId, err }, "Fact extraction failed"));
    } catch (err) {
      logger.error({ chatId, err }, "OpenRouter error");
      await ctx.reply("Произошла ошибка при обращении к AI.").catch(() => {});
      throw err;
    } finally {
      clearInterval(typingInterval);
      processing.delete(chatId);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    logger.info({ chatId }, "Photo message received");

    if (processing.has(chatId)) {
      await ctx.reply(randomBusyReply(), { reply_parameters: { message_id: ctx.message.message_id } });
      return;
    }

    upsertUser(ctx.from).catch((err) => logger.error({ chatId, err }, "upsertUser failed"));
    processing.add(chatId);
    ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    try {
      const photo = ctx.message.photo.at(-1)!;
      const file = await retry(() => ctx.api.getFile(photo.file_id), 3, 1500, "getFile");
      const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

      let userMessage: string;

      try {
        const imageAnalysis = await retry(
          () => analyzeImage(fileUrl),
          3, 1500, "Gemini",
          (err) => !(err instanceof GeminiBlockedError)
        );
        const caption = ctx.message.caption ?? null;
        userMessage = caption
          ? `${caption}\n\n[Photo: ${imageAnalysis.description}]`
          : `[User sent a photo without caption]\n\n[Photo: ${imageAnalysis.description}]`;

        const embeddingText = `${imageAnalysis.description} ${[...imageAnalysis.moodTags, ...imageAnalysis.contentTags].join(" ")}`;
        generateEmbedding(embeddingText)
          .then((embedding) => saveImage({
            fileId: photo.file_id,
            senderUserId: ctx.from.id,
            description: imageAnalysis.description,
            caption,
            moodTags: imageAnalysis.moodTags,
            contentTags: imageAnalysis.contentTags,
            embedding,
          }))
          .then(() => logger.info({ chatId, moodTags: imageAnalysis.moodTags, contentTags: imageAnalysis.contentTags }, "Image saved to DB with embedding"))
          .catch((err) => logger.warn({ chatId, err }, "Failed to save image to DB"));
      } catch (err) {
        if (err instanceof GeminiBlockedError) {
          logger.info({ chatId, blockReason: err.blockReason }, "Gemini blocked image");
          userMessage = "[User sent a photo that was blocked by content policy]";
        } else {
          logger.error({ chatId, err }, "Gemini error");
          await ctx.reply("Не удалось распознать изображение. Попробуй ещё раз.").catch(() => {});
          return;
        }
      }

      const answer = await retry(() => askOpenRouter(ctx.from.id, userMessage), 3, 1500, "OpenRouter");
      await sendResponseWithImage(ctx, chatId, answer);
      extractFacts(ctx.from.id).then(async (count) => {
        if (count > 0) {
          const note = await ctx.reply(randomFactSavedReply());
          setTimeout(() => ctx.api.deleteMessage(chatId, note.message_id).catch(() => {}), 4000);
        }
      }).catch((err) => logger.warn({ chatId, err }, "Fact extraction failed"));
    } catch (err) {
      logger.error({ chatId, err }, "Photo handler error");
      await ctx.reply("Произошла ошибка при обработке запроса.").catch(() => {});
      throw err;
    } finally {
      clearInterval(typingInterval);
      processing.delete(chatId);
    }
  });
}
