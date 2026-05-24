#!/usr/bin/env bash
# Local sandbox bringing up the full Bee Flow stack on one machine:
#   - Postgres 16              (data store for the Bee Flow server)
#   - RustFS                   (S3-compatible blob storage)
#   - Bee Flow server          (ghcr.io/bee-flow/beeflow:dev)
#   - Nextcloud                (Docker Hub)
#   - Bee Flow connector       (this repo's image)
#
# All five containers share the bee-flow-net Docker network and can
# resolve each other by container name. Set WITH_SERVER=0 to skip the
# Postgres + RustFS + server containers and point the connector at a
# remote server / SaaS instead (override API_BASE_URL).
#
# Subcommands: up | down | clean | logs | status
#   `up` accepts `--cloud` to point the connector at https://server.beeflow.nl
#   instead of the local SaaS, and auto-spawn a public tunnel (cloudflared by
#   default, ngrok if NGROK_AUTHTOKEN is set) so the cloud can callback-verify
#   your NC. One-command sandbox-against-cloud:
#     ./local-sandbox.sh --cloud
#
# Env overrides:
#   NC_VERSION=stable  NC_PORT=8080  APP_ID=bee_flow
#                      (info.xml supports 31–34; "stable" tracks Docker Hub
#                       latest-stable. Pin to NC_VERSION=32 / 32.0.5 / etc.
#                       for reproducibility.)
#   IMAGE=bee-flow-connector:dev          # local build (default)
#   IMAGE=ghcr.io/bee-flow/connector:dev  # pull pre-built (no local build)
#   TENANT_KEY=auto                       # default: connector handshakes with
#                                          # the SaaS, which provisions an org
#                                          # and returns a real tenant key.
#                                          # A literal value here SKIPS that
#                                          # handshake — the SaaS won't have a
#                                          # matching `connector_tenant_key_*`
#                                          # row and every JWT will 401.
#   API_BASE_URL=                         # default: http://bee-flow-server:3001
#                                          override to e.g. https://server.beeflow.nl
#                                          to skip running the server locally
#   WITH_SERVER=1                          # 0 to skip Postgres + RustFS + server
#   SERVER_IMAGE=ghcr.io/bee-flow/beeflow:dev
#   SERVER_PORT=3001                       # host-published port for the server
#   PG_PASSWORD=beeflow-dev
#   RUSTFS_IMAGE=rustfs/rustfs:latest
#   RUSTFS_ACCESS_KEY=rustfsadmin
#   RUSTFS_SECRET_KEY=rustfsadmin
#
#   NGROK_AUTHTOKEN=...                    # if set, expose the local NC at a
#                                          # public https://*.ngrok-free.app URL
#                                          # so server.beeflow.nl's bootstrap
#                                          # callback can verify NC ownership.
#                                          # Required to use Cloud mode from
#                                          # this Docker sandbox; without it,
#                                          # only Self-hosted mode works.
#                                          # Get a free token (no card needed) at
#                                          # https://dashboard.ngrok.com/get-started/your-authtoken
#                                          # and run:
#                                          #   NGROK_AUTHTOKEN=... ./local-sandbox.sh

set -euo pipefail

NC_VERSION="${NC_VERSION:-stable}"
NC_PORT="${NC_PORT:-8080}"
APP_ID="${APP_ID:-bee_flow}"
IMAGE="${IMAGE:-bee-flow-connector:dev}"
TENANT_KEY="${TENANT_KEY:-auto}"

# Bee Flow server stack
WITH_SERVER="${WITH_SERVER:-1}"
SERVER_IMAGE="${SERVER_IMAGE:-ghcr.io/bee-flow/beeflow:dev}"
SERVER_PORT="${SERVER_PORT:-3001}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
PG_PASSWORD="${PG_PASSWORD:-beeflow-dev}"
RUSTFS_IMAGE="${RUSTFS_IMAGE:-rustfs/rustfs:latest}"
RUSTFS_ACCESS_KEY="${RUSTFS_ACCESS_KEY:-rustfsadmin}"
RUSTFS_SECRET_KEY="${RUSTFS_SECRET_KEY:-rustfsadmin}"

