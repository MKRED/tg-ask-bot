// Фоновый воркер Danbooru: хронологически тянет новые посты и добавляет их в saved_images.
//
// Порядок обработки каждого поста (advisor: «embed first, upload last»):
//   1. Скачиваем картинку в буфер (один раз для обоих шагов ниже).
//   2. Генерируем embedding — если Gemini заблокировал, помечаем failed и пропускаем.
//   3. Загружаем буфер в Telegram storage chat → получаем Telegram file_id.
//   4. Сохраняем в saved_images + обновляем danbooru_posts.
//   5. Сдвигаем курсор (происходит в любом исходе — skip/fail тоже двигают курсор,
//      чтобы один битый пост не блокировал весь поток).

import type { Api } from "grammy";
import { InputFile } from "grammy";
import { generateImageEmbeddingFromBuffer } from "../ai/gemini.js";
import { getDanbooruState, advanceDanbooruCursor } from "../db/danbooruState.js";
import { insertDanbooruPost, getDanbooruPostStatus, saveImageAndMarkDone, markDanbooruPostFailed, markDanbooruPostSkipped } from "../db/danbooruPosts.js";
import { retry } from "../utils/retry.js";
import {
  fetchPosts,
  downloadDanbooruImage,
  fetchLatestPostId,
  extToMimeType,
  isNsfwRating,
  buildDescriptionAndTags,
  danbooruPostUrl,
  type DanbooruApiPost,
} from "./api.js";
import { config } from "../config.js";
import {
  DANBOORU_TICK_MS,
  DANBOORU_BATCH_SIZE,
  DANBOORU_UPLOAD_DELAY_MS,
  DANBOORU_SENDER_ID,
  DANBOORU_ALLOWED_EXTS,
  DANBOORU_MIN_AGE_MS,
  DANBOORU_MIN_SCORE,
} from "../constants/index.js";
import logger from "../logger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function tick(api: Api): Promise<void> {
  // Воркер не запускается, если не настроены учётные данные или хранилище
  if (!config.danbooruLogin || !config.danbooruApiKey) return;

  const state = await getDanbooruState();
  if (!state?.storageChatId) return; // ждём /setdanboorustorage

  const { lastPostId, storageChatId, storageThreadId } = state;
  const t0 = Date.now();

  let posts: DanbooruApiPost[];
  try {
    posts = await fetchPosts(lastPostId, DANBOORU_BATCH_SIZE, config.danbooruLogin, config.danbooruApiKey);
  } catch (err) {
    logger.warn({ err, lastPostId }, "Danbooru fetchPosts failed");
    return;
  }

  if (posts.length === 0) {
    // Нет новых постов — догнали актуальный конец
    logger.debug({ lastPostId }, "Danbooru: no new posts");
    return;
  }

  // ВАЖНО: Danbooru на page=a{cursor} отдаёт окно id > cursor, но в порядке УБЫВАНИЯ id.
  // Сортируем по возрастанию, иначе advanceDanbooruCursor по каждому посту уводит курсор
  // к минимуму батча (+1 за тик), и каждый следующий тик заново тянет почти весь предыдущий
  // батч → пере-обработка тех же постов. Сортировка делает обход хронологическим, а курсор
  // корректно двигается к максимуму окна.
  posts.sort((a, b) => a.id - b.id);

  let imported = 0;
  let failed = 0;
  let skipped = 0;
  let skippedLowScore = 0;
  let alreadyDone = 0;
  let stoppedYoung = false;
  let advancedTo = lastPostId; // куда реально доехал курсор (для лога; при раннем стопе ≠ хвост батча)

  for (const post of posts) {
    // Возрастной фильтр: у свежего поста score ещё не сформирован, поэтому ждём, пока
    // он «настоится» (DANBOORU_MIN_AGE_MS). Посты отсортированы по возрастанию id, а id
    // Danbooru хронологичны → все последующие посты тоже моложе. Останавливаем батч и НЕ
    // двигаем курсор за этот пост: на следующем тике окно перезапросится, и пост обработается,
    // когда повзрослеет. Так курсор трейлит на ~MIN_AGE позади реального времени.
    const ageMs = Date.now() - new Date(post.created_at).getTime();
    if (ageMs < DANBOORU_MIN_AGE_MS) {
      stoppedYoung = true;
      break;
    }
    // Все ветки ниже двигают курсор за этот пост — фиксируем для итогового лога
    advancedTo = post.id;

    // Идемпотентность: если пост уже обработан (done/skipped) — НЕ гоним его через
    // processPost повторно (иначе saveImage создаст дубликат в saved_images). Такое
    // бывает при рестарте между save и сдвигом курсора или при сбросе курсора назад.
    const existingStatus = await getDanbooruPostStatus(post.id);
    if (existingStatus === "done" || existingStatus === "skipped") {
      await advanceDanbooruCursor(post.id);
      alreadyDone++;
      continue;
    }

    // Фиксируем пост в danbooru_posts до обработки (idempotent — onConflictDoNothing)
    const postTags = buildDescriptionAndTags(post);
    await insertDanbooruPost({
      danbooruId: post.id,
      rating: post.rating,
      fileExt: post.file_ext,
      fileSize: post.file_size ?? null,
      md5: post.md5 ?? null,
      sourceUrl: post.large_file_url ?? post.file_url ?? null,
      generalTags: postTags.generalTags,
      characterTags: postTags.characterTags,
      copyrightTags: postTags.copyrightTags,
      artistTags: postTags.artistTags,
      score: post.score,
      danbooruCreatedAt: post.created_at ? new Date(post.created_at) : null,
      status: "pending",
    });

    const ext = post.file_ext.toLowerCase();
    if (!DANBOORU_ALLOWED_EXTS.has(ext)) {
      // GIF/WebM/MP4 — не можем получить Telegram photo file_id, пропускаем
      await markDanbooruPostSkipped(post.id, `unsupported_ext:${post.file_ext}`);
      await advanceDanbooruCursor(post.id);
      skipped++;
      continue;
    }

    // Фильтр качества: пост уже «настоялся» (прошёл возрастной гейт), значит score
    // достоверен. Ниже порога — «работа без отклика», не грузим (без download/upload).
    if (post.score < DANBOORU_MIN_SCORE) {
      await markDanbooruPostSkipped(post.id, `low_score:${post.score}`);
      await advanceDanbooruCursor(post.id);
      skippedLowScore++;
      continue;
    }

    const result = await processPost(post, storageChatId, storageThreadId, api);
    if (result === "imported") imported++;
    else if (result === "skipped") skipped++;
    else failed++;

    // Курсор двигаем в любом исходе — битый пост не должен блокировать поток
    await advanceDanbooruCursor(post.id);

    // Пауза между загрузками в Telegram — защита от flood-лимита
    if (posts.indexOf(post) < posts.length - 1) {
      await sleep(DANBOORU_UPLOAD_DELAY_MS);
    }
  }

  logger.info({
    lastPostId,
    newLastPostId: advancedTo,
    total: posts.length,
    imported,
    skipped,
    skippedLowScore,
    failed,
    alreadyDone,
    stoppedYoung, // true → упёрлись в ещё «не настоявшиеся» посты, ждём следующего тика
    durationMs: Date.now() - t0,
  }, "Danbooru tick completed");
}

