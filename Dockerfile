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

# ── Stage 1a: fetch the hive source at the pinned ref ────────────
FROM node:22-alpine AS hive-src

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
FROM node:22-alpine AS spa-build
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

# HaRP integration: install the runtime deps. ca-certificates is needed for
# update-ca-certificates (harp-start.sh folds any CA HaRP drops into the trust
# store on first start); bash for the entrypoint; curl for the healthcheck
# (busybox wget can't probe a unix socket, which HaRP mode requires). The
# canonical HaRP ExApp pattern runs as root because HaRP writes into
# /usr/local/share/ca-certificates, /etc/ssl/certs, and /certs/frp on first
# start — paths that are root-owned. Container isolation comes from Docker's
# namespace, not from a non-root UID inside the container.
RUN apk add --no-cache bash curl ca-certificates tar

# frpc, pinned. We do NOT use Alpine's `frp` package — its version floats and
# FRP requires a client compatible with HaRP's bundled frps; a mismatch fails
# the tunnel handshake silently and the ExApp becomes unreachable. Pin to the
# version the Nextcloud HaRP guide ships (0.61.1). 0.61.1 is an immutable
# tagged GitHub asset, so the reproducible-build promise above is preserved.
# Bump FRP_VERSION in lockstep when HaRP bumps its frps. TARGETARCH is provided
# by BuildKit (both CI workflows build amd64 + arm64 natively).
ARG TARGETARCH
ARG FRP_VERSION=0.61.1
RUN set -eux; \
    case "$TARGETARCH" in \
        amd64) frp_arch=amd64 ;; \
        arm64) frp_arch=arm64 ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${frp_arch}.tar.gz" -o /tmp/frp.tgz; \
    tar -xzf /tmp/frp.tgz -C /tmp; \
    install -m 0755 "/tmp/frp_${FRP_VERSION}_linux_${frp_arch}/frpc" /usr/local/bin/frpc; \
    rm -rf /tmp/frp.tgz "/tmp/frp_${FRP_VERSION}_linux_${frp_arch}"; \
    frpc --version

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
