import type { Bot } from "grammy";
import logger from "../../logger";
import {
  randomUnsupportedVideoReply,
  randomUnsupportedAnimationReply,
  randomUnsupportedStickerReply,
  randomUnsupportedVoiceReply,
  randomUnsupportedAudioReply,
  randomUnsupportedDocumentReply,
  randomUnsupportedVideoNoteReply,
} from "../../strings/replies";

export function registerUnsupportedHandlers(bot: Bot): void {
  const dm = bot.chatType("private");

  dm.on("message:video", async (ctx) => {
    logger.debug({ chatId: ctx.chat.id }, "Unsupported message type: video");
    await ctx.reply(randomUnsupportedVideoReply(), { reply_parameters: { message_id: ctx.message.message_id } });
  });

  dm.on("message:animation", async (ctx) => {
    logger.debug({ chatId: ctx.chat.id }, "Unsupported message type: animation");
    await ctx.reply(randomUnsupportedAnimationReply(), { reply_parameters: { message_id: ctx.message.message_id } });
  });

  dm.on("message:sticker", async (ctx) => {
    logger.debug({ chatId: ctx.chat.id }, "Unsupported message type: sticker");
    await ctx.reply(randomUnsupportedStickerReply(), { reply_parameters: { message_id: ctx.message.message_id } });
  });

  dm.on("message:voice", async (ctx) => {
    logger.debug({ chatId: ctx.chat.id }, "Unsupported message type: voice");
    await ctx.reply(randomUnsupportedVoiceReply(), { reply_parameters: { message_id: ctx.message.message_id } });
  });

  dm.on("message:audio", async (ctx) => {
    logger.debug({ chatId: ctx.chat.id }, "Unsupported message type: audio");
    await ctx.reply(randomUnsupportedAudioReply(), { reply_parameters: { message_id: ctx.message.message_id } });
  });

  dm.on("message:document", async (ctx) => {
    logger.debug({ chatId: ctx.chat.id }, "Unsupported message type: document");
    await ctx.reply(randomUnsupportedDocumentReply(), { reply_parameters: { message_id: ctx.message.message_id } });
  });

  dm.on("message:video_note", async (ctx) => {
    logger.debug({ chatId: ctx.chat.id }, "Unsupported message type: video_note");
    await ctx.reply(randomUnsupportedVideoNoteReply(), { reply_parameters: { message_id: ctx.message.message_id } });
  });
}
