import type { Api } from "grammy";
import { getPendingBatch, deleteBatchByIds, markReportedByIds, countPending, getStaleIngestThreads } from "../../../db/groupIngestImages.js";
import { GROUP_MSG_TIMEZONE } from "../../../constants/index.js";
import logger from "../../../logger.js";

const DIGEST_DELAY_MS = 5 * 60 * 1000;

// Таймеры дебаунса: chatId:threadId → NodeJS.Timeout
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function timerKey(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

// Сбрасывает таймер дайджеста на DIGEST_DELAY_MS.
// Вызывается после каждой принятой картинки в ingest-треде.
export function scheduleDigest(chatId: number, threadId: number, api: Api): void {
  armTimer(chatId, threadId, api, DIGEST_DELAY_MS);
}

function armTimer(chatId: number, threadId: number, api: Api, delayMs: number): void {
  const key = timerKey(chatId, threadId);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    timers.delete(key);
    sendDigest(chatId, threadId, api).catch((err) =>
      logger.error({ err, chatId, threadId }, "Ingest digest send failed")
    );
  }, delayMs);
  timers.set(key, timer);
}

async function sendDigest(chatId: number, threadId: number, api: Api): Promise<void> {
  // Пока в очереди есть необработанные картинки (например, Ollama лежит и строки ждут повтора),
  // сводку НЕ шлём — иначе она будет частичной. Перевзводим таймер и проверим позже.
  // Безопасно от «никогда не выстрелит»: poison-картинки уходят в failed после OLLAMA_MAX_ATTEMPTS,
  // так что pending > 0 держится только пока Ollama реально недоступна.
  const pending = await countPending(chatId, threadId);
  if (pending > 0) {
    logger.info({ chatId, threadId, pending }, "Digest deferred — queue not drained yet, re-arming timer");
    armTimer(chatId, threadId, api, DIGEST_DELAY_MS);
    return;
  }

  const rows = await getPendingBatch(chatId, threadId);
  if (rows.length === 0) return;

  // Захватываем ID до await sendMessage — новые картинки, пришедшие пока шлём, не попадут под удаление.
  // Успешные строки удаляем; проблемные (failed/telegram_error) оставляем в таблице для разбора и повтора,
  // лишь помечая reported_at, чтобы они не считались в следующих сводках.
  const successIds = rows.filter((r) => r.analyzedBy === "gemini" || r.analyzedBy === "ollama").map((r) => r.id);
  const keepIds = rows.filter((r) => r.analyzedBy === "failed" || r.analyzedBy === "telegram_error").map((r) => r.id);
  const text = formatDigest(rows);

  const threadOpts = threadId !== 0 ? { message_thread_id: threadId } : {};
  const t0 = Date.now();

  try {
    await api.sendMessage(chatId, text, { parse_mode: "HTML", ...threadOpts });
    await deleteBatchByIds(successIds);
    await markReportedByIds(keepIds);
    logger.info({ chatId, threadId, deleted: successIds.length, kept: keepIds.length, durationMs: Date.now() - t0 }, "Ingest digest sent");
  } catch (err) {
    logger.error({ err, chatId, threadId }, "Failed to send ingest digest, rows NOT deleted — will retry on next batch");
  }
}

// Вызывается при старте бота. Для каждого треда с незакрытыми строками:
// — если последняя картинка пришла ≥5 мин назад, шлём сводку сразу
// — иначе перевооружаем таймер на оставшееся время
export async function checkStaleDigests(api: Api): Promise<void> {
  let threads: Awaited<ReturnType<typeof getStaleIngestThreads>>;
  try {
    threads = await getStaleIngestThreads();
  } catch (err) {
    logger.error({ err }, "Failed to load stale ingest threads on startup");
    return;
  }

  logger.info({ count: threads.length }, "Checking stale ingest digests on startup");

  for (const { chatId, threadId, maxSavedAt } of threads) {
    const ageMs = Date.now() - maxSavedAt.getTime();
    if (ageMs >= DIGEST_DELAY_MS) {
      logger.info({ chatId, threadId, ageMs }, "Stale ingest batch found, sending digest immediately");
      sendDigest(chatId, threadId, api).catch((err) =>
        logger.warn({ err, chatId, threadId }, "Stale ingest digest send failed")
      );
    } else {
      const remaining = DIGEST_DELAY_MS - ageMs;
      logger.info({ chatId, threadId, remainingMs: remaining }, "Re-arming ingest digest timer after restart");
      armTimer(chatId, threadId, api, remaining);
    }
  }
}