# Public-tunnel for Cloud mode (server.beeflow.nl needs to call NC back to
# verify ownership). Two implementations: cloudflared (default, no signup)
# and ngrok (opt-in via NGROK_AUTHTOKEN, named URL, slightly more reliable).
# A tunnel is started automatically whenever cmd_up runs in --cloud mode.
NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-}"
NGROK_IMAGE="${NGROK_IMAGE:-ngrok/ngrok:latest}"
NGROK_NAME="bee-flow-ngrok"
CFD_IMAGE="${CFD_IMAGE:-cloudflare/cloudflared:latest}"
CFD_NAME="bee-flow-cloudflared"

# --cloud flag — set later by cmd_up arg parsing. When true, the script:
#   1. skips the local Postgres+RustFS+server stack (WITH_SERVER=0)
#   2. points the connector at https://server.beeflow.nl
#   3. spawns a public tunnel for the bootstrap callback
CLOUD_MODE=0

# Container names — used as DNS aliases on the shared network.
NC_NAME="bee-flow-nc-sandbox"
CONN_NAME="bee-flow-connector-instance"
SRV_NAME="bee-flow-server"
PG_NAME="bee-flow-postgres"
RUSTFS_NAME="bee-flow-rustfs"
DAEMON="manual_dev"
NETWORK="bee-flow-net"     # shared bridge network — NC ↔ connector ↔ server
                           # all resolve each other by container name.

# Default the connector's SaaS target to the server we're starting locally.
# If WITH_SERVER=0, fall back to the public hosted SaaS (override per env).
if [ "$WITH_SERVER" = "1" ]; then
    API_BASE_URL="${API_BASE_URL:-http://$SRV_NAME:$SERVER_PORT}"
else
    API_BASE_URL="${API_BASE_URL:-https://server.beeflow.nl}"
fi

# Connector dir = parent of this script. Works in both layouts:
#   monorepo:   <monorepo>/nextcloud-connector/scripts/local-sandbox.sh
#   standalone: <connector-clone>/scripts/local-sandbox.sh
CONNECTOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB=/var/www/html/data/owncloud.db

g() { printf '\033[1;32m%s\033[0m\n' "$*"; }
b() { printf '\033[1;34m%s\033[0m\n' "$*"; }
r() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }

nc_occ() { docker exec -u www-data "$NC_NAME" php occ "$@"; }
nc_sql() { docker exec "$NC_NAME" sqlite3 "$DB" "$1"; }

# ─── stack helpers (Postgres + RustFS + server) ──────────────────────────────

start_postgres() {
    if docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
        b "[Postgres] $PG_NAME already running"
    elif docker ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then
        b "[Postgres] starting existing $PG_NAME"
        docker start "$PG_NAME" >/dev/null
    else
        b "[Postgres] launching $PG_IMAGE"
        docker run -d --name "$PG_NAME" \
            --network "$NETWORK" \
            -e POSTGRES_DB=beeflow \
            -e POSTGRES_USER=beeflow \
            -e POSTGRES_PASSWORD="$PG_PASSWORD" \
            "$PG_IMAGE" >/dev/null
    fi
    b "[Postgres] waiting for ready"
    for _ in $(seq 1 30); do
        if docker exec "$PG_NAME" pg_isready -U beeflow >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    r "Postgres failed to become ready in 30s"
    return 1
}

start_rustfs() {
    if docker ps --format '{{.Names}}' | grep -qx "$RUSTFS_NAME"; then
        b "[RustFS] $RUSTFS_NAME already running"
    elif docker ps -a --format '{{.Names}}' | grep -qx "$RUSTFS_NAME"; then
        b "[RustFS] starting existing $RUSTFS_NAME"
        docker start "$RUSTFS_NAME" >/dev/null
    else
        b "[RustFS] launching $RUSTFS_IMAGE"
        docker run -d --name "$RUSTFS_NAME" \
            --network "$NETWORK" \
            -e RUSTFS_ACCESS_KEY="$RUSTFS_ACCESS_KEY" \
            -e RUSTFS_SECRET_KEY="$RUSTFS_SECRET_KEY" \
            -e RUSTFS_VOLUMES=/data \
            "$RUSTFS_IMAGE" >/dev/null
    fi
    b "[RustFS] waiting for ready"
    for _ in $(seq 1 20); do
        # RustFS / S3 endpoints answer on / with a 200 or auth-challenge — both
        # mean the server is alive enough to serve PUTs.
        if docker exec "$RUSTFS_NAME" sh -c 'wget -q -O - --timeout=2 http://localhost:9000/ >/dev/null 2>&1 || curl -sf -m 2 http://localhost:9000/ >/dev/null 2>&1' ; then
            return 0
        fi
        sleep 0.5
    done
    # Don't fail the whole sandbox on RustFS readiness — server falls back to
    # local-disk if RustFS is unreachable. Just warn and continue.
    echo "  ${YLW:-}note: RustFS readiness check timed out; server will use local-disk fallback if needed${OFF:-}"
    return 0
}

