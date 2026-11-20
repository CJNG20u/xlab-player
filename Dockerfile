# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: Builder (compile native better-sqlite3 addon & build Vite frontend)
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Build toolchain required for compiling native Node addons (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies (uses deterministic npm ci when package-lock.json is present)
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy source and build production Vite bundle into dist/
COPY . .
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: Runtime (minimal Debian-slim with ffmpeg, yt-dlp, python3, gosu)
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# Install runtime media tools, TLS certs, curl (for healthcheck & yt-dlp), and gosu
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    gosu \
  && rm -rf /var/lib/apt/lists/*

# Install latest official yt-dlp release (uses python3; works on amd64 and arm64)
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

# Copy manifests, full node_modules (including tsx for `npm start`), server, and built frontend
COPY --from=builder /app/package.json /app/package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist

# Copy and enable container entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /app/data /music

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    MUSIC_DIR=/music \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/auth/status" > /dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
