import { run } from "@grammyjs/runner";
import { bot } from "./bot.js";
import { registerCommands } from "./handlers/commands.js";
import { registerMessageHandlers } from "./handlers/messages/index.js";
import { registerForgetCallbacks, startMenuCleanupScheduler } from "./handlers/forgetMenu/index.js";
import { registerMyChatMemberHandler } from "./handlers/myChatMember.js";
import logger from "./logger.js";

registerMyChatMemberHandler(bot);
registerCommands(bot);
registerForgetCallbacks(bot);
registerMessageHandlers(bot);

bot.catch((err) => {
  logger.error({ err }, "Bot error");
});

startMenuCleanupScheduler(bot);

run(bot);
logger.info("Bot is running...");
