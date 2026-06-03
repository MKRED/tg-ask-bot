import type { Bot } from "grammy";
import type { InlineQueryResultCachedPhoto } from "grammy/types";
import { generateTextEmbedding } from "../ai/gemini.js";
import { getCachedEmbedding, cacheEmbedding } from "../db/searchEmbeddings.js";
import { findSimilarImages, findRandomImages } from "../db/savedImages.js";
import { getDanbooruIdsByImageIds } from "../db/danbooruPosts.js";
import { danbooruPostUrl } from "../danbooru/api.js";
import { getUserNsfwEnabled } from "../db/users.js";
import {
  INLINE_MIN_QUERY_LEN,
  INLINE_POOL_SIZE,
  INLINE_SHOWN_COUNT,
  INLINE_BROWSE_COUNT,
  INLINE_CACHE_TIME,
} from "../constants/index.js";
import type { SavedImage } from "../db/schema.js";
import logger from "../logger.js";

// Нормализация ключа кэша: схлопываем пробелы, в нижний регистр, обрезаем до длины
// столбца query_text (varchar 255). По этому же тексту и эмбеддим — варианты регистра
// и пробелов делят один вектор.
function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 255);
}

// Fisher-Yates: тасуем пул на месте, чтобы одна и та же фраза каждый раз давала
// свежую выборку в пределах релевантных кандидатов.
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

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
    const t0 = Date.now();

    try {
      const nsfwEnabled = await getUserNsfwEnabled(userId);

      let images: SavedImage[];
      let mode: "browse" | "search";

      if (norm.length < INLINE_MIN_QUERY_LEN) {
        // Пустой/слишком короткий запрос — browse: случайные картинки без эмбеддинга.
        mode = "browse";
        images = await findRandomImages(nsfwEnabled, INLINE_BROWSE_COUNT);
      } else {
        mode = "search";
        const embedding = await resolveEmbedding(norm, userId);
        const pool = await findSimilarImages(embedding, nsfwEnabled, INLINE_POOL_SIZE);
        images = shuffle(pool).slice(0, INLINE_SHOWN_COUNT);
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
      await ctx.answerInlineQuery(results, { cache_time: INLINE_CACHE_TIME, is_personal: true });
      logger.info({ userId, mode, nsfwEnabled, results: results.length, durationMs: Date.now() - t0 }, "Inline query answered");
    } catch (err) {
      logger.error({ userId, norm, err }, "Inline query failed");
      // Всё равно отвечаем пустым — иначе у пользователя висит спиннер.
      await ctx.answerInlineQuery([], { cache_time: INLINE_CACHE_TIME, is_personal: true })
        .catch((e) => logger.warn({ userId, err: e }, "Failed to send empty inline answer"));
    }
  });
}
