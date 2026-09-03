import type { Addressing, AddressingRule, BotIdentity } from "@assistant-hub-swarm/transport-sdk";
import type { Message } from "@grammyjs/types";

import type { TgUpdate } from "../telegram/adapter";

/**
 * The STRUCTURAL half of addressing — whether the Telegram wire shape alone
 * says the message targets this bot (entities, mentions, commands, reply
 * targets). That is exactly why it lives in this transport: the verdict
 * crosses the contract, the wire format never does.
 *
 * The NAME half belongs to the core (user decision, 2026-08-24): people
 * summon the ASSISTANT by its name — which lives in the core's store and can
 * be renamed there any time — never by the bot account's profile name. A
 * group message this check cannot decide comes back `needsAnalyzer`, and the
 * core runs its own deterministic name check before the LLM analyzer.
 *
 * Rules here: private chats always addressed; groups when the message
 * @mentions the bot, replies to one of its messages, or is a
 * `/command@botusername`.
 */

const NOT_ADDRESSED: Addressing = { addressed: false, needsAnalyzer: false };

/**
 * What each structural verdict says for itself, carried to the core and onto
 * the turn's trace. A message these checks address never reaches the LLM
 * analyzer, so there is no exchange to read afterwards — this sentence is the
 * whole account of why the bot answered, and it has to name the evidence
 * rather than the branch that fired.
 */
const REASONS = {
  private: "a direct chat — every message in it is for this bot",
  reply: "the sender replied to one of this bot's messages",
  mention: "the message @mentions this bot's username",
  command: "a /command addressed to this bot's username",
  undecided: "nothing in the message structure names this bot — over to the name check",
} as const;

/** Telegram entity offsets are UTF-16 code units, matching JS string indexing. */
function sliceEntity(text: string, offset: number, length: number): string {
  return text.slice(offset, offset + length);
}

function messageText(message: Message): string {
  return message.text ?? message.caption ?? "";
}

function hasUsernameMention(message: Message, botId: number, username: string): boolean {
  const text = messageText(message);
  if (!text) return false;

  const user = username.toLowerCase();
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  for (const entity of entities) {
    if (entity.type === "text_mention" && entity.user.id === botId) return true;
    if (entity.type === "mention") {
      const mention = sliceEntity(text, entity.offset, entity.length)
        .replace(/^@/, "")
        .toLowerCase();
      if (mention === user) return true;
    }
  }
  // Fallback for clients that omit entities: literal "@username" substring.
  return user.length > 0 && text.toLowerCase().includes(`@${user}`);
}

function hasCommandForBot(message: Message, username: string): boolean {
  const text = messageText(message);
  if (!text.trimStart().startsWith("/")) return false;

  const user = username.toLowerCase();
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  for (const entity of entities) {
    if (entity.type !== "bot_command") continue;
    const cmd = sliceEntity(text, entity.offset, entity.length);
    const at = cmd.indexOf("@");
    if (at !== -1 && cmd.slice(at + 1).toLowerCase() === user) return true;
  }
  return false;
}

export const addressing: AddressingRule<TgUpdate> = ({ message }, bot: BotIdentity): Addressing => {
  const chatType = message.chat.type;
  if (chatType === "private") {
    return { addressed: true, source: "private", needsAnalyzer: false, reason: REASONS.private };
  }
  if (chatType !== "group" && chatType !== "supergroup") return NOT_ADDRESSED;

  const botId = Number(bot.id);
  const username = bot.identity.botUsername;
  if (!Number.isFinite(botId) || !botId || !username) return NOT_ADDRESSED;

  if (message.reply_to_message?.from?.id === botId) {
    return { addressed: true, source: "reply", needsAnalyzer: false, reason: REASONS.reply };
  }
  // Command before the mention fallback: `/start@botname` carries a
  // bot_command entity whose suffix would otherwise match the loose check.
  if (hasCommandForBot(message, username)) {
    return { addressed: true, source: "command", needsAnalyzer: false, reason: REASONS.command };
  }
  if (hasUsernameMention(message, botId, username)) {
    return { addressed: true, source: "mention", needsAnalyzer: false, reason: REASONS.mention };
  }

  if (messageText(message).trim()) {
    return { addressed: false, needsAnalyzer: true, reason: REASONS.undecided };
  }
  return NOT_ADDRESSED;
};
