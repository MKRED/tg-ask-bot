import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import logger from "../logger.js";
import { httpsPost, downloadFile } from "../utils/http.js";
import { DESCRIPTION_PROMPT, RESPONSE_SCHEMA } from "../prompts/imageAnalysis.js";
import type { ImageAnalysis } from "../types/index.js";

export class GeminiBlockedError extends Error {
  constructor(public readonly blockReason: string) {
    super(`Gemini blocked: ${blockReason}`);
    this.name = "GeminiBlockedError";
  }
}

export type { ImageAnalysis };

// finishReason'ы, означающие, что контент заблокирован моделью на этапе
// генерации (не сетевая ошибка) — ретраить их бессмысленно.
const BLOCKING_FINISH_REASONS = new Set([
  "PROHIBITED_CONTENT",
  "SAFETY",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
]);

const GEMINI_MODEL = "gemini-3.1-flash-lite";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${config.geminiApiKey}`;

// gemini-embedding-2 — нативно мультимодальная: эмбеддит и текст, и картинку в одно
// общее векторное пространство, поэтому текстовый запрос можно сравнивать с эмбеддингом
// картинки напрямую (см. generateImageEmbedding). По умолчанию отдаёт 3072 dims.
const EMBEDDING_MODEL = "gemini-embedding-2";
// URL строим из ключа: обычно это config.geminiApiKey, но скрипт миграции может
// передать бесплатный ключ (см. generateImageEmbedding).
function embeddingUrl(apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
}

// Размерность столбца saved_images.embedding. Совпадает с дефолтом модели; guard ниже
// ловит молчаливое расхождение — иначе вектор чужой размерности уехал бы в БД незаметно.
const EMBEDDING_DIMS = 3072;

// Текстовый эмбеддинг — для стороны ЗАПРОСА (пользователь ищет картинку текстом).
export async function generateTextEmbedding(text: string): Promise<number[]> {
  const agent = config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;
  const body = {
    model: `models/${EMBEDDING_MODEL}`,
    content: { parts: [{ text }] },
  };
  const t0 = Date.now();
  const data = await httpsPost(embeddingUrl(config.geminiApiKey), body, agent);
  const values: number[] | undefined = data?.embedding?.values;
  if (!values) throw new Error(`Gemini text embedding error: ${JSON.stringify(data)}`);
  if (values.length !== EMBEDDING_DIMS) throw new Error(`Gemini text embedding: unexpected dims ${values.length}, expected ${EMBEDDING_DIMS}`);
  logger.info({ model: EMBEDDING_MODEL, durationMs: Date.now() - t0, dims: values.length }, "Gemini text embedding generated");
  return values;
}

// Эмбеддинг картинки — для стороны ХРАНЕНИЯ. В один вектор кладём и саму картинку
// (визуал, сцена, композиция), и текст анализа от нейронки (описание + теги, включая
// имена франшиз/персонажей, если их распознал грундинг). Так именованные сущности
// получают текстовый якорь прямо в векторе, а не зависят только от визуальных знаний модели.
// caption пользователя НЕ кладём: он может быть не про картинку (вопрос и т.п.) → шум.
export async function generateImageEmbedding(fileUrl: string, analysisText: string, apiKey: string = config.geminiApiKey): Promise<number[]> {
  const agent = config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;
  const buffer = await downloadFile(fileUrl, agent);
  // Текстовый part добавляем только если есть что эмбеддить — пустой text API отклоняет.
  const parts: object[] = [{ inline_data: { mime_type: "image/jpeg", data: buffer.toString("base64") } }];
  if (analysisText.trim()) parts.push({ text: analysisText });
  const body = {
    model: `models/${EMBEDDING_MODEL}`,
    content: { parts },
  };
  const t0 = Date.now();
  const data = await httpsPost(embeddingUrl(apiKey), body, agent);
  const values: number[] | undefined = data?.embedding?.values;
  if (!values) throw new Error(`Gemini image embedding error: ${JSON.stringify(data)}`);
  if (values.length !== EMBEDDING_DIMS) throw new Error(`Gemini image embedding: unexpected dims ${values.length}, expected ${EMBEDDING_DIMS}`);
  logger.info({ model: EMBEDDING_MODEL, durationMs: Date.now() - t0, dims: values.length }, "Gemini image embedding generated");
  return values;
}

export async function analyzeImage(fileUrl: string): Promise<ImageAnalysis> {
  const agent = config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;
  const buffer = await downloadFile(fileUrl, agent);

  const body = {
    tools: [{ googleSearch: {} }],
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
    generationConfig: {
      thinkingConfig: { thinkingLevel: "low" },
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
    contents: [{
      parts: [
        { inline_data: { mime_type: "image/jpeg", data: buffer.toString("base64") } },
        { text: DESCRIPTION_PROMPT },
      ],
    }],
  };

  const t0 = Date.now();
  const data = await httpsPost(API_URL, body, agent);
  const durationMs = Date.now() - t0;

  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) throw new GeminiBlockedError(blockReason);

  // Gemini может заблокировать не на этапе промпта, а на этапе генерации —
  // тогда blockReason пустой, а причина приходит в candidate.finishReason.
  // Такие ответы детерминированы: ретрай вернёт то же самое, поэтому бросаем
  // GeminiBlockedError, чтобы retry() сразу ушёл в Ollama-фолбэк без повторов.
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason && BLOCKING_FINISH_REASONS.has(finishReason)) {
    throw new GeminiBlockedError(finishReason);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini error: ${JSON.stringify(data)}`);

  const usage = data?.usageMetadata;
  logger.info({ model: GEMINI_MODEL, durationMs, promptTokens: usage?.promptTokenCount, totalTokens: usage?.totalTokenCount }, "Gemini request completed");

  const parsed = JSON.parse(text);
  return {
    description: parsed.description,
    moodTags: parsed.mood_tags ?? [],
    contentTags: parsed.content_tags ?? [],
    isNsfw: parsed.is_nsfw ?? false,
  };
}
