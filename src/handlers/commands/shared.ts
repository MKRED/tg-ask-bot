import { type Context } from "grammy";
import logger from "../../logger.js";

// Проверка прав для групповых команд (/botstart, /botstop): команда работает только в группе
// и только для администраторов/создателя. На любой неуспех сам отправляет ответ и возвращает false.
export async function ensureGroupAdmin(ctx: Context, label: string): Promise<boolean> {
  const chatType = ctx.chat?.type;
  if (chatType !== "group" && chatType !== "supergroup") {
    await ctx.reply("Эта команда доступна только в группах.");
    return false;
  }

  try {
    const member = await ctx.getChatMember(ctx.from!.id);
    if (!["administrator", "creator"].includes(member.status)) {
      await ctx.reply("Только администраторы могут управлять ботом.");
      return false;
    }
  } catch (err) {
    logger.warn({ chatId: ctx.chat!.id, userId: ctx.from!.id, err }, `${label}: getChatMember failed`);
    await ctx.reply("Не удалось проверить права. Попробуйте снова.");
    return false;
  }

  return true;
}
