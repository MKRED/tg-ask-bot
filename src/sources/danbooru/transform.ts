// Преобразование метаданных Danbooru-поста в формат проекта: ссылка на пост, MIME-тип,
// NSFW-флаг, описание и теги для эмбеддинга/saved_images.
import { DANBOORU_BASE_URL } from "./constants.js";
import type { DanbooruApiPost } from "./types.js";

// URL страницы поста на Danbooru — строится из id (отдельной колонки не держим,
// danbooru_id уже есть в danbooru_posts). Используется для inline-кнопки «Источник».
export function danbooruPostUrl(id: number): string {
  return `${DANBOORU_BASE_URL}/posts/${id}`;
}

// Конвертация расширения файла в MIME-тип для Gemini embedding.
export function extToMimeType(ext: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
  return map[ext.toLowerCase()] ?? "image/jpeg";
}

// Определяем NSFW по рейтингу Danbooru.
// g (general) и s (sensitive) — безопасный/слегка suggestive контент.
// q (questionable) и e (explicit) — NSFW.
export function isNsfwRating(rating: string): boolean {
  return rating === "q" || rating === "e";
}

// Разбиваем пробел-разделённые строки тегов на массивы.
// Danbooru не возвращает массивы нативно — только строки вида "tag1 tag2 tag3".
export function splitTags(tagString: string): string[] {
  return tagString.split(" ").filter(Boolean);
}

// Danbooru-теги в snake_case (long_hair, hatsune_miku, fate/grand_order). Для текста
// эмбеддинга и для saved_images.content_tags переводим в естественную форму («long hair»):
// поисковый запрос пользователя — обычный текст, а не booru-тег, и пробельная форма
// заметно лучше стыкуется с ним в общем мультимодальном пространстве. Сырая (underscore)
// форма сохраняется отдельно в danbooru_posts.*_tags для аудита/точного маппинга.
function normalizeTag(tag: string): string {
  return tag.replace(/_/g, " ");
}

// Строим текстовое описание и теги из метаданных Danbooru.
// Возвращаемые *Tags-массивы — СЫРЫЕ (для danbooru_posts.*_tags).
// description + contentTags — НОРМАЛИЗОВАННЫЕ (для эмбеддинга и saved_images.content_tags).
// Персонаж, франшиза (copyright) и автор (artist) — основные якоря поиска, поэтому они
// и в описании, и в начале contentTags (чтобы обрезка по лимиту их не выбросила).
export function buildDescriptionAndTags(post: DanbooruApiPost): {
  description: string;
  contentTags: string[];
  generalTags: string[];
  characterTags: string[];
  copyrightTags: string[];
  artistTags: string[];
} {
  const generalTags = splitTags(post.tag_string_general);
  const characterTags = splitTags(post.tag_string_character);
  const copyrightTags = splitTags(post.tag_string_copyright);
  const artistTags = splitTags(post.tag_string_artist);

  const parts: string[] = [];
  if (characterTags.length) parts.push(`Characters: ${characterTags.slice(0, 5).map(normalizeTag).join(", ")}`);
  if (copyrightTags.length) parts.push(`From: ${copyrightTags.slice(0, 5).map(normalizeTag).join(", ")}`);
  if (artistTags.length) parts.push(`Art by: ${artistTags.slice(0, 3).map(normalizeTag).join(", ")}`);
  if (generalTags.length) parts.push(generalTags.slice(0, 30).map(normalizeTag).join(" "));
  const description = parts.join(". ") || `Danbooru post ${post.id}`;

  // contentTags для saved_images: сущности (персонаж/франшиза/автор) идут первыми,
  // затем general; всё нормализовано и дедуплицировано, обрезка с запасом.
  const contentTags = [...new Set([
    ...characterTags.map(normalizeTag),
    ...copyrightTags.map(normalizeTag),
    ...artistTags.map(normalizeTag),
    ...generalTags.map(normalizeTag),
  ])].slice(0, 60);

  return { description, contentTags, generalTags, characterTags, copyrightTags, artistTags };
}
