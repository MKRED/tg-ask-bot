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
};
