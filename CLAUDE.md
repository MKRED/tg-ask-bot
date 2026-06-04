# tg_ask_bot — Claude Code Instructions

## Package manager
Always use **yarn**. Never use npm.

## Module system
Project is **native ESM** (`"type": "module"`, tsconfig `module`/`moduleResolution: nodenext`).
- Every **relative** import/export MUST carry an explicit `.js` extension — even though the source file is `.ts`. Example: `import { config } from "../config.js";`
- Importing a directory does **not** work — point at the barrel file explicitly: `import { X } from "../constants/index.js";`
- Bare package imports (`grammy`, `drizzle-orm`, …) stay extensionless as usual.

## Dev workflow
```
yarn dev           # start bot (run in background)
Stop-Process -Name "node"  # stop bot
yarn drizzle-kit generate  # generate migration from schema changes
yarn drizzle-kit migrate   # apply migrations to DB
yarn test          # run unit tests once (vitest run)
yarn test:watch    # run tests in watch mode
yarn build         # tsc typecheck/compile (excludes *.test.ts)
```

## Architecture

```
src/
  index.ts               — entry point, bot init, graceful shutdown (thin: register handlers + start workers/sources)
  bot.ts                 — grammY bot instance
  config.ts              — env vars (requireEnv for mandatory, process.env for optional)
  logger.ts              — pino logger (daily rolling, pino-pretty in TTY)
  ai/
    gemini/              — Gemini API client (folder: split by concern)
      index.ts           — barrel: public API (analyzeImage, generate*Embedding*, GeminiBlockedError, ImageAnalysis)
      client.ts          — shared: GEMINI_MODEL, EMBEDDING_MODEL, EMBEDDING_DIMS, API_URL, embeddingUrl(), proxyAgent()
      analyze.ts         — analyzeImage() + BLOCKING_FINISH_REASONS
      embeddings.ts      — generateTextEmbedding(), generateImageEmbedding(), generateImageEmbeddingFromBuffer()
      errors.ts          — GeminiBlockedError
      types.ts           — ImageAnalysis interface (co-located with gemini)
    openrouter.ts        — OpenRouter chat: askOpenRouter(), clearHistory(), addToHistory(), parseResponse()
    extractFacts.ts      — LLM fact extraction from conversation history
    ollama.ts            — Ollama fallback: analyzeImageOllama() (used when Gemini blocks an image)
    groupChat.ts         — group chat LLM: askGroupChat() (OpenRouter with reasoning, saves to buffer)
    groupDecision.ts     — decision LLM: checkShouldRespond() (should bot reply in group?)
  db/
    index.ts             — drizzle DB client
    schema.ts            — all table definitions + exported types
    messages.ts          — save/get/clear chat history (DM)
    users.ts             — upsertUser(), getUser(), getUserNsfwEnabled(), toggleNsfwEnabled(), updateUserProfile()
    facts.ts             — user facts CRUD
    savedImages.ts       — saveImage() → returns inserted ID, findSimilarImages(), findRandomImages(), countUserImages() (pgvector cosine)
    searchEmbeddings.ts  — inline-query embedding cache: getCachedEmbedding(), cacheEmbedding() (normalized phrase → vector)
    danbooruState.ts     — getDanbooruState(), setDanbooruStorageChat(), advanceDanbooruCursor() (singleton config row)
    danbooruPosts.ts     — insertDanbooruPost(), markDanbooruPostDone/Failed/Skipped() (audit + mapping to saved_images)
    inlineMenus.ts       — inline keyboard menu state
    groupChats.ts        — upsertGroupChat(), getGroupChat(), getGroupNsfwEnabled()
    groupEnabledThreads.ts — enableThread(mode), disableThread(), getThreadMode(), isThreadEnabled() (mode: "chat" | "ingest")
    groupMessages.ts     — appendToBuffer(), getBuffer(), pruneBuffer() (sliding window, GROUP_BUFFER_SIZE rows)
    groupIngestImages.ts — durable ingest queue: enqueueIngestImage(), claimQueued(), markDone(), routeToOllama(), deferRetry(), markFailed(), getPendingBatch(), deleteBatchByIds(), markReportedByIds(), getStaleIngestThreads()
  handlers/
    commands/            — bot commands (folder: one file per command group)
      index.ts           — registerCommands() — aggregates the register* functions below
      shared.ts          — ensureGroupAdmin()
      basic.ts           — /start, /help, unknown-command catch-all (registered last)
      account.ts         — /clear, /facts, /account + buildAccountText/nsfwKeyboard + account:toggle_nsfw callback
      group.ts           — /botstart, /botingest, /botstop
      danbooru.ts        — /setdanboorustorage
    myChatMember.ts      — bot join/leave group events → upsertGroupChat()
    inline/              — inline image search (folder)
      index.ts           — registerInlineQueryHandler() — inline image search (any chat): text → embedding (cached) → findSimilarImages → shuffled cached-photo results; empty query → findRandomImages (browse)
      constants.ts       — INLINE_MIN_QUERY_LEN, INLINE_POOL_SIZE, INLINE_SHOWN_COUNT, INLINE_BROWSE_COUNT, INLINE_CACHE_TIME
    messages/
      index.ts           — registerMessageHandlers()
      text.ts            — DM text handler (private chats only)
      photo.ts           — DM photo handler (private chats only)
      groupText.ts       — group text handler (group/supergroup)
      groupPhoto.ts      — group photo handler (group/supergroup)
      shared.ts          — processing Set<string>, processingKey(), sendMessage(), sendResponseWithImage()
      photoAnalysis.ts   — analyzePhotoWithFallback() (Gemini→Ollama, never throws) — used by DM/chat-mode photo only
      ingest/            — ingest queue pipeline (folder)
        worker.ts        — startIngestWorker() — background two-lane worker draining the ingest queue (Gemini parallel, Ollama serial + circuit breaker). Both lanes share module state → kept in one file.
        shared.ts        — pure helpers: errMsg(), isOllamaDown(), resolveFileUrl(), saveAnalysisToImages()
        digest.ts        — scheduleDigest(), checkStaleDigests() (5-min debounce digest for ingest threads)
        constants.ts     — INGEST_TICK_MS, GEMINI_INGEST_CONCURRENCY, OLLAMA_INGEST_CONCURRENCY, OLLAMA_MAX_ATTEMPTS, OLLAMA_BACKOFF_*, OLLAMA_HEALTH_TIMEOUT_MS
    forgetMenu/
      index.ts           — sendForgetMenu(), registerForgetCallbacks(), startMenuCleanupScheduler()
      render.ts          — buildMenuText(), buildMenuKeyboard(), buildConfirmKeyboard(), disableMenu()
  sources/               — external content importers (one folder per source; add reddit etc. here)
    index.ts             — startSources(api) — starts every source's worker (called once from index.ts)
    danbooru/
      worker.ts          — startDanbooruWorker(api), initDanbooruCursorIfNeeded() — background chronological crawler loop + age/score filters + cursor
      processPost.ts     — processPost() + ProcessResult — per-post pipeline (download → embed → upload → save)
      client.ts          — Danbooru HTTP API: fetchPosts(), downloadDanbooruImage(), fetchLatestPostId(), fetchPostById() (Basic Auth)
      transform.ts       — danbooruPostUrl(), extToMimeType(), isNsfwRating(), splitTags(), buildDescriptionAndTags()
      types.ts           — DanbooruApiPost interface
      constants.ts       — DANBOORU_BASE_URL, DANBOORU_TICK_MS, DANBOORU_BATCH_SIZE, DANBOORU_UPLOAD_DELAY_MS, DANBOORU_SENDER_ID, DANBOORU_ALLOWED_EXTS, DANBOORU_MIN_AGE_MS, DANBOORU_MIN_SCORE
  prompts/
    conversation.ts      — SYSTEM_PROMPT + buildSystemPrompt(facts) (DM)
    factExtraction.ts    — EXTRACTION_SYSTEM_PROMPT
    imageAnalysis.ts     — DESCRIPTION_PROMPT + RESPONSE_SCHEMA
    groupConversation.ts — GROUP_SYSTEM_PROMPT + buildGroupSystemPrompt(nsfwEnabled)
    groupDecision.ts     — GROUP_DECISION_PROMPT (JSON-only: should_respond true/false)
  types/                 — cross-cutting types only (feature types live with their feature)
    bot.types.ts         — BotResponse interface
    index.ts             — barrel export
  constants/             — cross-cutting constants only (feature constants live with their feature)
    ai.constants.ts      — LAST_EXCHANGES, IMAGE_MARKER
    db.constants.ts      — MAX_HISTORY_MESSAGES, MAX_STORED_MESSAGES, MAX_FACTS, GROUP_BUFFER_SIZE, GROUP_DECISION_MSGS, GROUP_FULL_CONTEXT_SIZE
    ui.constants.ts      — MAX_MSG_LENGTH, FACTS_PER_PAGE, CLEANUP_INTERVAL_MS, GROUP_MSG_TIMEZONE
    index.ts             — barrel export
  strings/
    replies.ts           — FACT_SAVED_REPLIES, BUSY_REPLIES, randomBusyReply(), randomFactSavedReply()
  utils/
    retry.ts             — retry(fn, attempts, delayMs, label, shouldRetry?)
    http.ts              — httpsPost(), downloadFile() (used by ai/gemini/)
    groupFormat.ts       — formatTimestamp(), formatBufferForLLM(), extractForwardInfo()
  scripts/
    reembedImages.ts      — one-time migration: re-embed ALL saved_images with the current image-embedding pipeline (run with the bot stopped). Uses GEMINI_API_KEY_FREE first (≤900/day, ~85/min), falls back to the paid key for the rest
    retryFailedIngest.ts  — reset failed ingest rows back to "pending" so the running worker re-processes them
    retryFailedDanbooru.ts — re-process failed danbooru_posts (status='failed'): re-fetches each by ID (fetchPostById) and runs it through the same processPost. Needs storage chat configured; safe to run with the bot up. Optional arg = max rows per run
```

