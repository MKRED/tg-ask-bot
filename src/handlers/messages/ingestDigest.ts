import type { Api } from "grammy";
import { getPendingBatch, deleteBatchByIds, getStaleIngestThreads } from "../../db/groupIngestImages.js";
import { GROUP_MSG_TIMEZONE } from "../../constants/index.js";
import logger from "../../logger.js";

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
  const rows = await getPendingBatch(chatId, threadId);
  if (rows.length === 0) return;

  // Захватываем ID до await sendMessage — новые картинки, пришедшие пока шлём, не попадут под удаление
  const ids = rows.map((r) => r.id);
  const text = formatDigest(rows);

  const threadOpts = threadId !== 0 ? { message_thread_id: threadId } : {};
  const t0 = Date.now();

  try {
    await api.sendMessage(chatId, text, { parse_mode: "HTML", ...threadOpts });
    await deleteBatchByIds(ids);
    logger.info({ chatId, threadId, count: ids.length, durationMs: Date.now() - t0 }, "Ingest digest sent");
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

type DigestRow = { analyzedBy: string; moodTags: string[]; contentTags: string[]; isNsfw: boolean; savedAt: Date };

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
  const durationMin = Math.round((maxTime.getTime() - minTime.getTime()) / 60000);
  const timeStr = durationMin > 0
    ? `${fmtTime(minTime)} — ${fmtTime(maxTime)} (${durationMin} мин)`
    : `в ${fmtTime(minTime)}`;

  const topMood = topN(rows.flatMap((r) => r.moodTags), 5);
  const topContent = topN(rows.flatMap((r) => r.contentTags), 5);

  let text = `📦 <b>Сводка поглощения</b>\n\n`;
  text += `🕐 ${timeStr}\n\n`;
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
