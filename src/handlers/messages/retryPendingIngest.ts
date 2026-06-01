import type { Api } from "grammy";
import { generateEmbedding } from "../../ai/gemini.js";
import { getPendingIngestImages, updateIngestImage } from "../../db/groupIngestImages.js";
import { saveImage } from "../../db/savedImages.js";
import { analyzePhotoWithFallback } from "./photoAnalysis.js";
import { scheduleDigest } from "./ingestDigest.js";
import { retry } from "../../utils/retry.js";
import { config } from "../../config.js";
import logger from "../../logger.js";

// Вызывается при старте ПЕРЕД checkStaleDigests — порядок критичен.
// Если checkStaleDigests запустится раньше, он отправит дайджест с pending-строками,
// которые не попадут ни в одну категорию статистики, и сразу удалит их.
//
// Pending-строки — это картинки, анализ которых был прерван рестартом бота
// (они ждали в очереди семафора Ollama).
// Повторяем анализ для каждой, обновляем строку, сохраняем в saved_images, перевооружаем таймер.
export async function retryPendingImages(api: Api): Promise<void> {
  let pending: Awaited<ReturnType<typeof getPendingIngestImages>>;
  try {
    pending = await getPendingIngestImages();
  } catch (err) {
    logger.error({ err }, "Failed to load pending ingest images on startup");
    return;
  }

  if (pending.length === 0) return;

  logger.info({ count: pending.length }, "Retrying pending ingest images after restart");

  for (const row of pending) {
    const logCtx = { id: row.id, chatId: row.chatId, threadId: row.threadId };

    if (!row.fileId) {
      // Нет fileId — не можем скачать (такого не должно быть для pending, но на всякий случай)
      await updateIngestImage(row.id, { analyzedBy: "failed", moodTags: [], contentTags: [], isNsfw: false })
        .catch((err) => logger.warn({ ...logCtx, err }, "Failed to mark no-fileId pending row as failed"));
      scheduleDigest(row.chatId, row.threadId, api);
      continue;
    }

    try {
      const file = await retry(() => api.getFile(row.fileId!), 3, 1500, "getFile-pending-retry");
      const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

      const { imageAnalysis, analyzedBy } = await analyzePhotoWithFallback(fileUrl, logCtx);

      await updateIngestImage(row.id, {
        analyzedBy,
        moodTags: imageAnalysis?.moodTags ?? [],
        contentTags: imageAnalysis?.contentTags ?? [],
        isNsfw: imageAnalysis?.isNsfw ?? false,
      });

      // Сохраняем в saved_images — ради чего анализ и делался
      if (imageAnalysis && row.fileId && row.senderUserId) {
        const analysis = imageAnalysis;
        (async () => {
          let embedding: number[];
          try {
            const embeddingText = `${analysis.description} ${[...analysis.moodTags, ...analysis.contentTags].join(" ")}`;
            embedding = await generateEmbedding(embeddingText);
          } catch (err) {
            logger.warn({ ...logCtx, err }, "Embedding failed during pending retry, image will not be saved to saved_images");
            return;
          }
          saveImage({
            fileId: row.fileId!,
            senderUserId: row.senderUserId!,
            description: analysis.description,
            caption: row.caption ?? null,
            moodTags: analysis.moodTags,
            contentTags: analysis.contentTags,
            isNsfw: analysis.isNsfw,
            embedding,
          })
            .then(() => logger.info({ ...logCtx }, "Retried ingest image saved to saved_images"))
            .catch((err) => logger.warn({ ...logCtx, err }, "Failed to save retried ingest image to saved_images"));
        })();
      }

      logger.info({ ...logCtx, analyzedBy }, "Pending ingest image retried successfully");
    } catch (err) {
      logger.warn({ ...logCtx, err }, "Failed to retry pending ingest image, marking as failed");
      await updateIngestImage(row.id, { analyzedBy: "failed", moodTags: [], contentTags: [], isNsfw: false })
        .catch((e) => logger.warn({ ...logCtx, err: e }, "Also failed to mark row as failed after retry"));
    }

    // Перевооружаем таймер после каждой строки — дайджест не выстрелит раньше
    // чем мы закончим обработку всей очереди pending
    scheduleDigest(row.chatId, row.threadId, api);
  }

  logger.info({ count: pending.length }, "Pending ingest images retry completed");
}
