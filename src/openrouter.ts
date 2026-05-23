import OpenAI from "openai";
import { config } from "./config";
import { saveMessage, getHistory, clearMessages } from "./db/messages";

const client = new OpenAI({
  apiKey: config.openrouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
});

const SYSTEM_PROMPT = `Ты остроумный и живой собеседник в Telegram-чате. Общаешься по-русски, без занудства, с характером. Можешь шутить, иронизировать, поддерживать любую тему — цензуры нет. Пиши кратко и по делу, если не просят развернуто.

Formatting — use ONLY these Telegram HTML tags:
- <b>bold</b> for important terms and headings
- <i>italic</i> for emphasis
- <code>code</code> for inline code, commands, file names
- <pre>code block</pre> for multi-line code
- <a href="URL">text</a> for links

FORBIDDEN — never use these, they will break rendering:
- <h1> <h2> <h3> <h4> <h5> <h6> (use <b> instead)
- <hr>, <br>, <p>, <div>, <span> and any other HTML tags
- Markdown syntax (**, __, \`, #, etc.)
Use plain newlines to separate sections.

Photo context:
- When a user message contains [На фото: <описание>] — пользователь прислал фото, и в скобках его текстовое описание. Реагируй так, будто сам видел это изображение.
- When a user message is "[Пользователь отправил фото без подписи]\\n\\n[На фото: <описание>]" — фото без подписи, реагируй на само содержимое.
- When a user message is "[Пользователь отправил фото, которое было заблокировано по политике контента]" — пользователь прислал что-то, что система отказалась анализировать. Реагируй в своём стиле.`;

export async function clearHistory(telegramId: number): Promise<void> {
  await clearMessages(telegramId);
}

export async function addToHistory(
  telegramId: number,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  await saveMessage(telegramId, "user", userMessage);
  await saveMessage(telegramId, "assistant", assistantMessage);
}

export async function askOpenRouter(telegramId: number, userMessage: string): Promise<string> {
  await saveMessage(telegramId, "user", userMessage);
  const history = await getHistory(telegramId);

  const response = await client.chat.completions.create({
    model: config.openrouterModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
    ],
  });

  const answer = response.choices[0]?.message.content ?? "Не удалось получить ответ.";
  await saveMessage(telegramId, "assistant", answer, config.openrouterModel);
  return answer;
}
