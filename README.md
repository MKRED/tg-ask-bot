# tg-ask-bot

Telegram-бот с AI-ответами на базе OpenRouter и распознаванием изображений через Gemini API.

## Возможности

- Отвечает на текстовые сообщения через OpenRouter (DeepSeek V4 Flash по умолчанию)
- Распознаёт и описывает изображения через Google Gemini 2.5 Flash
- Сохраняет историю диалога в рамках сессии (отдельно для каждого чата)
- Параллельная обработка сообщений от нескольких пользователей
- Поддержка прокси
- HTML-форматирование ответов

## Команды

| Команда | Описание |
|---------|----------|
| `/start` | Приветствие |
| `/clear` | Очистить историю диалога |
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
BOT_TOKEN=       # токен от @BotFather
OPENROUTER_API_KEY=  # ключ на openrouter.ai
GEMINI_API_KEY=      # ключ на aistudio.google.com
PROXY_URL=           # опционально: http://host:port
OPENROUTER_MODEL=    # опционально, по умолчанию deepseek/deepseek-v4-flash
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
- TypeScript + tsx
