// Конвейер обработки одного Danbooru-поста: download → embed → Telegram upload → save.
//
// Порядок (advisor: «embed first, upload last»):
//   1. Скачиваем картинку в буфер (один раз для обоих шагов ниже).
//   2. Генерируем embedding — если Gemini заблокировал, помечаем failed и пропускаем.
//   3. Загружаем буфер в Telegram storage chat → получаем Telegram file_id.
//   4. Сохраняем в saved_images + помечаем danbooru_posts done (атомарно).
import type { Api } from "grammy";
import { InputFile } from "grammy";
import { generateImageEmbeddingFromBuffer } from "../../ai/gemini/index.js";
import { saveImageAndMarkDone, markDanbooruPostFailed, markDanbooruPostSkipped } from "../../db/danbooruPosts.js";
import { retry } from "../../utils/retry.js";
import { downloadDanbooruImage } from "./client.js";
import { extToMimeType, isNsfwRating, buildDescriptionAndTags, danbooruPostUrl } from "./transform.js";
import { DANBOORU_SENDER_ID } from "./constants.js";
import type { DanbooruApiPost } from "./types.js";
import logger from "../../logger.js";

function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

// Исход обработки одного поста — для корректного подсчёта статистики в логе тика.
export type ProcessResult = "imported" | "skipped" | "failed";

// Обрабатываем один пост: embed → upload → save.
// Транзиентные шаги (download/embed/save) обёрнуты в retry — иначе один сетевой блип
// или Gemini 5xx навсегда теряет пост (курсор уходит вперёд). Восстановление упавших
// постов — см. scripts/retryFailedDanbooru.ts.
// Экспортируется, чтобы скрипт восстановления мог переобработать пост по тому же пути.
export async function processPost(post: DanbooruApiPost, storageChatId: number, storageThreadId: number, api: Api): Promise<ProcessResult> {
  const logCtx = { danbooruId: post.id, ext: post.file_ext, rating: post.rating };

  // Пропускаем удалённые/забаненные/pending посты без file_url
  if (post.is_deleted || post.is_banned) {
    await markDanbooruPostSkipped(post.id, "deleted_or_banned");
    logger.debug({ ...logCtx }, "Danbooru post skipped: deleted/banned");
    return "skipped";
  }

  const imageUrl = post.large_file_url ?? post.file_url;
  if (!imageUrl) {
    await markDanbooruPostSkipped(post.id, "no_file_url");
    logger.debug({ ...logCtx }, "Danbooru post skipped: no image URL");
    return "skipped";
  }

  // Шаг 1: скачиваем один раз — используем для embedding и Telegram upload
  let buffer: Buffer;
  try {
    buffer = await retry(() => downloadDanbooruImage(imageUrl), 3, 1500, `Danbooru download ${post.id}`);
  } catch (err) {
    await markDanbooruPostFailed(post.id, errMsg(err));
    logger.warn({ ...logCtx, err }, "Danbooru image download failed");
    return "failed";
  }

  // Шаг 2: embedding — если не удалось, пост можно переобработать позже (retryFailedDanbooru)
  const { description, contentTags } = buildDescriptionAndTags(post);
  const analysisText = `${description} ${contentTags.join(" ")}`;
  const mimeType = extToMimeType(post.file_ext);

  let embedding: number[];
  try {
    embedding = await retry(() => generateImageEmbeddingFromBuffer(buffer, mimeType, analysisText), 3, 1500, `Danbooru embed ${post.id}`);
  } catch (err) {
    await markDanbooruPostFailed(post.id, errMsg(err));
    logger.warn({ ...logCtx, err }, "Danbooru post embedding failed, skipping Telegram upload");
    return "failed";
  }

  // Шаг 3: загружаем в storage chat → получаем Telegram file_id.
  // Флуд-лимиты (429) ретраит транспортный autoRetry() в bot.ts; здесь ретраить
  // не нужно — прочие ошибки sendPhoto (битый файл, недопустимые размеры) детерминированы.
  let telegramFileId: string;
  try {
    const filename = `danbooru_${post.id}.${post.file_ext}`;
    const sendOpts = {
      // message_thread_id передаём только для тем форум-группы (0 = General/без тем)
      ...(storageThreadId !== 0 ? { message_thread_id: storageThreadId } : {}),
      // Кнопка со ссылкой на исходный пост Danbooru
      reply_markup: { inline_keyboard: [[{ text: "🔗 Danbooru", url: danbooruPostUrl(post.id) }]] },
      // NSFW (rating q/e) — нативный спойлер: в канале картинка приходит заблюренной,
      // раскрывается по тапу. Здесь это работает, потому что бот сам шлёт sendPhoto
      // (в inline-выдаче has_spoiler недоступен — медиа отправляет клиент пользователя).
      has_spoiler: isNsfwRating(post.rating),
    };
    const msg = await api.sendPhoto(storageChatId, new InputFile(buffer, filename), sendOpts);
    // photo — массив PhotoSize[] от меньшего к большему; берём последний (наивысшее разрешение)
    const photo = msg.photo;
    if (!photo || photo.length === 0) throw new Error("sendPhoto returned no photo array");
    telegramFileId = photo[photo.length - 1].file_id;
  } catch (err) {
    await markDanbooruPostFailed(post.id, errMsg(err));
    logger.warn({ ...logCtx, err }, "Danbooru Telegram upload failed");
    return "failed";
  }

  // Шаг 4: сохраняем в saved_images и помечаем пост done — атомарно (одна транзакция),
  // чтобы не осталось «сохранено, но не done» и повторный проход не создал дубль.
  let savedImageId: number;
  try {
    savedImageId = await retry(() => saveImageAndMarkDone({
      fileId: telegramFileId,
      senderUserId: DANBOORU_SENDER_ID,
      description,
      caption: null,
      moodTags: [],
      contentTags,
      isNsfw: isNsfwRating(post.rating),
      embedding,
    }, post.id), 2, 1000, `Danbooru saveImage ${post.id}`);
  } catch (err) {
    await markDanbooruPostFailed(post.id, errMsg(err));
    logger.warn({ ...logCtx, err }, "Danbooru saveImage failed");
    return "failed";
  }

  logger.info({ ...logCtx, savedImageId }, "Danbooru post imported");
  return "imported";
}
