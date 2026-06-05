// Параллельный map с ограничением степени параллелизма: запускает fn для каждого
// элемента, удерживая не более `concurrency` задач одновременно. Результаты возвращаются
// в порядке входного массива (как Promise.all), независимо от порядка завершения.
//
// Зачем: воркеры (danbooru) обрабатывают батч постов конвейером download→embed→upload,
// где сетевые шаги доминируют. Серийная обработка простаивает на каждом round-trip;
// пул из N задач прячет ожидание одних за работой других, не превышая нагрузку на
// внешние сервисы (Telegram/Gemini/прокси) больше, чем на N одновременных запросов.
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  // Запускаем min(concurrency, items.length) воркеров; каждый тянет следующий
  // свободный индекс, пока элементы не кончатся. next++ атомарен в однопоточном
  // event loop, поэтому два воркера не возьмут один индекс.
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
