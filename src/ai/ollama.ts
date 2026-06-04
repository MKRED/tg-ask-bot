import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import logger from "../logger.js";
import { downloadFile } from "../utils/http.js";
import { DESCRIPTION_PROMPT, RESPONSE_SCHEMA } from "../prompts/imageAnalysis.js";
import type { ImageAnalysis } from "./gemini/index.js";

// Ollama — локальная модель, плохо переносит параллельные запросы: при пике
// (все картинки отброшены Gemini одновременно) runner падает с OOM/crash.
// Семафор на 1 слот: запросы строго по одному, остальные ждут в очереди.
class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

const ollamaSemaphore = new Semaphore(1);

export async function analyzeImageOllama(fileUrl: string): Promise<ImageAnalysis> {
  const agent = config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;
  const buffer = await downloadFile(fileUrl, agent);

  await ollamaSemaphore.acquire();

  const t0 = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  let data: any;
  try {
    const response = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaVisionModel,
        messages: [{ role: "user", content: DESCRIPTION_PROMPT, images: [buffer.toString("base64")] }],
        format: RESPONSE_SCHEMA,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama HTTP ${response.status}: ${body}`);
    }

    data = await response.json();
  } finally {
    clearTimeout(timeout);
    ollamaSemaphore.release();
  }

  const durationMs = Date.now() - t0;
  const content: string | undefined = data?.message?.content;
  if (!content) throw new Error(`Ollama returned empty content: ${JSON.stringify(data)}`);

  logger.info({ model: config.ollamaVisionModel, durationMs }, "Ollama image analysis completed");

  const parsed = JSON.parse(content);
  if (!parsed.description) throw new Error(`Ollama response missing description field: ${content}`);
  return {
    description: parsed.description,
    moodTags: parsed.mood_tags ?? [],
    contentTags: parsed.content_tags ?? [],
    isNsfw: parsed.is_nsfw ?? false,
  };
}
