import OpenAI from "openai";
import { config } from "./config";
import { getUserFacts, upsertUserFact } from "./db/facts";
import logger from "./logger";

const client = new OpenAI({
  apiKey: config.openrouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
});

const EXTRACTION_SYSTEM_PROMPT = `You are a personal facts extractor for a Telegram bot. Read the user's message and extract key facts they shared about themselves.

Return ONLY a valid JSON array. Each item must have: "key" (snake_case English), "value" (English), "value_original" (original language).
Example: [{"key": "favorite_color", "value": "blue", "value_original": "синий"}]
Return [] if no facts were shared.

Rules:
- Only extract facts explicitly stated by the user (not inferred)
- Keys: snake_case English (e.g. favorite_color, city, age, profession, pet_name)
- Values: concise, translate to English
- value_original: the value as the user said it (may be same as value if already English)
- If updating an existing fact, reuse the SAME key from the existing keys list
- Maximum 5 facts per message`;

export async function extractFacts(telegramId: number, userMessage: string): Promise<number> {
  const existingFacts = await getUserFacts(telegramId);
  const existingKeys = existingFacts.map((f) => f.key);

  const systemPrompt = existingKeys.length > 0
    ? `${EXTRACTION_SYSTEM_PROMPT}\n\nExisting fact keys for this user: ${existingKeys.join(", ")}`
    : EXTRACTION_SYSTEM_PROMPT;

  const response = await client.chat.completions.create({
    model: config.openrouterModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    reasoning: { effort: "low" },
  } as any);

  const raw = response.choices[0]?.message.content ?? "[]";

  let facts: { key: string; value: string; value_original?: string }[];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    facts = JSON.parse(match ? match[0] : raw);
    if (!Array.isArray(facts)) return 0;
  } catch {
    logger.warn({ telegramId, raw }, "Failed to parse facts extraction response");
    return 0;
  }

  let saved = 0;
  for (const fact of facts) {
    if (typeof fact.key === "string" && typeof fact.value === "string") {
      await upsertUserFact(telegramId, fact.key, fact.value, fact.value_original);
      saved++;
    }
  }

  return saved;
}
