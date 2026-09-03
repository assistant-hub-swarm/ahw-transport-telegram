import "dotenv/config";

import { startTransportService } from "@assistant-hub-swarm/transport-sdk";

import { descriptor } from "./descriptor";
import { addressing } from "./inbound/addressing";
import { createNormalizer } from "./inbound/normalize";
import { telegramAdapter } from "./telegram/adapter";
import { registerReactionTool } from "./telegram/reaction-tool";

/**
 * The Telegram transport, whole.
 *
 * Everything that is true of any transport — registering with the core,
 * reconciling pollers from the desired state, deduping shared chats,
 * assembling and publishing events, splitting and performing sends, serving
 * `/health` and the internal API, hosting the delivery tools, shutting down
 * in order — is the SDK's runtime. What is left below is Telegram: the
 * descriptor, the poller adapter, the normalizer and the addressing rule.
 */

await startTransportService({
  descriptor,
  adapter: telegramAdapter,
  normalize: createNormalizer(),
  addressing,
  defaultPort: 3210,
  // The delivery tools are the contract's, but they speak to a model about a
  // specific platform, so the words are this transport's to choose.
  tools: {
    platform: "Telegram",
    // Reacting is Telegram's own tool: the 73 emoji it takes are its own.
    register: registerReactionTool,
  },
});
