import type { Bot } from "grammy";
import { upsertGroupChat } from "../db/groupChats";
import logger from "../logger";

export function registerMyChatMemberHandler(bot: Bot): void {
  bot.on("my_chat_member", async (ctx) => {
    const chat = ctx.chat;
    if (chat.type !== "group" && chat.type !== "supergroup") return;

    const newStatus = ctx.myChatMember.new_chat_member.status;
    const joined = ["member", "administrator", "creator"].includes(newStatus);
    const chatId = chat.id;
    const title = chat.title ?? undefined;
    const type = chat.type;
    // is_forum присутствует только у супергрупп с включёнными темами
    const topicsEnabled = "is_forum" in chat ? (chat.is_forum ?? false) : false;

    if (joined) {
      await upsertGroupChat(chatId, title, type, topicsEnabled).catch((err) =>
        logger.error({ chatId, err }, "upsertGroupChat failed on join")
      );
      logger.info({ chatId, title, type, topicsEnabled }, "Bot joined group");
    } else {
      logger.info({ chatId, title, status: newStatus }, "Bot left or was removed from group");
    }
  });
}