# Tunnel the local NC at $NC_NAME:80 to a public https URL so that the cloud
# Bee Flow SaaS (server.beeflow.nl) can call back to verify NC ownership
# during bootstrap. Returns the public URL on stdout (e.g.
# `https://9f8e7d.ngrok-free.app`). No-op when NGROK_AUTHTOKEN is unset.
start_ngrok() {
    [ -z "$NGROK_AUTHTOKEN" ] && return 0

    if ! docker ps --format '{{.Names}}' | grep -qx "$NGROK_NAME"; then
        docker rm -f "$NGROK_NAME" >/dev/null 2>&1 || true
        b "[ngrok] launching $NGROK_IMAGE → $NC_NAME:80" >&2
        # `--log=stdout` is critical: without it ngrok writes to a file we
        # can't tail, and we have no way to know it's ready. Port 4040 is
        # the local API for tunnel introspection (only exposed on the
        # internal docker network — not published).
        docker run -d --name "$NGROK_NAME" \
            --network "$NETWORK" \
            -e NGROK_AUTHTOKEN="$NGROK_AUTHTOKEN" \
            "$NGROK_IMAGE" \
            http "$NC_NAME:80" --log=stdout >/dev/null
    fi

    b "[ngrok] waiting for public URL" >&2
    for _ in $(seq 1 30); do
        # Tunnels API returns JSON; jq isn't installed in the alpine ngrok
        # image, so grep+sed the URL out. Match https only — the http and
        # https tunnels are both listed; we want the https one for callback
        # to actually succeed against NC.
        url=$(docker exec "$NGROK_NAME" wget -qO- http://localhost:4040/api/tunnels 2>/dev/null \
            | grep -oE '"public_url":"https://[^"]+"' | head -1 | sed 's/.*"\(https:[^"]*\)"/\1/')
        if [ -n "$url" ]; then
            echo "$url"
            return 0
        fi
        sleep 1
    done
    r "ngrok did not produce a public URL within 30s — check 'docker logs $NGROK_NAME'"
    return 1
}

# cloudflared quick-tunnel — same purpose as start_ngrok but no signup, no
# authtoken. The tunnel URL changes on every restart (e.g.
# https://random-words.trycloudflare.com), which is fine for a sandbox: each
# fresh `up` re-bootstraps with the new URL anyway.
start_cloudflared() {
    if ! docker ps --format '{{.Names}}' | grep -qx "$CFD_NAME"; then
        docker rm -f "$CFD_NAME" >/dev/null 2>&1 || true
        b "[cloudflared] launching → $NC_NAME:80" >&2
        # `--no-autoupdate` keeps the container deterministic; `--url`
        # creates a quick-tunnel (anonymous, no Cloudflare account).
        docker run -d --name "$CFD_NAME" \
            --network "$NETWORK" \
            "$CFD_IMAGE" \
            tunnel --no-autoupdate --url "http://$NC_NAME:80" >/dev/null
    fi

    b "[cloudflared] waiting for public URL" >&2
    for _ in $(seq 1 30); do
        # cloudflared logs the URL within ~5s, e.g.:
        #   "Your quick Tunnel has been created!  https://<words>.trycloudflare.com"
        url=$(docker logs "$CFD_NAME" 2>&1 \
            | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)
        if [ -n "$url" ]; then
            echo "$url"
            return 0
        fi
        sleep 1
    done
    r "cloudflared did not produce a public URL within 30s — check 'docker logs $CFD_NAME'"
    return 1
}

