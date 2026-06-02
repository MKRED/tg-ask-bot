import { run } from "@grammyjs/runner";
import { bot } from "./bot.js";
import { registerCommands } from "./handlers/commands.js";
import { registerMessageHandlers } from "./handlers/messages/index.js";
import { registerForgetCallbacks, startMenuCleanupScheduler } from "./handlers/forgetMenu/index.js";
import { registerMyChatMemberHandler } from "./handlers/myChatMember.js";
import { checkStaleDigests } from "./handlers/messages/ingestDigest.js";
import { startIngestWorker } from "./handlers/messages/ingestWorker.js";
import logger from "./logger.js";

registerMyChatMemberHandler(bot);
registerCommands(bot);
registerForgetCallbacks(bot);
registerMessageHandlers(bot);

bot.catch((err) => {
  logger.error({ err }, "Bot error");
});

startMenuCleanupScheduler(bot);

// Фоновый воркер непрерывно разгребает ingest-очередь, в т.ч. строки "pending",
// чей анализ был прерван рестартом (at-least-once). checkStaleDigests безопасен —
// он смотрит только на терминальные неотправленные строки, а pending добьёт воркер.
startIngestWorker(bot.api);
checkStaleDigests(bot.api).catch((err) => logger.error({ err }, "Startup stale digest check failed"));

run(bot);
logger.info("Bot is running...");
