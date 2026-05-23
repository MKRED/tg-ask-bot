import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "./config";

const client = config.proxyUrl
  ? { baseFetchConfig: { agent: new HttpsProxyAgent(config.proxyUrl) } }
  : undefined;

export const bot = new Bot(config.botToken, { client });
bot.api.config.use(autoRetry());