# Picks an available public-tunnel implementation. Preference order:
#   1. ngrok      — when NGROK_AUTHTOKEN set; named *.ngrok-free.app URL
#   2. cloudflared — default; *.trycloudflare.com, no signup
start_public_tunnel() {
    if [ -n "$NGROK_AUTHTOKEN" ]; then
        start_ngrok
    else
        start_cloudflared
    fi
}

run_server_migrations() {
    b "[Server] running migrations"
    docker run --rm --network "$NETWORK" \
        -e CORE_DATABASE_URL="postgres://beeflow:$PG_PASSWORD@$PG_NAME:5432/beeflow" \
        "$SERVER_IMAGE" \
        node migrateDb.js 2>&1 | tail -5 || true
}

start_server() {
    if docker ps --format '{{.Names}}' | grep -qx "$SRV_NAME"; then
        b "[Server] $SRV_NAME already running — reusing"
        return 0
    fi
    docker rm -f "$SRV_NAME" >/dev/null 2>&1 || true
    b "[Server] launching $SERVER_IMAGE on :$SERVER_PORT"
    docker run -d --name "$SRV_NAME" \
        --network "$NETWORK" \
        -p "$SERVER_PORT:$SERVER_PORT" \
        -e PORT="$SERVER_PORT" \
        -e NODE_ENV=development \
        -e SESSION_SECRET=dev-session-secret-change-me-at-least-32-chars \
        -e MASTER_ENCRYPTION_KEY=dev-master-encryption-key-32-chars-min \
        -e BEEFLOW_BOOTSTRAP_SKIP_VERIFY=true \
        -e CORE_DATABASE_URL="postgres://beeflow:$PG_PASSWORD@$PG_NAME:5432/beeflow" \
        -e RUSTFS_ENDPOINT="http://$RUSTFS_NAME:9000" \
        -e RUSTFS_ACCESS_KEY="$RUSTFS_ACCESS_KEY" \
        -e RUSTFS_SECRET_KEY="$RUSTFS_SECRET_KEY" \
        -e CORS_ORIGIN="http://localhost:$NC_PORT,http://$NC_NAME" \
        -e COOKIE_SECURE=false \
        "$SERVER_IMAGE" >/dev/null

    b "[Server] waiting for /api/health"
    for _ in $(seq 1 60); do
        if curl -sf -m 1 "http://localhost:$SERVER_PORT/api/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    r "Server failed to become healthy in 60s — check: docker logs $SRV_NAME"
    return 1
}

ensure_server_image() {
    if docker image inspect "$SERVER_IMAGE" >/dev/null 2>&1; then
        b "[Server] image $SERVER_IMAGE already present"
        return 0
    fi
    b "[Server] pulling $SERVER_IMAGE"
    docker pull "$SERVER_IMAGE"
}

