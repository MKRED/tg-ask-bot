import "dotenv/config";
import { config } from "../config.js";
import { bot } from "../bot.js";
import { getDanbooruState } from "../db/danbooruState.js";
import { getFailedDanbooruPosts, markDanbooruPostSkipped } from "../db/danbooruPosts.js";
import { fetchPostById } from "../sources/danbooru/client.js";
import { processPost } from "../sources/danbooru/processPost.js";
import { DANBOORU_UPLOAD_DELAY_MS } from "../sources/danbooru/constants.js";
import logger from "../logger.js";

// Переобрабатывает упавшие Danbooru-посты (status='failed').
// Зачем отдельный скрипт: фоновый воркер тянет только посты ВПЕРЁД от курсора и
// никогда не перечитывает danbooru_posts — поэтому упавший пост (он позади курсора)
// сам не переобработается. Здесь мы перезапрашиваем каждый пост по ID и гоним его
// через тот же processPost (download → embed → upload → save с ретраями).
// Запускать можно при работающем боте (он не трогает эти строки) или с остановленным.
//
// Использование:
//   yarn tsx src/scripts/retryFailedDanbooru.ts          # все failed-посты
//   yarn tsx src/scripts/retryFailedDanbooru.ts 100       # не больше 100 за прогон
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!config.danbooruLogin || !config.danbooruApiKey) {
    console.log("DANBOORU_LOGIN / DANBOORU_API_KEY not set — nothing to do.");
    process.exit(0);
  }

  const state = await getDanbooruState();
  if (!state?.storageChatId) {
    console.log("Danbooru storage chat not configured (/setdanboorustorage) — cannot upload images.");
    process.exit(1);
  }
  const storageChatId = state.storageChatId;
  const storageThreadId = state.storageThreadId;

  const limitArg = Number(process.argv[2]);
  const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : 500;

  const failed = await getFailedDanbooruPosts(limit);
  if (failed.length === 0) {
    console.log("No failed Danbooru posts to retry.");
    process.exit(0);
  }

  console.log(`Retrying ${failed.length} failed Danbooru post(s)...\n`);

  let imported = 0;
  let gone = 0;
  let skipped = 0;
  let stillFailed = 0;

  for (const row of failed) {
    try {
      const post = await fetchPostById(row.danbooruId, config.danbooruLogin, config.danbooruApiKey);
      if (!post) {
        // Пост удалён/недоступен — больше не пытаемся, помечаем skipped
        await markDanbooruPostSkipped(row.danbooruId, "not_found_on_retry");
        gone++;
        console.log(`  #${row.danbooruId}: gone (404) → skipped`);
        continue;
      }

      const result = await processPost(post, storageChatId, storageThreadId, bot.api);
      // skipped/failed уже зафиксированы внутри processPost. skipped (напр. битые размеры —
      // PHOTO_INVALID_DIMENSIONS) больше не вернётся в getFailedDanbooruPosts, failed вернётся.
      if (result === "imported") {
        imported++;
        console.log(`  #${row.danbooruId}: imported ✅`);
      } else if (result === "skipped") {
        skipped++;
        console.log(`  #${row.danbooruId}: skipped (не вернётся в retry)`);
      } else {
        stillFailed++;
        console.log(`  #${row.danbooruId}: failed`);
      }
    } catch (err) {
      // Сетевая ошибка fetchPostById и т.п. — строка остаётся failed, попробуем в следующий раз
      stillFailed++;
      logger.warn({ danbooruId: row.danbooruId, err }, "retryFailedDanbooru: post retry crashed");
      console.log(`  #${row.danbooruId}: error — ${err instanceof Error ? err.message : String(err)}`);
    }

    // Пауза между загрузками в Telegram — защита от flood-лимита
    await sleep(DANBOORU_UPLOAD_DELAY_MS);
  }

  console.log(`\nDone. imported=${imported}, gone=${gone}, skipped=${skipped}, still_failed=${stillFailed}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
