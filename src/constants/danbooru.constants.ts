// Интервал между тиками воркера (мс)
export const DANBOORU_TICK_MS = 15_000;
// Количество постов Danbooru за один тик (лимит API — 100, берём поменьше)
export const DANBOORU_BATCH_SIZE = 20;
// Пауза между загрузками картинок в Telegram-хранилище (мс) — защита от flood-лимита
export const DANBOORU_UPLOAD_DELAY_MS = 1_500;
// Sentinel senderUserId для saved_images, импортированных с Danbooru
// (Telegram ID всегда > 0, поэтому 0 означает «не живой пользователь»)
export const DANBOORU_SENDER_ID = 0;
// Поддерживаемые расширения. GIF/WebM/MP4 пропускаем: Telegram принимает их только как
// animation/document, а не как photo — значит InlineQueryResultCachedPhoto не заработает.
export const DANBOORU_ALLOWED_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);
