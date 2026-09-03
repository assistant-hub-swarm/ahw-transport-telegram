import type { TransportDescriptor } from "@assistant-hub-swarm/transport-sdk";

/**
 * Who this transport is, as the core learns it at registration: the id every
 * scoped ref is prefixed with, the name the dashboard shows, the config
 * fields the assistant editor renders, and the two platform limits the
 * runtime needs to send correctly.
 *
 * Nothing else about Telegram reaches the core. Adding a field here is how
 * this transport asks the dashboard for a new setting — no core change.
 */

/** The longest a Telegram message may be. Longer text is split, never cut. */
export const MAX_MESSAGE_LENGTH = 4096;

/** Telegram's "typing…" action lasts about five seconds unless refreshed. */
const TYPING_REFRESH_MS = 4_000;

export const descriptor: TransportDescriptor = {
  id: "tg",
  name: "Telegram",
  mcpPath: "/mcp",
  maxMessageLength: MAX_MESSAGE_LENGTH,
  typingRefreshMs: TYPING_REFRESH_MS,
  connectionConfigSchema: [
    {
      key: "botToken",
      label: "Bot token",
      kind: "secret",
      required: true,
      help:
        "From @BotFather. Stored by the core; never shown again. " +
        "The bot starts polling as soon as it connects.",
    },
  ],
  // Owner rights moved to the core's accounts + identity links (Phase 8):
  // this transport has no config of its own any more.
  transportConfigSchema: [],
};
