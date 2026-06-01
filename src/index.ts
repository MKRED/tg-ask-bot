import { run } from "@grammyjs/runner";
import { bot } from "./bot.js";
import { registerCommands } from "./handlers/commands.js";
import { registerMessageHandlers } from "./handlers/messages/index.js";
import { registerForgetCallbacks, startMenuCleanupScheduler } from "./handlers/forgetMenu/index.js";
import { registerMyChatMemberHandler } from "./handlers/myChatMember.js";
import { checkStaleDigests } from "./handlers/messages/ingestDigest.js";
import { retryPendingImages } from "./handlers/messages/retryPendingIngest.js";
import logger from "./logger.js";

registerMyChatMemberHandler(bot);
registerCommands(bot);
registerForgetCallbacks(bot);
registerMessageHandlers(bot);

bot.catch((err) => {
  logger.error({ err }, "Bot error");
});

startMenuCleanupScheduler(bot);

// Порядок критичен: сначала retry pending (анализируем прерванные картинки),
// потом checkStaleDigests (отправляем/перевооружаем дайджесты).
// Если поменять местами — checkStaleDigests отправит дайджест с pending-строками и сразу удалит их.
retryPendingImages(bot.api)
  .then(() => checkStaleDigests(bot.api))
  .catch((err) => logger.error({ err }, "Startup ingest recovery failed"));

run(bot);
logger.info("Bot is running...");
