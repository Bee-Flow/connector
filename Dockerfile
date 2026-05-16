# syntax=docker/dockerfile:1.7
#
# Bee Flow Nextcloud connector — Docker image.
#
# Self-contained, reviewer-reproducible build: clones the Bee Flow frontend
# (Bee-Flow/hive) anonymously over HTTPS at build time. Anyone (including
# Nextcloud App Store reviewers and CI runners) can rebuild the exact same
# image without any GitHub token, SSH key or private credential.
#
# Build:
#     cd nextcloud-connector            # or any clone of Bee-Flow/connector
#     docker build -t bf-connector:dev .
#
# Pin the frontend to a specific tag/commit/branch (recommended for
# reproducible releases) via HIVE_REF — defaults to `main`:
#     docker build --build-arg HIVE_REF=v1.0.0 -t bf-connector:v1.0.0 .
#
# Override the source repo (e.g. for a fork) via HIVE_REPO:
#     docker build --build-arg HIVE_REPO=tomkooy/bee-flow-fork \
#                  --build-arg HIVE_REF=feature/foo .

# ── Stage 1: build the React SPA from Bee-Flow/hive ──────────────
FROM node:22-alpine AS spa-build

# git is enough — no SSH client, no credentials. Anonymous HTTPS clone
# works once Bee-Flow/hive is public. While the repo is still private
# you can supply a token via BuildKit secret:
#   echo $GITHUB_TOKEN | docker build --secret id=gh_token,src=- ...
# The token is read inside the RUN and never lands in the image layers.
RUN apk add --no-cache git

ARG HIVE_REPO=Bee-Flow/hive
ARG HIVE_REF=main

WORKDIR /spa
RUN --mount=type=secret,id=gh_token,required=false \
    if [ -s /run/secrets/gh_token ]; then \
        TOKEN=$(cat /run/secrets/gh_token); \
        git clone --depth=1 --branch=${HIVE_REF} \
            "https://x-access-token:${TOKEN}@github.com/${HIVE_REPO}.git" . ; \
    else \
        git clone --depth=1 --branch=${HIVE_REF} \
            "https://github.com/${HIVE_REPO}.git" . ; \
    fi \
    && rm -rf .git

RUN npm ci --no-audit --no-fund

# When the SPA runs inside Nextcloud, all its API calls must traverse NC's
# signed-proxy route (/index.php/apps/app_api/proxy/<app_id>/...). Setting
# VITE_API_URL at build time prefixes every `${API_BASE}/auth/...` call so
# the request lands on NC's proxy → connector → SaaS. Vite's --base does
# the same for static asset URLs in index.html.
ARG APP_ID=bee_flow
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
FROM node:22-alpine AS runtime
WORKDIR /app

# Connector source is the build context. Paths are relative to the connector
# repo root (post-split layout): no `nextcloud-connector/` prefix needed.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY appinfo ./appinfo
COPY --from=spa-build /spa/dist ./public

# HaRP integration: install frpc + ca-certificates (for update-ca-certificates,
# which HaRP runs inside the container to install NC's CA bundle). The
# canonical HaRP ExApp pattern runs as root because HaRP writes into
# /usr/local/share/ca-certificates, /etc/ssl/certs, and /certs/frp on first
# start — paths that are root-owned. Container isolation comes from Docker's
# namespace, not from a non-root UID inside the container.
RUN apk add --no-cache frp bash curl ca-certificates
COPY scripts/harp-start.sh /start.sh
RUN chmod +x /start.sh

# AppAPI injects APP_PORT; we default to 8080 for local dev.
EXPOSE 8080

# Healthcheck mirrors the /heartbeat contract Nextcloud uses.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${APP_PORT:-8080}/heartbeat" || exit 1

ENTRYPOINT ["/start.sh"]
CMD ["node", "src/server.js"]
