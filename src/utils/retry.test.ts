import { describe, it, expect, vi, beforeEach } from "vitest";

// Мокаем logger: иначе импорт retry потянет config (requireEnv бросит без .env) и pino-roll
// поднимет worker-потоки транспорта. Для юнит-теста ретраев нам нужна лишь заглушка warn.
vi.mock("../logger.js", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { retry } from "./retry.js";

describe("retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("возвращает результат с первой попытки, без повторов", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    // delayMs=1 — реальные таймеры, но задержка ничтожна
    const result = await retry(fn, 3, 1, "label");
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("повторяет после провала и возвращает успех", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("ok");
    const result = await retry(fn, 3, 1, "label");
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("исчерпав все попытки, бросает последнюю ошибку", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always"));
    await expect(retry(fn, 3, 1, "label")).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("shouldRetry=false → не повторяет, бросает сразу после первого провала", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(retry(fn, 3, 1, "label", () => false)).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("shouldRetry различает ошибки: повторяет ретраибельные, не повторяет фатальные", async () => {
    class Fatal extends Error {}
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Fatal("stop"));
    const shouldRetry = (err: unknown) => !(err instanceof Fatal);

    await expect(retry(fn, 5, 1, "label", shouldRetry)).rejects.toThrow("stop");
    // 1-я (transient) → повтор; 2-я (Fatal) → стоп. Итого 2 вызова, не 5.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
