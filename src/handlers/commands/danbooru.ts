// Команда настройки Danbooru-хранилища: /setdanboorustorage [start_id].
import { Bot } from "grammy";
import { setDanbooruStorageChat, getDanbooruState, clearDanbooruStorageChat } from "../../db/danbooruState.js";
import { initDanbooruCursorIfNeeded } from "../../sources/danbooru/worker.js";
import { ensureGroupAdmin } from "./shared.js";
import logger from "../../logger.js";

export function registerDanbooruCommands(bot: Bot): void {
  // Устанавливает текущий чат как Telegram-хранилище для Danbooru-картинок.
  // Использование: /setdanboorustorage [start_post_id]
  //   start_post_id — с какого поста Danbooru начинать импорт (опционально).
  //   Без аргумента: если курсор уже задан — продолжаем оттуда; если нет — стартуем
  //   с самого свежего поста на момент вызова команды (история не затягивается).
  // Требования: бот должен иметь права на отправку сообщений в этот чат.
  bot.command("setdanboorustorage", async (ctx) => {
    const chatType = ctx.chat?.type;

    // В группах/супергруппах требуем права администратора
    if (chatType === "group" || chatType === "supergroup") {
      if (!(await ensureGroupAdmin(ctx, "setdanboorustorage"))) return;
    }

    // Каналы: bot.command() не ловит channel_post, поэтому на практике сюда
    // приходят только private/group/supergroup. Если когда-нибудь понадобится
    // поддержка каналов, нужно отдельно слушать channel_post.

    const userId = ctx.from?.id;
    const chatId = ctx.chat!.id;
    // Тема форум-группы, в которой выполнена команда. 0 = General/группа без тем.
    // Без этого бот постит картинки в General, а не в выбранную тему.
    const threadId = ctx.message?.message_thread_id ?? 0;
    const t0 = Date.now();

    // Парсим опциональный start_id из аргумента команды
    const argText = ctx.match?.toString().trim();
    let startPostId: number | undefined;
    if (argText) {
      const parsed = parseInt(argText, 10);
      if (isNaN(parsed) || parsed < 0) {
        return ctx.reply("Неверный start_id. Укажите целое положительное число или не передавайте аргумент.");
      }
      startPostId = parsed;
    }

    // Выбираем стартовую позицию курсора. Три случая:
    //   1. Передан start_id      → используем его (resolvedStartId = число).
    //   2. Курсор уже настроен    → продолжаем с него, НЕ перематывая (resolvedStartId = undefined,
    //      setDanbooruStorageChat сохранит текущий lastPostId). Меняем только storageChatId.
    //   3. Первый запуск без арг. → инициализируем самым свежим постом (историю не тянем).
    // Без проверки существующего стейта повторный вызов команды молча перематывал бы
    // курсор на «сейчас» и терял весь неимпортированный бэклог.
    const existing = await getDanbooruState();

    let resolvedStartId: number | undefined;
    let startMsg: string;
    if (startPostId !== undefined) {
      resolvedStartId = startPostId;
      startMsg = `с поста #${startPostId}`;
    } else if (existing) {
      // Уже настраивали раньше — продолжаем с текущего курсора, меняем только чат-хранилище
      resolvedStartId = undefined;
      startMsg = `с текущей позиции (#${existing.lastPostId})`;
    } else {
      // Первый запуск без аргумента — стартуем с самого свежего поста Danbooru
      try {
        resolvedStartId = await initDanbooruCursorIfNeeded(undefined);
      } catch (err) {
        logger.warn({ chatId, err }, "setdanboorustorage: failed to fetch latest Danbooru post ID");
        // Не блокируем команду, используем 0 как fallback (начнём с самого начала)
        resolvedStartId = 0;
      }
      startMsg = resolvedStartId > 0
        ? `с текущего поста #${resolvedStartId} (история не затягивается)`
        : "с самого начала";
    }

    await setDanbooruStorageChat(chatId, threadId, resolvedStartId);
    logger.info({ chatId, threadId, userId, resolvedStartId, durationMs: Date.now() - t0 }, "Danbooru storage chat set");

    return ctx.reply(
      `✅ Этот чат установлен как хранилище Danbooru-картинок.\n` +
      `Импорт начнётся ${startMsg}.`,
    );
  });

  // Ставит Danbooru-выгрузку на паузу: обнуляет storageChatId, воркер перестаёт грузить.
  // Курсор (lastPostId) сохраняется — повторный /setdanboorustorage без аргумента
  // продолжит с той же позиции, бэклог не теряется.
  bot.command("stopdanboorustorage", async (ctx) => {
    const chatType = ctx.chat?.type;

    // В группах/супергруппах требуем права администратора (как и у /setdanboorustorage)
    if (chatType === "group" || chatType === "supergroup") {
      if (!(await ensureGroupAdmin(ctx, "stopdanboorustorage"))) return;
    }

    const userId = ctx.from?.id;
    const t0 = Date.now();

    const state = await getDanbooruState();
    const paused = await clearDanbooruStorageChat();
    logger.info({ userId, paused, durationMs: Date.now() - t0 }, "Danbooru storage chat stop requested");

    if (!paused) {
      return ctx.reply("ℹ️ Danbooru-выгрузка и так не активна — останавливать нечего.");
    }

    return ctx.reply(
      `⏸️ Danbooru-выгрузка остановлена.\n` +
      `Позиция сохранена (#${state?.lastPostId ?? 0}). ` +
      `Чтобы продолжить с того же места — выполните /setdanboorustorage без аргумента в нужном чате.`,
    );
  });
}
