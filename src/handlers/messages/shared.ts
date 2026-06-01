import { generateEmbedding } from "../../ai/gemini.js";
import { findSimilarImages } from "../../db/savedImages.js";
import { getUserNsfwEnabled } from "../../db/users.js";
import logger from "../../logger.js";
import { MAX_MSG_LENGTH, MAX_CAPTION_LENGTH } from "../../constants/index.js";
import type { BotResponse } from "../../types/index.js";

export const processing = new Set<string>();

export function processingKey(chatId: number, threadId = 0): string {
  return `${chatId}:${threadId}`;
}

// Определяет, упомянут ли бот в сообщении через @username (или text_mention).
// Username берём динамически из ctx.me (кэш getMe после bot.init) — хардкодить в env не нужно.
// Работает и для текста (entities), и для фото с подписью (caption_entities).
export function isBotMentioned(ctx: any): boolean {
  const me: string | undefined = ctx.me?.username;
  const text: string | undefined = ctx.message?.text ?? ctx.message?.caption;
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities;
  if (!text || !entities) return false;

  for (const ent of entities) {
    // @username — entity типа "mention": сравниваем вырезанную подстроку с @username бота
    if (ent.type === "mention" && me) {
      const mention = text.substring(ent.offset, ent.offset + ent.length);
      if (mention.toLowerCase() === `@${me.toLowerCase()}`) return true;
    }
    // text_mention — упоминание пользователя без username (у ботов почти не встречается, но проверяем по id)
    if (ent.type === "text_mention" && ent.user?.id === ctx.me?.id) return true;
  }
  return false;
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

// nsfwEnabledOverride — флаг фильтрации NSFW для поиска картинок.
// Если не передан (личные сообщения) — берём персональную настройку отправителя.
// В группах вызывающий обязан передать настройку группы (getGroupNsfwEnabled), а не настройку конкретного юзера.
export async function sendResponseWithImage(
  ctx: any,
  chatId: number,
  answer: BotResponse,
  nsfwEnabledOverride?: boolean
): Promise<void> {
  if (!answer.imageTags || answer.imageTags.length === 0) {
    await sendMessage(ctx, answer.text);
    return;
  }

  const queryText = answer.imageTags.join(" ");
  logger.info({ chatId, tags: answer.imageTags }, "Searching similar image by embedding");

  const nsfwEnabled = nsfwEnabledOverride !== undefined
    ? nsfwEnabledOverride
    : ctx.from?.id
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
