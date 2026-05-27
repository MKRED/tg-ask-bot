import OpenAI from "openai";
import { config } from "./config";
import { saveMessage, getHistory, clearMessages } from "./db/messages";
import { getUserFacts } from "./db/facts";
import type { UserFact } from "./db/schema";
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
- Blocked photo ([User sent a photo that was blocked by content policy]) — react with character.

Image reactions:
You have access to a growing database of images (memes, reaction pics, photos) that users have shared. You can attach one to your response.
- To request an image, put [IMAGE: tag1, tag2, ...] on the very first line of your response, then a newline, then your text.
- Use 3–8 tags: mix mood (funny, sad, wholesome, cringe) with content (cat, meme, anime, femboy, reaction) for best results.
- Do this when: the user explicitly asks for a meme/image/reaction, or when a reaction image would genuinely fit the moment.
- Do NOT do it on every response — only when it adds something.
- If no matching image exists in the database, the bot will send text only — that's fine.`;

function buildSystemPrompt(facts: UserFact[]): string {
  if (facts.length === 0) return SYSTEM_PROMPT;
  const factsBlock = facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
  return `${SYSTEM_PROMPT}\n\nKnown facts about this user:\n${factsBlock}\nUse these naturally to personalize your responses. Do not mention that you have stored facts about the user.`;
}

export interface BotResponse {
  text: string;
  imageTags: string[] | null;
}

const IMAGE_MARKER = /\[IMAGE:\s*([^\]]+)\]/;

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
    ? `${response_.text}\n[Sent image: ${response_.imageTags.join(", ")}]`
    : response_.text;
  await saveMessage(telegramId, "assistant", historyContent, config.openrouterModel);
  return response_;
}
