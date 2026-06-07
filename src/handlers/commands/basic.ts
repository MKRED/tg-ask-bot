import { Bot } from "grammy";

export function registerBasicCommands(bot: Bot): void {
  bot.command("start", (ctx) =>
    ctx.reply("Привет! Я бот-помощник. Напишите мне что-нибудь.")
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      "Доступные команды:\n" +
      "/start — начать\n" +
      "/clear — очистить историю чата (только в личных сообщениях)\n" +
      "/facts — управлять сохранёнными фактами (только в личных сообщениях)\n" +
      "/account — профиль и настройки (только в личных сообщениях)\n" +
      "/help — помощь\n\n" +
      "<b>Команды для групп (только администраторы):</b>\n" +
      "/botstart — включить бота в текущем разделе\n" +
      "/botingest — режим «пожиратель»: бот молча собирает картинки в базу\n" +
      "/botstop — выключить бота в текущем разделе\n\n" +
      "<b>Danbooru-импорт:</b>\n" +
      "/setdanboorustorage [start_id] — установить текущий чат как хранилище Danbooru-картинок\n" +
      "/stopdanboorustorage — остановить выгрузку (позиция сохраняется)",
      { parse_mode: "HTML" }
    )
  );

  bot.on("message:entities:bot_command", (ctx) => {
    // В группах команды могут быть адресованы конкретному боту через суффикс @username
    // (например /addchat@aoshi_bot). Отвечаем только на команды без суффикса либо
    // адресованные именно нам — чужие команды игнорируем, чтобы не спамить в чужой адрес.
    const text = ctx.message.text ?? ctx.message.caption ?? "";
    const entity = ctx.message.entities?.find((e) => e.type === "bot_command")
      ?? ctx.message.caption_entities?.find((e) => e.type === "bot_command");
    if (entity) {
      const command = text.slice(entity.offset, entity.offset + entity.length);
      const atIndex = command.indexOf("@");
      if (atIndex !== -1) {
        const target = command.slice(atIndex + 1).toLowerCase();
        if (target !== ctx.me.username.toLowerCase()) return;
      }
    }
    return ctx.reply("Такой команды не существует. Используйте /help для списка доступных команд.");
  });
}