## Структура и размер файлов — mandatory
Чтобы файлы не разрастались и проект оставался читаемым/масштабируемым:
- **Один файл — одна обязанность.** «Главный» файл (entry-point, register-агрегатор, цикл воркера) держим тонким, вынося реализацию в соседние файлы той же папки.
- **Ориентир ~100–150 строк.** Файл за ~150 строк — сигнал, что в нём несколько обязанностей; разбей, если они отделимы. Это эвристика читаемости, **не** жёсткий лимит: когезивные single-responsibility файлы (данные/строки как `strings/replies.ts`, одиночный хендлер, DAO одной таблицы как `db/groupIngestImages.ts`) не дробим ради цифры.
- **Папка-фича вместо россыпи.** Когда сущность вырастает из одного файла — заводим папку с `index.ts`-агрегатором (barrel или `registerXxx`) и соседними файлами-реализациями. Образцы: `handlers/commands/`, `handlers/messages/ingest/`, `ai/gemini/`, `sources/danbooru/`.
- **Со-локация констант/типов.** Фичевые константы/типы лежат рядом с использованием (`<feature>/constants.ts`, `<feature>/types.ts`), а не в общем barrel. В `src/constants/`/`src/types/` оставляем только кросс-каттинговое (`db`, `ui`, `ai`-общие, `BotResponse`).
- **Новый внешний источник контента** (reddit и т.п.) — только папкой в `src/sources/<name>/` по шаблону danbooru (`worker.ts` + `processPost.ts` + `client.ts` + `transform.ts` + `types.ts` + `constants.ts`); экспортирует функцию запуска воркера, которая подключается одной строкой в `sources/index.ts`.

