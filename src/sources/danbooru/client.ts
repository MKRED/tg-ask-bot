// HTTP-клиент Danbooru API.
// Документация: https://danbooru.donmai.us/wiki_pages/api
// Аутентификация: HTTP Basic Auth (login:api_key).
// Пагинация курсором: page=a{id} возвращает посты с id > N в порядке возрастания —
// именно то, что нужно для хронологического обхода.
//
// Все запросы ходят через прокси (если задан PROXY_URL) — прямой доступ к danbooru
// заблокирован. Используем Node's https + HttpsProxyAgent как везде в проекте.
import https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../../config.js";
import { DANBOORU_BASE_URL } from "./constants.js";
import type { DanbooruApiPost } from "./types.js";

// Danbooru требует указывать User-Agent для API-клиентов; пустой UA может дать 403.
const USER_AGENT = "tg-ask-bot/1.0 (private Telegram bot)";

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
  const url = new URL(`${DANBOORU_BASE_URL}/posts.json`);
  url.searchParams.set("page", `a${afterId}`);
  url.searchParams.set("limit", String(Math.min(limit, 100)));
  return httpsGetJson(url.toString(), login, apiKey) as Promise<DanbooruApiPost[]>;
}

// Получить один пост по ID (нужен скрипту восстановления упавших постов —
// они остаются позади курсора, перезапросить их по курсору нельзя).
// Возвращает null, если пост не найден (404) или удалён.
export async function fetchPostById(id: number, login: string, apiKey: string): Promise<DanbooruApiPost | null> {
  const url = `${DANBOORU_BASE_URL}/posts/${id}.json`;
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
  const url = new URL(`${DANBOORU_BASE_URL}/posts.json`);
  url.searchParams.set("limit", "1");
  const posts = await httpsGetJson(url.toString(), login, apiKey) as DanbooruApiPost[];
  return posts[0]?.id ?? 0;
}
