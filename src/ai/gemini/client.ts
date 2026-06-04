// Общие параметры Gemini API: модели, URL, размерность эмбеддинга, helper прокси-агента.
// Используются и анализом картинок (analyze.ts), и эмбеддингами (embeddings.ts).
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../../config.js";

export const GEMINI_MODEL = "gemini-3.1-flash-lite";
export const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${config.geminiApiKey}`;

// gemini-embedding-2 — нативно мультимодальная: эмбеддит и текст, и картинку в одно
// общее векторное пространство, поэтому текстовый запрос можно сравнивать с эмбеддингом
// картинки напрямую (см. embeddings.ts). По умолчанию отдаёт 3072 dims.
export const EMBEDDING_MODEL = "gemini-embedding-2";

// Размерность столбца saved_images.embedding. Совпадает с дефолтом модели; guard в
// embeddings.ts ловит молчаливое расхождение — иначе вектор чужой размерности уехал бы в БД незаметно.
export const EMBEDDING_DIMS = 3072;

// URL строим из ключа: обычно это config.geminiApiKey, но скрипт миграции может
// передать бесплатный ключ (см. generateImageEmbedding).
export function embeddingUrl(apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
}

// Прокси-агент для запросов к Gemini, если задан PROXY_URL (иначе прямое соединение).
export function proxyAgent(): HttpsProxyAgent<string> | undefined {
  return config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;
}
