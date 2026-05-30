// Сколько сообщений ЛС подаётся в LLM как контекст ответа
export const MAX_HISTORY_MESSAGES = 50;
// Сколько сообщений ЛС реально хранится в БД (история длиннее контекста)
export const MAX_STORED_MESSAGES = 1000;
export const MAX_FACTS = 50;

export const GROUP_BUFFER_SIZE = 1000;
export const GROUP_DECISION_MSGS = 5;
export const GROUP_FULL_CONTEXT_SIZE = 50;