## Code conventions

### Logging — mandatory
Every new module that does external I/O (API calls, DB writes, Telegram API) **must**:
1. Import `logger` from `../logger` (adjust path as needed)
2. Log the start or key parameters at `debug` or `info`
3. Measure duration: `const t0 = Date.now()` before the call, `durationMs: Date.now() - t0` in the log after
4. Log completion with timing and relevant metadata (token counts for LLM calls, row counts for DB ops, `dims` for embeddings)
5. Log errors with `logger.error({ err, ...context }, "description")` — never swallow silently

Pattern from existing code:
```typescript
const t0 = Date.now();
const result = await externalCall(...);
logger.info({ durationMs: Date.now() - t0, ...relevantFields }, "Operation completed");
```

### Error handling — mandatory
- Every new `async` function must either propagate errors to its caller or catch and log them explicitly
- Fire-and-forget chains (`.then().catch()`) must always end with `.catch((err) => logger.warn({ err, ...ctx }, "what failed"))`
- Never use an empty `catch {}` block — always log at minimum
- For handlers: unexpected errors should be logged with `logger.error` and result in a user-facing reply
- **Exception — group handlers** (`groupText.ts`, `groupPhoto.ts`): on error, log with `logger.error` but do **not** send a user-facing reply. The bot is one of many participants in a shared chat, so surfacing every internal error would spam the group. Errors stay in the logs only.

