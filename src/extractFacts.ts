import OpenAI from "openai";
import { config } from "./config";
import { getUserFacts, upsertUserFact, deleteUserFact } from "./db/facts";
import { getHistory } from "./db/messages";
import logger from "./logger";

const client = new OpenAI({
  apiKey: config.openrouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
});

const LAST_EXCHANGES = 3;

const EXTRACTION_SYSTEM_PROMPT = `You are a personal facts extractor for a Telegram bot. Analyze the conversation and extract key facts the user shared about themselves.

Return ONLY a valid JSON array. Each item is either:
- An upsert: {"key": "...", "value": "...", "value_original": "..."}
- A deletion: {"key": "...", "action": "delete"}
Return [] if nothing to update.

What counts as a personal fact:
- Personal characteristics: name, age, city, profession, nationality
- Stable preferences: favorite color, food, music, games, anime, hobbies
- Life situation: relationships, pets, education, health conditions
- Personality traits explicitly stated by the user

What does NOT count:
- Opinions about public figures or celebrities that don't reveal something about the user personally
- Reactions to conversation topics ("interesting", "I didn't know that")
- Temporary states or moods
- Things merely mentioned in conversation

Rules:
- Extract facts explicitly stated by the user about themselves
- Also extract facts from implied agreement: if the user agrees with something the Bot said ("me too", "same", "у меня тоже", "тоже", "+1", etc.) — extract the referenced fact and attribute it to the user
- Do NOT infer facts without explicit statement or clear agreement
- Keys: snake_case English (e.g. favorite_color, city, age, profession, pet_name)
- Values: concise, translate to English
- value_original: the value as the user said it (may be same as value if already English)
- Multi-value facts: when a fact can have several values (favorite_anime, hobbies, etc.) store as comma-separated. If the user ADDS to an existing list ("also", "тоже", "ещё", "и ещё") — include ALL previous values + the new one. If the user REPLACES a fact ("now", "теперь", "actually", "нет, на самом деле") — return only the new value
- If the user retracts or negates a previously stated fact ("шучу", "пошутил", "kidding", "just joking", "на самом деле нет", "врал", "забудь") — return {"key": "...", "action": "delete"} to remove it
- If updating an existing fact, reuse the SAME key from the existing facts list below
- Maximum 5 operations per exchange (upserts + deletes combined)

Examples:
Direct: User: "мой любимый цвет синий" → [{"key": "favorite_color", "value": "blue", "value_original": "синий"}]
Agreement: Bot: "Мой любимый персонаж — Аска из NGE!", User: "у меня тоже" → [{"key": "favorite_character", "value": "Asuka (NGE)", "value_original": "Аска"}]
List append: existing favorite_anime: "Evangelion", User: "ещё обожаю Берсерк" → [{"key": "favorite_anime", "value": "Evangelion, Berserk", "value_original": "Берсерк"}]
Single replace: existing favorite_color: "blue", User: "теперь мне нравится жёлтый" → [{"key": "favorite_color", "value": "yellow", "value_original": "жёлтый"}]
Retraction: existing favorite_streamer: "Papich", User: "шучу, он долбоёб" → [{"key": "favorite_streamer", "action": "delete"}]
Mixed: existing city: "Moscow", User: "переехал в Питер, и кстати шучу насчёт кошки" → [{"key": "city", "value": "Saint Petersburg", "value_original": "Питер"}, {"key": "pet", "action": "delete"}]
Not a fact: User: "Папич крутой стример" → []
No update: User: "окей понял" → []`;

export async function extractFacts(telegramId: number): Promise<number> {
  const [history, existingFacts] = await Promise.all([
    getHistory(telegramId),
    getUserFacts(telegramId),
  ]);

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
