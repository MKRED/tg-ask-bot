// Фаза загрузки готовых постов в Telegram storage-чат и сохранения в saved_images.
// Картинки отправляются ПАЧКОЙ как media group (альбом) — одно уведомление вместо N,
// меньше спама. Альбом не поддерживает inline-кнопки, поэтому ссылка на пост Danbooru идёт
// ГИПЕРССЫЛКОЙ В ПОДПИСИ каждого фото (пронумерованной: «1 🔗 Danbooru», «2 🔗 Danbooru»…) —
// никакого отдельного сообщения.
//
// sendMediaGroup требует 2–10 элементов, поэтому пачка из 1 (хвост батча / retry-скрипт)
// уходит обычным sendPhoto — тоже с подписью-гиперссылкой.
import type { Api } from "grammy";
import { InputFile, InputMediaBuilder } from "grammy";
import type { Message } from "grammy/types";
import { saveImageAndMarkDone, markDanbooruPostFailed, markDanbooruPostSkipped } from "../../db/danbooruPosts.js";
import { retry } from "../../utils/retry.js";
import { isNsfwRating, danbooruPostUrl } from "./transform.js";
import { DANBOORU_SENDER_ID, DANBOORU_UPLOAD_MIN_INTERVAL_MS } from "./constants.js";
import { errMsg, type PreparedPost, type ProcessResult } from "./prepare.js";
import logger from "../../logger.js";

// Глобальный пейсер загрузок в Telegram: воркер готовит посты параллельно (DANBOORU_CONCURRENCY),
// но в один storage-чат нельзя слать быстрее per-chat flood-лимита. Каждый вызов резервирует
// следующий «слот» и сдвигает курсор на weight × интервал (weight = число фото в альбоме),
// поэтому эффективный темп фото/мин не зависит от того, шлём мы по одной или альбомами.
// Это проактивный троттлинг; autoRetry в bot.ts остаётся страховкой на случай 429.
let nextUploadSlot = 0;
function awaitUploadSlot(weight = 1): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextUploadSlot);
  nextUploadSlot = slot + weight * DANBOORU_UPLOAD_MIN_INTERVAL_MS;
  const wait = slot - now;
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

// Детерминированная ошибка Telegram-апача, которая НИКОГДА не пройдёт при повторе:
// картинка с недопустимыми размерами/соотношением сторон. Такой пост помечаем skipped, а
// не failed — иначе retry-скрипт будет вечно его перезагружать. Сознательно матчим ТОЛЬКО
// PHOTO_INVALID_DIMENSIONS (эмпирически подтверждён): skipped терминален, и записать сюда
// потенциально транзиентную ошибку (напр. IMAGE_PROCESS_FAILED бывает временным на стороне
// Telegram) — значит навсегда потерять восстановимый пост. Всё остальное → failed (ретраится
// скриптом). 429/сетевые сюда не попадают: 429 гасит autoRetry, сеть — это failed.
function isPermanentUploadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /PHOTO_INVALID_DIMENSIONS/i.test(msg);
}

// Подпись-гиперссылка на пост Danbooru (HTML parse_mode). Альбом не поддерживает inline-кнопки,
// поэтому ссылку кладём прямо в подпись фото — кликабельный текст под картинкой. В label только
// цифры/латиница/emoji (без <>&), URL — danbooruPostUrl без спецсимволов → экранирование не нужно.
function captionLink(postId: number, label: string): string {
  return `<a href="${danbooruPostUrl(postId)}">${label}</a>`;
}

// Сохраняем картинку в saved_images + помечаем пост done — атомарно (одна транзакция).
async function saveOne(p: PreparedPost, telegramFileId: string): Promise<ProcessResult> {
  const logCtx = { danbooruId: p.post.id, ext: p.post.file_ext, rating: p.post.rating };
  try {
    const savedImageId = await retry(() => saveImageAndMarkDone({
      fileId: telegramFileId,
      senderUserId: DANBOORU_SENDER_ID,
      description: p.description,
      caption: null,
      moodTags: [],
      contentTags: p.contentTags,
      isNsfw: isNsfwRating(p.post.rating),
      embedding: p.embedding,
    }, p.post.id), 2, 1000, `Danbooru saveImage ${p.post.id}`);
    logger.info({ ...logCtx, savedImageId }, "Danbooru post imported");
    return "imported";
  } catch (err) {
    await markDanbooruPostFailed(p.post.id, errMsg(err));
    logger.warn({ ...logCtx, err }, "Danbooru saveImage failed");
    return "failed";
  }
}

