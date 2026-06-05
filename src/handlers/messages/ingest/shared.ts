// Чистые helper-ы ingest-воркера (без разделяемого мутабельного состояния — оно живёт
// в worker.ts). Вынесены отдельно, чтобы worker.ts оставался компактным.
import type { Api } from "grammy";
import { generateImageEmbedding } from "../../../ai/gemini/index.js";
import { saveImage } from "../../../db/savedImages.js";
import type { GroupIngestImage } from "../../../db/schema.js";
import { retry } from "../../../utils/retry.js";
import { config } from "../../../config.js";
import logger from "../../../logger.js";
import type { ImageAnalysis } from "../../../ai/gemini/index.js";

export function errMsg(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 500);
}

// Ошибки, означающие что сервер Ollama недоступен / runner упал (а не битый ответ на конкретной картинке).
export function isOllamaDown(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /connection refused|model runner|fetch failed|ECONNREFUSED|socket hang up|terminated|Ollama HTTP 5|aborted/i.test(msg);
}

export async function resolveFileUrl(api: Api, fileId: string): Promise<string> {
  const file = await retry(() => api.getFile(fileId), 3, 1500, "getFile-ingest");
  return `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
}

// Сохранение в saved_images — ради чего анализ и делается. Fire-and-forget: сбой не должен ломать конвейер.
export function saveAnalysisToImages(row: GroupIngestImage, analysis: ImageAnalysis, fileUrl: string, logCtx: Record<string, unknown>): void {
  if (!row.fileId || !row.senderUserId) return;
  const fileId = row.fileId;
  const senderUserId = row.senderUserId;
  (async () => {
    let embedding: number[];
    try {
      // Эмбеддим картинку + текст анализа (см. generateImageEmbedding).
      // Обёрнуто в retry (как danbooru-путь): транзиентные сбои (ECONNRESET, socket hang up,
      // 429 RESOURCE_EXHAUSTED от общей с danbooru квоты Gemini) иначе молча теряли картинку.
      // 6 попыток с базой 4с (паузы до 60с суммарно) пересиживают минутное окно rate-лимита;
      // это безопасно — функция fire-and-forget (вызывается без await), Gemini-лейн не блокируется.
      const analysisText = `${analysis.description} ${[...analysis.moodTags, ...analysis.contentTags].join(" ")}`;
      embedding = await retry(() => generateImageEmbedding(fileUrl, analysisText), 6, 4000, "Ingest embed");
    } catch (err) {
      logger.warn({ ...logCtx, err }, "Embedding failed, image not saved to saved_images");
      return;
    }
    saveImage({
      fileId,
      senderUserId,
      description: analysis.description,
      caption: row.caption ?? null,
      moodTags: analysis.moodTags,
      contentTags: analysis.contentTags,
      isNsfw: analysis.isNsfw,
      embedding,
    })
      .then(() => logger.info({ ...logCtx }, "Ingest image saved to saved_images"))
      .catch((err) => logger.warn({ ...logCtx, err }, "Failed to save ingest image to saved_images"));
  })().catch((err) => logger.warn({ ...logCtx, err }, "saveAnalysisToImages background task crashed"));
}
