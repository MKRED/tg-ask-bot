import type { Bot } from "grammy";
import { generateEmbedding } from "../../ai/gemini.js";
import { askGroupChat } from "../../ai/groupChat.js";
import { checkShouldRespond } from "../../ai/groupDecision.js";
import { getGroupNsfwEnabled } from "../../db/groupChats.js";
import { getThreadMode } from "../../db/groupEnabledThreads.js";
import { appendToBuffer, getBuffer } from "../../db/groupMessages.js";
import { addIngestImage, updateIngestImage } from "../../db/groupIngestImages.js";
import { saveImage } from "../../db/savedImages.js";
import { upsertUser } from "../../db/users.js";
import { extractForwardInfo } from "../../utils/groupFormat.js";
import { retry } from "../../utils/retry.js";
import { processing, processingKey, sendResponseWithImage, isBotMentioned } from "./shared.js";
import { scheduleDigest } from "./ingestDigest.js";
import { analyzePhotoWithFallback } from "./photoAnalysis.js";
import { GROUP_DECISION_MSGS, GROUP_FULL_CONTEXT_SIZE } from "../../constants/index.js";
import { config } from "../../config.js";
import logger from "../../logger.js";

export function registerGroupPhotoHandler(bot: Bot): void {
  bot.chatType(["group", "supergroup"]).on("message:photo", async (ctx) => {

    const chatId = ctx.chat.id;
    const threadId = ctx.message.message_thread_id ?? 0;
    const userId = ctx.from.id;

    logger.debug({ chatId, threadId }, "Group photo message received");

    const mode = await getThreadMode(chatId, threadId);
    if (!mode) {
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
    if (!file) {
      // В ingest-режиме учитываем ошибку Telegram в статистике батча
      if (mode === "ingest") {
        addIngestImage({ chatId, threadId, fileId: null, analyzedBy: "telegram_error", moodTags: [], contentTags: [], isNsfw: false })
          .catch((err) => logger.warn({ chatId, threadId, err }, "Failed to track telegram_error in ingest batch"));
        scheduleDigest(chatId, threadId, ctx.api);
      }
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const { isForward, forwardFrom } = extractForwardInfo(ctx.message);
    const senderName = ctx.from.first_name;
    const senderUsername = ctx.from.username ?? null;
    const caption = ctx.message.caption ?? null;

    // В ingest-режиме вставляем строку "pending" сразу, до анализа.
    // Если бот упадёт во время очереди Ollama — картинка уже в БД и не потеряется из статистики.
    let ingestRowId: number | null = null;
    if (mode === "ingest") {
      try {
        ingestRowId = await addIngestImage({
          chatId, threadId, fileId: photo.file_id,
          analyzedBy: "pending", moodTags: [], contentTags: [], isNsfw: false,
          senderUserId: userId,
          caption,
        });
      } catch (err) {
        logger.warn({ chatId, threadId, err }, "Failed to insert pending ingest row");
      }
    }

    const { imageAnalysis, analyzedBy } = await analyzePhotoWithFallback(fileUrl, { chatId, threadId });

    let userContent: string;
    if (imageAnalysis) {
      userContent = caption
        ? `${caption}\n\n[Photo: ${imageAnalysis.description}]`
        : `[User sent a photo without caption]\n\n[Photo: ${imageAnalysis.description}]`;
    } else {
      userContent = "[User sent a photo, but it could not be analyzed. React in your own style.]";
    }

    // Всегда сохраняем изображение в БД — fire-and-forget.
    // Делаем это до буфера: в режиме ingest буфер не нужен, а картинку всё равно надо поглотить.
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

    // Режим «пожиратель»: обновляем pending-строку реальным результатом анализа и уходим.
    if (mode === "ingest") {
      if (ingestRowId !== null) {
        updateIngestImage(ingestRowId, {
          analyzedBy,
          moodTags: imageAnalysis?.moodTags ?? [],
          contentTags: imageAnalysis?.contentTags ?? [],
          isNsfw: imageAnalysis?.isNsfw ?? false,
        }).catch((err) => logger.warn({ chatId, threadId, err }, "Failed to update ingest image"));
      }
      scheduleDigest(chatId, threadId, ctx.api);
      logger.info({ chatId, threadId, analyzedBy }, "Ingest mode: photo processed, staying silent");
      return;
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

    // Прямое обращение к боту — reply на его сообщение или @упоминание в подписи к фото.
    // В обоих случаях decision LLM не нужен: отвечаем сразу.
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
    const isMentioned = isBotMentioned(ctx);
    const isDirectAddress = isReplyToBot || isMentioned;

    const key = processingKey(chatId, threadId);
    if (processing.has(key)) return;
    processing.add(key);

    let typingInterval: ReturnType<typeof setInterval> | null = null;

    try {
      if (!isDirectAddress) {
        const decisionBuffer = await getBuffer(chatId, threadId, GROUP_DECISION_MSGS);
        const { shouldRespond } = await checkShouldRespond(chatId, threadId, decisionBuffer);
        if (!shouldRespond) return;
      } else {
        logger.info({ chatId, threadId, isReplyToBot, isMentioned }, "Direct address detected, skipping decision LLM");
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
