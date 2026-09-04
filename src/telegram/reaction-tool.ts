import {
  reactToMessage,
  toolRefusal,
  tracedTool,
  turnOf,
  type TransportRuntime,
} from "@assistant-hub-swarm/transport-sdk";
import type { ReactionTypeEmoji } from "@grammyjs/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TgUpdate } from "./adapter";

/**
 * Reacting, as Telegram does it.
 *
 * The tool is this transport's because the emoji are: Telegram accepts
 * exactly 73 of them and nothing else, and a model needs to be told which —
 * a very different sentence from Discord's "any emoji". What the tool does
 * NOT own is the mirror gate or the badge record: `reactToMessage` is the
 * contract's, and every transport reaches the same verdicts through it.
 */

/** Exactly the reactions Telegram's Bot API accepts. */
export const TELEGRAM_REACTION_EMOJI = [
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔",
  "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩",
  "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳",
  "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆",
  "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈",
  "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈",
  "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄",
  "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄",
  "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀",
  "😡",
] as const satisfies readonly ReactionTypeEmoji["emoji"][];

export type TelegramReactionEmoji = (typeof TELEGRAM_REACTION_EMOJI)[number];

/**
 * The canonical reaction emoji matching `input`, or null when Telegram has
 * none. Only mechanical normalization: emoji presentation selectors (U+FE0F)
 * are stripped before matching. Nothing is guessed.
 */
export function toTelegramReactionEmoji(input: string): TelegramReactionEmoji | null {
  const stripped = input.trim().replaceAll("\u{FE0F}", "");
  return TELEGRAM_REACTION_EMOJI.find((emoji) => emoji === stripped) ?? null;
}

const DESCRIPTION =
  "Put one of Telegram's reaction emoji on a specific message in this chat — the small emoji " +
  "badge under it. Give the message's numeric id in 'message_id' and the 'emoji' to show. Use " +
  "it when someone asks you to like, thumbs-up, heart or otherwise react to a message. " +
  "Reacting is an acknowledgement, not an answer: it delivers no text and nobody is notified, " +
  "so when something was asked of you, react and still answer. Omit 'emoji' to take your " +
  "reaction back. The message must be one you can see here and not one of your own.";

export function registerReactionTool(server: McpServer, runtime: TransportRuntime<TgUpdate>): void {
  server.registerTool(
    "set_message_reaction",
    {
      title: "React to a message",
      description: DESCRIPTION,
      inputSchema: {
        message_id: z
          .number()
          .int()
          .positive()
          .describe(
            "The Telegram message id to react to — the number in the #<id> anchor of the " +
              "message you are reacting to.",
          ),
        // Free text carrying the allowed set in its description, rather than a
        // `z.enum` of the 73 values. An enum would be validated by the schema
        // layer, and the local backends this bot usually runs on template tool
        // JSON without enforcing schemas — so an off-list or
        // variation-selector spelling would come back as a raw validation
        // error instead of a refusal written for the model. The handler checks
        // it instead, and accepts spellings Telegram itself would not.
        emoji: z
          .string()
          .default("")
          .describe(
            `The reaction emoji, one of: ${TELEGRAM_REACTION_EMOJI.join(" ")} — ` +
              "leave empty to remove your reaction from the message",
          ),
        big: z
          .boolean()
          .default(false)
          .describe("Show the reaction as a big animated effect (use sparingly)"),
      },
      outputSchema: {
        ok: z.boolean(),
        message_id: z.number().int().nullable(),
        emoji: z.string().nullable(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message_id, emoji, big }, extra) => {
      const turn = turnOf(extra?._meta, runtime.descriptor.id);
      return tracedTool(
        {
          traces: runtime.traces,
          descriptor: runtime.descriptor,
          turn,
          action: "set_message_reaction",
          inputSummary: `#${message_id} ${emoji.trim() || "(cleared)"}`,
        },
        async (event) => {
          if (!turn) {
            return toolRefusal(
              "This tool can only be used inside a turn on Telegram, and this call carries no turn " +
                "binding. Nothing was changed.",
            );
          }

          const requested = emoji.trim();
          const reaction = requested ? toTelegramReactionEmoji(requested) : null;
          if (requested && !reaction) {
            return toolRefusal(
              `Telegram has no "${requested}" reaction. Pick one of: ` +
                `${TELEGRAM_REACTION_EMOJI.join(" ")}`,
            );
          }

          let outcome;
          try {
            outcome = await reactToMessage(
              { ...runtime.send, core: runtime.core },
              {
                chatId: turn.chatId,
                sourceMessageId: String(message_id),
                emoji: reaction,
                assistantId: turn.assistantId ?? null,
                options: { big },
              },
            );
          } catch (err) {
            // Telegram refused for a reason only it knows (a chat-restricted
            // emoji, a message too old, no running connection) — relayed verbatim
            // so the model does not claim it reacted.
            return toolRefusal(
              `Telegram did not accept the reaction: ${err instanceof Error ? err.message : String(err)}. ` +
                "Do not claim you reacted.",
            );
          }

          if (outcome.status === "not_found") {
            return toolRefusal(
              `No message #${message_id} in this chat. Do not guess ids — look the message up again ` +
                "and use an id from the result, or answer without reacting.",
            );
          }
          // Reacting to itself is the one target that is never right: a badge the
          // bot put on its own message says nothing to anyone, and Telegram would
          // happily allow it.
          if (outcome.status === "own_message") {
            return toolRefusal(
              `Message #${message_id} is your own — do not react to what you said yourself. ` +
                "React to someone else's message, or say what you mean in your answer.",
            );
          }

          // Whether the bot will *remember* reacting: the mirror renders it on the
          // target line (`[you reacted: ...]`); without that record the very next
          // turn denied having set it (operator report, 2026-08-15). The reaction
          // IS on the message either way — a failed record must not read as a
          // Telegram refusal, only as the memory of it missing.
          const note = outcome.recorded
            ? ""
            : " (Warning: the reaction could not be recorded in your history — later turns may not remember it.)";
          event({
            message: reaction ? `reacted ${reaction}` : "reaction cleared",
            type: "external_call",
            level: outcome.recorded ? "success" : "warn",
            data: {
              sourceMessageId: String(message_id),
              emoji: reaction,
              big,
              // False means the badge is on the message but the core's mirror does
              // not know, so the next turn will not remember reacting.
              recorded: outcome.recorded,
        },
      });
      const text =
        (reaction
          ? `Reacted ${reaction} to message #${message_id}. The chat sees it under that ` +
            "message, so there is no need to also say that you reacted."
          : `Removed your reaction from message #${message_id}.`) + note;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { ok: true, message_id, emoji: reaction },
      };
        },
      );
    },
  );
}
