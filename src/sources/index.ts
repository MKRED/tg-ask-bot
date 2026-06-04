// Внешние источники контента (импортёры). Каждый источник живёт в своей папке
// src/sources/<name>/ и экспортирует функцию запуска воркера. Все они стартуют здесь —
// добавляя новый источник (например reddit), достаточно дописать одну строку.
import type { Api } from "grammy";
import { startDanbooruWorker } from "./danbooru/worker.js";

export function startSources(api: Api): void {
  startDanbooruWorker(api);
}
