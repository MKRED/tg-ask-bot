import OpenAI from "openai";
import { config } from "../config.js";
import { formatBufferForLLM } from "../utils/groupFormat.js";
import { GROUP_DECISION_PROMPT } from "../prompts/groupDecision.js";
import type { GroupMessageBuffer } from "../db/schema.js";
import logger from "../logger.js";

const client = new OpenAI({
  apiKey: config.openrouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
  timeout: 30_000,
});

export async function checkShouldRespond(
  chatId: number,
  threadId: number,
  recentMsgs: GroupMessageBuffer[]
): Promise<{ shouldRespond: boolean }> {
  if (recentMsgs.length === 0) return { shouldRespond: false };

  const conversationText = formatBufferForLLM(recentMsgs);
  const t0 = Date.now();

  try {
    // Без retry: decision вызывается под локом, а сбой/таймаут просто означает "бот промолчит".
    // Ретраить решение «стоит ли вообще отвечать» — лишняя задержка под локом при нулевой пользе.
    const response = await client.chat.completions.create({
      model: config.openrouterModel,
      messages: [
        { role: "system", content: GROUP_DECISION_PROMPT },
        { role: "user", content: conversationText },
      ],
      // effort: "low" — decision это тривиальная бинарная классификация, полноценный CoT ей не нужен;
      // низкий effort срезает reasoning-токены и латентность (вызов идёт под локом).
      reasoning: { effort: "low" },
      // max_tokens оставлен с запасом: deepseek тратит токены на thinking перед ответом,
      // при малом лимите весь бюджет уходил на reasoning и content оставался пустым
      max_tokens: 1000,
    } as any);

    const message = response.choices[0]?.message;
    const content = message?.content ?? "";
    const durationMs = Date.now() - t0;

    let parsed: { should_respond?: boolean } = {};
    try {
      parsed = JSON.parse(content.trim());
    } catch {
      logger.warn({ chatId, threadId, content, durationMs }, "Group decision: JSON parse failed, defaulting to false");
      return { shouldRespond: false };
    }

    const shouldRespond = parsed.should_respond === true;
    logger.info({ chatId, threadId, shouldRespond, durationMs }, "Group decision: should respond?");
    return { shouldRespond };
  } catch (err) {
    logger.warn({ chatId, threadId, err, durationMs: Date.now() - t0 }, "Group decision call failed, defaulting to false");
    return { shouldRespond: false };
  }
}
