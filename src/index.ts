import { run } from "@grammyjs/runner";
import { bot } from "./bot";
import { registerCommands } from "./handlers/commands";
import { registerMessageHandlers } from "./handlers/messages";
import logger from "./logger";

registerCommands(bot);
registerMessageHandlers(bot);

bot.catch((err) => {
  logger.error({ err }, "Bot error");
});

run(bot);
logger.info("Bot is running...");
