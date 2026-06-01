import type { Bot } from "grammy";
import { registerTextHandler } from "./text.js";
import { registerPhotoHandler } from "./photo.js";
import { registerUnsupportedHandlers } from "./unsupported.js";
import { registerGroupTextHandler } from "./groupText.js";
import { registerGroupPhotoHandler } from "./groupPhoto.js";

export function registerMessageHandlers(bot: Bot): void {
  registerTextHandler(bot);
  registerPhotoHandler(bot);
  registerGroupTextHandler(bot);
  registerGroupPhotoHandler(bot);
  registerUnsupportedHandlers(bot);
}
