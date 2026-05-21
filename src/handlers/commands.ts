import { Bot } from "grammy";
import { clearHistory } from "../openrouter";

export function registerCommands(bot: Bot): void {
  bot.command("start", (ctx) =>
    ctx.reply("Привет! Я бот-помощник. Напишите мне что-нибудь.")
  );

  bot.command("help", (ctx) =>
    ctx.reply("Доступные команды:\n/start — начать\n/clear — очистить историю чата\n/help — помощь")
  );

  bot.command("clear", (ctx) => {
    clearHistory(ctx.chat.id);
    return ctx.reply("История чата очищена.");
  });
}
