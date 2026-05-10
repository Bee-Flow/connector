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
#                                          override to e.g. https://api.beeflow.ai
#                                          to skip running the server locally
#   WITH_SERVER=1                          # 0 to skip Postgres + RustFS + server
#   SERVER_IMAGE=ghcr.io/bee-flow/beeflow:dev
#   SERVER_PORT=3001                       # host-published port for the server
#   PG_PASSWORD=beeflow-dev
#   RUSTFS_IMAGE=rustfs/rustfs:latest
#   RUSTFS_ACCESS_KEY=rustfsadmin
#   RUSTFS_SECRET_KEY=rustfsadmin

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
    API_BASE_URL="${API_BASE_URL:-https://api.beeflow.ai}"
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
}

cmd_down() {
    docker rm -f "$NC_NAME" "$CONN_NAME" "$SRV_NAME" "$RUSTFS_NAME" "$PG_NAME" 2>/dev/null \
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

case "${1:-up}" in
    up) cmd_up ;;
    down) cmd_down ;;
    clean) cmd_clean ;;
    logs) cmd_logs ;;
    status) cmd_status ;;
    *) echo "Usage: $0 {up|down|clean|logs|status}"; exit 1 ;;
esac