// --- форматирование сводки ---

type DigestRow = {
  analyzedBy: string;
  moodTags: string[];
  contentTags: string[];
  isNsfw: boolean;
  savedAt: Date;
  processedAt: Date | null;
  processingMs: number | null;
};

function topN(tags: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([tag]) => tag);
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: GROUP_MSG_TIMEZONE });
}

function pct(n: number, total: number): string {
  return `${Math.round((n / total) * 100)}%`;
}

function formatDigest(rows: DigestRow[]): string {
  const total = rows.length;
  const gemini = rows.filter((r) => r.analyzedBy === "gemini").length;
  const ollama = rows.filter((r) => r.analyzedBy === "ollama").length;
  const failed = rows.filter((r) => r.analyzedBy === "failed").length;
  const tgError = rows.filter((r) => r.analyzedBy === "telegram_error").length;
  const nsfw = rows.filter((r) => r.isNsfw).length;

  const times = rows.map((r) => r.savedAt.getTime());
  const minTime = new Date(Math.min(...times));
  const maxTime = new Date(Math.max(...times));
  const receivedMin = Math.round((maxTime.getTime() - minTime.getTime()) / 60000);
  const receivedStr = receivedMin > 0
    ? `${fmtTime(minTime)} — ${fmtTime(maxTime)} (${receivedMin} мин)`
    : `в ${fmtTime(minTime)}`;

  // Статистика времени обработки: от первой принятой до последней обработанной картинки
  const processedTimes = rows.map((r) => r.processedAt).filter((d): d is Date => d != null).map((d) => d.getTime());
  const procMs = rows.map((r) => r.processingMs).filter((m): m is number => m != null);

  const topMood = topN(rows.flatMap((r) => r.moodTags), 5);
  const topContent = topN(rows.flatMap((r) => r.contentTags), 5);

  let text = `📦 <b>Сводка поглощения</b>\n\n`;
  text += `🕐 Получено: ${receivedStr}\n`;

  if (processedTimes.length > 0) {
    const lastProcessed = new Date(Math.max(...processedTimes));
    const totalMin = Math.round((lastProcessed.getTime() - minTime.getTime()) / 60000);
    text += `⏱ Обработано к ${fmtTime(lastProcessed)}${totalMin > 0 ? ` (заняло ${totalMin} мин)` : ""}\n`;
  }
  if (procMs.length > 0) {
    const sumMs = procMs.reduce((a, b) => a + b, 0);
    const avgSec = Math.round(sumMs / procMs.length / 1000);
    const totalSec = Math.round(sumMs / 1000);
    const totalStr = totalSec >= 60 ? `${Math.round(totalSec / 60)} мин` : `${totalSec} сек`;
    text += `⚙️ В среднем ${avgSec} сек/картинка (суммарно ${totalStr} анализа)\n`;
  }
  text += `\n`;
  text += `📊 <b>Всего получено:</b> ${total}\n\n`;
  text += `✅ Gemini: ${gemini} (${pct(gemini, total)})\n`;
  text += `🔄 Ollama: ${ollama} (${pct(ollama, total)})\n`;
  if (failed > 0) text += `⚠️ Не удалось обработать: ${failed} (${pct(failed, total)})\n`;
  if (tgError > 0) text += `📡 Ошибка Telegram: ${tgError} (${pct(tgError, total)})\n`;
  if (nsfw > 0) text += `\n🔞 NSFW: ${nsfw} (${pct(nsfw, total)})\n`;
  if (topMood.length > 0) text += `\n🏷 <b>Настроение:</b> ${topMood.join(", ")}\n`;
  if (topContent.length > 0) text += `📌 <b>Содержимое:</b> ${topContent.join(", ")}\n`;

  return text;
}
