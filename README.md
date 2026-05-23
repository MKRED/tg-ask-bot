# tg-ask-bot

Telegram-бот с AI-ответами на базе OpenRouter и распознаванием изображений через Gemini API.

## Возможности

- Отвечает на текстовые сообщения через OpenRouter (DeepSeek V4 Flash по умолчанию)
- Распознаёт изображения через Google Gemini 2.5 Flash с поиском Google для дополнительного контекста
- Фото понимается в контексте диалога: Gemini описывает изображение, OpenRouter отвечает с учётом истории переписки
- Подпись к фото передаётся вместе с описанием; если подписи нет — бот реагирует на содержимое
- Заблокированные по политике фото тоже обрабатываются — бот отвечает в своём стиле
- Персонализация: бот автоматически запоминает ключевые факты о пользователе (город, предпочтения, хобби и т.д.) и использует их в ответах
- Факты извлекаются асинхронно после каждого сообщения, включая косвенные согласия («у меня тоже»), обновления и отзывы («шучу»)
- Хранит до 50 фактов на пользователя с поддержкой обновления и удаления отдельных фактов
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
| `/forget` | Удалить все сохранённые факты о себе |
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
```

## База данных

```bash
# Применить миграции
yarn db:migrate

# Сгенерировать новую миграцию после изменений схемы
yarn db:generate
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

```bash
docker build -t tg-ask-bot .
docker run --env-file .env tg-ask-bot
```

## Стек

- [grammY](https://grammy.dev/) — Telegram Bot framework
- [OpenRouter](https://openrouter.ai/) — LLM API (текст)
- [Google Gemini](https://aistudio.google.com/) — Vision API (изображения)
- [Drizzle ORM](https://orm.drizzle.team/) + PostgreSQL — хранение истории и пользователей
- [pino](https://getpino.io/) — логирование
- TypeScript + tsx
