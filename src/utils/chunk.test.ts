import { describe, it, expect } from "vitest";
import { chunk } from "./chunk.js";

describe("chunk", () => {
  it("разбивает на пачки заданного размера, последняя короче", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("ровное деление без остатка", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("size больше длины → одна пачка со всем", () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("пустой вход → пустой результат", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("size < 1 → ошибка (защита от бесконечного цикла)", () => {
    expect(() => chunk([1, 2], 0)).toThrow();
  });
});
