import type {
  BotIdentity,
  MenuGrid,
  PlatformConnection,
  SendOptions,
  SentMessage,
} from "@assistant-hub-swarm/transport-sdk";
import type { ReactionTypeEmoji } from "@grammyjs/types";
import { GrammyError, InputFile, type Bot } from "grammy";

import { renderTelegramHtml } from "./html";
import { messageLinkBase, telegramFileKind, telegramId, type TelegramFileKind } from "./ids";

/**
 * Everything this transport can ASK Telegram to do, behind the runtime's
 * platform interface. This is the ONE place model text meets Telegram:
 * Markdown is rendered to Telegram HTML, whitelisted `#<id>` citations become
 * tappable message links, and a rejected render falls back to the plain text
 * — the raw model text is always deliverable, formatting is best-effort.
 *
 * Ids cross the contract as strings because not every platform's are numbers;
 * Telegram's are, so they are converted here, at the boundary that owns it.
 */

function toInlineKeyboard(keyboard: MenuGrid) {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
    ),
  };
}

/**
 * Telegram rejected the rendered HTML entities (a converter blind spot, e.g.
 * a nesting Telegram forbids). Only this failure falls back to a plain-text
 * send — anything else (network, chat gone) must surface to the caller, and
 * a blind retry could double-deliver.
 */
function isEntityParseError(err: unknown): boolean {
  return (
    err instanceof GrammyError && err.description.toLowerCase().includes("can't parse entities")
  );
}

/**
 * What Telegram actually delivered. The reply target is read back off the
 * sent message rather than echoed from the request: `allow_sending_without_reply`
 * drops a target Telegram will not attach SILENTLY, and the mirror (and the
 * trace) must record what is in the chat, not what was asked for.
 */
function delivered(sent: {
  message_id: number;
  reply_to_message?: { message_id: number };
}): SentMessage {
  return {
    sourceMessageId: String(sent.message_id),
    replyToSourceMessageId:
      sent.reply_to_message?.message_id != null ? String(sent.reply_to_message.message_id) : null,
  };
}

/** Reply/thread params shared by the send methods. */
function sendParams(opts?: SendOptions) {
  const replyTo = telegramId(opts?.replyToSourceMessageId);
  const threadId = telegramId(opts?.threadId);
  return {
    ...(replyTo != null
      ? {
          reply_parameters: {
            message_id: replyTo,
            // Losing the answer to save the pointer is the wrong trade — a
            // stale reply target must not cost the user their message (v1).
            allow_sending_without_reply: true,
          },
        }
      : {}),
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    ...(opts?.silent ? { disable_notification: true } : {}),
  };
}

