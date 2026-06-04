// Фоновый воркер Danbooru: хронологически тянет новые посты и добавляет их в saved_images.
// Конвейер обработки одного поста — см. processPost.ts. Здесь только цикл, фильтры
// (возраст + score), сдвиг курсора и инициализация.
import type { Api } from "grammy";
import { getDanbooruState, advanceDanbooruCursor } from "../../db/danbooruState.js";
import { insertDanbooruPost, getDanbooruPostStatus, markDanbooruPostSkipped } from "../../db/danbooruPosts.js";
import { fetchPosts, fetchLatestPostId } from "./client.js";
import { buildDescriptionAndTags } from "./transform.js";
import { processPost } from "./processPost.js";
import type { DanbooruApiPost } from "./types.js";
import { config } from "../../config.js";
import {
  DANBOORU_TICK_MS,
  DANBOORU_BATCH_SIZE,
  DANBOORU_UPLOAD_DELAY_MS,
  DANBOORU_ALLOWED_EXTS,
  DANBOORU_MIN_AGE_MS,
  DANBOORU_MIN_SCORE,
} from "./constants.js";
import logger from "../../logger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