### Comments — encouraged
Add comments freely, especially in places with non-trivial logic. Preferred spots:
- Complex conditionals or multi-step flows — explain the intent
- Non-obvious constraints or invariants
- Workarounds for external API quirks
- Any place where a reader might ask "why is this done this way?"

All comments must be written in **Russian**.

Still avoid restating what the code obviously does — focus on the **why**, not the **what**.

### DB schema changes
1. Edit `src/db/schema.ts`
2. Run `yarn drizzle-kit generate` to create migration SQL in `drizzle/`
3. For pgvector extensions: manually add `CREATE EXTENSION IF NOT EXISTS vector;` to the migration — drizzle-kit does not generate it
4. Run `yarn drizzle-kit migrate` to apply

### Testing — vitest
Test runner is **vitest** (`yarn test` = `vitest run`, `yarn test:watch` = watch mode). Config: [vitest.config.ts](vitest.config.ts).
- **Co-locate** tests next to the code as `*.test.ts` (same folder, e.g. `transform.ts` → `transform.test.ts`). The runner globs `src/**/*.test.ts`; `tsc` (`yarn build`) excludes them via `**/*.test.ts` in `tsconfig.json`, so tests never land in `dist/`.
- **What to test:** pure functions — transformers, formatters, parsers, retry/decision logic — the stuff with no I/O. Examples already covered: `sources/danbooru/transform.ts`, `utils/groupFormat.ts`, `utils/retry.ts`. Workers, DAOs (`db/*`), and Telegram/LLM handlers are **not** unit-tested (they need a live DB / external services / mutable module state — out of scope until there's an integration setup).
- **Imports still need `.js`** in test files too (native ESM). Vitest/Vite resolves the `.js` specifier to the `.ts` source automatically.
- **Avoid pulling in `config`/`logger` transitively.** A unit under test that imports `../logger.js` will drag in `config.ts` (which `requireEnv`s `BOT_TOKEN` etc. and would throw without a `.env`) plus pino-roll worker threads. Mock it: `vi.mock("../logger.js", () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))`. See [retry.test.ts](src/utils/retry.test.ts).
- **Pool is `forks`** (not the default threads): on Windows the thread pool + Vite's cold dep-optimizer occasionally fails the first run with `Cannot read properties of undefined (reading 'config')`. Forks make cold runs deterministic — keep it.
- **Adding new pure logic?** Add a `*.test.ts` beside it. It's cheap now that the harness exists.

## External APIs

| Service | Used for | Key env var |
|---|---|---|
| OpenRouter | Chat completions, fact extraction | `OPENROUTER_API_KEY` |
| Gemini | Image analysis, embeddings | `GEMINI_API_KEY` |
| Telegram | Bot API | `BOT_TOKEN` |
| Danbooru | Image crawling (optional) | `DANBOORU_LOGIN`, `DANBOORU_API_KEY` |

- Gemini image analysis model: `gemini-3.1-flash-lite` (in `ai/gemini/client.ts`)
- Gemini embedding model: `gemini-embedding-2` (natively multimodal — embeds text and images into one shared space), produces **3072-dim** vectors
- OpenRouter model: configured via `OPENROUTER_MODEL` env var (default: `deepseek/deepseek-v4-flash`)

## pgvector
- DB must have the `vector` extension: `CREATE EXTENSION IF NOT EXISTS vector;`
- Vector column type is a `customType` in `schema.ts` (drizzle has no native pgvector support)
- Cosine similarity search: `ORDER BY embedding <=> ${vec}::vector`
- Storage-side embedding: `generateImageEmbedding(fileUrl, analysisText)` — embeds the **image itself + analysis text** (`description + " " + [...moodTags, ...contentTags].join(" ")`) into one multimodal vector. The image carries visual/compositional signal; the text anchors named entities (franchises/characters from grounding). The user's caption is **not** embedded (may be off-topic).
- Query-side embedding: `generateTextEmbedding(queryText)` — the user's search text. Lives in the same multimodal space, so text→image search matches directly.
- Both default to 3072 dims; `ai/gemini/embeddings.ts` guards against any other length (same-dim ≠ same-space — a foreign vector would otherwise enter the column silently).

## Keeping docs up to date

### README.md
Update `README.md` whenever:
- A new external dependency or service is added (API, DB extension, package)
- Setup steps change (new env vars, new migration, new required tool)
- A major feature is added that a new developer would need to know about
- Something in the stack section becomes outdated

### CLAUDE.md (this file)
Update this file whenever:
- A new architectural pattern is established (new module type, new convention)
- A new external API or model is introduced
- A code convention is agreed upon or changed in conversation
- A new mandatory rule is introduced (logging, error handling, etc.)
- The project structure changes significantly (new directories, new key files)

Both files should reflect the **current state** of the project, not its history. If something is removed — remove it from the docs too.

## Key patterns

**Inline menus must expire** — every inline keyboard menu must:
1. Track its state in the `inline_menus` table via `createInlineMenu(userId, chatId, messageId, menuType)`
2. On open: call `getActiveMenuByUser(userId, menuType)` and `disableMenu()` on any existing menu of the same type
3. On callback: verify `menu.messageId === messageId`; if not — answer with "Меню устарело" and return
4. Use a unique `menuType` string per menu kind (e.g. `"forget"`, `"account"`)
5. Add its expired text to the `EXPIRED_TEXT` map in `forgetMenu/render.ts`

**Retry wrapper** — use for all external calls that can transiently fail:
```typescript
await retry(() => someApiCall(), 3, 1500, "Label");
// or with custom shouldRetry:
await retry(() => call(), 3, 1500, "Label", (err) => !(err instanceof NonRetryableError));
```

**Fire-and-forget** — for non-blocking background work:
```typescript
someAsyncWork()
  .then((result) => logger.info({ result }, "Background work done"))
  .catch((err) => logger.warn({ err }, "Background work failed"));
```

**Processing lock** — `shared.ts` uses a `Set<string>` keyed by `"chatId:threadId"` (via `processingKey()`) to reject concurrent requests from the same chat/thread. Lock must always be released in `finally`.

**Group chat flow** — two-step LLM for groups:
1. `appendToBuffer()` — always, **before** acquiring the lock, so messages are never lost even if bot is busy
2. Check `processing.has(key)` — if locked, return silently
3. `checkShouldRespond()` (decision LLM, last `GROUP_DECISION_MSGS` messages, low reasoning effort, no retry) — skip if `isReplyToBot`
4. `askGroupChat()` (full LLM, last `GROUP_FULL_CONTEXT_SIZE` messages, with reasoning `effort: high`)
5. `processing.delete(key)` in `finally`

Bot response is saved to buffer inside `askGroupChat()` as fire-and-forget (DB failure must not block sending).

**Group thread whitelist** — bot only acts in threads with a row in `group_enabled_threads`. Each row has a `mode`: `"chat"` (full conversation, set by `/botstart`) or `"ingest"` (silent image absorption, set by `/botingest`). Check via `getThreadMode(chatId, threadId)` at the top of every group handler — `null` = not enabled, ignore. `isThreadEnabled()` is a thin boolean wrapper kept for convenience. `threadId = 0` is the sentinel for groups without topics.

**Ingest mode** (`mode === "ingest"`) — "pictures-only" thread: bot silently feeds photos into the image DB and never replies. Analysis is **decoupled from the message handler** via a durable queue (`group_ingest_images`) drained by a background worker, so the processing rate is set by the worker, not by Telegram's message stream (this is what killed the old inline approach — a flood of blocked images all hit Ollama at once and crashed the runner).
- `groupPhoto.ts` (ingest branch): only calls `enqueueIngestImage()` (inserts a `pending`/`route=gemini` row holding just the `fileId`) and returns. **No `getFile`, no analysis, no `saveImage`, no `scheduleDigest`** in the handler.
- `groupText.ts`: returns immediately — text in an ingest thread is ignored entirely (not even buffered).
- `/botstop` clears the thread row regardless of mode. Re-running `/botstart` or `/botingest` switches the mode in place.

**Ingest worker — two lanes** (`handlers/messages/ingest/worker.ts`, started in `index.ts` via `startIngestWorker(api)`): each lane is a recursive-`setTimeout` loop (no overlap between ticks) that claims `pending` rows of its `route` via `claimQueued()` (`WHERE analyzed_by='pending' AND route=? AND next_attempt_at<=now() ORDER BY next_attempt_at`). An in-memory `Set<id>` per lane prevents double-claim at runtime; on restart any non-terminal row is still `pending` → re-processed (at-least-once).
- **Gemini lane**: up to `GEMINI_INGEST_CONCURRENCY` (3) in parallel. Success → `markDone(gemini)` + `saveImage` (fire-and-forget) + `scheduleDigest`. Block/any error → `routeToOllama()` (sets `route='ollama'`, resets `attempts`; not a failure).
- **Ollama lane**: strictly serial (`OLLAMA_INGEST_CONCURRENCY=1`; plus the internal semaphore in `ai/ollama.ts`). On failure: `attempts+1`; if it's a "down"-type error (`connection refused` / `model runner` / `fetch failed` / timeout) → trip the **circuit breaker** (`ollamaDown=true`); `deferRetry()` with exponential backoff `min(OLLAMA_BACKOFF_CAP_MS, BASE·2^(n-1))` (pushes the row to the back of the queue — poison images don't block the lane). After `OLLAMA_MAX_ATTEMPTS` (6) → `markFailed("failed")`.
- **Circuit breaker**: while `ollamaDown`, the Ollama lane stops claiming rows and instead health-pings `GET {ollamaUrl}/api/version` each tick; it resumes the instant Ollama answers. This is how "wait until Ollama comes back up" works **without burning rows' attempt budgets** during an outage (serial loop = only 1 row ever in flight, so an outage burns at most one attempt before the breaker pauses everything).
- `getFile` happens **in the worker** right before download (handler stores only `fileId`) — avoids Telegram `file_path` URL expiry for backlogged rows. A getFile failure → `markFailed("telegram_error")`.

