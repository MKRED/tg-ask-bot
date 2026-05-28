import OpenAI from "openai";
import { config } from "../config";
import { saveMessage, getHistory, clearMessages } from "../db/messages";
import { getUserFacts } from "../db/facts";
import logger from "../logger";
import { IMAGE_MARKER } from "../constants";
import { buildSystemPrompt } from "../prompts/conversation";
import type { BotResponse } from "../types";

export type { BotResponse };

const client = new OpenAI({
  apiKey: config.openrouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
});

// IMAGE_MARKER — специальный токен, который модель вставляет когда хочет прикрепить изображение.
// Формат: [IMAGE: tag1, tag2, ...] в самой первой строке ответа.
function parseResponse(content: string): BotResponse {
  const match = content.match(IMAGE_MARKER);
  if (match) {
    const tags = match[1].split(",").map((t) => t.trim()).filter(Boolean);
    logger.info({ tags }, "Model requested image attachment");
    const text = content.replace(IMAGE_MARKER, "").trim();
    return { text, imageTags: tags };
  }
  return { text: content, imageTags: null };
}

export async function clearHistory(telegramId: number): Promise<void> {
  await clearMessages(telegramId);
}

export async function addToHistory(
  telegramId: number,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  await saveMessage(telegramId, "user", userMessage);
  await saveMessage(telegramId, "assistant", assistantMessage);
}

export async function askOpenRouter(telegramId: number, userMessage: string): Promise<BotResponse> {
  await saveMessage(telegramId, "user", userMessage);
  const [history, facts] = await Promise.all([getHistory(telegramId), getUserFacts(telegramId)]);
  const systemPrompt = buildSystemPrompt(facts);

  const t0 = Date.now();
  const response = await client.chat.completions.create({
    model: config.openrouterModel,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
    ],
    reasoning: { effort: "high" },
  } as any);
  const durationMs = Date.now() - t0;

  const usage = response.usage as any;
  logger.info({ model: config.openrouterModel, durationMs, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens, totalTokens: usage?.total_tokens }, "OpenRouter request completed");

  const content = response.choices[0]?.message.content;
  if (!content) {
    logger.warn({ telegramId, model: config.openrouterModel, choices: JSON.stringify(response.choices) }, "OpenRouter returned empty content, will retry");
    throw new Error("OpenRouter returned empty content");
  }
  const response_ = parseResponse(content);
  const historyContent = response_.imageTags
    ? `[IMAGE: ${response_.imageTags.join(", ")}]\n${response_.text}`
    : response_.text;
  await saveMessage(telegramId, "assistant", historyContent, config.openrouterModel);
  return response_;
}
