import { eq } from "drizzle-orm";
import { bot } from "../bot.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { savedImages } from "../db/schema.js";
import { analyzeImage, GeminiBlockedError } from "../ai/gemini/index.js";
import { analyzeImageOllama } from "../ai/ollama.js";
import type { ImageAnalysis } from "../ai/gemini/index.js";

// Диагностика промпта: берёт картинку из saved_images по id, прогоняет её ЗАНОВО
// через текущий промпт (Gemini → Ollama при блокировке, как в проде) и печатает
// старый результат рядом с новым. Ничего в базу не пишет.
//
// Использование:
//   yarn tsx src/scripts/reanalyzeImage.ts 521          # Gemini (→ Ollama при блокировке)
//   yarn tsx src/scripts/reanalyzeImage.ts 521 ollama   # принудительно локальная Ollama
async function main() {
  const id = Number(process.argv[2]);
  const forceOllama = process.argv[3] === "ollama";
  if (!Number.isInteger(id)) {
    console.error("Usage: yarn tsx src/scripts/reanalyzeImage.ts <id> [ollama]");
    process.exit(1);
  }

  const [row] = await db.select().from(savedImages).where(eq(savedImages.id, id));
  if (!row) {
    console.error(`No saved_images row with id=${id}`);
    process.exit(1);
  }

  console.log(`=== СТАРЫЙ результат (id=${id}, в базе) ===`);
  console.log("description:", row.description);
  console.log("mood_tags:  ", row.moodTags.join(", "));
  console.log("content_tags:", row.contentTags.join(", "));
  console.log("is_nsfw:    ", row.isNsfw);

  const file = await bot.api.getFile(row.fileId);
  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

  let fresh: ImageAnalysis;
  let analyzedBy: string;
  if (forceOllama) {
    fresh = await analyzeImageOllama(url);
    analyzedBy = "ollama (forced)";
  } else {
    try {
      fresh = await analyzeImage(url);
      analyzedBy = "gemini";
    } catch (err) {
      if (err instanceof GeminiBlockedError) {
        console.log(`\n(Gemini заблокировал: ${err.blockReason} → фолбэк на Ollama)`);
        fresh = await analyzeImageOllama(url);
        analyzedBy = "ollama";
      } else {
        throw err;
      }
    }
  }

  console.log(`\n=== НОВЫЙ промпт (${analyzedBy}) ===`);
  console.log("description:", fresh.description);
  console.log("mood_tags:  ", fresh.moodTags.join(", "));
  console.log("content_tags:", fresh.contentTags.join(", "));
  console.log("is_nsfw:    ", fresh.isNsfw);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