**Ingest digest** — after 5 min of no newly *finalized* images, `handlers/messages/ingest/digest.ts` sends a summary:
- `scheduleDigest(chatId, threadId, api)` — resets a per-thread 5-min debounce timer (in-memory `Map`). Called by the **worker** after each row reaches a terminal state, so the window starts from the last *processed* image (a long Ollama outage delays the digest until the backlog drains — it never fires a partial summary).
- `sendDigest()` — **guard first**: if `countPending() > 0` (rows still `pending`, e.g. waiting out an Ollama outage), it re-arms the timer and returns without sending — so the summary is never partial. Otherwise reads terminal, not-yet-reported rows (`getPendingBatch`: `analyzed_by != 'pending' AND reported_at IS NULL`), captures IDs before `sendMessage`, then **deletes only successful rows** (`gemini`/`ollama`) and **marks `failed`/`telegram_error` rows with `reported_at`** (kept in the table with `last_error` for manual inspection/retry — see `scripts/retryFailedIngest.ts`).
- The digest reports processing-time stats from `processed_at`/`processing_ms` (wall-clock span + avg sec/image + total analysis time).
- `checkStaleDigests(api)` — at startup, for each thread with un-reported rows: if last image ≥5 min ago → `sendDigest` immediately (no-ops safely if only `pending` rows remain), else re-arm timer for the remainder.

