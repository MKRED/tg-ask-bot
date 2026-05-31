import type { Message } from "grammy/types";
import type { GroupMessageBuffer } from "../db/schema";
import { GROUP_MSG_TIMEZONE } from "../constants";

export function formatTimestamp(date: Date): string {
  // Формат: "29.05.2025 14:32" по временной зоне Владивостока
  return date
    .toLocaleString("ru-RU", {
      timeZone: GROUP_MSG_TIMEZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(",", "");
}

export function formatBufferForLLM(messages: GroupMessageBuffer[]): string {
  return messages
    .map((msg) => {
      const ts = formatTimestamp(msg.createdAt);
      const name = msg.senderUsername
        ? `${msg.senderName} (@${msg.senderUsername})`
        : msg.senderName;

      if (msg.isBot) {
        return `[${ts}] Бот: ${msg.content}`;
      }
      if (msg.isForward) {
        return `[${ts}] ${name} переслал от ${msg.forwardFrom ?? "неизвестного"}:\n${msg.content}`;
      }
      return `[${ts}] ${name}: ${msg.content}`;
    })
    .join("\n");
}

export interface ForwardInfo {
  isForward: boolean;
  forwardFrom: string | null;
}

export function extractForwardInfo(msg: Message): ForwardInfo {
  const origin = msg.forward_origin;
  if (!origin) return { isForward: false, forwardFrom: null };

  switch (origin.type) {
    case "channel": {
      const chat = origin.chat;
      const name = "username" in chat && chat.username ? `@${chat.username}` : (chat.title ?? null);
      return { isForward: true, forwardFrom: name };
    }
    case "user": {
      const u = origin.sender_user;
      const name = u.username ? `${u.first_name} (@${u.username})` : u.first_name;
      return { isForward: true, forwardFrom: name };
    }
    case "hidden_user":
      return { isForward: true, forwardFrom: origin.sender_user_name };
    case "chat": {
      const chat = origin.sender_chat;
      const name = "username" in chat && chat.username ? `@${chat.username}` : (chat.title ?? null);
      return { isForward: true, forwardFrom: name };
    }
    default:
      return { isForward: true, forwardFrom: "неизвестный источник" };
  }
}
