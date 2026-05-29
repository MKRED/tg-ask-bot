import { run } from "@grammyjs/runner";
import { bot } from "./bot";
import { registerCommands } from "./handlers/commands";
import { registerMessageHandlers } from "./handlers/messages/index";
import { registerForgetCallbacks, startMenuCleanupScheduler } from "./handlers/forgetMenu/index";
import { registerMyChatMemberHandler } from "./handlers/myChatMember";
import logger from "./logger";

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
