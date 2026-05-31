import type { Bot } from "grammy";
import { analyzeImage, generateEmbedding, GeminiBlockedError } from "../../ai/gemini";
import { analyzeImageOllama } from "../../ai/ollama";
import { askOpenRouter } from "../../ai/openrouter";
import { extractFacts } from "../../ai/extractFacts";
import { config } from "../../config";
import logger from "../../logger";
import { retry } from "../../utils/retry";
import { upsertUser } from "../../db/users";
import { saveImage } from "../../db/savedImages";
import { processing, processingKey, sendResponseWithImage } from "./shared";
import { randomBusyReply, randomFactSavedReply, randomProcessingReply } from "../../strings/replies";

export function registerPhotoHandler(bot: Bot): void {
  bot.chatType("private").on("message:photo", async (ctx) => {

    const chatId = ctx.chat.id;
    logger.info({ chatId }, "Photo message received");

    const key = processingKey(chatId);
    if (processing.has(key)) {
      await ctx.reply(randomBusyReply(), { reply_parameters: { message_id: ctx.message.message_id } });
      return;
    }

    upsertUser(ctx.from, true).catch((err) => logger.error({ chatId, err }, "upsertUser failed"));
    processing.add(key);
    // Fire-and-forget: если упадёт — просто не покажется индикатор печатания
    ctx.api.sendChatAction(chatId, "typing").catch((err) => logger.debug({ chatId, err }, "sendChatAction failed"));
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch((err) => logger.debug({ chatId, err }, "sendChatAction interval failed"));
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
        // Fire-and-forget: генерация эмбеддинга и сохранение в БД выполняются в фоне после отправки ответа
        (async () => {
          let embedding: number[];
          try {
            embedding = await generateEmbedding(embeddingText);
          } catch (err) {
            logger.warn({ chatId, err }, "Gemini embedding failed, image will not be saved");
            return;
          }
          saveImage({ fileId: photo.file_id, senderUserId: ctx.from.id, description: imageAnalysis.description, caption, moodTags: imageAnalysis.moodTags, contentTags: imageAnalysis.contentTags, isNsfw: imageAnalysis.isNsfw, embedding })
            .then(() => logger.info({ chatId, moodTags: imageAnalysis.moodTags, contentTags: imageAnalysis.contentTags, isNsfw: imageAnalysis.isNsfw }, "Image saved to DB with embedding"))
            .catch((err) => logger.warn({ chatId, err }, "Failed to save image to DB"));
        })();
      } catch (geminiErr) {
        const blocked = geminiErr instanceof GeminiBlockedError;
        if (blocked) {
          logger.info({ chatId, blockReason: (geminiErr as GeminiBlockedError).blockReason }, "Gemini blocked image, falling back to Ollama");
        } else {
          logger.warn({ chatId, err: geminiErr }, "Gemini failed, falling back to Ollama");
        }

        const processingMsg = await ctx.reply(randomProcessingReply()).catch((err) => { logger.warn({ chatId, err }, "Failed to send processing message"); return null; });
        try {
          const imageAnalysis = await analyzeImageOllama(fileUrl);
          const caption = ctx.message.caption ?? null;
          userMessage = caption
            ? `${caption}\n\n[Photo: ${imageAnalysis.description}]`
            : `[User sent a photo without caption]\n\n[Photo: ${imageAnalysis.description}]`;

          const embeddingText = `${imageAnalysis.description} ${[...imageAnalysis.moodTags, ...imageAnalysis.contentTags].join(" ")}`;
          // Fire-and-forget: генерация эмбеддинга и сохранение в БД выполняются в фоне после отправки ответа
          (async () => {
            let embedding: number[];
            try {
              embedding = await generateEmbedding(embeddingText);
            } catch (err) {
              logger.warn({ chatId, err }, "Gemini embedding failed for Ollama image (likely content policy), image will not be saved");
              return;
            }
            saveImage({ fileId: photo.file_id, senderUserId: ctx.from.id, description: imageAnalysis.description, caption, moodTags: imageAnalysis.moodTags, contentTags: imageAnalysis.contentTags, isNsfw: imageAnalysis.isNsfw, embedding })
              .then(() => logger.info({ chatId, moodTags: imageAnalysis.moodTags, contentTags: imageAnalysis.contentTags, isNsfw: imageAnalysis.isNsfw }, "Image saved to DB with Ollama embedding"))
              .catch((err) => logger.warn({ chatId, err }, "Failed to save Ollama image to DB"));
          })();
        } catch (ollamaErr) {
          logger.error({ chatId, err: ollamaErr }, "Ollama fallback failed");
          userMessage = "[User sent a photo, but it could not be analyzed — neither Gemini nor the local model could process it. React in your own style, don't just say sorry.]";
        } finally {
          if (processingMsg) {
            ctx.api.deleteMessage(chatId, processingMsg.message_id).catch((err) => logger.debug({ chatId, err }, "deleteMessage (processing) failed"));
          }
        }
      }

      const answer = await retry(() => askOpenRouter(ctx.from.id, userMessage), 3, 1500, "OpenRouter");
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
      logger.error({ chatId, err }, "Photo handler error");
      await ctx.reply("Произошла ошибка при обработке запроса.").catch((err) => logger.warn({ chatId, err }, "Failed to send error reply"));
      throw err;
    } finally {
      clearInterval(typingInterval);
      processing.delete(key);
    }
  });
}
