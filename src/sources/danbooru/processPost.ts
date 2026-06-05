// Обработка ОДНОГО Danbooru-поста целиком: prepare (download → embed) → commit (upload → save).
// Тонкая обёртка над prepare.ts + upload.ts. Используется retry-скриптом восстановления
// (scripts/retryFailedDanbooru.ts), которому удобнее по одному посту. Воркер же (worker.ts)
// вызывает preparePost/commitBatch напрямую, чтобы загружать картинки пачками (альбомами).
import type { Api } from "grammy";
import { preparePost, type ProcessResult } from "./prepare.js";
import { commitBatch } from "./upload.js";
import type { DanbooruApiPost } from "./types.js";

export type { ProcessResult } from "./prepare.js";

export async function processPost(post: DanbooruApiPost, storageChatId: number, storageThreadId: number, api: Api): Promise<ProcessResult> {
  const prep = await preparePost(post);
  if (prep.status !== "ok") return prep.status;
  // Пачка из одного → commitBatch уйдёт обычным sendPhoto (sendMediaGroup требует ≥2)
  const [result] = await commitBatch([prep.prepared], storageChatId, storageThreadId, api);
  return result;
}
