import type { Bot } from "grammy";
import { askGroupChat } from "../../ai/groupChat";
import { checkShouldRespond } from "../../ai/groupDecision";
import { getGroupNsfwEnabled } from "../../db/groupChats";
import { isThreadEnabled } from "../../db/groupEnabledThreads";
import { appendToBuffer, getBuffer } from "../../db/groupMessages";
import { upsertUser } from "../../db/users";
import { extractForwardInfo } from "../../utils/groupFormat";
import { retry } from "../../utils/retry";
import { processing, processingKey, sendResponseWithImage } from "./shared";
import { GROUP_DECISION_MSGS, GROUP_FULL_CONTEXT_SIZE } from "../../constants";
import logger from "../../logger";

export function registerGroupTextHandler(bot: Bot): void {
  bot.chatType(["group", "supergroup"]).on("message:text", async (ctx) => {

    const chatId = ctx.chat.id;
    const threadId = ctx.message.message_thread_id ?? 0;
    const userId = ctx.from.id;

    logger.debug({ chatId, threadId }, "Group text message received");

    const enabled = await isThreadEnabled(chatId, threadId);
    if (!enabled) {
      logger.debug({ chatId, threadId }, "Thread not enabled, ignoring");
      return;
    }

    upsertUser(ctx.from).catch((err) => logger.warn({ chatId, err }, "upsertUser failed"));

    const { isForward, forwardFrom } = extractForwardInfo(ctx.message);
    // Буферизируем сообщение до захвата lock — иначе при зависшем запросе сообщения теряются из истории
    await appendToBuffer({
      chatId, threadId,
      senderUserId: userId,
      senderName: ctx.from.first_name,
      senderUsername: ctx.from.username ?? null,
      content: ctx.message.text,
      isForward,
      forwardFrom,
    });

    // Если сообщение является reply на сообщение бота — сразу отвечаем, decision LLM не нужен
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
      logger.error({ chatId, threadId, err }, "Group text handler error");
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      processing.delete(key);
    }
  });
}
