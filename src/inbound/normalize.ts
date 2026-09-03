import type { InboundMessage, Normalizer } from "@assistant-hub-swarm/transport-sdk";
import type { Message } from "@grammyjs/types";

import type { TgUpdate } from "../telegram/adapter";
import { detectMessageMedia } from "../telegram/media/detect";
import { loadMessageMedia, type FileDownloader } from "../telegram/media/ingest";

/**
 * One Telegram update, read into the contract's vocabulary — media downloaded
 * with the receiving connection's token and normalized to bounded JPEG on the
 * way. That is the whole job: what a `message` update MEANS is Telegram's
 * business, and everything that happens to the result afterwards — deduping,
 * the receivers list, the envelope, the queue — belongs to the runtime and is
 * the same everywhere.
 */

/** `download` is a test seam; the default hits the Telegram file API. */
export function createNormalizer(deps: { download?: FileDownloader } = {}): Normalizer<TgUpdate> {
  return async ({ message, botToken }): Promise<InboundMessage | null> => {
    const from = message.from;
    const chat = message.chat;
    const text = message.text ?? message.caption ?? "";
    const hasMedia = detectMessageMedia(message) !== null;
    if (!from || (!text.trim() && !hasMedia)) return null;

    const direct = chat.type === "private";
    const replyTo = message.reply_to_message;
    const replyAuthor = replyTo?.from ?? null;

    return {
      chatId: String(chat.id),
      direct,
      chatTitle: chat.title ?? null,
      chatType: direct ? null : chat.type,
      sourceMessageId: String(message.message_id),
      content: text,
      sentAt: new Date(message.date * 1000).toISOString(),
      threadId: message.message_thread_id != null ? String(message.message_thread_id) : null,
      // Owner rights are the core's judgement (Phase 8) — this only reports
      // who spoke.
      sender: {
        userId: String(from.id),
        username: from.username?.toLowerCase() ?? null,
        firstName: from.first_name ?? null,
        lastName: from.last_name ?? null,
      },
      replyTo: replyTo
        ? {
            sourceMessageId: String(replyTo.message_id),
            hasMedia: detectMessageMedia(replyTo as Message) !== null,
            text: replyTo.text ?? replyTo.caption ?? null,
            quote: message.quote?.text ?? null,
            author:
              replyAuthor && !replyAuthor.is_bot
                ? {
                    userId: String(replyAuthor.id),
                    username: replyAuthor.username?.toLowerCase() ?? null,
                    firstName: replyAuthor.first_name ?? null,
                    lastName: replyAuthor.last_name ?? null,
                  }
                : null,
            // The runtime resolves this to an assistant when it is one of ours.
            authorPlatformId: replyAuthor?.is_bot ? String(replyAuthor.id) : null,
          }
        : null,
      media: hasMedia
        ? await loadMessageMedia({ token: botToken, message, download: deps.download }).catch(
            () => null,
          )
        : null,
    };
  };
}
