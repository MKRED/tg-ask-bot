import { eq, inArray, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { groupIngestImages } from "../db/schema.js";

// Сбрасывает провалившиеся ingest-картинки (analyzed_by='failed') обратно в очередь,
// чтобы их заново подхватил работающий фоновый воркер (ingestWorker.ts).
// Запускать после того, как разобрался с причиной провала (она лежит в колонке last_error).
//
// Использование:
//   yarn tsx src/scripts/retryFailedIngest.ts            # все failed-строки
//   yarn tsx src/scripts/retryFailedIngest.ts 12 34 56   # только указанные id
async function main() {
  const idArgs = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n));

  // Показываем, что собираемся повторить, вместе с причиной провала
  const targets = await db
    .select({
      id: groupIngestImages.id,
      chatId: groupIngestImages.chatId,
      threadId: groupIngestImages.threadId,
      route: groupIngestImages.route,
      lastError: groupIngestImages.lastError,
    })
    .from(groupIngestImages)
    .where(
      idArgs.length > 0
        ? and(eq(groupIngestImages.analyzedBy, "failed"), inArray(groupIngestImages.id, idArgs))
        : eq(groupIngestImages.analyzedBy, "failed"),
    );

  if (targets.length === 0) {
    console.log("No failed ingest rows to retry.");
    process.exit(0);
  }

  console.log(`Re-enqueueing ${targets.length} failed ingest row(s):`);
  for (const t of targets) {
    console.log(`  id=${t.id} chat=${t.chatId} thread=${t.threadId} route=${t.route} lastError=${t.lastError ?? "-"}`);
  }

  // Сброс в очередь: статус pending, счётчик попыток обнулён, время повтора — сейчас,
  // reported_at снят (строка снова попадёт в будущую сводку). route НЕ трогаем —
  // провалившиеся строки уже в нужной полосе (как правило ollama), повторный прогон
  // через Gemini только потратил бы лишний заблокированный запрос.
  const ids = targets.map((t) => t.id);
  await db
    .update(groupIngestImages)
    .set({
      analyzedBy: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      reportedAt: null,
      lastError: null,
      processedAt: null,
      processingMs: null,
    })
    .where(inArray(groupIngestImages.id, ids));

  console.log(`\nDone. ${ids.length} row(s) reset to 'pending' — the running bot's worker will pick them up.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
