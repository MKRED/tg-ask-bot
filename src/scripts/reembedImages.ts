import { isNull, gt, asc, eq } from "drizzle-orm";
import { bot } from "../bot.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { savedImages } from "../db/schema.js";
import { generateImageEmbedding } from "../ai/gemini.js";

// Миграция эмбеддингов на gemini-embedding-2 (картинка + текст анализа).
//
// ЗАЧЕМ: старые строки saved_images.embedding построены текстовой моделью
// gemini-embedding-001. Новая модель живёт в ДРУГОМ пространстве той же
// размерности (3072) — Postgres примет их молча, но косинус между старым и
// новым вектором бессмыслен. Поэтому переэмбеддить нужно ВСЕ строки,
// а query-путь переключать только после полного прогона.
//
// ВАЖНО: запускать при ОСТАНОВЛЕННОМ боте — пока в таблице смешаны старые и новые
// векторы, поиск по картинкам выдаёт мусор.
//
// Узкое место — латентность одного вызова (~4.5с через прокси), поэтому гоняем
// ПУЛОМ из N параллельных запросов. Лимит API (per-project) ловим через backoff
// на 429: ждём (по retryDelay из тела ошибки либо экспоненту) и повторяем ту же строку.
// При окончательном провале или пропавшем файле — пишем NULL (НЕ оставляем старый
// вектор: иначе он останется мусором в новом пространстве). NULL-строки добираются
// повторным проходом в режиме "nulls".
//
// Использование:
//   yarn tsx src/scripts/reembedImages.ts                  # все строки, конкурентность 4
//   yarn tsx src/scripts/reembedImages.ts 30 0 4           # до 30 строк с id>0, конкурентность 4 (тест)
//   yarn tsx src/scripts/reembedImages.ts 5000 123 6       # до 5000 строк с id>123, конкурентность 6
//   yarn tsx src/scripts/reembedImages.ts nulls 4          # mop-up: только строки с embedding IS NULL

const MAX_RETRIES = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /RESOURCE_EXHAUSTED|"code":\s*429|quota|rate.?limit/i.test(msg);
}

// Google часто кладёт рекомендованную паузу в RetryInfo.retryDelay ("30s") — уважаем её.
function parseRetryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

// Эмбеддинг с backoff: на 429 ждём и повторяем ту же строку; на прочих ошибках —
// короткий ретрай (на случай сетевого сбоя). После MAX_RETRIES пробрасываем наверх.
async function embedWithBackoff(fileUrl: string, analysisText: string, logTag: string): Promise<number[]> {
  let attempt = 0;
  for (;;) {
    try {
      return await generateImageEmbedding(fileUrl, analysisText);
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES) throw err;
      if (isQuotaError(err)) {
        const wait = parseRetryDelayMs(err) ?? Math.min(30000, 4000 * 2 ** (attempt - 1));
        console.log(`  ${logTag} 429 (attempt ${attempt}/${MAX_RETRIES}) → wait ${wait}ms`);
        await sleep(wait);
      } else {
        console.log(`  ${logTag} error (attempt ${attempt}/${MAX_RETRIES}), retry:`, err instanceof Error ? err.message : err);
        await sleep(1500);
      }
    }
  }
}

async function nullify(id: number): Promise<void> {
  try {
    await db.update(savedImages).set({ embedding: null }).where(eq(savedImages.id, id));
  } catch (err) {
    console.log(`  id=${id} failed to NULL embedding:`, err);
  }
}

type Outcome = "ok" | "nulled";

async function processRow(row: typeof savedImages.$inferSelect): Promise<Outcome> {
  // 1. Достаём картинку. Сбой getFile (файл пропал/протух) → NULL.
  let fileUrl: string;
  try {
    const file = await bot.api.getFile(row.fileId);
    fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  } catch (err) {
    console.log(`  id=${row.id} getFile failed → NULL:`, err instanceof Error ? err.message : err);
    await nullify(row.id);
    return "nulled";
  }

  const analysisText = `${row.description ?? ""} ${[...row.moodTags, ...row.contentTags].join(" ")}`.trim();

  // 2. Эмбеддинг с backoff. Не вышло за MAX_RETRIES → NULL.
  try {
    const embedding = await embedWithBackoff(fileUrl, analysisText, `id=${row.id}`);
    await db.update(savedImages).set({ embedding }).where(eq(savedImages.id, row.id));
    return "ok";
  } catch (err) {
    console.log(`  id=${row.id} embed gave up → NULL:`, err instanceof Error ? err.message : err);
    await nullify(row.id);
    return "nulled";
  }
}

// Пул из `concurrency` воркеров, тянущих строки из общего курсора.
async function runPool(rows: (typeof savedImages.$inferSelect)[], concurrency: number) {
  let idx = 0;
  let ok = 0;
  let nulled = 0;
  const total = rows.length;
  const t0 = Date.now();

  async function worker() {
    while (idx < total) {
      const row = rows[idx++];
      const n = idx;
      const res = await processRow(row);
      if (res === "ok") ok++; else nulled++;
      const rate = (ok + nulled) / ((Date.now() - t0) / 60000);
      console.log(`[${n}/${total}] ${res === "ok" ? "✓" : "⊘"} id=${row.id} (~${rate.toFixed(1)}/min)`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { ok, nulled, elapsedMs: Date.now() - t0 };
}

async function main() {
  const argv = process.argv.slice(2);
  let rows: (typeof savedImages.$inferSelect)[];
  let concurrency: number;
  let cursorHint = "";

  if (argv[0] === "nulls") {
    // Mop-up: только строки без эмбеддинга (провалы прошлых проходов + пропавшие файлы).
    concurrency = argv[1] ? parseInt(argv[1], 10) : 4;
    rows = await db.select().from(savedImages).where(isNull(savedImages.embedding)).orderBy(asc(savedImages.id));
    console.log(`Mop-up mode: ${rows.length} rows with NULL embedding, concurrency=${concurrency}`);
  } else {
    const limitArg = argv[0] ? parseInt(argv[0], 10) : null;
    const afterId = argv[1] ? parseInt(argv[1], 10) : 0;
    concurrency = argv[2] ? parseInt(argv[2], 10) : 4;
    const baseQuery = db.select().from(savedImages).where(gt(savedImages.id, afterId)).orderBy(asc(savedImages.id));
    rows = limitArg ? await baseQuery.limit(limitArg) : await baseQuery;
    console.log(`Forward mode: ${rows.length} rows (afterId=${afterId}, ${limitArg ? `limit=${limitArg}` : "all"}), concurrency=${concurrency}`);
    if (rows.length) cursorHint = `${rows[rows.length - 1].id}`;
  }

  if (!rows.length) { console.log("Nothing to do."); process.exit(0); }

  const { ok, nulled, elapsedMs } = await runPool(rows, concurrency);

  const min = (elapsedMs / 60000).toFixed(1);
  console.log(`\nDone in ${min} min: ${ok} re-embedded, ${nulled} nulled (file gone / gave up)`);
  console.log(`Throughput: ${((ok + nulled) / (elapsedMs / 60000)).toFixed(1)} rows/min`);
  if (cursorHint) console.log(`Resume next batch from: yarn tsx src/scripts/reembedImages.ts <limit> ${cursorHint} <concurrency>`);
  if (nulled) console.log(`Mop up nulled rows later with: yarn tsx src/scripts/reembedImages.ts nulls <concurrency>`);
  process.exit(0);
}

main().catch((err) => {
  console.log(err);
  process.exit(1);
});
