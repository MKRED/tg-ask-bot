import type { Bot } from "grammy";
import type { InlineQueryResultCachedPhoto } from "grammy/types";
import { generateTextEmbedding } from "../../ai/gemini/index.js";
import { getCachedEmbedding, cacheEmbedding } from "../../db/searchEmbeddings.js";
import { findSimilarImages, findRandomImages } from "../../db/savedImages.js";
import { getDanbooruIdsByImageIds } from "../../db/danbooruPosts.js";
import { danbooruPostUrl } from "../../sources/danbooru/transform.js";
import { getUserNsfwEnabled } from "../../db/users.js";
import {
  INLINE_MIN_QUERY_LEN,
  INLINE_PAGE_SIZE,
  INLINE_MAX_RESULTS,
  INLINE_BROWSE_COUNT,
  INLINE_CACHE_TIME,
} from "./constants.js";
import { normalizeQuery, parseOffset, computeNextOffset } from "./paginate.js";
import type { SavedImage } from "../../db/schema.js";
import logger from "../../logger.js";

// danbooruIds: saved_image_id → danbooru_id. Для картинок с Danbooru вешаем inline-кнопку
// со ссылкой на пост; у остальных (загруженных пользователями) кнопки нет.
function toResults(images: SavedImage[], danbooruIds: Map<number, number>): InlineQueryResultCachedPhoto[] {
  return images.map((img) => {
    const result: InlineQueryResultCachedPhoto = {
      type: "photo",
      id: String(img.id),
      photo_file_id: img.fileId,
    };
    const danbooruId = danbooruIds.get(img.id);
    if (danbooruId !== undefined) {
      result.reply_markup = { inline_keyboard: [[{ text: "🔗 Danbooru", url: danbooruPostUrl(danbooruId) }]] };
    }
    return result;
  });
}

// Достаём вектор запроса: сначала кэш, при промахе — Gemini + запись в кэш (fire-and-forget,
// сбой кэша не должен ломать выдачу).
async function resolveEmbedding(norm: string, userId: number): Promise<number[]> {
  const cached = await getCachedEmbedding(norm);
  if (cached) return cached;
  const embedding = await generateTextEmbedding(norm);
  cacheEmbedding(norm, embedding, userId).catch((err) => logger.warn({ err, norm }, "Failed to cache search embedding"));
  return embedding;
}

export function registerInlineQueryHandler(bot: Bot): void {
  // ВАЖНО: эти апдейты приходят, только если у бота включён inline-режим у BotFather
  // (/setinline). inline_query входит в дефолтный allowed_updates getUpdates — если
  // когда-нибудь появится явный список allowed_updates, его сюда нужно добавить, иначе
  // inline молча перестанет работать.
  bot.on("inline_query", async (ctx) => {
    const userId = ctx.from.id;
    const norm = normalizeQuery(ctx.inlineQuery.query);
    const offset = parseOffset(ctx.inlineQuery.offset);
    const t0 = Date.now();

    try {
      const nsfwEnabled = await getUserNsfwEnabled(userId);

      let images: SavedImage[];
      let mode: "browse" | "search";
      // next_offset для Telegram: непустая строка → бот докинет следующую страницу,
      // когда пользователь долистает; "" → пагинация закончена.
      let nextOffset = "";

      if (norm.length < INLINE_MIN_QUERY_LEN) {
        // Пустой/слишком короткий запрос — browse: случайные картинки без эмбеддинга.
        // Random-выдачу нельзя стабильно пагинировать (дубли/пропуски), поэтому одна страница.
        mode = "browse";
        images = await findRandomImages(nsfwEnabled, INLINE_BROWSE_COUNT);
      } else {
        mode = "search";
        const embedding = await resolveEmbedding(norm, userId);
        // Страница ближайших картинок начиная с offset, в порядке близости (ближняя → дальняя).
        images = await findSimilarImages(embedding, nsfwEnabled, INLINE_PAGE_SIZE, offset);
        nextOffset = computeNextOffset(offset, images.length, INLINE_PAGE_SIZE, INLINE_MAX_RESULTS);
      }

      // Ссылки на посты Danbooru — не критичны для выдачи: при сбое просто отдаём картинки
      // без кнопок, а не роняем весь ответ.
      let danbooruIds = new Map<number, number>();
      try {
        danbooruIds = await getDanbooruIdsByImageIds(images.map((i) => i.id));
      } catch (err) {
        logger.warn({ userId, err }, "Failed to resolve Danbooru post links for inline results");
      }

      const results = toResults(images, danbooruIds);
      // is_personal: true — обязательно. NSFW зависит от настроек пользователя, поэтому
      // Telegram не должен кэшировать результаты одного юзера для другого.
      await ctx.answerInlineQuery(results, {
        cache_time: INLINE_CACHE_TIME,
        is_personal: true,
        next_offset: nextOffset,
      });
      logger.info(
        { userId, mode, nsfwEnabled, offset, results: results.length, nextOffset, durationMs: Date.now() - t0 },
        "Inline query answered",
      );
    } catch (err) {
      logger.error({ userId, norm, offset, err }, "Inline query failed");
      // Всё равно отвечаем пустым — иначе у пользователя висит спиннер.
      await ctx.answerInlineQuery([], { cache_time: INLINE_CACHE_TIME, is_personal: true })
        .catch((e) => logger.warn({ userId, err: e }, "Failed to send empty inline answer"));
    }
  });
}
