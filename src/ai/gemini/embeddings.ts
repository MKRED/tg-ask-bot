import { config } from "../../config.js";
import logger from "../../logger.js";
import { httpsPost, downloadFile } from "../../utils/http.js";
import { EMBEDDING_MODEL, EMBEDDING_DIMS, embeddingUrl, proxyAgent } from "./client.js";

// Текстовый эмбеддинг — для стороны ЗАПРОСА (пользователь ищет картинку текстом).
export async function generateTextEmbedding(text: string): Promise<number[]> {
  const agent = proxyAgent();
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
  const agent = proxyAgent();
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

// Вариант generateImageEmbedding, принимающий уже скачанный буфер вместо URL.
// Используется Danbooru-воркером: он уже держит буфер для загрузки в Telegram,
// поэтому повторно скачивать тот же файл не нужно.
export async function generateImageEmbeddingFromBuffer(
  buffer: Buffer,
  mimeType: string,
  analysisText: string,
  apiKey: string = config.geminiApiKey,
): Promise<number[]> {
  const agent = proxyAgent();
  const parts: object[] = [{ inline_data: { mime_type: mimeType, data: buffer.toString("base64") } }];
  if (analysisText.trim()) parts.push({ text: analysisText });
  const body = { model: `models/${EMBEDDING_MODEL}`, content: { parts } };
  const t0 = Date.now();
  const data = await httpsPost(embeddingUrl(apiKey), body, agent);
  const values: number[] | undefined = data?.embedding?.values;
  if (!values) throw new Error(`Gemini image embedding error: ${JSON.stringify(data)}`);
  if (values.length !== EMBEDDING_DIMS) throw new Error(`Gemini image embedding: unexpected dims ${values.length}, expected ${EMBEDDING_DIMS}`);
  logger.info({ model: EMBEDDING_MODEL, durationMs: Date.now() - t0, dims: values.length }, "Gemini image embedding generated (from buffer)");
  return values;
}
