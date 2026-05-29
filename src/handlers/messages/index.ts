import type { Bot } from "grammy";
import { registerTextHandler } from "./text";
import { registerPhotoHandler } from "./photo";
import { registerUnsupportedHandlers } from "./unsupported";

export function registerMessageHandlers(bot: Bot): void {
  registerTextHandler(bot);
  registerPhotoHandler(bot);
  registerUnsupportedHandlers(bot);
}
