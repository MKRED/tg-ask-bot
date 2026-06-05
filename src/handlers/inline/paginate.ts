// Чистые помощники inline-пагинации (без I/O) — отделены от хендлера, чтобы покрыть юнит-тестами.

// Нормализация ключа кэша: схлопываем пробелы, в нижний регистр, обрезаем до длины
// столбца query_text (varchar 255). По этому же тексту и эмбеддим — варианты регистра
// и пробелов делят один вектор.
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 255);
}

// Парсим offset из inline_query (пагинация Telegram). На первом запросе offset = "",
// дальше — то, что мы вернули в next_offset. Невалидное/отрицательное → 0.
export function parseOffset(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// next_offset для Telegram: непустая строка → бот докинет следующую страницу, когда
// пользователь долистает; "" → пагинация закончена. Следующая страница есть, только если
// текущая пришла полной (значит, возможно, есть ещё) И мы не упёрлись в потолок глубины.
export function computeNextOffset(
  offset: number,
  pageLength: number,
  pageSize: number,
  maxResults: number,
): string {
  const nextStart = offset + pageLength;
  if (pageLength === pageSize && nextStart < maxResults) return String(nextStart);
  return "";
}
