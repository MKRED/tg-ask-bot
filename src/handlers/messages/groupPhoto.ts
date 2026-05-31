import type { Bot } from "grammy";
import { analyzeImage, generateEmbedding, GeminiBlockedError } from "../../ai/gemini";
import { analyzeImageOllama } from "../../ai/ollama";
import { askGroupChat } from "../../ai/groupChat";
import { checkShouldRespond } from "../../ai/groupDecision";
import { getGroupNsfwEnabled } from "../../db/groupChats";
import { isThreadEnabled } from "../../db/groupEnabledThreads";
import { appendToBuffer, getBuffer } from "../../db/groupMessages";
import { saveImage } from "../../db/savedImages";
import { upsertUser } from "../../db/users";
import { extractForwardInfo } from "../../utils/groupFormat";
import { retry } from "../../utils/retry";
import { processing, processingKey, sendResponseWithImage } from "./shared";
import { GROUP_DECISION_MSGS, GROUP_FULL_CONTEXT_SIZE } from "../../constants";
import { config } from "../../config";
import logger from "../../logger";

export function registerGroupPhotoHandler(bot: Bot): void {
  bot.chatType(["group", "supergroup"]).on("message:photo", async (ctx) => {

    const chatId = ctx.chat.id;
    const threadId = ctx.message.message_thread_id ?? 0;
    const userId = ctx.from.id;

    logger.debug({ chatId, threadId }, "Group photo message received");

    const enabled = await isThreadEnabled(chatId, threadId);
    if (!enabled) {
      logger.debug({ chatId, threadId }, "Thread not enabled, ignoring photo");
      return;
    }

    upsertUser(ctx.from).catch((err) => logger.warn({ chatId, err }, "upsertUser failed"));

    logger.info({ chatId, threadId }, "Group photo received — analyzing");

    const photo = ctx.message.photo.at(-1)!;
    const file = await retry(() => ctx.api.getFile(photo.file_id), 3, 1500, "getFile").catch((err) => {
      logger.error({ chatId, threadId, err }, "getFile failed for group photo");
      return null;
    });
    if (!file) return;

    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const { isForward, forwardFrom } = extractForwardInfo(ctx.message);
    const senderName = ctx.from.first_name;
    const senderUsername = ctx.from.username ?? null;
    const caption = ctx.message.caption ?? null;

    let userContent: string;
    let imageAnalysis: { description: string; moodTags: string[]; contentTags: string[]; isNsfw: boolean } | null = null;

    try {
      imageAnalysis = await retry(
        () => analyzeImage(fileUrl),
        3, 1500, "Gemini",
        (err) => !(err instanceof GeminiBlockedError)
      );
      userContent = caption
        ? `${caption}\n\n[Photo: ${imageAnalysis.description}]`
        : `[User sent a photo without caption]\n\n[Photo: ${imageAnalysis.description}]`;
    } catch (geminiErr) {
      const blocked = geminiErr instanceof GeminiBlockedError;
      if (blocked) {
        logger.info({ chatId, threadId, blockReason: (geminiErr as GeminiBlockedError).blockReason }, "Gemini blocked group image, falling back to Ollama");
      } else {
        logger.warn({ chatId, threadId, err: geminiErr }, "Gemini failed for group photo, falling back to Ollama");
      }

      try {
        const ollamaAnalysis = await analyzeImageOllama(fileUrl);
        imageAnalysis = ollamaAnalysis;
        userContent = caption
          ? `${caption}\n\n[Photo: ${ollamaAnalysis.description}]`
          : `[User sent a photo without caption]\n\n[Photo: ${ollamaAnalysis.description}]`;
      } catch (ollamaErr) {
        logger.error({ chatId, threadId, err: ollamaErr }, "Ollama fallback also failed for group photo");
        userContent = "[User sent a photo, but it could not be analyzed. React in your own style.]";
      }
    }

    // Встраиваем forward-инфо в контент если есть
    const bufferContent = isForward && forwardFrom
      ? `[переслано от ${forwardFrom}]\n${userContent}`
      : userContent;

    await appendToBuffer({
      chatId, threadId,
      senderUserId: userId,
      senderName,
      senderUsername,
      content: bufferContent,
      isForward,
      forwardFrom,
    });

    // Всегда сохраняем изображение в БД — fire-and-forget
    if (imageAnalysis) {
      const analysis = imageAnalysis;
      (async () => {
        let embedding: number[];
        try {
          const embeddingText = `${analysis.description} ${[...analysis.moodTags, ...analysis.contentTags].join(" ")}`;
          embedding = await generateEmbedding(embeddingText);
        } catch (err) {
          logger.warn({ chatId, threadId, err }, "Embedding failed for group photo, image will not be saved");
          return;
        }
        saveImage({
          fileId: photo.file_id,
          senderUserId: userId,
          description: analysis.description,
          caption,
          moodTags: analysis.moodTags,
          contentTags: analysis.contentTags,
          isNsfw: analysis.isNsfw,
          embedding,
        })
          .then(() => logger.info({ chatId, threadId, moodTags: analysis.moodTags, isNsfw: analysis.isNsfw }, "Group photo saved to DB"))
          .catch((err) => logger.warn({ chatId, threadId, err }, "Failed to save group photo to DB"));
      })();
    }

    // Если фото является reply на сообщение бота — сразу отвечаем, decision LLM не нужен
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;

    const key = processingKey(chatId, threadId);
    if (processing.has(key)) return;
    processing.add(key);

    let typingInterval: ReturnType<typeof setInterval> | null = null;

    try {
      if (!isReplyToBot) {
        const decisionBuffer = await getBuffer(chatId, threadId, GROUP_DECISION_MSGS);
        const { shouldRespond } = await checkShouldRespond(chatId, threadId, decisionBuffer);
        if (!shouldRespond) return;
      } else {
        logger.info({ chatId, threadId }, "Reply to bot detected, skipping decision LLM");
      }

      const threadOpts = threadId !== 0 ? { message_thread_id: threadId } : {};
      ctx.api.sendChatAction(chatId, "typing", threadOpts).catch((err) => logger.debug({ chatId, err }, "sendChatAction failed"));
      typingInterval = setInterval(() => {
        ctx.api.sendChatAction(chatId, "typing", threadOpts).catch((err) => logger.debug({ chatId, err }, "sendChatAction interval failed"));
      }, 4000);

      const fullBuffer = await getBuffer(chatId, threadId, GROUP_FULL_CONTEXT_SIZE);
      const nsfwEnabled = await getGroupNsfwEnabled(chatId);
      const answer = await retry(
        () => askGroupChat({ chatId, threadId, fullBuffer, nsfwEnabled }),
        2, 1500, "OpenRouter-group"
      );
      await sendResponseWithImage(ctx, chatId, answer, nsfwEnabled);
    } catch (err) {
      logger.error({ chatId, threadId, err }, "Group photo handler error");
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      processing.delete(key);
    }
  });
}
