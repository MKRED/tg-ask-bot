// Клиент Danbooru API.
// Документация: https://danbooru.donmai.us/wiki_pages/api
// Аутентификация: HTTP Basic Auth (login:api_key).
// Пагинация курсором: page=a{id} возвращает посты с id > N в порядке возрастания —
// именно то, что нужно для хронологического обхода.
//
// Все запросы ходят через прокси (если задан PROXY_URL) — прямой доступ к danbooru
// заблокирован. Используем Node's https + HttpsProxyAgent как везде в проекте.
import https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";

const BASE_URL = "https://danbooru.donmai.us";
// Danbooru требует указывать User-Agent для API-клиентов; пустой UA может дать 403.
const USER_AGENT = "tg-ask-bot/1.0 (private Telegram bot)";

export interface DanbooruApiPost {
  id: number;
  created_at: string;
  rating: string; // 'g' | 's' | 'q' | 'e'
  file_ext: string;
  file_size: number;
  md5: string | null;
  // Оригинал — может быть огромным (до 20MB+); используем large_file_url (sample, ~720px)
  file_url: string | null;
  large_file_url: string | null;
  preview_file_url: string | null;
  tag_string: string;
  tag_string_general: string;
  tag_string_character: string;
  tag_string_copyright: string;
  tag_string_artist: string;
  score: number;
  is_deleted: boolean;
  is_pending: boolean;
  is_banned: boolean;
}

// URL страницы поста на Danbooru — строится из id (отдельной колонки не держим,
// danbooru_id уже есть в danbooru_posts). Используется для inline-кнопки «Источник».
export function danbooruPostUrl(id: number): string {
  return `${BASE_URL}/posts/${id}`;
}

function authHeader(login: string, apiKey: string): string {
  return `Basic ${Buffer.from(`${login}:${apiKey}`).toString("base64")}`;
}

function agent(): HttpsProxyAgent<string> | undefined {
  return config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;
}

// GET-запрос через https-модуль (с поддержкой прокси) → парсим JSON.
function httpsGetJson(url: string, login: string, apiKey: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: {
        "Authorization": authHeader(login, apiKey),
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
      agent: agent(),
    };
    const req = https.get(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Danbooru API ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

// Скачиваем картинку в буфер (через прокси).
// CDN Danbooru публичен — авторизация не нужна, но User-Agent лучше указывать.
export function downloadDanbooruImage(imageUrl: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(imageUrl);
    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      agent: agent(),
    };
    const req = https.get(options, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`Danbooru image download ${res.statusCode}: ${imageUrl}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

// Тянем посты с ID > afterId (page=a{id}). ВНИМАНИЕ: возвращаются окном id > afterId,
// но в порядке УБЫВАНИЯ id — вызывающий код (worker.tick) сортирует по возрастанию сам.
// limit — не более 100 (ограничение API).
export async function fetchPosts(
  afterId: number,
  limit: number,
  login: string,
  apiKey: string,
): Promise<DanbooruApiPost[]> {
  const url = new URL(`${BASE_URL}/posts.json`);
  url.searchParams.set("page", `a${afterId}`);
  url.searchParams.set("limit", String(Math.min(limit, 100)));
  return httpsGetJson(url.toString(), login, apiKey) as Promise<DanbooruApiPost[]>;
}

// Получить один пост по ID (нужен скрипту восстановления упавших постов —
// они остаются позади курсора, перезапросить их по курсору нельзя).
// Возвращает null, если пост не найден (404) или удалён.
export async function fetchPostById(id: number, login: string, apiKey: string): Promise<DanbooruApiPost | null> {
  const url = `${BASE_URL}/posts/${id}.json`;
  try {
    return await httpsGetJson(url, login, apiKey) as DanbooruApiPost;
  } catch (err) {
    // 404 → поста больше нет; пробрасываем прочие ошибки (сетевые) вызывающему
    if (err instanceof Error && err.message.includes("404")) return null;
    throw err;
  }
}

// Получить самый свежий пост (нужен для инициализации курсора когда start_id не задан).
export async function fetchLatestPostId(login: string, apiKey: string): Promise<number> {
  const url = new URL(`${BASE_URL}/posts.json`);
  url.searchParams.set("limit", "1");
  const posts = await httpsGetJson(url.toString(), login, apiKey) as DanbooruApiPost[];
  return posts[0]?.id ?? 0;
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
