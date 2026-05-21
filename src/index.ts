import { run } from "@grammyjs/runner";
import { bot } from "./bot";
import { registerCommands } from "./handlers/commands";
import { registerMessageHandlers } from "./handlers/messages";

registerCommands(bot);
registerMessageHandlers(bot);

bot.catch((err) => {
  console.error("Bot error:", err);
});

run(bot);
console.log("Bot is running...");
