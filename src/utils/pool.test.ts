import { describe, it, expect } from "vitest";
import { mapPool } from "./pool.js";

describe("mapPool", () => {
  it("сохраняет порядок результатов независимо от порядка завершения", async () => {
    // Ранние элементы завершаются позже поздних — проверяем, что результат всё равно по индексу
    const out = await mapPool([1, 2, 3, 4], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (5 - n) * 10));
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it("не превышает заданную степень параллелизма", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it("обрабатывает каждый элемент ровно один раз", async () => {
    const seen: number[] = [];
    await mapPool([5, 6, 7], 5, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([5, 6, 7]);
  });

  it("пустой вход → пустой результат, fn не вызывается", async () => {
    let calls = 0;
    const out = await mapPool([], 4, async () => {
      calls++;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
