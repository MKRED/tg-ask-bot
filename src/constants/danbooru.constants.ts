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
// Минимальный «возраст» поста перед загрузкой (мс). У свежих постов score ещё не сформирован
// (0–1 сразу после публикации), поэтому фильтр по оценке был бы недостоверен. По эмпирическому
// анализу score созревает за ~2 суток (медиана 2→5, дальше плато), поэтому ждём 48ч. Курсор
// при этом трейлит на ~48ч позади реального времени.
export const DANBOORU_MIN_AGE_MS = 48 * 60 * 60 * 1000;
// Минимальный score «настоявшегося» поста. Ниже — «работа без отклика»: на 48ч ~половина
// постов имеет score < 5 (медиана ровно 5). T=5 отсекает нижнюю половину, оставляя посты
// с реальными голосами. Анализ распределения см. в истории проекта.
export const DANBOORU_MIN_SCORE = 5;
