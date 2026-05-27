import { generateEmbedding } from "../../ai/gemini";
import { findSimilarImages } from "../../db/savedImages";
import logger from "../../logger";
import { MAX_MSG_LENGTH } from "../../constants";
import type { BotResponse } from "../../types";

export const processing = new Set<number>();

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
    } catch {
      await ctx.reply(part);
    }
  }
  logger.info({ chatId: ctx.chat.id, durationMs: Date.now() - t0, parts: parts.length }, "Telegram sendMessage completed");
}

export async function sendResponseWithImage(ctx: any, chatId: number, answer: BotResponse): Promise<void> {
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
