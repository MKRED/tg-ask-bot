import logger from "../../logger.js";
import { httpsPost, downloadFile } from "../../utils/http.js";
import { DESCRIPTION_PROMPT, RESPONSE_SCHEMA } from "../../prompts/imageAnalysis.js";
import { GeminiBlockedError } from "./errors.js";
import { API_URL, GEMINI_MODEL, proxyAgent } from "./client.js";
import type { ImageAnalysis } from "./types.js";

// finishReason'ы, означающие, что контент заблокирован моделью на этапе
// генерации (не сетевая ошибка) — ретраить их бессмысленно.
const BLOCKING_FINISH_REASONS = new Set([
  "PROHIBITED_CONTENT",
  "SAFETY",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
]);

export async function analyzeImage(fileUrl: string): Promise<ImageAnalysis> {
  const agent = proxyAgent();
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
