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
# When the SPA runs inside Nextcloud, all its API calls must traverse NC's
# signed-proxy route (/index.php/apps/app_api/proxy/<app_id>/...). Setting
# VITE_API_URL at build time prefixes every `${API_BASE}/auth/...` call so
# the request lands on NC's proxy → connector → SaaS. Vite's --base does
# the same for static asset URLs in index.html.
ARG APP_ID=bee_flow_ai
ENV VITE_API_URL=/index.php/apps/app_api/proxy/${APP_ID}
# Hardcoded absolute paths in JSX (e.g. <img src="/bee-flow-logo.svg" />)
# bypass Vite's --base rewrite. Strip the leading slash before build so they
# resolve relative to the <base href> Vite injects, which routes through
# NC's proxy back to this connector's static handler.
RUN find . -path ./node_modules -prune -o \( -name '*.jsx' -o -name '*.js' -o -name '*.html' \) -print \
    | xargs sed -i \
        -e 's|src="/bee-flow-logo|src="bee-flow-logo|g' \
        -e 's|src="/BeeFlow-logo|src="BeeFlow-logo|g' \
        -e 's|href="/bee-flow-logo|href="bee-flow-logo|g' \
        -e 's|href="/BeeFlow-logo|href="BeeFlow-logo|g' \
        -e "s|'/bee-flow-logo|'bee-flow-logo|g" \
        -e "s|'/BeeFlow-logo|'BeeFlow-logo|g"
RUN npm run build -- --base=/index.php/apps/app_api/proxy/${APP_ID}/

# ── Stage 2: connector runtime ────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

COPY nextcloud-connector/package.json nextcloud-connector/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY nextcloud-connector/src ./src
COPY --from=spa-build /spa/dist ./public

# HaRP integration: install frpc + ca-certificates (for update-ca-certificates,
# which HaRP runs inside the container to install NC's CA bundle). The
# canonical HaRP ExApp pattern runs as root because HaRP writes into
# /usr/local/share/ca-certificates, /etc/ssl/certs, and /certs/frp on first
# start — paths that are root-owned. Container isolation comes from Docker's
# namespace, not from a non-root UID inside the container.
RUN apk add --no-cache frp bash curl ca-certificates
COPY nextcloud-connector/scripts/harp-start.sh /start.sh
RUN chmod +x /start.sh

# AppAPI injects APP_PORT; we default to 8080 for local dev.
EXPOSE 8080

# Healthcheck mirrors the /heartbeat contract Nextcloud uses.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${APP_PORT:-8080}/heartbeat" || exit 1

ENTRYPOINT ["/start.sh"]
CMD ["node", "src/server.js"]
