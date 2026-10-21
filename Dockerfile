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
#     docker build --build-arg HIVE_REPO=<github-user>/bee-flow-fork \
#                  --build-arg HIVE_REF=feature/foo .

# ── Stage 1a: fetch the hive source at the pinned ref ────────────
FROM node:22.23.4-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc AS hive-src

# git is enough — no SSH client, no credentials. Anonymous HTTPS fetch
# works once Bee-Flow/hive is public. While the repo is still private
# you can supply a token via BuildKit secret:
#   echo $GITHUB_TOKEN | docker build --secret id=gh_token,src=- ...
# The token is read inside the RUN and never lands in the image layers.
RUN apk add --no-cache git

ARG HIVE_REPO=Bee-Flow/hive
ARG HIVE_REF=main

WORKDIR /spa
# init+fetch+checkout (not `git clone --branch`): --branch only accepts a
# branch or tag, but releases pin HIVE_REF to a commit SHA. GitHub's anonymous
# HTTPS transport allows fetching an arbitrary SHA, and this form works equally
# for a branch (the `main` default) or a tag.
RUN --mount=type=secret,id=gh_token,required=false \
    if [ -s /run/secrets/gh_token ]; then \
        TOKEN=$(cat /run/secrets/gh_token); \
        REMOTE="https://x-access-token:${TOKEN}@github.com/${HIVE_REPO}.git"; \
    else \
        REMOTE="https://github.com/${HIVE_REPO}.git"; \
    fi; \
    git init -q . \
    && git remote add origin "$REMOTE" \
    && git fetch --depth=1 origin "${HIVE_REF}" \
    && git checkout -q FETCH_HEAD \
    && rm -rf .git

# ── Stage 1b: build the React SPA from the fetched source ────────
FROM node:22.23.4-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc AS spa-build
WORKDIR /spa

# Lockfile-only layer first: `npm ci` re-runs ONLY when hive's dependencies
# change, not on every hive source commit. Releases pin HIVE_REF to a per-release
# SHA, so the source layer below busts whenever hive `main` moves — but this
# (slow) dependency layer stays cached as long as the lockfiles are identical.
COPY --from=hive-src /spa/package.json /spa/package-lock.json ./
RUN npm ci --no-audit --no-fund

# Bring in the rest of the source (cheap layer; busts on every hive commit).
COPY --from=hive-src /spa/ ./

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

# Rebuild the HaRP-compatible 0.61.1 client with patched dependencies.
# The source commit and module versions are fixed; the wire protocol stays 0.61.1.
FROM golang:1.27.3-alpine@sha256:f2c872bcee949b7be9c490efd02b48a8a2fbf947cdf533f1c58525ec9d8170fd AS frp-build
RUN apk add --no-cache git
WORKDIR /src
RUN git init -q . \
    && git remote add origin https://github.com/fatedier/frp.git \
    && git fetch --depth=1 origin 2a7aa69890690229f9c0e67e1d360ee094a56c84 \
    && git checkout -q FETCH_HEAD \
    && go get github.com/go-jose/go-jose/v4@v4.1.4 github.com/quic-go/quic-go@v0.49.1 \
        golang.org/x/crypto@v0.55.0 golang.org/x/net@v0.57.0 golang.org/x/oauth2@v0.27.0 \
    && go mod tidy \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/frpc ./cmd/frpc

# ── Stage 2: connector runtime ────────────────────────────────
FROM node:22.23.4-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc AS runtime
RUN apk upgrade --no-cache
WORKDIR /app

# Connector source is the build context. Paths are relative to the connector
# repo root (post-split layout): no `nextcloud-connector/` prefix needed.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund \
    # lucide-static ships 48 MB, of which we need only `icons/` (8 MB) — the
    # per-icon SVGs served as Nextcloud top-menu icons for published Studio
    # apps (src/studioAppMenus.js). The webfonts, the bundled dist/ and the
    # sprite are dead weight in this image.
    && rm -rf node_modules/lucide-static/font \
              node_modules/lucide-static/dist \
              node_modules/lucide-static/sprite.svg \
              node_modules/lucide-static/icon-nodes.json \
              node_modules/lucide-static/tags.json \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn* \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY src ./src
COPY appinfo ./appinfo
COPY --from=spa-build /spa/dist ./public

# HaRP integration: install the runtime deps. ca-certificates is needed for
# update-ca-certificates (harp-start.sh folds any CA HaRP drops into the trust
# store on first start); bash for the entrypoint; curl for the healthcheck
# (busybox wget can't probe a unix socket, which HaRP mode requires). The
# canonical HaRP ExApp pattern runs as root because HaRP writes into
# /usr/local/share/ca-certificates, /etc/ssl/certs, and /certs/frp on first
# start — paths that are root-owned. Container isolation comes from Docker's
# namespace, not from a non-root UID inside the container.
RUN apk add --no-cache bash curl ca-certificates tar

# The patched binary keeps the protocol expected by Nextcloud HaRP.
COPY --from=frp-build /out/frpc /usr/local/bin/frpc
RUN frpc --version

COPY scripts/harp-start.sh /start.sh
RUN chmod +x /start.sh

# AppAPI injects APP_PORT; we default to 8080 for local dev.
EXPOSE 8080

# Healthcheck mirrors the /heartbeat contract Nextcloud uses. Under HaRP the
# app binds ONLY the unix socket /tmp/exapp.sock (no TCP listener), so probe
# the socket there; otherwise probe the TCP port. curl (installed above)
# supports --unix-socket; busybox wget does not. Shell form so the `if` runs
# via /bin/sh -c with $HP_SHARED_KEY (injected by HaRP) visible at runtime.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD if [ -n "$HP_SHARED_KEY" ]; then \
            curl -fsS --unix-socket /tmp/exapp.sock http://localhost/heartbeat || exit 1; \
        else \
            curl -fsS "http://127.0.0.1:${APP_PORT:-8080}/heartbeat" || exit 1; \
        fi

ENTRYPOINT ["/start.sh"]
CMD ["node", "src/server.js"]
