import type { Bot } from "grammy";
import { registerTextHandler } from "./text";
import { registerPhotoHandler } from "./photo";

export function registerMessageHandlers(bot: Bot): void {
  registerTextHandler(bot);
  registerPhotoHandler(bot);
}
