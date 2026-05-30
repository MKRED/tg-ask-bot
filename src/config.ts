import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env variable: ${name}`);
  return value;
}

export const config = {
  botToken: requireEnv("BOT_TOKEN"),
  proxyUrl: process.env.PROXY_URL,
  openrouterApiKey: requireEnv("OPENROUTER_API_KEY"),
  openrouterModel: process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4-flash",
  geminiApiKey: requireEnv("GEMINI_API_KEY"),
  databaseUrl: requireEnv("DATABASE_URL"),
  inlineMenuInactivityTimeoutMs: parseInt(
    process.env.INLINE_MENU_INACTIVITY_TIMEOUT_MS ?? String(30 * 60 * 1000)
  ),
  inlineMenuMaxAgeMs: parseInt(
    process.env.INLINE_MENU_MAX_AGE_MS ?? String(24 * 60 * 60 * 1000)
  ),
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  ollamaVisionModel: process.env.OLLAMA_VISION_MODEL ?? "gemma4-vision",
  // Уровень логирования. По умолчанию info, чтобы в проде не раздувать логи debug-записями
  // (appendToBuffer/pruneBuffer пишут debug на каждое сообщение). На время тестирования — LOG_LEVEL=debug.
  logLevel: process.env.LOG_LEVEL ?? "info",
};