export function createTelegramConnection(input: {
  /** The live bot, or a throw explaining why there is none. */
  requireBot: () => Bot;
  /** Called on shutdown; the adapter owns the runner's lifetime. */
  stop: () => Promise<void>;
}): PlatformConnection {
  const { requireBot } = input;

  return {
    identity(): BotIdentity | null {
      const info = requireBot().botInfo;
      return info
        ? {
            id: String(info.id),
            identity: { botUsername: info.username, botDisplayName: info.first_name },
          }
        : null;
    },

    async sendMessage(chatId, text, opts) {
      const bot = requireBot();
      const params = sendParams(opts);
      const messageLinks = {
        baseUrl: messageLinkBase(chatId),
        ids: (opts?.linkableSourceMessageIds ?? [])
          .map((id) => telegramId(id))
          .filter((id): id is number => id != null),
      };
      try {
        return delivered(
          await bot.api.sendMessage(chatId, renderTelegramHtml(text, messageLinks), {
            ...params,
            parse_mode: "HTML",
          }),
        );
      } catch (err) {
        if (!isEntityParseError(err)) throw err;
        return delivered(await bot.api.sendMessage(chatId, text, params));
      }
    },

    /**
     * A Telegram voice bubble. `base64` is OGG/Opus — the one encoding
     * Telegram renders as a voice message (anything else shows as a music
     * file), which is why a refusal here is worth falling back from.
     */
    async sendVoice(chatId, voice, opts) {
      const sent = await requireBot().api.sendVoice(
        chatId,
        new InputFile(Buffer.from(voice.base64, "base64"), voice.filename),
        sendParams(opts),
      );
      return { sourceMessageId: String(sent.message_id), asVoice: true };
    },

    async sendPhoto(chatId, image, opts) {
      const sent = await requireBot().api.sendPhoto(
        chatId,
        new InputFile(Buffer.from(image.base64, "base64"), image.filename),
        sendParams(opts),
      );
      // Telegram returns the photo in several rendered sizes, largest last.
      // The largest is the one worth describing and re-reading later,
      // matching how incoming photos are picked up (`detectMessageMedia`).
      // The core stores a generated image as ordinary media keyed by this id.
      const largest = sent.photo?.[sent.photo.length - 1];
      return { sourceMessageId: String(sent.message_id), mediaId: largest?.file_id ?? null };
    },

    /**
     * Pick the send method by content type so a video or track plays straight
     * in Telegram instead of arriving as a bare attachment. A container
     * Telegram refuses as its playable kind is retried as a document — the
     * message was not delivered, so the retry cannot double-send.
     */
    async sendFile(chatId, file, opts) {
      const bot = requireBot();
      const threadId = telegramId(opts?.threadId);
      const base = threadId != null ? { message_thread_id: threadId } : {};
      // A fresh InputFile per attempt — grammy consumes the wrapper on send.
      const media = () => new InputFile(Buffer.from(file.base64, "base64"), file.filename);
      const sendAs: Record<
        TelegramFileKind,
        (extra: { caption?: string; parse_mode?: "HTML" }) => Promise<{ message_id: number }>
      > = {
        video: (extra) =>
          bot.api.sendVideo(chatId, media(), { ...base, supports_streaming: true, ...extra }),
        audio: (extra) => bot.api.sendAudio(chatId, media(), { ...base, ...extra }),
        document: (extra) => bot.api.sendDocument(chatId, media(), { ...base, ...extra }),
      };
      const caption = opts?.caption ?? undefined;
      const sendWithCaption = async (kind: TelegramFileKind) => {
        if (!caption) return sendAs[kind]({});
        try {
          return await sendAs[kind]({ caption: renderTelegramHtml(caption), parse_mode: "HTML" });
        } catch (err) {
          if (!isEntityParseError(err)) throw err;
          return sendAs[kind]({ caption });
        }
      };
      const kind = telegramFileKind(file.mime);
      try {
        return { sourceMessageId: String((await sendWithCaption(kind)).message_id) };
      } catch (err) {
        // Anything non-Grammy (network, chat gone) must surface.
        if (kind === "document" || !(err instanceof GrammyError)) throw err;
        return { sourceMessageId: String((await sendWithCaption("document")).message_id) };
      }
    },

    /** Telegram refuses deletes older than 48h; the caller treats that as cosmetic. */
    async deleteMessage(chatId, sourceMessageId) {
      const messageId = telegramId(sourceMessageId);
      if (messageId == null) throw new Error(`${sourceMessageId} is not a Telegram message id`);
      await requireBot().api.deleteMessage(chatId, messageId);
    },

    async sendMenu(chatId, menu) {
      const replyTo = telegramId(menu.replyToSourceMessageId);
      if (replyTo == null) {
        throw new Error(`${menu.replyToSourceMessageId} is not a Telegram message id`);
      }
      const sent = await requireBot().api.sendMessage(chatId, menu.text, {
        reply_parameters: { message_id: replyTo },
        reply_markup: toInlineKeyboard(menu.keyboard),
      });
      return { sourceMessageId: String(sent.message_id) };
    },

    async editMenu(chatId, sourceMessageId, menu) {
      const messageId = telegramId(sourceMessageId);
      if (messageId == null) throw new Error(`${sourceMessageId} is not a Telegram message id`);
      await requireBot().api.editMessageText(chatId, messageId, menu.text, {
        // Editing without `reply_markup` drops the inline keyboard.
        ...(menu.keyboard ? { reply_markup: toInlineKeyboard(menu.keyboard) } : {}),
      });
    },

    /**
     * Set (or, with null, clear) the bot's one reaction badge. The
     * canonical-emoji check is the tool's job (it words the refusal for the
     * model); Telegram enforces the set regardless, and a refusal throws here
     * for the caller to relay.
     */
    async setReaction(chatId, sourceMessageId, emoji, options) {
      const messageId = telegramId(sourceMessageId);
      if (messageId == null) throw new Error(`${sourceMessageId} is not a Telegram message id`);
      const reaction = emoji ? [{ type: "emoji", emoji } as ReactionTypeEmoji] : [];
      await requireBot().api.setMessageReaction(chatId, messageId, reaction, {
        is_big: options?.["big"] === true,
      });
    },

    sendTyping(chatId, threadId) {
      const id = telegramId(threadId);
      void requireBot()
        .api.sendChatAction(chatId, "typing", id != null ? { message_thread_id: id } : {})
        .catch(() => undefined);
    },

    /**
     * Telegram encodes the chat kind in the id itself: only a private chat
     * has a positive one. No round trip, and no way for a group and a DM to
     * share a dedupe stream.
     */
    async isDirectChat(chatId) {
      return !chatId.startsWith("-");
    },

    close: input.stop,
  };
}
