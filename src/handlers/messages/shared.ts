import { generateEmbedding } from "../../ai/gemini";
import { findSimilarImages } from "../../db/savedImages";
import { getUserNsfwEnabled } from "../../db/users";
import logger from "../../logger";
import { MAX_MSG_LENGTH, MAX_CAPTION_LENGTH } from "../../constants";
import type { BotResponse } from "../../types";

export const processing = new Set<string>();

export function processingKey(chatId: number, threadId = 0): string {
  return `${chatId}:${threadId}`;
}

export function splitMessage(text: string): string[] {
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

export async function sendMessage(ctx: any, text: string): Promise<void> {
  const parts = splitMessage(text);
  const t0 = Date.now();
  for (const part of parts) {
    try {
      await ctx.reply(part, { parse_mode: "HTML" });
    } catch (htmlErr) {
      logger.warn({ chatId: ctx.chat.id, err: htmlErr }, "HTML parse_mode failed, retrying as plain text");
      await ctx.reply(part);
    }
  }
  logger.info({ chatId: ctx.chat.id, durationMs: Date.now() - t0, parts: parts.length }, "Telegram sendMessage completed");
}

export async function sendResponseWithImage(ctx: any, chatId: number, answer: BotResponse): Promise<void> {
  if (!answer.imageTags || answer.imageTags.length === 0) {
    await sendMessage(ctx, answer.text);
    return;
  }

  const queryText = answer.imageTags.join(" ");
  logger.info({ chatId, tags: answer.imageTags }, "Searching similar image by embedding");

  const nsfwEnabled = ctx.from?.id
    ? await getUserNsfwEnabled(ctx.from.id).catch(() => false)
    : false;

  let images: Awaited<ReturnType<typeof findSimilarImages>> = [];
  try {
    const embedding = await generateEmbedding(queryText);
    images = await findSimilarImages(embedding, nsfwEnabled);
  } catch (err) {
    logger.warn({ chatId, err }, "Image retrieval failed, sending text only");
    await sendMessage(ctx, answer.text);
    return;
  }

  if (images.length === 0) {
    logger.info({ chatId, tags: answer.imageTags }, "Image requested but no match found in DB");
    await sendMessage(ctx, answer.text);
    return;
  }

  const chosen = images[0];
  logger.info({ chatId, imageId: chosen.id, tags: answer.imageTags }, "Sending image with caption");

  // Подписи к фото в Telegram ограничены 1024 символами; если текст длиннее — отправляем его отдельным сообщением
  if (answer.text.length <= MAX_CAPTION_LENGTH) {
    try {
      await ctx.replyWithPhoto(chosen.fileId, { caption: answer.text, parse_mode: "HTML" });
    } catch {
      await ctx.replyWithPhoto(chosen.fileId, { caption: answer.text });
    }
  } else {
    await sendMessage(ctx, answer.text);
    await ctx.replyWithPhoto(chosen.fileId).catch((err: unknown) => logger.warn({ chatId, err }, "replyWithPhoto failed after text"));
  }
}
