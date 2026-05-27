import { Bot } from "grammy";
import { clearHistory } from "../ai/openrouter";
import { sendForgetMenu } from "./forgetMenu/index";
import logger from "../logger";

export function registerCommands(bot: Bot): void {
  bot.command("start", (ctx) =>
    ctx.reply("Привет! Я бот-помощник. Напишите мне что-нибудь.")
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      "Доступные команды:\n" +
      "/start — начать\n" +
      "/clear — очистить историю чата\n" +
      "/facts — управлять сохранёнными фактами\n" +
      "/help — помощь"
    )
  );

  bot.command("clear", async (ctx) => {
    await clearHistory(ctx.from!.id);
    logger.info({ chatId: ctx.chat.id }, "History cleared");
    return ctx.reply("История чата очищена.");
  });

  bot.command("facts", async (ctx) => {
    logger.info({ userId: ctx.from!.id }, "forget_menu_opened");
    await sendForgetMenu(ctx);
  });

  bot.on("message:entities:bot_command", (ctx) =>
    ctx.reply("Такой команды не существует. Используйте /help для списка доступных команд.")
  );
}
