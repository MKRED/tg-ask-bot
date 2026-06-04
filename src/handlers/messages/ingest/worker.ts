import type { Api } from "grammy";
import { analyzeImage, GeminiBlockedError } from "../../../ai/gemini/index.js";
import { analyzeImageOllama } from "../../../ai/ollama.js";
import {
  claimQueued,
  markDone,
  routeToOllama,
  deferRetry,
  markFailed,
} from "../../../db/groupIngestImages.js";
import type { GroupIngestImage } from "../../../db/schema.js";
import { scheduleDigest } from "./digest.js";
import { errMsg, isOllamaDown, resolveFileUrl, saveAnalysisToImages } from "./shared.js";
import { retry } from "../../../utils/retry.js";
import { config } from "../../../config.js";
import {
  INGEST_TICK_MS,
  GEMINI_INGEST_CONCURRENCY,
  OLLAMA_INGEST_CONCURRENCY,
  OLLAMA_MAX_ATTEMPTS,
  OLLAMA_BACKOFF_BASE_MS,
  OLLAMA_BACKOFF_CAP_MS,
  OLLAMA_HEALTH_TIMEOUT_MS,
} from "./constants.js";
import logger from "../../../logger.js";

// Фоновый воркер ingest-очереди. Обработчик сообщения только кладёт строку "pending"
// в group_ingest_images; разбирает очередь этот воркер — двумя независимыми полосами:
//   • Gemini — облачный API, до GEMINI_INGEST_CONCURRENCY параллельно;
//   • Ollama — локальная модель, строго по одной (защищена семафором в ai/ollama.ts).
// Сериализация Ollama-полосы структурно исключает лавину connection-refused при пике картинок.
//
// ВАЖНО: обе полосы держат общее мутабельное состояние модуля (geminiInFlight, ollamaInFlight,
// ollamaDown), поэтому они живут в одном файле — выносить полосы в отдельные модули нельзя
// без аккуратной шарированной структуры состояния.

// Какие строки сейчас обрабатываются — защита от повторного захвата одной строки.
const geminiInFlight = new Set<number>();
const ollamaInFlight = new Set<number>();

// Circuit breaker Ollama: при "down"-ошибке полоса перестаёт брать строки и каждый тик
// пингует сервер, возобновляя работу как только он ответит (см. ollamaTick).
let ollamaDown = false;

// --- Gemini-полоса ---

async function processGemini(row: GroupIngestImage, api: Api): Promise<void> {
  const logCtx = { id: row.id, chatId: row.chatId, threadId: row.threadId };

  let fileUrl: string;
  try {
    fileUrl = await resolveFileUrl(api, row.fileId!);
  } catch (err) {
    logger.warn({ ...logCtx, err }, "getFile failed in Gemini lane, marking telegram_error");
    await markFailed(row.id, "telegram_error", errMsg(err)).catch((e) => logger.warn({ ...logCtx, err: e }, "markFailed failed"));
    scheduleDigest(row.chatId, row.threadId, api);
    return;
  }

  const t0 = Date.now();
  try {
    const analysis = await retry(
      () => analyzeImage(fileUrl),
      3, 1500, "Gemini-ingest",
      (err) => !(err instanceof GeminiBlockedError),
    );
    await markDone(row.id, {
      analyzedBy: "gemini",
      moodTags: analysis.moodTags,
      contentTags: analysis.contentTags,
      isNsfw: analysis.isNsfw,
      processingMs: Date.now() - t0,
    });
    saveAnalysisToImages(row, analysis, fileUrl, logCtx);
    scheduleDigest(row.chatId, row.threadId, api);
    logger.info({ ...logCtx, durationMs: Date.now() - t0 }, "Ingest image analyzed by Gemini");
  } catch (err) {
    // Блокировка или любая ошибка Gemini → передаём строку в Ollama-полосу (это не провал).
    const reason = err instanceof GeminiBlockedError ? `gemini blocked: ${err.blockReason}` : errMsg(err);
    await routeToOllama(row.id, reason).catch((e) => logger.warn({ ...logCtx, err: e }, "routeToOllama failed"));
    logger.info({ ...logCtx, reason }, "Gemini failed/blocked, routed to Ollama lane");
  }
}

async function geminiTick(api: Api): Promise<void> {
  const capacity = GEMINI_INGEST_CONCURRENCY - geminiInFlight.size;
  if (capacity <= 0) return;

  const rows = await claimQueued("gemini", capacity, [...geminiInFlight]);
  for (const row of rows) {
    geminiInFlight.add(row.id);
    // processGemini не должен бросать (всё внутри обёрнуто), но .catch обязателен —
    // иначе любая необработанная ошибка станет unhandled rejection.
    processGemini(row, api)
      .catch((err) => logger.error({ id: row.id, chatId: row.chatId, threadId: row.threadId, err }, "processGemini crashed"))
      .finally(() => geminiInFlight.delete(row.id));
  }
}

