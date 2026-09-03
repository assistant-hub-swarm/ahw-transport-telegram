# ahw-transport-telegram

The **Telegram transport** for [assistant-hub][core]: stateless pollers that
register with a running core, forward every update as transport events, perform
the sends the core asks for, and host Telegram's own actions as MCP tools.

It has no database and no files. Everything it knows at runtime it learns from
the core at boot (registration answers with the desired state) and from the bus
(config changes). Its whole job is translation.

It is also the **worked example** for
[Adding a transport][manual] — every duty in that manual has a file here.

## Run it

Against a core you are already running (its Redis and its internal token):

```bash
npm install              # needs a GitHub Packages token — see below
cp .env.example .env     # REDIS_URL, INTERNAL_API_TOKEN, CORE_API_URL, SELF_URL
npm run dev
```

`.npmrc` points the `@assistant-hub-swarm` scope at GitHub Packages, which
wants a token on every request: a public package there is readable by any
account, but not anonymously. Put one with `read:packages` in your user-level
`~/.npmrc`, so it never reaches this repository:

```
//npm.pkg.github.com/:_authToken=<token>
```

Or as the container, which is how an operator runs it — one service next to the
core's, and no change to the core:

```yaml
  tg:
    image: ghcr.io/assistant-hub-swarm/ahw-transport-telegram:1.0.0
    depends_on:
      redis: { condition: service_healthy }
    environment:
      NODE_ENV: production
      PORT: 3210
      SELF_URL: http://tg:3210          # what the core will call
      REDIS_URL: redis://redis:6379
      CORE_API_URL: http://app:3200
      INTERNAL_API_TOKEN: ${INTERNAL_API_TOKEN:-change-me}
      TZ: ${TZ:-UTC}
    restart: unless-stopped
```

Do not publish its port (the internal API is the core's alone) and do not add
it to the core's `depends_on` — the core depends on no transport, and this one
registers itself whenever it comes up.

## Environment

Bootstrap only. Bot tokens, which assistants to run, personas, tasks — all of
that comes from the core at registration and on every change.

| Variable | Required | Purpose |
| --- | --- | --- |
| `REDIS_URL` | yes | The bus and the update queue |
| `INTERNAL_API_TOKEN` | yes | Must equal the core's |
| `PORT` | no | This service's HTTP port (default 3210) |
| `CORE_API_URL` | no | The core's base URL (default `http://localhost:3200`) |
| `SELF_URL` | no | The base URL it **announces** — what the core calls back. Default `http://localhost:<PORT>` |

## What lives where

| Duty | File |
| --- | --- |
| Boot order, shutdown | `src/index.ts` |
| Registration, desired-state fetch, retry | `src/desired-state.ts` |
| Poller lifecycle, reconcile, supervision, update handlers | `src/bot-manager.ts` |
| Normalizing a message into `transport.message`, media, receivers | `src/inbound.ts`, `src/media/*` |
| Structural addressing verdicts | `src/addressing.ts` |
| Queue publisher, envelope, seen-cache | `src/updates.ts` |
| The one send: split under Telegram's cap, each part sent and reported | `src/send.ts`, `src/split.ts` |
| Bus consumer: reply delivery, typing loops, deliver trace | `src/delivery.ts` |
| Platform sends (HTML render, link whitelist, files by mime, menus, reactions) | `src/outbound.ts`, `src/telegram-html.ts`, `src/telegram.ts` |
| HTTP surface: health, `/internal/*`, `/mcp` | `src/api.ts` |
| MCP tools and the turn binding | `src/mcp.ts`, `src/reactions.ts` |
| Calls into the core (callback toast, mirror lookup) | `src/core-client.ts` |
| Running-connection roster | `src/connections.ts` |

## The contract

Everything that crosses the boundary comes from
[`@assistant-hub-swarm/transport-sdk`][sdk] — the zod schemas, the Redis
helpers, the internal-token guard, `serveMcp`, the trace client, image
normalization. The package lives in the org's registry on GitHub Packages,
which is what the `.npmrc` here points at — see [Run it](#run-it) for the token
that registry asks for.

Two versions matter, and they are different numbers:

- This repository's own version is what its image is tagged with.
- `CONTRACT_MAJOR`, exported by the SDK, is the **wire** major, announced at
  registration. A core that speaks another major refuses this transport by name
  with a reason its dashboard shows — never a silent drop. When that happens,
  bump the SDK and rebuild.

## Development

```bash
npm run typecheck
npm run test        # the seams worth pinning: one event per update, the
                    # addressing verdicts, the split-and-send path
```

Registration, the reconcile and the bus subscriptions all run at boot, so
restart the service after a change before judging a live check — `tsx watch`
will not re-run them.

Releases: bump `version` in `package.json`, push to `main`, and the workflow
verifies, pushes `ghcr.io/assistant-hub-swarm/ahw-transport-telegram` on that
version and tags the commit.

## A note on the comments

This code was extracted from the core repository, where it lived as `apps/tg`.
Comments citing "Phase N", "v1" or a dated decision refer to that history: the
reasoning still holds, and the record is in
[assistant-hub-swarm/ahw-core][core].

[core]: https://github.com/assistant-hub-swarm/ahw-core
[manual]: https://github.com/assistant-hub-swarm/ahw-core/blob/main/docs/development/adding-a-transport.md
[sdk]: https://github.com/assistant-hub-swarm/ahw-core/blob/main/packages/transport-sdk/README.md
