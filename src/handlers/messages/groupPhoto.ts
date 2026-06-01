import type { Bot } from "grammy";
import { analyzeImage, generateEmbedding, GeminiBlockedError } from "../../ai/gemini.js";
import { analyzeImageOllama } from "../../ai/ollama.js";
import { askGroupChat } from "../../ai/groupChat.js";
import { checkShouldRespond } from "../../ai/groupDecision.js";
import { getGroupNsfwEnabled } from "../../db/groupChats.js";
import { getThreadMode } from "../../db/groupEnabledThreads.js";
import { appendToBuffer, getBuffer } from "../../db/groupMessages.js";
import { saveImage } from "../../db/savedImages.js";
import { upsertUser } from "../../db/users.js";
import { extractForwardInfo } from "../../utils/groupFormat.js";
import { retry } from "../../utils/retry.js";
import { processing, processingKey, sendResponseWithImage, isBotMentioned } from "./shared.js";
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

    // Режим «пожиратель»: картинку обработали — на этом всё. Ни буфера, ни decision, ни ответа.
    // saved=false означает, что и Gemini, и Ollama не смогли распознать картинку (см. error-логи выше),
    // поэтому в базу ничего не ушло — картинка молча пропущена.
    if (mode === "ingest") {
      logger.info({ chatId, threadId, saved: imageAnalysis !== null }, "Ingest mode: photo processed, staying silent");
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