cmd_up() {
    docker info >/dev/null 2>&1 || { r "Docker daemon is not reachable"; exit 1; }

    # --cloud — point connector at https://server.beeflow.nl instead of the
    # local SaaS, skip the Postgres+RustFS+server stack, and start a public
    # tunnel so the cloud can callback-verify the NC instance.
    if [ "$CLOUD_MODE" = "1" ]; then
        WITH_SERVER=0
        API_BASE_URL="https://server.beeflow.nl"
        b "[cloud] Connector will target $API_BASE_URL; local SaaS stack disabled"
    fi

    # Image source priority:
    #   1. Already-loaded local image  → reuse
    #   2. Image looks like a registry path (contains '/' and a registry host
    #      such as ghcr.io / docker.io)  → docker pull
    #   3. Plain local tag (no registry host)  → docker build from CONNECTOR_DIR
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then
        b "[1/7] Reusing existing $IMAGE"
    elif [[ "$IMAGE" == *"/"*"/"* ]] || [[ "$IMAGE" == ghcr.io/* ]] || [[ "$IMAGE" == */* && "$IMAGE" != "library/"* && "$IMAGE" =~ \. ]]; then
        b "[1/7] Pulling $IMAGE from registry"
        docker pull "$IMAGE"
    else
        b "[1/7] Building $IMAGE locally (~1-3 min one-off; pre-built dev images live at ghcr.io/bee-flow/connector:dev)"
        # Self-contained build: Dockerfile clones Bee-Flow/hive anonymously
        # over HTTPS at build time. Context is the connector dir only — no
        # agent-hub/ sibling, no SSH key, no GitHub token required.
        docker build -t "$IMAGE" "$CONNECTOR_DIR"
    fi

    # Ensure shared docker network exists. All sandbox containers attach so
    # they can resolve each other by container name (no host.docker.internal).
    if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
        docker network create "$NETWORK" >/dev/null
    fi

    # ─── Server stack (Postgres + RustFS + Bee Flow server) ──────────────
    if [ "$WITH_SERVER" = "1" ]; then
        ensure_server_image
        start_postgres
        start_rustfs
        run_server_migrations
        start_server
    else
        b "[Server] WITH_SERVER=0 — skipping server stack; connector will hit $API_BASE_URL"
    fi

    if ! docker ps --format '{{.Names}}' | grep -qx "$NC_NAME"; then
        if docker ps -a --format '{{.Names}}' | grep -qx "$NC_NAME"; then
            b "[2/7] Starting existing $NC_NAME"
            docker start "$NC_NAME" >/dev/null
        else
            b "[2/7] Launching Nextcloud $NC_VERSION on :$NC_PORT"
            docker run -d --name "$NC_NAME" -p "$NC_PORT:80" \
                --network "$NETWORK" \
                "nextcloud:$NC_VERSION" >/dev/null
        fi
    else
        b "[2/7] $NC_NAME already running"
    fi

    # Existing NC container may have been started before $NETWORK existed —
    # attach it now if it isn't already on the network.
    if ! docker network inspect "$NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}' | grep -qw "$NC_NAME"; then
        docker network connect "$NETWORK" "$NC_NAME" 2>/dev/null || true
    fi

    b "[3/7] Waiting for apache"
    until docker exec "$NC_NAME" curl -sf http://127.0.0.1/status.php >/dev/null 2>&1; do sleep 2; done

    # Disable Apache mod_deflate so SSE responses (e.g. /ai/chat/direct/stream)
    # aren't gzip-buffered before reaching the browser. With deflate on, the
    # SPA's chat UI sees a partial / corrupted stream and prints "Error
    # generating response" while the cloud is actually streaming fine.
    # Idempotent: a2dismod is a no-op if already disabled.
    if docker exec "$NC_NAME" sh -c 'apache2ctl -M 2>/dev/null | grep -q deflate_module'; then
        docker exec "$NC_NAME" a2dismod -f deflate >/dev/null 2>&1 || true
        docker exec "$NC_NAME" apache2ctl restart 2>&1 | grep -v "fully qualified" >&2 || true
        # apache2ctl restart can briefly tear down the listener; wait for it back.
        until docker exec "$NC_NAME" curl -sf http://127.0.0.1/status.php >/dev/null 2>&1; do sleep 1; done
    fi

    if ! nc_occ status 2>/dev/null | grep -q 'installed: true'; then
        b "[4/7] Installing Nextcloud (admin/admin)"
        nc_occ maintenance:install --database=sqlite --admin-user=admin --admin-pass=admin >/dev/null
    else
        b "[4/7] Nextcloud already installed"
    fi

    # The connector mints SaaS-bound JWTs from the NC user record; the SaaS
    # rejects JWTs with no `email` claim (400 "Connector token missing email
    # claim"). NC's default admin has no email, so set one — idempotent.
    nc_occ user:setting admin settings email admin@example.com >/dev/null 2>&1 || true

    # Public tunnel for Cloud-mode bootstrap. The cloud SaaS verifies NC
    # ownership by calling back to ${ncBaseUrl}/ocs/.../capabilities; the
    # Docker-internal hostname $NC_NAME isn't reachable from the public
    # internet, so we expose NC at a public https URL and pass that to the
    # connector as BEEFLOW_NC_PUBLIC_URL. Only the bootstrap claim uses it;
    # internal connector→NC traffic still goes via $NC_NAME.
    #
    # Tunnel auto-starts when --cloud is passed (cloudflared by default,
    # ngrok if NGROK_AUTHTOKEN is set). Without --cloud, only fires when an
    # NGROK_AUTHTOKEN is explicitly provided (preserves prior behaviour).
    NC_PUBLIC_URL=""
    if [ "$CLOUD_MODE" = "1" ] || [ -n "$NGROK_AUTHTOKEN" ]; then
        NC_PUBLIC_URL=$(start_public_tunnel)
        if [ -n "$NC_PUBLIC_URL" ]; then
            tunnel_host="${NC_PUBLIC_URL#https://}"
            b "[tunnel] adding $tunnel_host to NC trusted_domains"
            # Reserve slot 2 for the tunnel host (slot 0=localhost, 1=$NC_NAME).
            # Adding to trusted_domains is enough — NC will accept inbound
            # requests at this host (which the cloud SaaS hits during the
            # one-off bootstrap callback). DO NOT set overwritehost: that
            # makes NC redirect ALL browser traffic to the cloudflared URL,
            # routing the user's interactive session through a flaky free
            # tunnel (SSE 520, request rate limits, etc.). The user should
            # keep browsing http://localhost:$NC_PORT directly.
            nc_occ config:system:set trusted_domains 2 --value="$tunnel_host" >/dev/null
            # Defensive: clear overwritehost / overwriteprotocol if a prior
            # version of this script (or a previous run) set them.
            nc_occ config:system:delete overwritehost >/dev/null 2>&1 || true
            nc_occ config:system:delete overwriteprotocol >/dev/null 2>&1 || true
        fi
    fi

    # Trusted domains — must include every hostname the connector / browser
    # uses to reach NC. Without these, NC returns its web-UI HTML for OCS
    # calls instead of JSON, which breaks the connector's /init flow
    # (TopMenu / EmbedScript / events_listener registrations all 400).
    #   localhost        → for the browser (already default-trusted)
    #   $NC_NAME         → for the connector calling NC over the shared network
    nc_occ config:system:set trusted_domains 1 --value="$NC_NAME" >/dev/null

    nc_occ app:install app_api 2>&1 | tail -1 || true
    docker exec -e DEBIAN_FRONTEND=noninteractive "$NC_NAME" bash -c "command -v sqlite3 >/dev/null || (apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq sqlite3 >/dev/null 2>&1)" || true

    # Daemon's host MUST be the connector container's name — that's how
    # AppAPI builds the heartbeat URL (http://<host>:<exapp-port>/heartbeat).
    # NC reaches it via Docker's embedded DNS on the shared $NETWORK.
    # Re-register if the daemon's host is wrong (legacy "host.docker.internal"
    # value from older runs).
    daemon_host_in_db=$(nc_sql "SELECT host FROM oc_ex_apps_daemons WHERE name='$DAEMON';" 2>/dev/null || echo "")
    if [ -n "$daemon_host_in_db" ] && [ "$daemon_host_in_db" != "$CONN_NAME" ]; then
        b "[5/7] Daemon $DAEMON has stale host '$daemon_host_in_db' — re-registering with '$CONN_NAME'"
        nc_occ app_api:daemon:unregister "$DAEMON" 2>&1 | tail -1 || true
    fi
    if ! nc_occ app_api:daemon:list 2>/dev/null | grep -qw "$DAEMON"; then
        b "[5/7] Registering $DAEMON daemon (host=$CONN_NAME, networked)"
        nc_occ app_api:daemon:register \
            "$DAEMON" "Manual Local" manual-install http "$CONN_NAME" "http://$NC_NAME" 2>&1 | tail -1
    else
        b "[5/7] Daemon $DAEMON already registered (host=$daemon_host_in_db)"
    fi

    # Re-register if the ExApp doesn't exist OR if `info.xml` is newer than
    # the registered row (so route/menu changes pick up automatically) OR if
    # FORCE=1 was passed. Otherwise NC's stored routes drift from info.xml
    # silently.
    info_mtime=$(stat -c %Y "$CONNECTOR_DIR/appinfo/info.xml" 2>/dev/null || echo 0)
    db_ctime=$(nc_sql "SELECT created_time FROM oc_ex_apps WHERE appid='$APP_ID';" 2>/dev/null || echo 0)
    if [ -z "$db_ctime" ] || [ "${FORCE:-0}" = "1" ] || [ "$info_mtime" -gt "$db_ctime" ]; then
        b "[6/7] (Re-)registering ExApp $APP_ID (info.xml mtime=$info_mtime, db ctime=$db_ctime)"
        nc_occ app_api:app:disable "$APP_ID" 2>/dev/null | tail -1 || true
        nc_occ app_api:app:unregister "$APP_ID" 2>/dev/null | tail -1 || true
        nc_sql "DELETE FROM oc_ex_apps WHERE appid='$APP_ID'; DELETE FROM oc_ex_apps_routes WHERE appid='$APP_ID'; DELETE FROM oc_ex_ui_top_menu WHERE appid='$APP_ID'; DELETE FROM oc_ex_ui_scripts WHERE appid='$APP_ID';" 2>/dev/null || true
        docker cp "$CONNECTOR_DIR/appinfo/info.xml" "$NC_NAME:/tmp/info.xml"

        # Run register in BACKGROUND. AppAPI inserts the row + secret + port
        # synchronously, then blocks polling for the connector's heartbeat.
        # That heartbeat can only succeed once we start the container — but
        # the container needs the port + secret which AppAPI just minted.
        # So we let register hang while we read the row, start the container,
        # and then block on register to finish.
        REGISTER_LOG=$(mktemp)
        nc_occ app_api:app:register "$APP_ID" "$DAEMON" \
            --info-xml /tmp/info.xml \
            --env "BEEFLOW_TENANT_KEY=$TENANT_KEY" \
            --env "BEEFLOW_API_BASE_URL=$API_BASE_URL" >"$REGISTER_LOG" 2>&1 &
        REGISTER_PID=$!

        b "[6/7] Waiting for AppAPI to provision port + secret"
        for i in $(seq 1 60); do
            PORT=$(nc_sql "SELECT port FROM oc_ex_apps WHERE appid='$APP_ID';" 2>/dev/null)
            SECRET=$(nc_sql "SELECT secret FROM oc_ex_apps WHERE appid='$APP_ID';" 2>/dev/null)
            [ -n "$PORT" ] && [ -n "$SECRET" ] && break
            sleep 0.5
        done
        if [ -z "$PORT" ] || [ -z "$SECRET" ]; then
            r "Timed out waiting for AppAPI to provision the ExApp row"
            kill "$REGISTER_PID" 2>/dev/null
            cat "$REGISTER_LOG" >&2
            rm -f "$REGISTER_LOG"
            exit 1
        fi
    else
        b "[6/7] ExApp $APP_ID already registered (info.xml unchanged)"
        REGISTER_PID=""
        REGISTER_LOG=""
        SECRET=$(nc_sql "SELECT secret FROM oc_ex_apps WHERE appid='$APP_ID';")
        PORT=$(nc_sql "SELECT port FROM oc_ex_apps WHERE appid='$APP_ID';")
    fi

    docker rm -f "$CONN_NAME" >/dev/null 2>&1 || true
    b "[7/7] Starting connector on :$PORT (network=$NETWORK, name=$CONN_NAME)"
    docker run -d --name "$CONN_NAME" \
        --network "$NETWORK" \
        -p "$PORT:$PORT" \
        -e APP_ID="$APP_ID" -e APP_VERSION=0.1.0 \
        -e APP_HOST=0.0.0.0 -e APP_PORT="$PORT" \
        -e APP_SECRET="$SECRET" \
        -e NEXTCLOUD_URL="http://$NC_NAME" \
        -e BEEFLOW_NC_PUBLIC_URL="$NC_PUBLIC_URL" \
        -e BEEFLOW_TENANT_KEY="$TENANT_KEY" \
        -e BEEFLOW_API_BASE_URL="$API_BASE_URL" \
        "$IMAGE" >/dev/null

    # Wait for connector /heartbeat (this also unblocks the backgrounded
    # register call). Probe via the host port-publish — the same endpoint
    # that NC will hit through the container network.
    b "[7/7] Waiting for connector /heartbeat on :$PORT"
    for i in $(seq 1 30); do
        if curl -sf -o /dev/null -m 1 "http://localhost:$PORT/heartbeat"; then
            break
        fi
        sleep 0.5
    done

    # Cross-check: NC must also be able to reach it via the network.
    b "[7/7] Verifying NC → connector connectivity"
    if ! docker exec "$NC_NAME" curl -sf -m 3 "http://$CONN_NAME:$PORT/heartbeat" >/dev/null; then
        r "NC cannot reach the connector at http://$CONN_NAME:$PORT/heartbeat"
        r "Try: docker network inspect $NETWORK   (both containers should be listed)"
        r "     docker logs $CONN_NAME --tail 30"
    fi

    # Now wait for the backgrounded register call to finish (it should
    # complete within seconds once heartbeat works).
    if [ -n "${REGISTER_PID:-}" ]; then
        wait "$REGISTER_PID" 2>/dev/null || true
        tail -1 "$REGISTER_LOG" 2>/dev/null
        rm -f "$REGISTER_LOG"
    fi

    # Force-bootstrap the deploy state. AppAPI's deploy step (image pull +
    # container start) was bypassed because we ran docker run ourselves;
    # set deploy=100 so AppAPI doesn't think it's mid-install. The /init
    # step will report progress autonomously as the container processes
    # its background setup.
    nc_sql "UPDATE oc_ex_apps SET status='{\"deploy\":100,\"init\":0,\"action\":\"\",\"type\":\"install\",\"error\":\"\"}' WHERE appid='$APP_ID';"
    nc_occ app_api:app:enable "$APP_ID" 2>&1 | tail -1

    g "✔ Sandbox up — http://localhost:$NC_PORT  (admin / admin)"
    echo "  Connector port: $PORT  (heartbeat: http://localhost:$PORT/heartbeat)"
    echo "  Connector logs: docker logs -f $CONN_NAME"
    if [ -n "$NC_PUBLIC_URL" ]; then
        echo "  Public NC URL:  $NC_PUBLIC_URL  (Cloud-mode bootstrap callback)"
    fi
}

