import { describe, it, expect } from "vitest";
import type { Message } from "grammy/types";
import type { GroupMessageBuffer } from "../db/schema.js";
import { formatTimestamp, formatBufferForLLM, extractForwardInfo } from "./groupFormat.js";

// Фабрика строки буфера — заполняем только поля, которые читает formatBufferForLLM.
function makeMsg(overrides: Partial<GroupMessageBuffer>): GroupMessageBuffer {
  return {
    senderName: "Аня",
    senderUsername: null,
    content: "привет",
    isBot: false,
    isForward: false,
    forwardFrom: null,
    createdAt: new Date("2025-05-29T04:32:00Z"),
    ...overrides,
  } as GroupMessageBuffer;
}

describe("formatTimestamp", () => {
  it("форматирует дату в зоне Владивостока (UTC+10) как 'дд.мм.гггг чч:мм'", () => {
    // 04:32 UTC + 10ч = 14:32 во Владивостоке
    expect(formatTimestamp(new Date("2025-05-29T04:32:00Z"))).toBe("29.05.2025 14:32");
  });

  it("учитывает переход через полночь по локальной зоне", () => {
    // 16:00 UTC + 10ч = 02:00 следующего дня во Владивостоке
    expect(formatTimestamp(new Date("2025-05-29T16:00:00Z"))).toBe("30.05.2025 02:00");
  });
});

describe("formatBufferForLLM", () => {
  it("обычное сообщение пользователя без username", () => {
    const out = formatBufferForLLM([makeMsg({ senderName: "Аня", content: "йо" })]);
    expect(out).toBe("[29.05.2025 14:32] Аня: йо");
  });

  it("пользователь с username показывается как 'Имя (@user)'", () => {
    const out = formatBufferForLLM([
      makeMsg({ senderName: "Аня", senderUsername: "anya", content: "йо" }),
    ]);
    expect(out).toBe("[29.05.2025 14:32] Аня (@anya): йо");
  });

  it("сообщение бота помечается как 'Бот'", () => {
    const out = formatBufferForLLM([makeMsg({ isBot: true, content: "ответ" })]);
    expect(out).toBe("[29.05.2025 14:32] Бот: ответ");
  });

  it("пересланное сообщение содержит источник и контент с новой строки", () => {
    const out = formatBufferForLLM([
      makeMsg({ senderName: "Аня", isForward: true, forwardFrom: "@channel", content: "новость" }),
    ]);
    expect(out).toBe("[29.05.2025 14:32] Аня переслал от @channel:\nновость");
  });

  it("пересланное без известного источника → 'неизвестного'", () => {
    const out = formatBufferForLLM([
      makeMsg({ senderName: "Аня", isForward: true, forwardFrom: null, content: "x" }),
    ]);
    expect(out).toBe("[29.05.2025 14:32] Аня переслал от неизвестного:\nx");
  });

  it("несколько сообщений склеиваются через перевод строки", () => {
    const out = formatBufferForLLM([
      makeMsg({ senderName: "Аня", content: "раз" }),
      makeMsg({ senderName: "Боря", content: "два" }),
    ]);
    expect(out).toBe("[29.05.2025 14:32] Аня: раз\n[29.05.2025 14:32] Боря: два");
  });
});

describe("extractForwardInfo", () => {
  it("сообщение без forward_origin → не пересланное", () => {
    expect(extractForwardInfo({} as Message)).toEqual({ isForward: false, forwardFrom: null });
  });

  it("канал с username → '@username'", () => {
    const msg = {
      forward_origin: { type: "channel", chat: { username: "news", title: "Новости" } },
    } as unknown as Message;
    expect(extractForwardInfo(msg)).toEqual({ isForward: true, forwardFrom: "@news" });
  });

  it("канал без username → title", () => {
    const msg = {
      forward_origin: { type: "channel", chat: { title: "Новости" } },
    } as unknown as Message;
    expect(extractForwardInfo(msg)).toEqual({ isForward: true, forwardFrom: "Новости" });
  });

  it("пользователь с username → 'Имя (@user)'", () => {
    const msg = {
      forward_origin: { type: "user", sender_user: { first_name: "Иван", username: "ivan" } },
    } as unknown as Message;
    expect(extractForwardInfo(msg)).toEqual({ isForward: true, forwardFrom: "Иван (@ivan)" });
  });

  it("пользователь без username → только имя", () => {
    const msg = {
      forward_origin: { type: "user", sender_user: { first_name: "Иван" } },
    } as unknown as Message;
    expect(extractForwardInfo(msg)).toEqual({ isForward: true, forwardFrom: "Иван" });
  });

  it("скрытый пользователь → sender_user_name", () => {
    const msg = {
      forward_origin: { type: "hidden_user", sender_user_name: "Кто-то" },
    } as unknown as Message;
    expect(extractForwardInfo(msg)).toEqual({ isForward: true, forwardFrom: "Кто-то" });
  });
});
