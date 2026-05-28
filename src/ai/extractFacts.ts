import OpenAI from "openai";
import { config } from "../config";
import { getUserFacts, upsertUserFact, deleteUserFact } from "../db/facts";
import { getHistory } from "../db/messages";
import logger from "../logger";
import { LAST_EXCHANGES } from "../constants";
import { EXTRACTION_SYSTEM_PROMPT } from "../prompts/factExtraction";

const client = new OpenAI({
  apiKey: config.openrouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
});

export async function extractFacts(telegramId: number): Promise<number> {
  const [history, existingFacts] = await Promise.all([
    getHistory(telegramId),
    getUserFacts(telegramId),
  ]);

  // LAST_EXCHANGES * 2: каждый обмен — это сообщение пользователя + ответ бота
  const recentMessages = history.slice(-(LAST_EXCHANGES * 2));
  if (recentMessages.length === 0) return 0;

  const conversation = recentMessages
    .map((m) => `${m.role === "user" ? "User" : "Bot"}: ${m.content}`)
    .join("\n");

  const systemPrompt = existingFacts.length > 0
    ? `${EXTRACTION_SYSTEM_PROMPT}\n\nExisting facts for this user:\n${existingFacts.map((f) => `- ${f.key}: ${f.value}`).join("\n")}`
    : EXTRACTION_SYSTEM_PROMPT;

  const t0 = Date.now();
  const response = await client.chat.completions.create({
    model: config.openrouterModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: conversation },
    ],
    reasoning: { effort: "low" },
  } as any);
  const durationMs = Date.now() - t0;

  const usage = response.usage as any;
  const raw = response.choices[0]?.message.content ?? "[]";

  type FactOp = { key: string; value?: string; value_original?: string; action?: string };
  let ops: FactOp[];
  try {
    // Модель иногда оборачивает JSON в markdown-блок кода — вытаскиваем только массив
    const match = raw.match(/\[[\s\S]*\]/);
    ops = JSON.parse(match ? match[0] : raw);
    if (!Array.isArray(ops)) return 0;
  } catch {
    logger.warn({ telegramId, raw }, "Failed to parse facts extraction response");
    return 0;
  }

  let saved = 0;
  let deleted = 0;
  for (const op of ops) {
    if (typeof op.key !== "string") continue;
    if (op.action === "delete") {
      await deleteUserFact(telegramId, op.key);
      deleted++;
    } else if (typeof op.value === "string") {
      await upsertUserFact(telegramId, op.key, op.value, op.value_original);
      saved++;
    }
  }

  logger.info({ telegramId, durationMs, saved, deleted, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, totalTokens: usage?.total_tokens }, "Facts extraction completed");
  return saved + deleted;
}