cmd_down() {
    docker rm -f "$NC_NAME" "$CONN_NAME" "$SRV_NAME" "$RUSTFS_NAME" "$PG_NAME" "$NGROK_NAME" "$CFD_NAME" 2>/dev/null \
        && g "✔ stopped" || echo "(nothing to stop)"
}
cmd_clean() {
    cmd_down
    docker rmi "$IMAGE" 2>/dev/null && g "✔ connector image removed" || true
    # Server image is large (~1 GB) and tedious to re-pull — keep it cached
    # by default. Set FULL_CLEAN=1 to also remove it and Postgres/RustFS.
    if [ "${FULL_CLEAN:-0}" = "1" ]; then
        docker rmi "$SERVER_IMAGE" 2>/dev/null && g "✔ server image removed" || true
        docker rmi "$RUSTFS_IMAGE" 2>/dev/null && g "✔ rustfs image removed" || true
        docker rmi "$PG_IMAGE" 2>/dev/null && g "✔ postgres image removed" || true
    fi
    docker network rm "$NETWORK" 2>/dev/null && g "✔ network removed" || true
}
cmd_logs()   { docker logs -f --tail 50 "$CONN_NAME"; }
cmd_status() {
    docker ps \
        --filter "name=$PG_NAME" \
        --filter "name=$RUSTFS_NAME" \
        --filter "name=$SRV_NAME" \
        --filter "name=$NC_NAME" \
        --filter "name=$CONN_NAME" \
        --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo
    curl -s "http://localhost:$NC_PORT/status.php" | head -c 200; echo
}

# Parse subcommand + flags. `--cloud` can appear after `up` (or before, when
# implicit `up` is used). It sets CLOUD_MODE=1 which cmd_up acts on.
SUBCMD="up"
for arg in "$@"; do
    case "$arg" in
        --cloud) CLOUD_MODE=1 ;;
        up|down|clean|logs|status) SUBCMD="$arg" ;;
        *) echo "Usage: $0 {up|down|clean|logs|status} [--cloud]"; exit 1 ;;
    esac
done

case "$SUBCMD" in
    up) cmd_up ;;
    down) cmd_down ;;
    clean) cmd_clean ;;
    logs) cmd_logs ;;
    status) cmd_status ;;
esac