**Ingest restart recovery** — no special order needed anymore: `startIngestWorker(api)` is started, then `checkStaleDigests(api)`. The worker continuously drains `pending` rows (including any whose analysis was interrupted by the kill), calling `scheduleDigest` as it finalizes them. `checkStaleDigests` is safe to run anytime — it only looks at terminal, un-reported rows.

**Reply-to-bot bypass** — if `ctx.message.reply_to_message?.from?.id === ctx.me.id`, skip decision LLM and respond immediately. Log with `logger.info` for visibility.

**Inline image search** (`handlers/inline/index.ts`, registered in `index.ts`) — `@bot <query>` in any chat searches the saved-images DB:
1. **Requires `/setinline` at BotFather** — without it the bot receives no `inline_query` updates at all (no error, just silence). `inline_query` is in the default getUpdates `allowed_updates`, so `run(bot)` (no filter) gets it; if an explicit `allowed_updates` list is ever added, include `inline_query`.
2. Normalize the query (trim + collapse whitespace + lowercase + slice 255) — used as both the embedding input and the cache key, so casing/spacing variants share a vector.
3. Query `< INLINE_MIN_QUERY_LEN` → **browse**: `findRandomImages(nsfw, INLINE_BROWSE_COUNT)` (no embedding call). Otherwise → resolve embedding: `getCachedEmbedding()` → on miss `generateTextEmbedding()` + `cacheEmbedding()` (fire-and-forget); then `findSimilarImages(embedding, nsfw, INLINE_POOL_SIZE)`, **shuffle**, take `INLINE_SHOWN_COUNT` (same phrase → fresh subset each time, stays in the relevant pool — no relevance threshold yet).
4. Results are `InlineQueryResultCachedPhoto` by stored `fileId` (cached-photo is the only correct type — `photo_url` would need a public URL; the Telegram file URL expires and leaks the token). Для картинок с Danbooru вешается inline-кнопка «🔗 Danbooru» со ссылкой на пост: `getDanbooruIdsByImageIds(savedImageIds)` (один запрос по индексу `danbooru_posts_saved_image_idx`) даёт `saved_image_id → danbooru_id`, URL строит `danbooruPostUrl(id)`. Отдельной колонки нет — URL выводится из уже хранимого `danbooru_id`. Сбой этого шага не критичен: картинки отдаются без кнопок.
5. `answerInlineQuery(results, { cache_time: INLINE_CACHE_TIME, is_personal: true })` — **`is_personal: true` is mandatory** (NSFW depends on per-user settings; without it Telegram would serve one user's results to another). Low `cache_time` so the shuffle is visible on re-query.
6. NSFW from `getUserNsfwEnabled(userId)` — returns `false` for users who never DM'd the bot (safe SFW default). On any error: log + still `answerInlineQuery([])` (empty beats a hung spinner).

`search_embeddings` table — global cache (vector of a phrase is user-independent; NSFW filtering happens at search time). Looked up by exact `query_text` (btree unique), so **no vector index needed**.

**Danbooru import** (`sources/danbooru/`, started in `index.ts` via `startSources(api)` → `startDanbooruWorker(api)`; per-post pipeline в `processPost.ts`) — хронологически тянет новые посты и добавляет их в `saved_images` (после чего они доступны в inline-поиске). Опциональный: если `DANBOORU_LOGIN`/`DANBOORU_API_KEY` не заданы, воркер не запускается.
- Требует одноразовой настройки: `/setdanboorustorage [start_id]` в целевом чате/группе/супергруппе (в форум-группе — **в нужной теме**: команда запоминает `message_thread_id`, и `sendPhoto` постит именно туда, а не в General; `storageThreadId=0` = General/без тем). Бот будет загружать туда картинки (`sendPhoto`) чтобы получить Telegram `file_id`. Без этого воркер ждёт каждый тик. Поведение курсора: явный `start_id` → стартуем с него; **повторный вызов без аргумента, когда стейт уже есть → продолжаем с текущего курсора** (меняется только `storageChatId`, бэклог не теряется); первый запуск без аргумента → курсор = самый свежий пост (история не тянется).
- Порядок обработки поста: **download → embed → Telegram upload → saveImage**. Embed идёт до upload: зря не тратим Telegram flood-бюджет на картинки, которые Gemini не может проэмбеддить. `generateImageEmbeddingFromBuffer` принимает буфер напрямую — одна загрузка на оба шага. Транзиентные шаги (download/embed/save) обёрнуты в `retry()`; flood-лимиты `sendPhoto` (429) гасит транспортный `autoRetry()` в `bot.ts`.
- **Фильтр качества (возраст + score)**: грузим не всё подряд, а только «настоявшиеся» популярные посты. Два гейта в начале цикла `tick()` (батч отсортирован по возрастанию id = возрастанию свежести):
  1. **Возраст** `< DANBOORU_MIN_AGE_MS` (48ч) → `break` + курсор НЕ двигаем. У свежего поста score недостоверен (0–1 сразу после публикации); ждём, пока «настоится». Раз id хронологичны — все последующие посты в батче тоже моложе, поэтому останавливаем весь батч; на следующем тике окно перезапросится. Курсор трейлит на ~48ч позади реального времени.
  2. **Score** `< DANBOORU_MIN_SCORE` (5) → `markSkipped("low_score:N")` + сдвигаем курсор (без download/upload). Порог 5 ≈ медиана на 48ч — отсекает нижнюю «половину без отклика». Пороги выведены из эмпирического анализа распределения score по возрасту (медиана 2→5 за ~2 суток, дальше плато).
  - Лог тика: `skippedLowScore` (отсеяно по оценке), `stoppedYoung` (упёрлись в молодые → ждём), `newLastPostId` = реальная позиция курсора (при раннем стопе ≠ хвост батча).
- Рейтинги Danbooru: `g`/`s` → `isNsfw=false`, `q`/`e` → `isNsfw=true`. GIF/WebM/MP4 пропускаются (нельзя сохранить как Telegram photo → нет cached-photo file_id для inline).
- Загрузка в storage-чат (`sendPhoto`): к сообщению цепляется кнопка «🔗 Danbooru» (`reply_markup` со ссылкой `danbooruPostUrl(post.id)`), а для NSFW (`q`/`e`) ставится `has_spoiler: true` — картинка приходит заблюренной с раскрытием по тапу. Спойлер тут возможен, потому что бот сам отправляет медиа (в inline-выдаче `has_spoiler` недоступен — у inline-результатов нет такого поля). На извлекаемый `file_id` ни кнопка, ни спойлер не влияют.
- Теги (`buildDescriptionAndTags`): в текст эмбеддинга и в `saved_images.content_tags` уходят НОРМАЛИЗОВАННЫЕ теги (`_`→пробел — booru-теги в snake_case плохо стыкуются с естественными поисковыми фразами). Персонаж, франшиза (copyright) и автор (artist) — основные якоря поиска: они и в `description` (с метками `Characters:`/`From:`/`Art by:`), и первыми в `contentTags`. Сырая underscore-форма по категориям остаётся в `danbooru_posts.{general,character,copyright,artist}_tags` для аудита.
- `danbooru_posts` — аудит + маппинг `danbooru_id → saved_image_id`. Статусы: `pending → done/skipped/failed`. Курсор сдвигается в ЛЮБОМ исходе (включая fail) — битый пост не блокирует поток. **Идемпотентность**: `tick()` пропускает посты, уже бывшие `done`/`skipped` (`getDanbooruPostStatus`), а сохранение картинки и пометка `done` идут одной транзакцией (`saveImageAndMarkDone`) — поэтому ни рестарт, ни сброс курсора назад не плодят дубли в `saved_images` (там нет уникальности по danbooru-посту). Упавшие посты остаются позади курсора; переобработать их можно `scripts/retryFailedDanbooru.ts` (перезапрашивает по ID через `fetchPostById`). `DANBOORU_SENDER_ID=0` — sentinel senderUserId для Danbooru-импорта (у реальных Telegram-пользователей ID > 0).
- API: `GET /posts.json?page=a{last_id}&limit=N` — cursor-based пагинация, возвращает окно постов с id > last_id, но **в порядке УБЫВАНИЯ id** (не возрастания!). `worker.tick` сортирует батч по возрастанию перед обработкой — иначе `advanceDanbooruCursor` по каждому посту увёл бы курсор к минимуму батча (+1/тик) и каждый тик заново тянул бы предыдущее окно. Basic Auth (`login:api_key`). CDN-картинки публичны (auth не нужна). Лимит: 100 постов/запрос.
