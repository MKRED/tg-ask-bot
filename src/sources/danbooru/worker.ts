// Фоновый воркер Danbooru: хронологически тянет новые посты и добавляет их в saved_images.
// Конвейер обработки одного поста — см. processPost.ts. Здесь только цикл, фильтры
// (возраст + score), сдвиг курсора и инициализация.
import type { Api } from "grammy";
import { getDanbooruState, advanceDanbooruCursor } from "../../db/danbooruState.js";
import { insertDanbooruPost, getDanbooruPostStatus, markDanbooruPostSkipped } from "../../db/danbooruPosts.js";
import { fetchPosts, fetchLatestPostId } from "./client.js";
import { buildDescriptionAndTags } from "./transform.js";
import { preparePost, type PreparedPost } from "./prepare.js";
import { commitBatch } from "./upload.js";
import type { DanbooruApiPost } from "./types.js";
import { config } from "../../config.js";
import { mapPool } from "../../utils/pool.js";
import { chunk } from "../../utils/chunk.js";
import {
  DANBOORU_TICK_MS,
  DANBOORU_BATCH_SIZE,
  DANBOORU_CONCURRENCY,
  DANBOORU_UPLOAD_BATCH_SIZE,
  DANBOORU_ALLOWED_EXTS,
  DANBOORU_MIN_AGE_MS,
  DANBOORU_MIN_SCORE,
} from "./constants.js";
import logger from "../../logger.js";

// Один тик возвращает признак «бэклог скорее всего ещё есть» — тогда планировщик
// запускает следующий тик вплотную (без 15-секундной паузы), иначе ждёт DANBOORU_TICK_MS.
async function tick(api: Api): Promise<boolean> {
  // Воркер не запускается, если не настроены учётные данные или хранилище
  if (!config.danbooruLogin || !config.danbooruApiKey) return false;

  const state = await getDanbooruState();
  if (!state?.storageChatId) return false; // ждём /setdanboorustorage

  const { lastPostId, storageChatId, storageThreadId } = state;
  const t0 = Date.now();

  let posts: DanbooruApiPost[];
  try {
    posts = await fetchPosts(lastPostId, DANBOORU_BATCH_SIZE, config.danbooruLogin, config.danbooruApiKey);
  } catch (err) {
    logger.warn({ err, lastPostId }, "Danbooru fetchPosts failed");
    return false;
  }

  if (posts.length === 0) {
    // Нет новых постов — догнали актуальный конец
    logger.debug({ lastPostId }, "Danbooru: no new posts");
    return false;
  }

  // ВАЖНО: Danbooru на page=a{cursor} отдаёт окно id > cursor, но в порядке УБЫВАНИЯ id.
  // Сортируем по возрастанию: обход хронологический, а курсор двигается к максимуму окна.
  posts.sort((a, b) => a.id - b.id);

  let skipped = 0;
  let skippedLowScore = 0;
  let alreadyDone = 0;
  let stoppedYoung = false;
  let advancedTo = lastPostId; // куда реально доедет курсор (при раннем стопе ≠ хвост батча)

  // --- Фаза 1: серийная фильтрация (только БД, без сети) ---
  // Идёт строго по порядку id, потому что возрастной гейт обязан остановить весь хвост
  // батча. Собираем «выжившие» посты, которые реально нужно скачать/проэмбеддить/загрузить.
  const toProcess: DanbooruApiPost[] = [];

  for (const post of posts) {
    // Возрастной фильтр: у свежего поста score ещё не сформирован, ждём пока «настоится».
    // Посты по возрастанию id (хронологичны) → все последующие тоже моложе. Останавливаем
    // батч и НЕ двигаем курсор за этот пост: на следующем тике окно перезапросится.
    const ageMs = Date.now() - new Date(post.created_at).getTime();
    if (ageMs < DANBOORU_MIN_AGE_MS) {
      stoppedYoung = true;
      break;
    }
    // Все ветки ниже «проходят» этот пост — курсор дойдёт минимум до него
    advancedTo = post.id;

    // Идемпотентность: уже обработанный (done/skipped) пост не гоним повторно —
    // иначе saveImage создал бы дубликат. Бывает при рестарте или сбросе курсора назад.
    const existingStatus = await getDanbooruPostStatus(post.id);
    if (existingStatus === "done" || existingStatus === "skipped") {
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
      skipped++;
      continue;
    }

    // Фильтр качества: пост «настоялся» (прошёл возрастной гейт) → score достоверен.
    // Ниже порога — «работа без отклика», не грузим (без download/upload).
    if (post.score < DANBOORU_MIN_SCORE) {
      await markDanbooruPostSkipped(post.id, `low_score:${post.score}`);
      skippedLowScore++;
      continue;
    }

    toProcess.push(post);
  }

  // --- Фаза 2: параллельная подготовка выживших (download + embed) ---
  // preparePost никогда не бросает (внутри всё в try/catch → PrepareResult), поэтому
  // mapPool не отклонится. Пул прячет сетевые ожидания одних постов за работой других.
  let imported = 0;
  let failed = 0;
  const prepared = await mapPool(toProcess, DANBOORU_CONCURRENCY, preparePost);
  const ready: PreparedPost[] = [];
  for (const r of prepared) {
    if (r.status === "ok") ready.push(r.prepared);
    else if (r.status === "skipped") skipped++;
    else failed++;
  }

  // --- Фаза 3: загрузка готовых пачками (альбомами) ---
  // Серийно по пачкам (пейсер внутри commitBatch выдерживает интервал); порядок ready =
  // порядок toProcess = хронологический, поэтому и в чат картинки уходят по возрастанию id.
  for (const batch of chunk(ready, DANBOORU_UPLOAD_BATCH_SIZE)) {
    const results = await commitBatch(batch, storageChatId, storageThreadId, api);
    for (const r of results) {
      if (r === "imported") imported++;
      else if (r === "skipped") skipped++;
      else failed++;
    }
  }

  // Курсор двигаем ОДИН раз в конце тика — до максимального обработанного id. Внутри тика
  // обработка идёт вне порядка, поэтому подвигать курсор по каждому посту нельзя: при краше
  // он мог бы перепрыгнуть незавершённый пост. Сдвиг в конце + идемпотентность (краш в фазе 2
  // → перечитаем pending/failed на следующем тике, done/skipped пропустятся) делают это безопасным.
  if (advancedTo > lastPostId) {
    await advanceDanbooruCursor(advancedTo);
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
    concurrency: DANBOORU_CONCURRENCY,
    uploadBatchSize: DANBOORU_UPLOAD_BATCH_SIZE,
    durationMs: Date.now() - t0,
  }, "Danbooru tick completed");

  // Бэклог вероятно остался, если окно пришло полным и мы НЕ упёрлись в молодые посты:
  // значит за курсором есть ещё «настоявшиеся» посты — обрабатываем их сразу, без паузы.
  return posts.length >= DANBOORU_BATCH_SIZE && !stoppedYoung;
}

