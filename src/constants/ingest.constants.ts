// Параметры фонового воркера обработки ingest-очереди (group_ingest_images).

// Как часто каждая полоса опрашивает очередь
export const INGEST_TICK_MS = 2000;

// Gemini — облачный API, держит параллельные запросы. Но он же делает эмбеддинги,
// поэтому общая нагрузка на ключ ограничена.
export const GEMINI_INGEST_CONCURRENCY = 3;

// Ollama — локальная модель, строго по одному запросу за раз (см. семафор в ai/ollama.ts).
export const OLLAMA_INGEST_CONCURRENCY = 1;

// Сколько раз пробуем картинку в Ollama-полосе, прежде чем пометить failed.
export const OLLAMA_MAX_ATTEMPTS = 6;

// Backoff между попытками: min(CAP, BASE * 2^(attempts-1)).
// attempts 1→15с, 2→30с, 3→60с, 4→120с, 5→240с, 6→300с (потолок).
export const OLLAMA_BACKOFF_BASE_MS = 15_000;
export const OLLAMA_BACKOFF_CAP_MS = 5 * 60_000;

// Circuit breaker: при "down"-ошибке Ollama (connection refused / runner stopped / fetch failed)
// полоса перестаёт брать строки и каждый тик пингует сервер; возобновляет работу,
// как только Ollama ответит — так мы «ждём пока поднимется», не тратя попытки строк впустую.
// Таймаут health-пинга Ollama (GET /api/version)
export const OLLAMA_HEALTH_TIMEOUT_MS = 5_000;
