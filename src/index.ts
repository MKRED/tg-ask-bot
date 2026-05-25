import { run } from "@grammyjs/runner";
import { bot } from "./bot";
import { registerCommands } from "./handlers/commands";
import { registerMessageHandlers } from "./handlers/messages";
import { registerForgetCallbacks, startMenuCleanupScheduler } from "./handlers/forgetMenu";
import logger from "./logger";

registerCommands(bot);
registerForgetCallbacks(bot);
registerMessageHandlers(bot);

bot.catch((err) => {
  logger.error({ err }, "Bot error");
});

startMenuCleanupScheduler(bot);

run(bot);
logger.info("Bot is running...");
