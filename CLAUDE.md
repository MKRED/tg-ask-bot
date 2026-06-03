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
```

## Architecture

```
src/
  index.ts               — entry point, bot init, graceful shutdown
  bot.ts                 — grammY bot instance
  config.ts              — env vars (requireEnv for mandatory, process.env for optional)
  logger.ts              — pino logger (daily rolling, pino-pretty in TTY)
  ai/
    gemini.ts            — Gemini API: analyzeImage(), generateTextEmbedding(), generateImageEmbedding(), GeminiBlockedError
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
    savedImages.ts       — saveImage(), findSimilarImages(), findImagesByTags(), countUserImages() (pgvector cosine)
    inlineMenus.ts       — inline keyboard menu state
    groupChats.ts        — upsertGroupChat(), getGroupChat(), getGroupNsfwEnabled()
    groupEnabledThreads.ts — enableThread(mode), disableThread(), getThreadMode(), isThreadEnabled() (mode: "chat" | "ingest")
    groupMessages.ts     — appendToBuffer(), getBuffer(), pruneBuffer() (sliding window, GROUP_BUFFER_SIZE rows)
    groupIngestImages.ts — durable ingest queue: enqueueIngestImage(), claimQueued(), markDone(), routeToOllama(), deferRetry(), markFailed(), getPendingBatch(), deleteBatchByIds(), markReportedByIds(), getStaleIngestThreads()
  handlers/
    commands.ts          — /start, /help, /clear, /facts, /account, /botstart, /botingest, /botstop
    myChatMember.ts      — bot join/leave group events → upsertGroupChat()
    messages/
      index.ts           — registerMessageHandlers()
      text.ts            — DM text handler (private chats only)
      photo.ts           — DM photo handler (private chats only)
      groupText.ts       — group text handler (group/supergroup)
      groupPhoto.ts      — group photo handler (group/supergroup)
      shared.ts          — processing Set<string>, processingKey(), sendMessage(), sendResponseWithImage()
      photoAnalysis.ts   — analyzePhotoWithFallback() (Gemini→Ollama, never throws) — used by DM/chat-mode photo only
      ingestWorker.ts    — startIngestWorker() — background two-lane worker draining the ingest queue (Gemini parallel, Ollama serial + circuit breaker)
      ingestDigest.ts    — scheduleDigest(), checkStaleDigests() (5-min debounce digest for ingest threads)
    forgetMenu/
      index.ts           — sendForgetMenu(), registerForgetCallbacks(), startMenuCleanupScheduler()
      render.ts          — buildMenuText(), buildMenuKeyboard(), buildConfirmKeyboard(), disableMenu()
  prompts/
    conversation.ts      — SYSTEM_PROMPT + buildSystemPrompt(facts) (DM)
    factExtraction.ts    — EXTRACTION_SYSTEM_PROMPT
    imageAnalysis.ts     — DESCRIPTION_PROMPT + RESPONSE_SCHEMA
    groupConversation.ts — GROUP_SYSTEM_PROMPT + buildGroupSystemPrompt(nsfwEnabled)
    groupDecision.ts     — GROUP_DECISION_PROMPT (JSON-only: should_respond true/false)
  types/
    bot.types.ts         — BotResponse interface
    gemini.types.ts      — ImageAnalysis interface
    index.ts             — barrel export
  constants/
    ai.constants.ts      — LAST_EXCHANGES, IMAGE_MARKER
    db.constants.ts      — MAX_HISTORY_MESSAGES, MAX_STORED_MESSAGES, MAX_FACTS, GROUP_BUFFER_SIZE, GROUP_DECISION_MSGS, GROUP_FULL_CONTEXT_SIZE
    ui.constants.ts      — MAX_MSG_LENGTH, FACTS_PER_PAGE, CLEANUP_INTERVAL_MS, GROUP_MSG_TIMEZONE
    ingest.constants.ts  — INGEST_TICK_MS, GEMINI_INGEST_CONCURRENCY, OLLAMA_INGEST_CONCURRENCY, OLLAMA_MAX_ATTEMPTS, OLLAMA_BACKOFF_*, OLLAMA_HEALTH_TIMEOUT_MS
    index.ts             — barrel export
  strings/
    replies.ts           — FACT_SAVED_REPLIES, BUSY_REPLIES, randomBusyReply(), randomFactSavedReply()
  utils/
    retry.ts             — retry(fn, attempts, delayMs, label, shouldRetry?)
    http.ts              — httpsPost(), downloadFile() (used by ai/gemini.ts)
    groupFormat.ts       — formatTimestamp(), formatBufferForLLM(), extractForwardInfo()
  scripts/
    reembedImages.ts      — one-time migration: re-embed ALL saved_images with the current image-embedding pipeline (run with the bot stopped). Uses GEMINI_API_KEY_FREE first (≤900/day, ~85/min), falls back to the paid key for the rest
    retryFailedIngest.ts  — reset failed ingest rows back to "pending" so the running worker re-processes them
