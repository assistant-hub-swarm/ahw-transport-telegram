import type { PlatformAdapter, PlatformConnection } from "@assistant-hub-swarm/transport-sdk";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import type { MessageReactionUpdated } from "@grammyjs/types";
import { Bot, HttpError, type Context } from "grammy";

import { createTelegramConnection } from "./connection";

/**
 * The whole of this transport's Telegram knowledge on the INBOUND side: how a
 * poller is started and supervised, and what each update means. Everything it
 * reports goes out through the runtime's hooks in the contract's vocabulary —
 * deduping, event assembly and forwarding happen there, once.
 *
 * Updates handled: `message` / `edited_message` / `message_reaction`
 * (feedback triggers — in groups Telegram only delivers them when the bot is
 * an admin) / `callback_query` (menu presses, answered synchronously with the
 * toast the core words).
 */

/** What one update carries: grammy's message plus the token media needs. */
export interface TgUpdate {
  message: Context["message"] & object;
  /** The receiving connection's token — media downloads are authenticated. */
  botToken: string;
  /** The receiving bot's numeric id, for the structural addressing check. */
  botId: number;
}

/** See the v1 bot-manager for the reasoning behind each bound. */
const FETCH_RETRY_WINDOW_MS = 30_000;
const INIT_TIMEOUT_MS = 20_000;
const STOP_DRAIN_TIMEOUT_MS = 3_000;

class HandshakeTimeoutError extends Error {}

export function telegramErrorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a failure is worth reconnecting from. A network blip is; a token
 * Telegram refuses is not — but the runtime retries a still-desired
 * connection either way, and an operator fixing the token is the only thing
 * that ends the second case. Reporting both as errors keeps that visible on
 * the dashboard instead of hiding a dead poller behind a silent retry.
 */
function isTransientNetworkError(err: unknown): boolean {
  return err instanceof HttpError || err instanceof HandshakeTimeoutError;
}

async function initWithDeadline(bot: Bot): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      bot.init(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HandshakeTimeoutError(
                `Telegram did not answer getMe within ${INIT_TIMEOUT_MS / 1000}s`,
              ),
            ),
          INIT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Emoji set of one reaction list (custom/paid reactions are not thumbs). */
function emojiSet(reactions: { type: string; emoji?: string }[]): Set<string> {
  const set = new Set<string>();
  for (const reaction of reactions) {
    if (reaction.type === "emoji" && reaction.emoji) set.add(reaction.emoji);
  }
  return set;
}

/**
 * The thumb reaction *added* by this update, or null. Reaction removals and
 * other emoji are ignored — feedback is collected only on a fresh thumb.
 * Platform semantics, so the mapping lives with the transport. The thumbs are
 * written as escapes to keep this source ASCII.
 */
export function detectAddedThumb(
  update: Pick<MessageReactionUpdated, "old_reaction" | "new_reaction">,
): "up" | "down" | null {
  const before = emojiSet(update.old_reaction);
  const after = emojiSet(update.new_reaction);
  if (after.has("\u{1F44D}") && !before.has("\u{1F44D}")) return "up";
  if (after.has("\u{1F44E}") && !before.has("\u{1F44E}")) return "down";
  return null;
}

/** The bot token out of a connection's opaque config blob. */
function tokenOf(config: Record<string, unknown>): string {
  const token = config["botToken"];
  return typeof token === "string" ? token.trim() : "";
}

const isDirect = (chatId: string): boolean => !chatId.startsWith("-");

export const telegramAdapter: PlatformAdapter<TgUpdate> = {
  errorText: telegramErrorText,

  async connect(input, hooks): Promise<PlatformConnection> {
    const botToken = tokenOf(input.config);
    if (!botToken) throw new Error("this connection has no bot token");

    const bot = new Bot(botToken);
    let runner: RunnerHandle | null = null;

    // Per-chat sequential, cross-chat concurrent (v1 decision, 2026-07-20).
    bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

    bot.on("message", (ctx) => {
      const message = ctx.message;
      // Bot-authored messages are never forwarded: an assistant's own reply
      // is reported by the send that made it, and reaches the chat's other
      // assistants through the core's cross-feed.
      if (!message.from || message.from.is_bot) return;
      hooks.message({ message, botToken, botId: ctx.me.id });
    });

    bot.on("edited_message", (ctx) => {
      const edited = ctx.editedMessage;
      hooks.edited({
        chatId: String(edited.chat.id),
        direct: isDirect(String(edited.chat.id)),
        sourceMessageId: String(edited.message_id),
        content: edited.text ?? edited.caption ?? "",
        editedAt: new Date((edited.edit_date ?? edited.date) * 1000).toISOString(),
      });
    });

    // Feedback collection: thumb reactions open a menu, presses answer it.
    bot.on("message_reaction", (ctx) => {
      const reaction = ctx.messageReaction;
      // Anonymous (channel-identity) reactions carry no user — nobody to ask.
      const user = reaction.user;
      if (!user || user.is_bot) return;
      const thumb = detectAddedThumb(reaction);
      if (!thumb) return;
      const chatId = String(reaction.chat.id);
      hooks.reaction({
        chatId,
        direct: isDirect(chatId),
        sourceMessageId: String(reaction.message_id),
        reaction: thumb,
        user: {
          userId: String(user.id),
          username: user.username?.toLowerCase() ?? null,
          firstName: user.first_name ?? null,
          lastName: user.last_name ?? null,
        },
      });
    });

    bot.on("callback_query:data", async (ctx) => {
      const query = ctx.callbackQuery;
      const message = query.message;
      // The menu message is needed to act on it; Telegram omits it for
      // messages that are too old or inaccessible. Answer either way, so the
      // button stops spinning.
      if (!message) {
        await ctx.answerCallbackQuery().catch(() => undefined);
        return;
      }
      const chatId = String(message.chat.id);
      const { toast } = await hooks.menuPress({
        chatId,
        direct: isDirect(chatId),
        menuSourceMessageId: String(message.message_id),
        data: query.data,
        user: {
          userId: String(query.from.id),
          username: query.from.username?.toLowerCase() ?? null,
          firstName: query.from.first_name ?? null,
          lastName: query.from.last_name ?? null,
        },
      });
      await ctx.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => undefined);
    });

    bot.catch((err) => {
      console.error(`Telegram bot error (${input.connectionId}):`, err.error);
    });

    const stop = async (): Promise<void> => {
      const handle = runner;
      runner = null;
      if (!handle) return;
      await Promise.race([
        Promise.resolve(handle.stop()).catch((err: unknown) => {
          console.error("Failed to stop Telegram bot:", telegramErrorText(err));
        }),
        new Promise((resolve) => setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS)),
      ]);
    };

    // A refused or unreachable token rejects here; the runtime records it and
    // retries while the core still wants this connection.
    await initWithDeadline(bot);

    const connection = createTelegramConnection({ requireBot: () => bot, stop });

    runner = run(bot, {
      runner: {
        // `message_reaction` is opt-in: it must be listed here or Telegram
        // never delivers it (and in groups the bot must also be an admin).
        fetch: {
          allowed_updates: ["message", "edited_message", "message_reaction", "callback_query"],
        },
        maxRetryTime: FETCH_RETRY_WINDOW_MS,
      },
    });
    const started = runner;
    void started.task()?.catch((err) => {
      // Only the run this closure started may report; a restart already
      // replaced it.
      if (runner !== started) return;
      runner = null;
      hooks.status({
        state: "error",
        error: isTransientNetworkError(err)
          ? `${telegramErrorText(err)} (network)`
          : telegramErrorText(err),
      });
    });

    return connection;
  },
};
