import { Bot } from "grammy";
import { registerBasicCommands } from "./basic.js";
import { registerAccountCommands } from "./account.js";
import { registerGroupCommands } from "./group.js";
import { registerDanbooruCommands } from "./danbooru.js";

export function registerCommands(bot: Bot): void {
  // Порядок важен: basic регистрирует catch-all обработчик неизвестных команд
  // (message:entities:bot_command), поэтому он идёт последним.
  registerAccountCommands(bot);
  registerGroupCommands(bot);
  registerDanbooruCommands(bot);
  registerBasicCommands(bot);
}
