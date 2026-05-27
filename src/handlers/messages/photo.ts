import type { Bot } from "grammy";
import { analyzeImage, generateEmbedding, GeminiBlockedError } from "../../ai/gemini";
import { askOpenRouter } from "../../ai/openrouter";
import { extractFacts } from "../../ai/extractFacts";
import { config } from "../../config";
import logger from "../../logger";
import { retry } from "../../utils/retry";
import { upsertUser } from "../../db/users";
import { saveImage } from "../../db/savedImages";
import { processing, sendResponseWithImage } from "./shared";
import { randomBusyReply, randomFactSavedReply } from "../../strings/replies";

export function registerPhotoHandler(bot: Bot): void {
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