```

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

## External APIs

| Service | Used for | Key env var |
|---|---|---|
| OpenRouter | Chat completions, fact extraction | `OPENROUTER_API_KEY` |
| Gemini | Image analysis, embeddings | `GEMINI_API_KEY` |
| Telegram | Bot API | `BOT_TOKEN` |

- Gemini image analysis model: `gemini-3.1-flash-lite` (in `gemini.ts`)
- Gemini embedding model: `gemini-embedding-2` (natively multimodal — embeds text and images into one shared space), produces **3072-dim** vectors
- OpenRouter model: configured via `OPENROUTER_MODEL` env var (default: `deepseek/deepseek-v4-flash`)

## pgvector
- DB must have the `vector` extension: `CREATE EXTENSION IF NOT EXISTS vector;`
- Vector column type is a `customType` in `schema.ts` (drizzle has no native pgvector support)
- Cosine similarity search: `ORDER BY embedding <=> ${vec}::vector`
- Storage-side embedding: `generateImageEmbedding(fileUrl, analysisText)` — embeds the **image itself + analysis text** (`description + " " + [...moodTags, ...contentTags].join(" ")`) into one multimodal vector. The image carries visual/compositional signal; the text anchors named entities (franchises/characters from grounding). The user's caption is **not** embedded (may be off-topic).
- Query-side embedding: `generateTextEmbedding(queryText)` — the user's search text. Lives in the same multimodal space, so text→image search matches directly.
- Both default to 3072 dims; `gemini.ts` guards against any other length (same-dim ≠ same-space — a foreign vector would otherwise enter the column silently).

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

**Ingest worker — two lanes** (`ingestWorker.ts`, started in `index.ts` via `startIngestWorker(api)`): each lane is a recursive-`setTimeout` loop (no overlap between ticks) that claims `pending` rows of its `route` via `claimQueued()` (`WHERE analyzed_by='pending' AND route=? AND next_attempt_at<=now() ORDER BY next_attempt_at`). An in-memory `Set<id>` per lane prevents double-claim at runtime; on restart any non-terminal row is still `pending` → re-processed (at-least-once).
- **Gemini lane**: up to `GEMINI_INGEST_CONCURRENCY` (3) in parallel. Success → `markDone(gemini)` + `saveImage` (fire-and-forget) + `scheduleDigest`. Block/any error → `routeToOllama()` (sets `route='ollama'`, resets `attempts`; not a failure).
- **Ollama lane**: strictly serial (`OLLAMA_INGEST_CONCURRENCY=1`; plus the internal semaphore in `ai/ollama.ts`). On failure: `attempts+1`; if it's a "down"-type error (`connection refused` / `model runner` / `fetch failed` / timeout) → trip the **circuit breaker** (`ollamaDown=true`); `deferRetry()` with exponential backoff `min(OLLAMA_BACKOFF_CAP_MS, BASE·2^(n-1))` (pushes the row to the back of the queue — poison images don't block the lane). After `OLLAMA_MAX_ATTEMPTS` (6) → `markFailed("failed")`.
- **Circuit breaker**: while `ollamaDown`, the Ollama lane stops claiming rows and instead health-pings `GET {ollamaUrl}/api/version` each tick; it resumes the instant Ollama answers. This is how "wait until Ollama comes back up" works **without burning rows' attempt budgets** during an outage (serial loop = only 1 row ever in flight, so an outage burns at most one attempt before the breaker pauses everything).
- `getFile` happens **in the worker** right before download (handler stores only `fileId`) — avoids Telegram `file_path` URL expiry for backlogged rows. A getFile failure → `markFailed("telegram_error")`.

**Ingest digest** — after 5 min of no newly *finalized* images, `ingestDigest.ts` sends a summary:
- `scheduleDigest(chatId, threadId, api)` — resets a per-thread 5-min debounce timer (in-memory `Map`). Called by the **worker** after each row reaches a terminal state, so the window starts from the last *processed* image (a long Ollama outage delays the digest until the backlog drains — it never fires a partial summary).
- `sendDigest()` — **guard first**: if `countPending() > 0` (rows still `pending`, e.g. waiting out an Ollama outage), it re-arms the timer and returns without sending — so the summary is never partial. Otherwise reads terminal, not-yet-reported rows (`getPendingBatch`: `analyzed_by != 'pending' AND reported_at IS NULL`), captures IDs before `sendMessage`, then **deletes only successful rows** (`gemini`/`ollama`) and **marks `failed`/`telegram_error` rows with `reported_at`** (kept in the table with `last_error` for manual inspection/retry — see `scripts/retryFailedIngest.ts`).
- The digest reports processing-time stats from `processed_at`/`processing_ms` (wall-clock span + avg sec/image + total analysis time).
- `checkStaleDigests(api)` — at startup, for each thread with un-reported rows: if last image ≥5 min ago → `sendDigest` immediately (no-ops safely if only `pending` rows remain), else re-arm timer for the remainder.

**Ingest restart recovery** — no special order needed anymore: `startIngestWorker(api)` is started, then `checkStaleDigests(api)`. The worker continuously drains `pending` rows (including any whose analysis was interrupted by the kill), calling `scheduleDigest` as it finalizes them. `checkStaleDigests` is safe to run anytime — it only looks at terminal, un-reported rows.

**Reply-to-bot bypass** — if `ctx.message.reply_to_message?.from?.id === ctx.me.id`, skip decision LLM and respond immediately. Log with `logger.info` for visibility.