// Извлекаем file_id наивысшего разрешения из ответа sendPhoto/sendMediaGroup.
function fileIdFromPhotoMsg(msg: Message): string {
  const photo = msg.photo;
  if (!photo || photo.length === 0) throw new Error("sendPhoto/sendMediaGroup returned no photo array");
  // photo — массив PhotoSize[] от меньшего к большему; берём последний (наивысшее разрешение)
  return photo[photo.length - 1].file_id;
}

// Отправка ОДНОГО поста обычным sendPhoto с подписью-гиперссылкой.
// Используется для пачки из 1 и как поштучный фолбэк при сбое альбома.
async function sendOne(p: PreparedPost, storageChatId: number, storageThreadId: number, api: Api): Promise<ProcessResult> {
  const logCtx = { danbooruId: p.post.id, ext: p.post.file_ext, rating: p.post.rating };
  let telegramFileId: string;
  try {
    await awaitUploadSlot(1);
    const msg = await api.sendPhoto(storageChatId, new InputFile(p.buffer, `danbooru_${p.post.id}.${p.post.file_ext}`), {
      ...(storageThreadId !== 0 ? { message_thread_id: storageThreadId } : {}),
      caption: captionLink(p.post.id, "🔗 Danbooru"),
      parse_mode: "HTML",
      // NSFW (rating q/e) — нативный спойлер: картинка приходит заблюренной, раскрывается по тапу
      has_spoiler: isNsfwRating(p.post.rating),
    });
    telegramFileId = fileIdFromPhotoMsg(msg);
  } catch (err) {
    // Детерминированный отказ (битые размеры и т.п.) → skipped, иначе failed
    if (isPermanentUploadError(err)) {
      await markDanbooruPostSkipped(p.post.id, errMsg(err));
      logger.warn({ ...logCtx, err }, "Danbooru upload permanently rejected, skipped");
      return "skipped";
    }
    await markDanbooruPostFailed(p.post.id, errMsg(err));
    logger.warn({ ...logCtx, err }, "Danbooru Telegram upload failed");
    return "failed";
  }
  return saveOne(p, telegramFileId);
}

// Отправка пачки альбомом. Ссылка на каждый пост — гиперссылкой в подписи фото (нумерованной),
// никакого отдельного сообщения (альбом не поддерживает inline-кнопки).
async function sendAlbum(batch: PreparedPost[], storageChatId: number, storageThreadId: number, api: Api): Promise<ProcessResult[]> {
  const threadOpt = storageThreadId !== 0 ? { message_thread_id: storageThreadId } : {};

  // caption = пронумерованная гиперссылка на пост («1 🔗 Danbooru», «2 🔗 Danbooru»…)
  const media = batch.map((p, i) =>
    InputMediaBuilder.photo(new InputFile(p.buffer, `danbooru_${p.post.id}.${p.post.file_ext}`), {
      caption: captionLink(p.post.id, `${i + 1} 🔗 Danbooru`),
      parse_mode: "HTML",
      has_spoiler: isNsfwRating(p.post.rating),
    }),
  );

  let msgs: Message[];
  try {
    await awaitUploadSlot(batch.length);
    msgs = await api.sendMediaGroup(storageChatId, media, threadOpt);
  } catch (err) {
    // Telegram не сообщает, какой именно элемент альбома битый, → отправляем поштучно,
    // чтобы одна плохая картинка не уронила всю пачку (sendOne сам классифицирует ошибку).
    logger.warn({ count: batch.length, err }, "Danbooru sendMediaGroup failed, falling back to per-photo");
    const out: ProcessResult[] = [];
    for (const p of batch) out.push(await sendOne(p, storageChatId, storageThreadId, api));
    return out;
  }

  // Сохраняем каждый пост по его file_id (порядок msgs совпадает с порядком media)
  const out: ProcessResult[] = [];
  for (let i = 0; i < batch.length; i++) {
    try {
      out.push(await saveOne(batch[i], fileIdFromPhotoMsg(msgs[i])));
    } catch (err) {
      await markDanbooruPostFailed(batch[i].post.id, errMsg(err));
      logger.warn({ danbooruId: batch[i].post.id, err }, "Danbooru save after album failed");
      out.push("failed");
    }
  }
  return out;
}

// Публичный вход: загрузить и сохранить пачку готовых постов. Пачка из 1 → sendPhoto,
// 2+ → альбом. Никогда не бросает (всё внутри try/catch); порядок результатов = порядок входа.
export async function commitBatch(batch: PreparedPost[], storageChatId: number, storageThreadId: number, api: Api): Promise<ProcessResult[]> {
  if (batch.length === 0) return [];
  if (batch.length === 1) return [await sendOne(batch[0], storageChatId, storageThreadId, api)];
  return sendAlbum(batch, storageChatId, storageThreadId, api);
}