// --- Ollama-полоса ---

async function processOllama(row: GroupIngestImage, api: Api): Promise<void> {
  const logCtx = { id: row.id, chatId: row.chatId, threadId: row.threadId };

  let fileUrl: string;
  try {
    fileUrl = await resolveFileUrl(api, row.fileId!);
  } catch (err) {
    logger.warn({ ...logCtx, err }, "getFile failed in Ollama lane, marking telegram_error");
    await markFailed(row.id, "telegram_error", errMsg(err)).catch((e) => logger.warn({ ...logCtx, err: e }, "markFailed failed"));
    scheduleDigest(row.chatId, row.threadId, api);
    return;
  }

  const t0 = Date.now();
  try {
    const analysis = await analyzeImageOllama(fileUrl);
    await markDone(row.id, {
      analyzedBy: "ollama",
      moodTags: analysis.moodTags,
      contentTags: analysis.contentTags,
      isNsfw: analysis.isNsfw,
      processingMs: Date.now() - t0,
    });
    saveAnalysisToImages(row, analysis, fileUrl, logCtx);
    scheduleDigest(row.chatId, row.threadId, api);
    logger.info({ ...logCtx, durationMs: Date.now() - t0 }, "Ingest image analyzed by Ollama");
  } catch (err) {
    const attempts = row.attempts + 1;

    // Сервер недоступен → открываем breaker (полоса встанет и будет пинговать Ollama).
    if (isOllamaDown(err)) {
      if (!ollamaDown) logger.warn({ ...logCtx, err }, "Ollama appears down, circuit breaker tripped");
      ollamaDown = true;
    }

    if (attempts >= OLLAMA_MAX_ATTEMPTS) {
      logger.warn({ ...logCtx, attempts, err }, "Ollama exhausted attempts, marking failed");
      await markFailed(row.id, "failed", errMsg(err), Date.now() - t0).catch((e) => logger.warn({ ...logCtx, err: e }, "markFailed failed"));
      scheduleDigest(row.chatId, row.threadId, api);
    } else {
      // Backoff уводит строку в конец очереди — остальные пробуются, poison-картинка не блокирует полосу.
      const delay = Math.min(OLLAMA_BACKOFF_CAP_MS, OLLAMA_BACKOFF_BASE_MS * 2 ** (attempts - 1));
      logger.warn({ ...logCtx, attempts, delayMs: delay, err }, "Ollama attempt failed, deferring retry");
      await deferRetry(row.id, attempts, new Date(Date.now() + delay), errMsg(err))
        .catch((e) => logger.warn({ ...logCtx, err: e }, "deferRetry failed"));
    }
  }
}

// Health-пинг Ollama — лёгкий GET, отдельно от тяжёлого анализа.
async function ollamaHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.ollamaUrl}/api/version`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaTick(api: Api): Promise<void> {
  if (ollamaInFlight.size >= OLLAMA_INGEST_CONCURRENCY) return;

  // Пока breaker открыт — не берём строки, а пингуем сервер. Поднялся → возобновляем.
  if (ollamaDown) {
    if (await ollamaHealthy()) {
      ollamaDown = false;
      logger.info("Ollama recovered, circuit breaker closed");
    } else {
      return;
    }
  }

  const capacity = OLLAMA_INGEST_CONCURRENCY - ollamaInFlight.size;
  const rows = await claimQueued("ollama", capacity, [...ollamaInFlight]);
  for (const row of rows) {
    ollamaInFlight.add(row.id);
    processOllama(row, api)
      .catch((err) => logger.error({ id: row.id, chatId: row.chatId, threadId: row.threadId, err }, "processOllama crashed"))
      .finally(() => ollamaInFlight.delete(row.id));
  }
}

// --- циклы ---

// Рекурсивный setTimeout (а не setInterval) — следующий тик планируется только после
// завершения текущего, так что захват строк не перекрывается между тиками.
function startLoop(tick: () => Promise<void>, label: string): void {
  const run = async () => {
    try {
      await tick();
    } catch (err) {
      logger.error({ err, label }, "Ingest worker tick failed");
    } finally {
      setTimeout(run, INGEST_TICK_MS);
    }
  };
  run();
}

export function startIngestWorker(api: Api): void {
  logger.info(
    { geminiConcurrency: GEMINI_INGEST_CONCURRENCY, ollamaConcurrency: OLLAMA_INGEST_CONCURRENCY, tickMs: INGEST_TICK_MS },
    "Ingest worker starting",
  );
  startLoop(() => geminiTick(api), "gemini");
  startLoop(() => ollamaTick(api), "ollama");
}
