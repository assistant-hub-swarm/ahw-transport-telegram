# syntax=docker/dockerfile:1

# The Telegram transport for assistant-hub. One process, one HTTP port, no
# database, no migrations, no volumes — it registers with a core at boot and
# reconciles from the desired state the core answers with.
#
#   docker build -t ahw-transport-telegram .
#
# It runs from TypeScript source via tsx: the entrypoint uses top-level await,
# and a compile step would buy nothing here but a second module resolution to
# keep correct.

FROM node:24-alpine AS base
WORKDIR /app

# --- deps ---
# `npm install`, not `npm ci`: the lockfile may be generated on another OS and
# omit Linux-only optional native deps (sharp's musl build, which the SDK pulls
# in for image normalization), which `npm ci`'s strict sync check rejects.
#
# The SDK lives in the org's registry on GitHub Packages. The package is
# public, so no token is needed to pull it — only this scope line.
FROM base AS deps
COPY package.json package-lock.json* ./
RUN printf '@assistant-hub-swarm:registry=https://npm.pkg.github.com\n' > .npmrc \
    && npm install --no-audit --no-fund \
    && rm .npmrc

# --- runner ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3210

# ffmpeg: media ingestion samples video/GIF frames and probes durations with it
# (src/media/ffmpeg.ts — system ffmpeg over a bundled binary). sharp ships its
# own musl libvips binary via npm, so it needs no system package.
RUN apk add --no-cache ffmpeg

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3210

# The core probes /health unauthenticated; answering it is the first thing the
# process does, before it registers.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null 2>&1 || exit 1

CMD ["npx", "tsx", "src/index.ts"]
