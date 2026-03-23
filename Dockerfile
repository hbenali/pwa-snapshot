# ─────────────────────────────────────────────
# Stage 1 — install dependencies
# ─────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

RUN apk add --no-cache python3 make g++ vips-dev

COPY package.json package-lock.json* ./
RUN npm ci --include=optional

# ─────────────────────────────────────────────
# Stage 2 — final lean image
# ─────────────────────────────────────────────
FROM node:20-alpine

LABEL org.opencontainers.image.title="pwa-snapshot"
LABEL org.opencontainers.image.description="Dump a PWA manifest + icons into a zip for offline TWA builds"
LABEL org.opencontainers.image.source="https://github.com/your-org/pwa-snapshot"

# vips = sharp runtime; su-exec = privilege-drop helper
RUN apk add --no-cache vips su-exec

# Create non-root user with explicit uid/gid 1001
RUN addgroup -g 1001 -S snapshot \
 && adduser  -u 1001 -S snapshot -G snapshot

WORKDIR /app

# Copy deps and source — owned by root, world-readable (755/644 defaults)
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY entrypoint.sh /entrypoint.sh

# Ensure files are world-readable and entrypoint is executable
RUN chmod -R a+rX /app \
 && chmod +x /entrypoint.sh

# Pre-create /output owned by snapshot so anonymous volume usage works too
RUN mkdir -p /output && chown 1001:1001 /output

# Declare AFTER chown so image layer ownership is correct for anonymous volumes
VOLUME ["/output"]

# ── Environment variable defaults ─────────────────────────────────────────────
ENV PWA_URL=""
ENV OUTPUT_PATH="/output/pwa-snapshot.zip"
ENV ICON_SIZES="48,72,96,144,192,512"
ENV NO_RESIZE="false"
ENV REQUEST_TIMEOUT="15000"
ENV VERBOSE="false"

# Runs as root only to chown /output, then drops to uid 1001 via su-exec
ENTRYPOINT ["/entrypoint.sh"]
CMD ["--help"]