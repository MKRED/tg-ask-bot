import { describe, it, expect } from "vitest";
import { normalizeQuery, parseOffset, computeNextOffset } from "./paginate.js";

describe("normalizeQuery", () => {
  it("trims, collapses whitespace and lowercases", () => {
    expect(normalizeQuery("  Makima   Chainsaw  ")).toBe("makima chainsaw");
  });

  it("collapses tabs and newlines into single spaces", () => {
    expect(normalizeQuery("a\t\n  b")).toBe("a b");
  });

  it("обрезает до 255 символов (длина столбца query_text)", () => {
    const long = "x".repeat(300);
    expect(normalizeQuery(long)).toHaveLength(255);
  });

  it("пустую строку оставляет пустой", () => {
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("parseOffset", () => {
  it("пустой offset (первый запрос) → 0", () => {
    expect(parseOffset("")).toBe(0);
  });

  it("парсит положительное число", () => {
    expect(parseOffset("25")).toBe(25);
  });

  it("отрицательное → 0", () => {
    expect(parseOffset("-5")).toBe(0);
  });

  it("ноль → 0", () => {
    expect(parseOffset("0")).toBe(0);
  });

  it("нечисловое → 0", () => {
    expect(parseOffset("abc")).toBe(0);
  });

  it("отбрасывает дробную часть (parseInt)", () => {
    expect(parseOffset("12.9")).toBe(12);
  });
});

describe("computeNextOffset", () => {
  // pageSize=25, maxResults=250 — как в проде (INLINE_PAGE_SIZE / INLINE_MAX_RESULTS)
  it("полная страница ниже потолка → следующий offset", () => {
    expect(computeNextOffset(0, 25, 25, 250)).toBe("25");
    expect(computeNextOffset(25, 25, 25, 250)).toBe("50");
  });

  it("неполная страница (последняя) → пусто", () => {
    expect(computeNextOffset(0, 10, 25, 250)).toBe("");
  });

  it("полная страница ровно на потолке → пусто (нет следующей)", () => {
    // offset 225 + 25 = 250 = maxResults → дальше не листаем
    expect(computeNextOffset(225, 25, 25, 250)).toBe("");
  });

  it("полная страница на шаг до потолка → последний offset", () => {
    expect(computeNextOffset(200, 25, 25, 250)).toBe("225");
  });

  it("пустая выдача → пусто", () => {
    expect(computeNextOffset(0, 0, 25, 250)).toBe("");
  });
});
