import OpenAI from "openai";
import { config } from "../config";
import { formatBufferForLLM } from "../utils/groupFormat";
import { buildGroupSystemPrompt } from "../prompts/groupConversation";
import { parseResponse } from "./openrouter";
import { appendToBuffer } from "../db/groupMessages";
import type { GroupMessageBuffer } from "../db/schema";
import type { BotResponse } from "../types";
import logger from "../logger";

const client = new OpenAI({
  apiKey: config.openrouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
  timeout: 90_000,
});

interface GroupChatOpts {
  chatId: number;
  threadId: number;
  fullBuffer: GroupMessageBuffer[];
  nsfwEnabled: boolean;
}

export async function askGroupChat(opts: GroupChatOpts): Promise<BotResponse> {
  const { chatId, threadId, fullBuffer, nsfwEnabled } = opts;

  const historyText = formatBufferForLLM(fullBuffer);
  const systemPrompt = buildGroupSystemPrompt(nsfwEnabled);

  const t0 = Date.now();
  const response = await client.chat.completions.create({
    model: config.openrouterModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: historyText },
    ],
    reasoning: { effort: "high" },
  } as any);
  const durationMs = Date.now() - t0;

  const usage = response.usage as any;
  logger.info({
    chatId, threadId,
    model: config.openrouterModel,
    durationMs,
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    totalTokens: usage?.total_tokens,
  }, "Group chat OpenRouter request completed");

  const content = response.choices[0]?.message.content;
  if (!content) {
    logger.warn({ chatId, threadId }, "Group chat: OpenRouter returned empty content");
    throw new Error("OpenRouter returned empty content");
  }

  const result = parseResponse(content);

  // Fire-and-forget: ошибка сохранения не должна блокировать отправку ответа пользователю
  appendToBuffer({
    chatId,
    threadId,
    senderName: "Бот",
    content: result.text,
    isBot: true,
  }).catch((err) => logger.warn({ chatId, threadId, err }, "Failed to save bot response to group buffer"));

  return result;
}
