import { analyzeImage, GeminiBlockedError } from "../../ai/gemini.js";
import { analyzeImageOllama } from "../../ai/ollama.js";
import { retry } from "../../utils/retry.js";
import logger from "../../logger.js";
import type { ImageAnalysis } from "../../types/index.js";

export interface PhotoAnalysisResult {
  imageAnalysis: ImageAnalysis | null;
  analyzedBy: "gemini" | "ollama" | "failed";
}

// Gemini с автоматическим fallback на Ollama.
// Никогда не бросает ошибку — при провале обоих возвращает analyzedBy="failed".
export async function analyzePhotoWithFallback(
  fileUrl: string,
  logCtx: Record<string, unknown>,
): Promise<PhotoAnalysisResult> {
  try {
    const imageAnalysis = await retry(
      () => analyzeImage(fileUrl),
      3, 1500, "Gemini",
      (err) => !(err instanceof GeminiBlockedError),
    );
    return { imageAnalysis, analyzedBy: "gemini" };
  } catch (geminiErr) {
    if (geminiErr instanceof GeminiBlockedError) {
      logger.info({ ...logCtx, blockReason: geminiErr.blockReason }, "Gemini blocked image, falling back to Ollama");
    } else {
      logger.warn({ ...logCtx, err: geminiErr }, "Gemini failed for group photo, falling back to Ollama");
    }

    try {
      // Задержка 10 сек между попытками — Ollama автоматически перезапускает runner
      // после краша, за это время обычно успевает восстановиться
      const imageAnalysis = await retry(() => analyzeImageOllama(fileUrl), 2, 10000, "Ollama");
      return { imageAnalysis, analyzedBy: "ollama" };
    } catch (ollamaErr) {
      logger.error({ ...logCtx, err: ollamaErr }, "Ollama fallback also failed for group photo");
      return { imageAnalysis: null, analyzedBy: "failed" };
    }
  }
}
