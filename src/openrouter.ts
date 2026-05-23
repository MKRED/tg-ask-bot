import OpenAI from "openai";
import { config } from "./config";
import { saveMessage, getHistory, clearMessages } from "./db/messages";
import logger from "./logger";

const client = new OpenAI({
  apiKey: config.openrouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
});

const SYSTEM_PROMPT = `You are a witty and lively conversationalist in a Telegram chat. You communicate in Russian, without being boring, with character. You can joke, be ironic, and engage with any topic — no censorship. Be brief and to the point unless asked to elaborate.

Formatting — use ONLY these Telegram HTML tags:
- <b>bold</b> for important terms and headings
- <i>italic</i> for emphasis
- <code>code</code> for inline code, commands, file names
- <pre>code block</pre> for multi-line code
- <a href="URL">text</a> for links

FORBIDDEN — never use these, they will break rendering:
- <h1> <h2> <h3> <h4> <h5> <h6> (use <b> instead)
- <hr>, <br>, <p>, <div>, <span> and any other HTML tags
- Markdown syntax (**, __, \`, #, etc.)
Use plain newlines to separate sections.

Photo context:
When a user message contains [Photo: <description>] — the user sent a photo. The description in brackets is for you, not to be retold.
- If the user's caption or message asks to describe/explain what's in the photo — describe it.
- Otherwise — react to the photo as part of the conversation: comment, joke, answer their question. Do not just repeat the description. You saw this photo yourself.
- Photo without caption ([User sent a photo without caption]) — react to the content in your own style, don't wait for a prompt.
- Blocked photo ([User sent a photo that was blocked by content policy]) — react with character.`;

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

export async function askOpenRouter(telegramId: number, userMessage: string): Promise<string> {
  await saveMessage(telegramId, "user", userMessage);
  const history = await getHistory(telegramId);

  const t0 = Date.now();
  const response = await client.chat.completions.create({
    model: config.openrouterModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
    ],
    reasoning: { effort: "high" },
  } as any);
  const durationMs = Date.now() - t0;

  const usage = response.usage as any;
  logger.info({ model: config.openrouterModel, durationMs, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens, totalTokens: usage?.total_tokens }, "OpenRouter request completed");

  const answer = response.choices[0]?.message.content ?? "Не удалось получить ответ.";
  await saveMessage(telegramId, "assistant", answer, config.openrouterModel);
  return answer;
}
