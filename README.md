# tg-ask-bot

Telegram-бот с AI-ответами на базе OpenRouter и распознаванием изображений через Gemini API.

## Возможности

- Отвечает на текстовые сообщения через OpenRouter (DeepSeek V4 Flash по умолчанию)
- Распознаёт изображения через Google Gemini Flash Lite с внутренним рассуждением (`thinkingConfig`) и поиском Google для дополнительного контекста
- Фото понимается в контексте диалога: Gemini описывает изображение, OpenRouter отвечает с учётом истории переписки
- Подпись к фото передаётся вместе с описанием; если подписи нет — бот реагирует на содержимое
- **Fallback на Ollama**: если Gemini заблокировал изображение по политике или упал — запрос уходит на локальную модель (Ollama)
- Если ни Gemini, ни Ollama не смогли — DeepSeek всё равно отвечает в своём стиле
- Персонализация: бот автоматически запоминает ключевые факты о пользователе (город, предпочтения, хобби и т.д.) и использует их в ответах
- Факты извлекаются асинхронно после каждого сообщения, включая косвенные согласия («у меня тоже»), обновления и отзывы («шучу»)
- Хранит до 50 фактов на пользователя с поддержкой обновления и удаления отдельных фактов
- **Картинки по ситуации**: бот может прикрепить подходящее изображение к ответу — реакцию, мем или фото; текст и картинка отправляются одним сообщением (caption)
- **Семантический поиск картинок**: все отправленные пользователями изображения сохраняются в базе с описанием, тегами и флагом `is_nsfw`; для поиска используются векторные эмбеддинги (pgvector + Gemini Embedding)
- **NSFW-фильтр**: изображения автоматически классифицируются как 18+ или нет; по умолчанию NSFW-контент скрыт, включается через `/account`
- Сохраняет историю диалога в PostgreSQL (до 50 последних сообщений на пользователя)
- Считает количество запросов на пользователя
- История сохраняется между перезапусками бота
- Если пользователь пишет пока бот обрабатывает запрос — получает забавный ответ вместо зависания
- Поддержка прокси
- HTML-форматирование ответов с fallback на plain text при невалидной разметке
- Логирование через pino с ротацией по дням

## Команды

| Команда | Описание |
|---------|----------|
| `/start` | Приветствие |
| `/clear` | Очистить историю диалога |
| `/facts` | Управлять сохранёнными фактами |
| `/account` | Профиль, статистика и настройки (включая NSFW) |
| `/help` | Список команд |

## Установка

```bash
git clone https://github.com/MKRED/tg-ask-bot.git
cd tg-ask-bot
yarn install
```

## Настройка

Создай файл `.env` на основе `.env.example`:

```bash
cp .env.example .env
```

Заполни переменные:

```env
BOT_TOKEN=            # токен от @BotFather
OPENROUTER_API_KEY=   # ключ на openrouter.ai
GEMINI_API_KEY=       # ключ на aistudio.google.com
DATABASE_URL=         # postgres://user:password@host:5432/dbname
PROXY_URL=            # опционально: http://host:port
OPENROUTER_MODEL=     # опционально, по умолчанию deepseek/deepseek-v4-flash
OLLAMA_URL=           # опционально, по умолчанию http://localhost:11434
OLLAMA_VISION_MODEL=  # опционально, по умолчанию gemma4-vision
```

## База данных

Требуется PostgreSQL 17+ с расширением [pgvector](https://github.com/pgvector/pgvector) (для семантического поиска картинок).

```bash
# Применить миграции
yarn drizzle-kit migrate

# Сгенерировать новую миграцию после изменений схемы
yarn drizzle-kit generate
```

## Запуск

```bash
# Режим разработки (с hot reload)
yarn dev

# Продакшн
yarn build
yarn start
```

## Docker

Нужен образ с поддержкой pgvector, например `pgvector/pgvector:pg17`:

```bash
docker build -t tg-ask-bot .
docker run --env-file .env tg-ask-bot
```

## Стек

- [grammY](https://grammy.dev/) — Telegram Bot framework
- [OpenRouter](https://openrouter.ai/) — LLM API (текст)
- [Google Gemini](https://aistudio.google.com/) — Vision API (изображения, `gemini-3.1-flash-lite`) + Embedding API (`gemini-embedding-001`)
- [Ollama](https://ollama.com/) — локальная Vision модель, fallback при блокировке Gemini
- [Drizzle ORM](https://orm.drizzle.team/) + PostgreSQL + pgvector — хранение истории, фактов, изображений и векторный поиск
- [pino](https://getpino.io/) — логирование
- TypeScript + tsx