export function startDanbooruWorker(api: Api): void {
  if (!config.danbooruLogin || !config.danbooruApiKey) {
    logger.info("Danbooru worker disabled: DANBOORU_LOGIN / DANBOORU_API_KEY not set");
    return;
  }

  // Если storageChatId ещё не задан — воркер запустится, но в каждом тике молча пропускает работу.
  // Как только пользователь выполнит /setdanboorustorage, следующий тик уже начнёт работать.
  const run = async () => {
    let morePending = false;
    try {
      morePending = await tick(api);
    } catch (err) {
      logger.error({ err }, "Danbooru worker tick crashed");
    } finally {
      // При бэклоге — следующий тик вплотную (катимся по очереди), иначе ждём интервал.
      setTimeout(run, morePending ? 0 : DANBOORU_TICK_MS);
    }
  };

  logger.info(
    { tickMs: DANBOORU_TICK_MS, batchSize: DANBOORU_BATCH_SIZE, concurrency: DANBOORU_CONCURRENCY },
    "Danbooru worker starting",
  );
  run();
}

// Экспортируется для команды /setdanboorustorage: при первом запуске без явного start_id
// курсор инициализируется текущим последним постом (не тянем всю историю).
export async function initDanbooruCursorIfNeeded(startPostId?: number): Promise<number> {
  if (startPostId !== undefined) return startPostId;
  if (!config.danbooruLogin || !config.danbooruApiKey) return 0;
  return fetchLatestPostId(config.danbooruLogin, config.danbooruApiKey);
}
