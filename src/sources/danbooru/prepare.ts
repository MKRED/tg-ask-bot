// Фаза подготовки одного Danbooru-поста: download → embed (БЕЗ загрузки в Telegram).
// Вынесена из upload-фазы, потому что upload теперь батчевый (sendMediaGroup), а
// download/embed остаются по-постовыми и параллелятся в пуле воркера.
//
// Порядок (advisor: «embed first, upload last»): зря не тратим Telegram flood-бюджет на
// картинки, которые Gemini не может проэмбеддить. На вход upload-фазы идут только «готовые».
import { generateImageEmbeddingFromBuffer } from "../../ai/gemini/index.js";
import { markDanbooruPostFailed, markDanbooruPostSkipped } from "../../db/danbooruPosts.js";
import { retry } from "../../utils/retry.js";
import { downloadDanbooruImage } from "./client.js";
import { extToMimeType, buildDescriptionAndTags } from "./transform.js";
import type { DanbooruApiPost } from "./types.js";
import logger from "../../logger.js";

export function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

// Исход обработки одного поста — для статистики в логе тика.
export type ProcessResult = "imported" | "skipped" | "failed";

// Готовый к загрузке пост: всё, что нужно upload-фазе (буфер для sendPhoto/sendMediaGroup,
// embedding и метаданные для saved_images).
export interface PreparedPost {
  post: DanbooruApiPost;
  buffer: Buffer;
  embedding: number[];
  description: string;
  contentTags: string[];
}

export type PrepareResult =
  | { status: "ok"; prepared: PreparedPost }
  | { status: "skipped" }
  | { status: "failed" };

// Скачивает и эмбеддит пост. Терминальные исходы (skipped/failed) сразу фиксируются в БД.
// Никогда не бросает — всё в try/catch, чтобы пул воркера не отклонялся.
export async function preparePost(post: DanbooruApiPost): Promise<PrepareResult> {
  const logCtx = { danbooruId: post.id, ext: post.file_ext, rating: post.rating };

  // Пропускаем удалённые/забаненные/pending посты без file_url
  if (post.is_deleted || post.is_banned) {
    await markDanbooruPostSkipped(post.id, "deleted_or_banned");
    logger.debug({ ...logCtx }, "Danbooru post skipped: deleted/banned");
    return { status: "skipped" };
  }

  const imageUrl = post.large_file_url ?? post.file_url;
  if (!imageUrl) {
    await markDanbooruPostSkipped(post.id, "no_file_url");
    logger.debug({ ...logCtx }, "Danbooru post skipped: no image URL");
    return { status: "skipped" };
  }

  // Шаг 1: скачиваем один раз — буфер используется и для embedding, и для Telegram upload
  let buffer: Buffer;
  try {
    buffer = await retry(() => downloadDanbooruImage(imageUrl), 3, 1500, `Danbooru download ${post.id}`);
  } catch (err) {
    await markDanbooruPostFailed(post.id, errMsg(err));
    logger.warn({ ...logCtx, err }, "Danbooru image download failed");
    return { status: "failed" };
  }

  // Шаг 2: embedding. 6 попыток с базой 4с (linear backoff → паузы 4+8+12+16+20 = 60с) —
  // намеренно «пересиживает» минутное окно rate-лимита Gemini (429 RESOURCE_EXHAUSTED): на
  // догоне бэклога параллельные эмбеддинги + ingest-лейн на одном ключе всплесками пробивают
  // поминутную квоту. 60с дают окну отпустить; при всплеске пул сам уходит в backoff.
  const { description, contentTags } = buildDescriptionAndTags(post);
  const analysisText = `${description} ${contentTags.join(" ")}`;
  const mimeType = extToMimeType(post.file_ext);

  let embedding: number[];
  try {
    embedding = await retry(() => generateImageEmbeddingFromBuffer(buffer, mimeType, analysisText), 6, 4000, `Danbooru embed ${post.id}`);
  } catch (err) {
    await markDanbooruPostFailed(post.id, errMsg(err));
    logger.warn({ ...logCtx, err }, "Danbooru post embedding failed, skipping Telegram upload");
    return { status: "failed" };
  }

  return { status: "ok", prepared: { post, buffer, embedding, description, contentTags } };
}
