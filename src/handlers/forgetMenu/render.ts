import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { deleteInlineMenuById } from "../../db/inlineMenus";
import type { InlineMenu, UserFact } from "../../db/schema";
import logger from "../../logger";
import { FACTS_PER_PAGE } from "../../constants";

export function totalPages(factsCount: number): number {
  return Math.ceil(factsCount / FACTS_PER_PAGE);
}

export function buildMenuText(facts: UserFact[], page: number): string {
  const pages = totalPages(facts.length);
  const start = page * FACTS_PER_PAGE;
  const pageFacts = facts.slice(start, start + FACTS_PER_PAGE);
  const lines = pageFacts.map((f, i) => `${start + i + 1}. ${f.key}: ${f.valueOriginal ?? f.value}`);
  return `Твои факты (стр. ${page + 1}/${pages}):\n\n${lines.join("\n")}`;
}

export function buildMenuKeyboard(facts: UserFact[], page: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const pages = totalPages(facts.length);
  const start = page * FACTS_PER_PAGE;
  const pageFacts = facts.slice(start, start + FACTS_PER_PAGE);

  pageFacts.forEach((fact, i) => {
    kb.text(`🗑 ${start + i + 1}`, `forget:del:${page}:${fact.id}`);
  });
  kb.row();

  if (pages > 1) {
    if (page > 0) kb.text("◀", `forget:page:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, "forget:noop");
    if (page < pages - 1) kb.text("▶", `forget:page:${page + 1}`);
    kb.row();
  }

  kb.text("🗑 Удалить всё", `forget:all:${page}`);

  return kb;
}

export function buildConfirmKeyboard(page: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Да, удалить всё", "forget:all:confirm")
    .text("❌ Отмена", `forget:page:${page}`);
}

export async function disableMenu(api: Api, menu: InlineMenu, reason: "inactivity" | "max_age"): Promise<void> {
  try {
    await api.editMessageText(
      menu.chatId,
      menu.messageId,
      "Меню устарело. /facts — открыть заново."
    );
    logger.info(
      { userId: menu.userId, chatId: menu.chatId, messageId: menu.messageId, reason },
      "menu_expired"
    );
  } catch (err: any) {
    const desc: string = err?.description ?? "";
    if (desc.includes("message to edit not found") || desc.includes("message is not modified")) {
      logger.warn(
        { userId: menu.userId, messageId: menu.messageId },
        "menu_edit_failed_not_found"
      );
    } else {
      logger.error({ err, userId: menu.userId, messageId: menu.messageId }, "menu_edit_failed");
    }
  } finally {
    await deleteInlineMenuById(menu.id);
  }
}