export function startDanbooruWorker(api: Api): void {
  if (!config.danbooruLogin || !config.danbooruApiKey) {
    logger.info("Danbooru worker disabled: DANBOORU_LOGIN / DANBOORU_API_KEY not set");
    return;
  }

  // Если storageChatId ещё не задан — воркер запустится, но в каждом тике молча пропускает работу.
  // Как только пользователь выполнит /setdanboorustorage, следующий тик уже начнёт работать.
  const run = async () => {
    try {
      await tick(api);
    } catch (err) {
      logger.error({ err }, "Danbooru worker tick crashed");
    } finally {
      setTimeout(run, DANBOORU_TICK_MS);
    }
  };

  logger.info({ tickMs: DANBOORU_TICK_MS, batchSize: DANBOORU_BATCH_SIZE }, "Danbooru worker starting");
  run();
}

// Экспортируется для команды /setdanboorustorage: при первом запуске без явного start_id
// курсор инициализируется текущим последним постом (не тянем всю историю).
export async function initDanbooruCursorIfNeeded(startPostId?: number): Promise<number> {
  if (startPostId !== undefined) return startPostId;
  if (!config.danbooruLogin || !config.danbooruApiKey) return 0;
  return fetchLatestPostId(config.danbooruLogin, config.danbooruApiKey);
}
