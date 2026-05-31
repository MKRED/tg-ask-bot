import type { Bot } from "grammy";
import { registerTextHandler } from "./text";
import { registerPhotoHandler } from "./photo";
import { registerUnsupportedHandlers } from "./unsupported";
import { registerGroupTextHandler } from "./groupText";
import { registerGroupPhotoHandler } from "./groupPhoto";

export function registerMessageHandlers(bot: Bot): void {
  registerTextHandler(bot);
  registerPhotoHandler(bot);
  registerGroupTextHandler(bot);
  registerGroupPhotoHandler(bot);
  registerUnsupportedHandlers(bot);
}
