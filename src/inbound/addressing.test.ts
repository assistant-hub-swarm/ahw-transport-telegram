import type { BotIdentity } from "@assistant-hub-swarm/transport-sdk";
import type { Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";

import type { TgUpdate } from "../telegram/adapter";
import { addressing } from "./addressing";

const BOT: BotIdentity = {
  id: "999",
  identity: { botUsername: "fixture_bot", botDisplayName: "Fixture" },
};

function update(input: Partial<Message> & { text?: string }): TgUpdate {
  return {
    message: {
      message_id: 1,
      date: 0,
      chat: { id: -1, type: "supergroup", title: "G" },
      from: { id: 5, is_bot: false, first_name: "A" },
      ...input,
    } as TgUpdate["message"],
    botToken: "token",
    botId: 999,
  };
}

describe("addressing (structural half — the name check is the core's)", () => {
  it("private chats are always addressed", () => {
    const message = update({ chat: { id: 5, type: "private", first_name: "A" } as Message["chat"] });
    expect(addressing(message, BOT)).toMatchObject({ addressed: true, source: "private" });
  });

  it("a reply to the bot's message is addressed", () => {
    const message = update({
      text: "yes",
      reply_to_message: {
        message_id: 2,
        date: 0,
        chat: { id: -1, type: "supergroup", title: "G" },
        from: { id: 999, is_bot: true, first_name: "Aria" },
      } as Message["reply_to_message"],
    });
    expect(addressing(message, BOT)).toMatchObject({ addressed: true, source: "reply" });
  });

  it("an @mention entity addresses the bot", () => {
    const message = update({
      text: "hey @fixture_bot do it",
      entities: [{ type: "mention", offset: 4, length: 12 }],
    });
    expect(addressing(message, BOT)).toMatchObject({ addressed: true, source: "mention" });
  });

  it("a /command@botusername addresses the bot", () => {
    const message = update({
      text: "/start@fixture_bot",
      entities: [{ type: "bot_command", offset: 0, length: 18 }],
    });
    expect(addressing(message, BOT)).toMatchObject({ addressed: true, source: "command" });
  });

  it("any other group text is undecided — the core runs the name check + analyzer", () => {
    // Even text that speaks a name: the assistant's name lives in the core's
    // store (and can be renamed there), so this transport never matches names
    // (user decision, 2026-08-24).
    expect(addressing(update({ text: "Aria, help" }), BOT)).toMatchObject({
      addressed: false,
      needsAnalyzer: true,
    });
    expect(addressing(update({ text: "unrelated chatter" }), BOT)).toMatchObject({
      addressed: false,
      needsAnalyzer: true,
    });
  });

  it("every verdict says what it decided on", () => {
    // A message these checks address never reaches the analyzer, so the
    // verdict is the whole account of why the bot answered.
    const decided = [
      addressing(
        update({ text: "hi", chat: { id: 5, type: "private", first_name: "A" } as Message["chat"] }),
        BOT,
      ),
      addressing(
        update({ text: "and you?", reply_to_message: { from: { id: 999 } } as never }),
        BOT,
      ),
      addressing(update({ text: "@fixture_bot hi" }), BOT),
      addressing(update({ text: "unrelated chatter" }), BOT),
    ];
    for (const verdict of decided) expect(verdict.reason).toBeTruthy();
  });

  it("a text-less group message decides nothing and asks for no analyzer", () => {
    expect(addressing(update({}), BOT)).toMatchObject({
      addressed: false,
      needsAnalyzer: false,
    });
  });

  it("refuses to guess before the bot account is known", () => {
    expect(addressing(update({ text: "hi" }), { ...BOT, id: "" })).toMatchObject({
      addressed: false,
      needsAnalyzer: false,
    });
  });
});
