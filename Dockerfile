# syntax=docker/dockerfile:1.7
#
# Bee Flow Nextcloud connector — Docker image.
#
# Multi-stage so the final image only contains:
#   - Node runtime (alpine)
#   - Connector code + production deps
#   - Built React SPA at /app/public
#
# AppAPI fetches this image from the registry declared in appinfo/info.xml
# (<docker-install><image>...</image></docker-install>). The host running it
# is the customer's, not ours.

# ── Stage 1: build the React SPA ──────────────────────────────
# Build context must be the monorepo root so `agent-hub/` is reachable.
# When extracting this connector to its own repo, replace this stage with
# either a git submodule pointing at agent-hub or a pre-built tarball
# downloaded in CI.
FROM node:20-alpine AS spa-build
WORKDIR /spa
COPY agent-hub/package.json agent-hub/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY agent-hub/ ./
# When the SPA runs inside the connector its API base must be empty so the
# code constructs `'' + '/api/...'` (relative URLs that hit the connector's
# proxy). The agent-hub source reads import.meta.env.VITE_API_URL with `||
# ''` fallbacks throughout — leaving this unset works, but we set it
# explicitly to make the build deterministic and self-documenting.
ENV VITE_API_URL=
RUN npm run build

# ── Stage 2: connector runtime ────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Run as a non-root user. AppAPI's HaRP daemon does not require root inside
# the container; running as root would be a needless escalation surface.
RUN addgroup -S beeflow && adduser -S -G beeflow beeflow

COPY nextcloud-connector/package.json nextcloud-connector/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY nextcloud-connector/src ./src
COPY --from=spa-build /spa/dist ./public

USER beeflow

# AppAPI injects APP_PORT; we default to 8080 for local dev.
EXPOSE 8080

# Healthcheck mirrors the /heartbeat contract Nextcloud uses.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${APP_PORT:-8080}/heartbeat" || exit 1

CMD ["node", "src/server.js"]
